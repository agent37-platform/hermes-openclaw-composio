import { agent37 } from "@/lib/agent37";
import { requireAdmin, requireMember, requireUser } from "@/lib/auth";
import { AGENT_TEMPLATES, DEFAULT_AGENT, SERVICE_PORTS, runtimeForTemplate } from "@/config/agents";
import { kickBootstrap, needsBootstrap } from "@/lib/bootstrap";
import { usdToMicros } from "@/lib/format";
import { ApiError, handleError, json, readJson } from "@/lib/http";
import type { Agent, AgentRow, MergedAgent, Template } from "@/lib/types";

// The image catalog barely changes, but the dashboard polls this route every 5s while any agent is
// transitioning — so cache the template list briefly rather than re-fetching /templates on every
// poll (and on create). Module-scoped + best-effort: a stale entry only delays an agent's
// `update_available` flag by at most the TTL.
let templateCache: { at: number; data: Template[] } | null = null;
const TEMPLATES_TTL_MS = 60_000;

async function getTemplates(): Promise<Template[]> {
  if (templateCache && Date.now() - templateCache.at < TEMPLATES_TTL_MS) return templateCache.data;
  const { data } = await agent37.listTemplates();
  templateCache = { at: Date.now(), data };
  return data;
}

// The kit only creates agents on its own published templates (they build on the clean base
// images the bring-your-own-Composio wiring depends on) — never fall back to a stock system
// template, whose managed layer would overwrite the Composio config at every boot.
async function requireKitTemplate(name: string): Promise<string> {
  let published = false;
  try {
    const data = await getTemplates();
    published = data.some((t) => t.name === name);
  } catch {
    published = true; // template list unavailable — let create try, the API will 404 clearly
  }
  if (!published) {
    throw new ApiError(
      400,
      "template_not_published",
      `Template "${name}" is not published to your workspace yet — run \`npm run templates:publish\` first.`
    );
  }
  return name;
}

export async function GET(request: Request) {
  try {
    const { db, user } = await requireUser();
    const workspaceId = new URL(request.url).searchParams.get("workspace");
    if (!workspaceId) throw new ApiError(400, "invalid_request", "workspace query param is required");

    const role = await requireMember(db, workspaceId, user.id);

    const { data: rows, error } = await db
      .from("agents")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw new ApiError(500, "db_error", error.message);

    let live = new Map<string, Agent>();
    let templateImages = new Map<string, string>();
    let templateRevisions = new Map<string, number>();
    const [liveRes, tmplRes] = await Promise.allSettled([
      agent37.listAgents(),
      getTemplates(),
    ]);
    if (liveRes.status === "fulfilled") {
      live = new Map(liveRes.value.data.map((i) => [i.id, i]));
    }
    if (tmplRes.status === "fulfilled") {
      templateImages = new Map(
        tmplRes.value.filter((t) => t.image_ref).map((t) => [t.name, t.image_ref])
      );
      // Workspace templates version by revision (cloud-build-born ones expose no image_ref).
      templateRevisions = new Map(
        tmplRes.value.filter((t) => typeof t.revision === "number").map((t) => [t.name, t.revision as number])
      );
    }

    const agents: MergedAgent[] = (rows as AgentRow[]).map((row) => {
      const l = live.get(row.agent37_id);
      if (l && l.status !== row.status) {
        // Best-effort mirror sync. Authorized already: these rows belong to workspaceId, which the
        // caller is a member of (requireMember above).
        db.from("agents").update({ status: l.status }).eq("agent37_id", row.agent37_id).then(() => {});
      }
      const latestImage = l ? templateImages.get(l.template) : undefined;
      const latestRevision = l ? templateRevisions.get(l.template) : undefined;
      const update_available =
        !!(l?.image_ref && latestImage && l.image_ref !== latestImage) ||
        !!(l?.template_revision != null && latestRevision != null && l.template_revision !== latestRevision);

      // Bootstrap owed (fresh create, or the server restarted mid-bootstrap, or Composio creds
      // appeared after the agent was made): re-kick it — kickBootstrap single-flights and
      // cools down internally — and keep presenting "starting" until the agent is actually
      // configured, so nobody chats with an agent that has no model yet.
      const owesBootstrap = needsBootstrap(row);
      if (l?.status === "running" && owesBootstrap) kickBootstrap(row.agent37_id);
      const liveStatus = l?.status === "running" && !row.bootstrapped_at ? "starting" : l?.status ?? row.status;

      // Instances on workspace templates report no service ports — synthesize the ports both
      // base images actually serve so the open-in-new-tab buttons work.
      const runtime = runtimeForTemplate(row.template);
      const fallbackPorts = runtime
        ? SERVICE_PORTS[runtime].map((port) => ({ port, default: false, url: "" }))
        : [];

      return {
        ...row,
        cpu: l?.resources.cpu ?? row.cpu,
        memory: l?.resources.memory ?? row.memory,
        disk: l?.resources.disk ?? row.disk,
        live_status: liveStatus,
        status_reason: l?.status_reason ?? null,
        past_due: l?.past_due ?? false,
        ports: l?.ports?.length ? l.ports : fallbackPorts,
        update_available,
      };
    });

    return json({ agents, role });
  } catch (e) {
    return handleError(e);
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requireUser();
    // Shape is fixed server-side (DEFAULT_AGENT); the client picks the workspace and agent type.
    const body = await readJson<{ workspace_id?: string; template?: string }>(request);

    const workspaceId = body.workspace_id;
    if (!workspaceId) throw new ApiError(400, "invalid_request", "workspace_id is required");
    await requireAdmin(db, workspaceId, user.id);

    // Paywall/entitlement seam: a fork can gate agent creation here, e.g.
    // if (!(await canCreateAgent(db, workspaceId))) throw new ApiError(403, "forbidden", "Agent creation is not enabled for this workspace.");

    const template = await requireKitTemplate(
      body.template && AGENT_TEMPLATES.includes(body.template) ? body.template : DEFAULT_AGENT.template
    );

    const agent = await agent37.createAgent({
      template,
      resources: {
        cpu: DEFAULT_AGENT.cpu,
        memory: DEFAULT_AGENT.memory,
        disk: DEFAULT_AGENT.disk,
      },
      user: user.id,
      metadata: { app_workspace: workspaceId },
      budget: { monthly_cap_micros: usdToMicros(DEFAULT_AGENT.monthlyCapUsd) },
    });

    const { error } = await db.from("agents").insert({
      agent37_id: agent.id,
      workspace_id: workspaceId,
      name: agent.name || null,
      status: agent.status,
      template: agent.template,
      cpu: agent.resources.cpu,
      memory: agent.resources.memory,
      disk: agent.resources.disk,
      created_by: user.id,
    });
    if (error) {
      // Roll back the orphaned agent so we never bill for an untracked box.
      try {
        await agent37.deleteAgent(agent.id);
      } catch {
        /* best-effort */
      }
      throw new ApiError(500, "db_error", error.message);
    }

    // Configure the fresh instance in the background: managed model + your-Composio MCP wiring
    // (src/lib/bootstrap.ts). The fleet GET shows "starting" until it lands.
    kickBootstrap(agent.id);

    return json(agent, 201);
  } catch (e) {
    return handleError(e);
  }
}
