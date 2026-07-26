import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractBillableCalls, mintMcpSession, type McpSession } from "@/lib/composio";
import { hashProxyToken } from "@/lib/proxy-token";
import type { AgentRow } from "@/lib/types";

// The Composio MCP transport proxy — the ONLY place agent tool traffic meets your Composio key.
//
// Each agent instance runs a stock streamable-HTTP MCP client pointed here (bootstrap writes the
// `apps` server into its config with a per-agent Bearer token). We map the token back to the
// owning agent, mint a Composio tool-router session scoped to that agent's server-derived user id
// (Composio binds account resolution to it and ignores agent-supplied ids, so agents can't reach
// each other's connected accounts), meter the billable tool calls, and stream the MCP JSON-RPC
// through verbatim. Account OAuth rides Composio's native manage-connections meta-tool, so the
// agent surfaces connect links in chat by itself.
export const maxDuration = 300;

// MCP protocol headers pass through; the inbound Authorization (our proxy token) never reaches
// Composio. Mirrors Agent37's production proxy whitelists.
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"] as const;
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"] as const;

// In-memory session cache keyed by agent, minted single-flight. No TTL: a session is reused until
// Composio 404s (evicted) or 401s (key changed), then re-minted and the request replayed once. A
// server restart (or a fresh serverless instance) just re-mints on first use.
const sessions = new Map<string, McpSession>();
const minting = new Map<string, Promise<McpSession>>();

function getSession(agentId: string): Promise<McpSession> {
  const cached = sessions.get(agentId);
  if (cached) return Promise.resolve(cached);

  let inflight = minting.get(agentId);
  if (!inflight) {
    inflight = mintMcpSession(agentId)
      .then((session) => {
        sessions.set(agentId, session);
        return session;
      })
      .finally(() => minting.delete(agentId));
    minting.set(agentId, inflight);
  }
  return inflight;
}

function forward(session: McpSession, request: Request, body: ArrayBuffer | undefined): Promise<Response> {
  const headers: Record<string, string> = { ...session.headers };
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  // redirect:"manual" is load-bearing: fetch would otherwise forward x-api-key across a
  // cross-origin redirect, and Composio 308s on trailing-slash mismatches.
  return fetch(session.url, {
    method: request.method,
    headers,
    body: request.method === "POST" ? body : undefined,
    redirect: "manual",
    cache: "no-store",
  });
}

function errorJson(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

async function handle(request: Request): Promise<Response> {
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!token) return errorJson(401, "missing bearer token");

  const db = createAdminClient();
  const { data: row, error: lookupError } = await db
    .from("agents")
    .select("agent37_id")
    .eq("proxy_token_hash", hashProxyToken(token))
    .maybeSingle<Pick<AgentRow, "agent37_id">>();
  // A DB outage must not read as a permanent auth failure to the agent's MCP client.
  if (lookupError) return errorJson(503, "token lookup unavailable");
  if (!row) return errorJson(401, "invalid token");
  const agentId = row.agent37_id;

  // Buffer the body up front so a re-mint can replay it byte-for-byte.
  const body = request.method === "POST" ? await request.arrayBuffer() : undefined;

  try {
    let upstream = await forward(await getSession(agentId), request, body);
    if (upstream.status === 404 || upstream.status === 401) {
      sessions.delete(agentId);
      upstream = await forward(await getSession(agentId), request, body);
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      return errorJson(502, "upstream redirect refused");
    }

    // Meter after the response is sent — after() keeps the serverless instance alive for it,
    // where a plain fire-and-forget promise would be dropped at suspend.
    if (body && upstream.ok) {
      after(() => recordUsage(db, agentId, body));
    }

    const headers = new Headers();
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    console.warn(`[composio-mcp] ${agentId} proxy failed:`, e instanceof Error ? e.message : e);
    return errorJson(502, "composio upstream unavailable");
  }
}

async function recordUsage(db: ReturnType<typeof createAdminClient>, agentId: string, body: ArrayBuffer): Promise<void> {
  try {
    const calls = extractBillableCalls(new TextDecoder().decode(body));
    await Promise.all(
      calls.map(({ tool, calls: n }) =>
        db.rpc("increment_composio_usage", { p_agent37_id: agentId, p_tool: tool, p_calls: n }).then(
          ({ error }) => {
            if (error) console.warn("[composio-mcp] usage row failed:", error.message);
          }
        )
      )
    );
  } catch {
    /* metering must never break the transport */
  }
}

export { handle as POST, handle as DELETE };

// The optional MCP standalone GET (server-push SSE) stream is refused. Every agent's MCP client
// opens it at connect and holds it, so proxying it parks one open stream per agent on a
// serverless function until maxDuration and the client then reconnects — for a channel this app
// doesn't use (per-request streaming rides the POST response). Must stay a clean 405: a stream
// that is accepted and then closed puts both official client SDKs into a ~1s reconnect loop.
export function GET(): Response {
  return new Response(null, { status: 405, headers: { allow: "POST, DELETE, OPTIONS" } });
}
