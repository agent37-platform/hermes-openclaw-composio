import "server-only";
import { Composio } from "@composio/core";
import { ApiError } from "@/lib/http";
import type {
  IntegrationConnection,
  IntegrationConnectionsResult,
  IntegrationConnectResult,
  IntegrationToolkit,
  IntegrationToolkitsResult,
} from "@/lib/types";

// YOUR Composio project, reached with YOUR key — the whole point of this kit. The key lives only
// on this server: the UI routes below manage toolkits/connections with it, and the MCP transport
// proxy (src/app/api/composio-mcp/route.ts) mints tool-router sessions with it. Nothing
// Composio-related routes through Agent37, and the key never reaches an instance.
const COMPOSIO_API_BASE = "https://backend.composio.dev";

let cached: Composio | null = null;

export function composioConfigured(): boolean {
  return !!process.env.COMPOSIO_API_KEY;
}

export function getComposioClient(): Composio {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new ApiError(
      503,
      "composio_not_configured",
      "Set COMPOSIO_API_KEY on the server to enable integrations (get one at composio.dev)."
    );
  }
  if (!cached) cached = new Composio({ apiKey });
  return cached;
}

// The Composio "user id" every connected account and tool-router session is scoped to. One entity
// per agent, derived server-side from the agent id — Composio binds account resolution to it and
// ignores agent-supplied ids, so agents can never reach each other's connected accounts.
export function composioUserId(agentId: string): string {
  return `agent:${agentId}`;
}

// ---- Toolkit catalog (Browse tab) -------------------------------------------------------------

// Deliberately the global v3 catalog, not a per-session tool list: the session endpoint only
// surfaces a session's own tools and returns almost nothing for catalog search.
export async function listToolkits(search?: string): Promise<IntegrationToolkitsResult> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new ApiError(503, "composio_not_configured", "Set COMPOSIO_API_KEY on the server.");

  const params = new URLSearchParams({ limit: "24" });
  if (search) params.set("search", search);
  const res = await fetch(`${COMPOSIO_API_BASE}/api/v3/toolkits?${params}`, {
    headers: { "x-api-key": apiKey },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new ApiError(502, "composio_error", `Composio toolkit catalog failed (${res.status}).`);
  }
  const data = (await res.json()) as { items?: unknown[] };
  return { items: (data.items ?? []).map(normalizeToolkit) };
}

interface RawToolkit {
  slug?: string;
  name?: string;
  no_auth?: boolean;
  composio_managed_auth_schemes?: string[];
  auth_schemes?: string[];
  meta?: { description?: string; logo?: string };
}

// The v3 catalog has no `enabled` field (every listed toolkit is connectable) and prefers
// `composio_managed_auth_schemes` over `auth_schemes`.
function normalizeToolkit(raw: unknown): IntegrationToolkit {
  const t = (raw ?? {}) as RawToolkit;
  return {
    slug: t.slug ?? "",
    name: t.name ?? t.slug ?? "",
    description: t.meta?.description ?? null,
    logo: t.meta?.logo ?? null,
    enabled: true,
    isNoAuth: !!t.no_auth,
    authSchemes: t.composio_managed_auth_schemes ?? t.auth_schemes ?? [],
  };
}

// ---- Connect (OAuth redirect flow) ------------------------------------------------------------

// Composio auto-provisions its managed auth config on demand; toolkits without one throw
// error 4308 "NoManagedAuth" — surfaced as 422 so the UI can explain the fix (create an auth
// config for that toolkit in YOUR Composio dashboard, then retry).
export async function connectToolkit(agentId: string, toolkit: string): Promise<IntegrationConnectResult> {
  const client = getComposioClient();
  const userId = composioUserId(agentId);
  try {
    const session = await client.toolRouter.create(userId, { manageConnections: true });
    const request = await session.authorize(toolkit);
    return {
      toolkit,
      connectedAccountId: request.id,
      redirectUrl: request.redirectUrl ?? "",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("4308") || message.includes("NoManagedAuth")) {
      throw new ApiError(
        422,
        "custom_auth_required",
        `"${toolkit}" has no Composio-managed auth. Create an auth config for it in your Composio dashboard (Auth Configs → ${toolkit}), then retry.`
      );
    }
    throw e;
  }
}

// ---- Connected accounts ------------------------------------------------------------------------

interface RawConnectedAccount {
  id?: string;
  status?: string;
  userId?: string;
  user_id?: string;
  toolkit?: { slug?: string; name?: string };
  authConfig?: { id?: string; authScheme?: string };
  auth_config?: { id?: string; auth_scheme?: string };
  state?: { authScheme?: string };
  isDisabled?: boolean;
  is_disabled?: boolean;
  createdAt?: string | number;
  created_at?: string | number;
  updatedAt?: string | number;
  updated_at?: string | number;
}

function toEpochMs(value: string | number | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// The SDK returns camelCase or snake_case depending on the surface — handle both.
function normalizeConnection(raw: unknown): IntegrationConnection {
  const c = (raw ?? {}) as RawConnectedAccount;
  const status = (c.status ?? "").toUpperCase();
  return {
    id: c.id ?? "",
    status,
    userId: c.userId ?? c.user_id ?? null,
    toolkitSlug: c.toolkit?.slug ?? null,
    toolkitName: c.toolkit?.name ?? null,
    authConfigId: c.authConfig?.id ?? c.auth_config?.id ?? null,
    authScheme: c.state?.authScheme ?? c.authConfig?.authScheme ?? c.auth_config?.auth_scheme ?? null,
    isDisabled: !!(c.isDisabled ?? c.is_disabled) || status === "INACTIVE" || status === "DISABLED",
    createdAt: toEpochMs(c.createdAt ?? c.created_at),
    updatedAt: toEpochMs(c.updatedAt ?? c.updated_at),
  };
}

export async function listConnections(agentId: string): Promise<IntegrationConnectionsResult> {
  const client = getComposioClient();
  const userId = composioUserId(agentId);

  const seen = new Map<string, IntegrationConnection>();
  let cursor: string | undefined;
  // Paginated, hard-capped — an agent with >1000 connections is not a real case.
  for (let page = 0; page < 10; page++) {
    const res = await client.connectedAccounts.list({
      userIds: [userId],
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of res.items ?? []) {
      const conn = normalizeConnection(item);
      if (conn.id) seen.set(conn.id, conn);
    }
    cursor = (res as { nextCursor?: string | null }).nextCursor ?? undefined;
    if (!cursor) break;
  }

  const connections = [...seen.values()].sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)
  );
  return { connections };
}

// Ownership is enforced here (not by Composio): the account must belong to THIS agent's Composio
// user, otherwise any workspace admin could disconnect another agent's account by guessing its id.
export async function deleteConnection(
  agentId: string,
  connectedAccountId: string
): Promise<{ id: string; deleted: boolean }> {
  const client = getComposioClient();
  const { connections } = await listConnections(agentId);
  if (!connections.some((c) => c.id === connectedAccountId)) {
    throw new ApiError(404, "not_found", "No such connected account on this agent.");
  }
  const res = await client.connectedAccounts.delete(connectedAccountId);
  if (!(res as { success?: boolean }).success) {
    throw new ApiError(502, "composio_error", "The connection was not confirmed removed.");
  }
  return { id: connectedAccountId, deleted: true };
}

// ---- MCP tool-router sessions (the transport the proxy forwards to) ----------------------------

export interface McpSession {
  url: string;
  headers: Record<string, string>;
}

export async function mintMcpSession(agentId: string): Promise<McpSession> {
  const client = getComposioClient();
  const session = await client.create(composioUserId(agentId), {
    // Keep the manage-connections meta-tool so the agent can surface OAuth links in chat, allow
    // several accounts per toolkit, drop Composio's remote-execution meta-tools, and expose the
    // session's MCP endpoint.
    manageConnections: { waitForConnections: true },
    multiAccount: { enable: true },
    sandbox: { enable: false },
    mcp: true,
  });

  const url = typeof session.mcp?.url === "string" ? session.mcp.url.trim() : "";
  if (!url) throw new Error("Composio session response has no MCP URL");

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(session.mcp?.headers ?? {})) {
    if (typeof value === "string" && value) headers[key.toLowerCase()] = value;
  }
  if (Object.keys(headers).length === 0) {
    headers["x-api-key"] = process.env.COMPOSIO_API_KEY ?? "";
  }
  return { url, headers };
}

// ---- Metering ----------------------------------------------------------------------------------

const FREE_META_TOOLS = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);
const MULTI_EXECUTE_BATCH_CAP = 50;

export interface BillableCall {
  tool: string;
  calls: number;
}

// Extract the billable tool executions from an MCP JSON-RPC request body (single message or
// batch). Discovery meta-tools are free; COMPOSIO_MULTI_EXECUTE_TOOL bills its batch size; the
// executed tool's real slug is preferred over the meta-tool name so usage rows read "GMAIL_...",
// not "COMPOSIO_EXECUTE_TOOL". Parse failures return [] — metering must never block a tool call.
export function extractBillableCalls(bodyText: string): BillableCall[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const out: BillableCall[] = [];
  for (const message of messages) {
    const m = message as {
      method?: string;
      params?: { name?: string; arguments?: { tool_slug?: string; tools?: { tool_slug?: string }[] } };
    };
    if (m?.method !== "tools/call" || typeof m.params?.name !== "string") continue;
    const name = m.params.name;
    if (FREE_META_TOOLS.has(name)) continue;

    if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
      const tools = Array.isArray(m.params.arguments?.tools) ? m.params.arguments.tools : [];
      for (const t of tools.slice(0, MULTI_EXECUTE_BATCH_CAP)) {
        out.push({ tool: t?.tool_slug || name, calls: 1 });
      }
      if (tools.length === 0) out.push({ tool: name, calls: 1 });
      continue;
    }

    out.push({ tool: m.params.arguments?.tool_slug || name, calls: 1 });
  }
  return out;
}
