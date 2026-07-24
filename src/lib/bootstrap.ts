import "server-only";
import { agent37, instanceFetch } from "@/lib/agent37";
import { composioConfigured } from "@/lib/composio";
import { mintProxyToken, hashProxyToken } from "@/lib/proxy-token";
import { runtimeForTemplate, type AgentRuntime } from "@/config/agents";
import { createAdminClient } from "@/lib/supabase/admin";

// Post-create bootstrap for a fresh agent instance.
//
// The kit's templates build on Agent37's CLEAN base images (hermes-base / openclaw-base), which
// deliberately inject nothing at boot — so this module writes the agent's config once, over the
// control-plane exec endpoint:
//
//   1. Agent37's managed model, using the starter credentials the platform injects as env into
//      every instance (chat works with zero model setup, billed to the instance's budget).
//   2. The `apps` MCP server → this app's /api/composio-mcp proxy, authenticated by a per-agent
//      token minted here. That is the bring-your-own-Composio wiring.
//
// The starter credential ROTATES on every container recreate (restart/update/resize), so the
// provider block can't just be baked once: bootstrap also installs a post-restart hook (the base
// images run ~/.agent37/hooks/post-restart.sh before starting services) that re-reads the current
// env and refreshes the provider config at every boot — the same trick the managed images use.
// The kit's own `cpx_` MCP token never rotates, so the `apps` block stays static.
//
// Then it restarts the instance so the agent loads the config. Config + hook live on the
// persistent volume, so one bootstrap survives restarts, image updates, and resizes. Runs in the
// background (create returns immediately); the fleet GET overlays "starting" until
// `bootstrapped_at` lands and re-kicks bootstrap if it never did (e.g. the server restarted
// mid-run).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Two layers keep bootstraps single-flight. In-process: the dashboard polls the fleet GET every
// 5s while agents transition, and each poll may re-kick — dedupe + cool down locally. Across
// processes (serverless runs many instances): a DB lease (`bootstrap_claimed_at`) is claimed
// atomically before any work, so two lambdas can't interleave token mints and config writes.
const inflight = new Set<string>();
const lastAttempt = new Map<string, number>();
const RETRY_COOLDOWN_MS = 60_000;
const CLAIM_STALE_MS = 10 * 60_000; // > the worst-case run (3min wait-running + execs + restart)

export function kickBootstrap(agentId: string): void {
  if (inflight.has(agentId)) return;
  const last = lastAttempt.get(agentId) ?? 0;
  if (Date.now() - last < RETRY_COOLDOWN_MS) return;

  inflight.add(agentId);
  lastAttempt.set(agentId, Date.now());
  bootstrapAgent(agentId)
    .catch((e) => console.warn(`[bootstrap] ${agentId} failed:`, e instanceof Error ? e.message : e))
    .finally(() => inflight.delete(agentId));
}

// True when the agent still owes a bootstrap step the environment can now satisfy.
export function needsBootstrap(row: { bootstrapped_at?: string | null; composio_wired_at?: string | null }): boolean {
  if (!row.bootstrapped_at) return true;
  return !row.composio_wired_at && composioAvailable();
}

function composioAvailable(): boolean {
  return composioConfigured() && !!mcpPublicUrl();
}

// The URL the INSTANCE (running in Agent37's cloud) uses to reach this app's MCP proxy — it must
// be publicly reachable, so localhost dev can't serve it. Deploy first, or point a tunnel at dev.
function mcpPublicUrl(): string | null {
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  if (!site || !/^https?:\/\//.test(site) || site.includes("localhost") || site.includes("127.0.0.1")) {
    return null;
  }
  return `${site}/api/composio-mcp`;
}

async function waitForStatus(agentId: string, wanted: string, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const agent = await agent37.getAgent(agentId);
      if (agent.status === wanted) return true;
      if (agent.status === "failed" || agent.status === "deleted") return false;
    } catch {
      /* transient */
    }
    await sleep(2000);
  }
  return false;
}

async function waitHealthy(agentId: string, attempts = 45): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await instanceFetch(agentId, "/v1/health");
      if (res.ok) return true;
    } catch {
      /* booting */
    }
    await sleep(2000);
  }
  return false;
}

// OpenClaw runs first-boot state migrations under a lock; restarting the container mid-migration
// strands the lock and OpenClaw then refuses to start until it expires (~5 min). Its native
// gateway listening on loopback 28789 is the "migrations finished" signal — wait for it before
// restarting, and again after, so a lock-crash surfaces as a bootstrap failure (which the fleet
// poll retries) instead of a silently dead agent.
async function waitOpenclawReady(agentId: string, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await agent37.exec(agentId, "ss -ltn 2>/dev/null | grep -c ':28789 '");
      if (parseInt(result.stdout.trim(), 10) > 0) return true;
    } catch {
      /* transient exec failure */
    }
    await sleep(5000);
  }
  return false;
}

// The starter credentials only exist as env INSIDE the instance — read them off the entrypoint
// (PID 1), which is robust regardless of what shell/env `exec` itself gets.
async function readStarterEnv(agentId: string): Promise<Record<string, string>> {
  const result = await agent37.exec(agentId, "tr '\\0' '\\n' < /proc/1/environ");
  const env: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

async function bootstrapAgent(agentId: string): Promise<void> {
  const db = createAdminClient();

  // Claim the cross-process lease: an atomic conditional UPDATE — zero rows back means another
  // server instance owns this bootstrap right now.
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const { data: claimed, error: claimError } = await db
    .from("agents")
    .update({ bootstrap_claimed_at: new Date().toISOString() })
    .eq("agent37_id", agentId)
    .or(`bootstrap_claimed_at.is.null,bootstrap_claimed_at.lt.${staleBefore}`)
    .select("template, bootstrapped_at, composio_wired_at");
  if (claimError) throw new Error(`bootstrap claim failed: ${claimError.message}`);
  if (!claimed?.length) return;
  const row = claimed[0] as { template: string | null; bootstrapped_at: string | null; composio_wired_at: string | null };

  const releaseClaim = () =>
    db.from("agents").update({ bootstrap_claimed_at: null }).eq("agent37_id", agentId).then(() => {});

  try {
    const runtime = runtimeForTemplate(row.template);
    if (!runtime) {
      console.warn(`[bootstrap] ${agentId} template "${row.template}" is not a kit template; skipping.`);
      await releaseClaim();
      return;
    }

    if (!(await waitForStatus(agentId, "running", 90))) {
      console.warn(`[bootstrap] ${agentId} never reached running; will retry on the next fleet poll.`);
      await releaseClaim();
      return;
    }

    if (runtime === "openclaw" && !(await waitOpenclawReady(agentId))) {
      throw new Error("OpenClaw never finished its first-boot migrations; retrying later");
    }

    const starter = await readStarterEnv(agentId);
    const proxyUrl = starter.AGENT37_STARTER_PROXY_URL ?? "";
    const starterToken = starter.AGENT37_STARTER_TOKEN ?? "";
    const modelId = starter.AGENT37_STARTER_MODEL_ID || "default";
    if (!proxyUrl || !starterToken) {
      throw new Error("instance has no starter credentials in /proc/1/environ");
    }

    // Mint the per-agent MCP proxy token. The raw value exists only in the instance's config;
    // the hash is what /api/composio-mcp looks up.
    const mcpUrl = mcpPublicUrl();
    const wireComposio = composioConfigured() && !!mcpUrl;
    let mcpToken: string | null = null;
    if (wireComposio) {
      mcpToken = mintProxyToken();
      const { error } = await db
        .from("agents")
        .update({ proxy_token_hash: hashProxyToken(mcpToken) })
        .eq("agent37_id", agentId);
      if (error) throw new Error(`storing proxy token hash failed: ${error.message}`);
    } else {
      console.warn(
        `[bootstrap] ${agentId}: Composio wiring skipped (${composioConfigured() ? "NEXT_PUBLIC_SITE_URL is unset or local" : "COMPOSIO_API_KEY is unset"}). The agent still chats on the managed model.`
      );
    }

    const input: ConfigInput = { proxyUrl, starterToken, modelId, mcpUrl, mcpToken };
    if (runtime === "hermes") {
      // A fresh agent gets the full config; the late Composio re-wire (bootstrapped earlier,
      // creds appeared later) only appends the MCP block so the user's model choice and any
      // manual config edits survive.
      if (row.bootstrapped_at) {
        await appendHermesMcp(agentId, input);
      } else {
        await writeHermesConfig(agentId, input);
      }
    } else {
      // The OpenClaw writer is a key-level merge, safe on both the fresh and re-wire paths.
      await writeOpenclawConfig(agentId, input);
    }
    // The restart below recreates the container and ROTATES the starter credential — this hook
    // refreshes the provider from the new env before services start, every boot from now on.
    await installRefreshHook(agentId, runtime);

    await agent37.restart(agentId);
    await sleep(3000);
    await waitHealthy(agentId);
    if (runtime === "openclaw" && !(await waitOpenclawReady(agentId))) {
      throw new Error("OpenClaw did not come back after the config restart; retrying later");
    }

    const now = new Date().toISOString();
    const { error: stampError } = await db
      .from("agents")
      .update({
        bootstrapped_at: row.bootstrapped_at ?? now,
        ...(wireComposio ? { composio_wired_at: now } : {}),
        bootstrap_claimed_at: null,
      })
      .eq("agent37_id", agentId);
    if (stampError) throw new Error(`stamping bootstrap completion failed: ${stampError.message}`);
    console.log(`[bootstrap] ${agentId} ready (${runtime}${wireComposio ? " + composio" : ""}).`);
  } catch (e) {
    await releaseClaim();
    throw e;
  }
}

interface ConfigInput {
  proxyUrl: string;
  starterToken: string;
  modelId: string;
  mcpUrl: string | null;
  mcpToken: string | null;
}

// Match the managed image's normalization: the starter proxy is an OpenAI-compatible endpoint
// under /v1.
function providerBaseUrl(proxyUrl: string): string {
  const trimmed = proxyUrl.replace(/\/$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

async function execWriteFile(agentId: string, path: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const result = await agent37.exec(
    agentId,
    `mkdir -p "$(dirname ${path})" && echo ${b64} | base64 -d > ${path}`
  );
  if (result.exit_code !== 0) {
    throw new Error(`writing ${path} failed: ${result.stderr || result.stdout}`);
  }
}

// The provider-refresh hook: runs at every container start (before services), pulling the
// CURRENT starter credentials from env into the agent's config — the baked values go stale the
// moment the platform recreates the container and reissues the credential.
const HERMES_REFRESH_PY = `#!/usr/bin/env python3
# Managed by the app (bootstrap): refresh the Agent37 provider from the current starter env.
import os, yaml

path = os.path.expanduser("~/.hermes/config.yaml")
try:
    with open(path) as f:
        config = yaml.safe_load(f) or {}
except FileNotFoundError:
    config = {}
if not isinstance(config, dict):
    raise SystemExit(0)

url = os.environ.get("AGENT37_STARTER_PROXY_URL", "").rstrip("/")
token = os.environ.get("AGENT37_STARTER_TOKEN", "")
model_id = os.environ.get("AGENT37_STARTER_MODEL_ID", "default")
if not url or not token:
    raise SystemExit(0)
if not url.endswith("/v1"):
    url += "/v1"

providers = config.get("custom_providers")
if not isinstance(providers, list):
    providers = []
entry = {"name": "Agent37", "base_url": url, "api_key": token, "api_mode": "chat_completions", "model": model_id}
for i, existing in enumerate(providers):
    if isinstance(existing, dict) and existing.get("name") == "Agent37":
        providers[i] = {**existing, **entry}
        break
else:
    providers.append(entry)
config["custom_providers"] = providers

model = config.get("model")
if not isinstance(model, dict) or not (model.get("default") or model.get("model")):
    config["model"] = {"provider": "custom:Agent37", "default": model_id}

with open(path, "w") as f:
    yaml.safe_dump(config, f, sort_keys=False)
`;

const OPENCLAW_REFRESH_JS = `// Managed by the app (bootstrap): refresh the agent37 provider from the current starter env.
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const file = path.join(os.homedir(), ".openclaw", "openclaw.json");
let c = {};
try {
  const text = fs.readFileSync(file, "utf8");
  try { c = JSON.parse(text); }
  catch { c = vm.runInNewContext("(" + text + ")", Object.create(null), { timeout: 1000 }); }
} catch {}
if (!c || typeof c !== "object" || Array.isArray(c)) process.exit(0);
const url = (process.env.AGENT37_STARTER_PROXY_URL || "").replace(/\\/$/, "");
const token = process.env.AGENT37_STARTER_TOKEN || "";
const modelId = process.env.AGENT37_STARTER_MODEL_ID || "default";
if (!url || !token) process.exit(0);
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
c.models = obj(c.models);
c.models.mode = "merge";
c.models.providers = obj(c.models.providers);
const prev = obj(c.models.providers.agent37);
c.models.providers.agent37 = {
  ...prev,
  baseUrl: url,
  apiKey: token,
  api: "openai-completions",
  models: Array.isArray(prev.models) && prev.models.length
    ? prev.models
    : [{ id: modelId, name: "Agent37 Default", input: ["text", "image"] }],
};
fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\\n");
`;

// Install the refresh script and chain it into the base image's post-restart hook (created by
// the entrypoint on first boot; the grep keeps the append idempotent).
async function installRefreshHook(agentId: string, runtime: AgentRuntime): Promise<void> {
  const script = runtime === "hermes" ? HERMES_REFRESH_PY : OPENCLAW_REFRESH_JS;
  const scriptPath = `~/.agent37/hooks/refresh-agent37-provider.${runtime === "hermes" ? "py" : "js"}`;
  await execWriteFile(agentId, scriptPath, script);

  const runLine =
    runtime === "hermes"
      ? `"\${HERMES_PYTHON:-/usr/local/lib/hermes/hermes-agent/venv/bin/python}" ${scriptPath} || true`
      : `node ${scriptPath} || true`;
  const result = await agent37.exec(
    agentId,
    `touch ~/.agent37/hooks/post-restart.sh && grep -q refresh-agent37-provider ~/.agent37/hooks/post-restart.sh || printf '%s\\n' '${runLine}' >> ~/.agent37/hooks/post-restart.sh`
  );
  if (result.exit_code !== 0) {
    throw new Error(`installing refresh hook failed: ${result.stderr || result.stdout}`);
  }
}

// Hermes: ~/.hermes/config.yaml is untouched by hermes-base at boot, so one full write here owns
// it. The `apps` MCP server name is deliberately not `composio` — that key is what Agent37's
// MANAGED images rewrite, and staying off it keeps the config valid even if someone moves the
// agent to a stock template later.
async function writeHermesConfig(agentId: string, input: ConfigInput): Promise<void> {
  const lines = [
    "model:",
    `  provider: "custom:Agent37"`,
    `  default: "${input.modelId}"`,
    "custom_providers:",
    `  - name: "Agent37"`,
    `    base_url: "${providerBaseUrl(input.proxyUrl)}"`,
    `    api_key: "${input.starterToken}"`,
    `    api_mode: "chat_completions"`,
    `    model: "${input.modelId}"`,
    // composio-environment (baked by hermes-template/) steers SaaS intents to the MCP tools;
    // agent37-environment (in the base) documents persistent paths + native web hosting. Hermes
    // gates non-bundled plugins behind this allow-list, so both must be listed to load.
    "plugins:",
    "  enabled:",
    '    - "agent37-environment"',
    '    - "composio-environment"',
  ];
  if (input.mcpUrl && input.mcpToken) {
    lines.push(...hermesMcpLines(input.mcpUrl, input.mcpToken));
  }
  await execWriteFile(agentId, "~/.hermes/config.yaml", lines.join("\n") + "\n");
}

function hermesMcpLines(mcpUrl: string, mcpToken: string): string[] {
  return [
    "mcp_servers:",
    "  apps:",
    `    url: "${mcpUrl}"`,
    "    headers:",
    `      Authorization: "Bearer ${mcpToken}"`,
  ];
}

// The late re-wire: append only the MCP block. If a top-level mcp_servers key already exists
// (the user took the config over by hand), leave it alone — the grep guard makes the append a
// no-op and the wired stamp stops the retry loop.
async function appendHermesMcp(agentId: string, input: ConfigInput): Promise<void> {
  if (!input.mcpUrl || !input.mcpToken) return;
  const block = "\n" + hermesMcpLines(input.mcpUrl, input.mcpToken).join("\n") + "\n";
  const b64 = Buffer.from(block, "utf8").toString("base64");
  const result = await agent37.exec(
    agentId,
    `grep -q '^mcp_servers:' ~/.hermes/config.yaml 2>/dev/null || echo ${b64} | base64 -d >> ~/.hermes/config.yaml`
  );
  if (result.exit_code !== 0) {
    throw new Error(`appending mcp_servers failed: ${result.stderr || result.stdout}`);
  }
}

// OpenClaw: openclaw.json already carries structural config the base image writes at every boot
// (gateway auth token, OpenResponses endpoint), so MERGE — never overwrite. The base's boot
// script only manages its own keys (and deletes `mcp.servers.composio`, which is why the server
// is named `apps`); everything written here survives.
async function writeOpenclawConfig(agentId: string, input: ConfigInput): Promise<void> {
  const values = {
    providerBaseUrl: input.proxyUrl.replace(/\/$/, ""),
    starterToken: input.starterToken,
    modelId: input.modelId,
    mcpUrl: input.mcpUrl,
    mcpToken: input.mcpToken,
  };
  const script = `
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const v = ${JSON.stringify(values)};
const file = path.join(os.homedir(), ".openclaw", "openclaw.json");
// OpenClaw may persist its config as JSON5 (comments / trailing commas) — mirror the platform
// updater's fallback, and abort rather than merge into {} if the file exists but won't parse.
let c = {};
try {
  const text = fs.readFileSync(file, "utf8");
  try { c = JSON.parse(text); }
  catch { c = vm.runInNewContext("(" + text + ")", Object.create(null), { timeout: 1000 }); }
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("not an object");
} catch (e) {
  if (fs.existsSync(file)) { console.error("unparseable openclaw.json: " + e.message); process.exit(1); }
  c = {};
}
const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
c.models = obj(c.models);
c.models.mode = "merge";
c.models.providers = obj(c.models.providers);
c.models.providers.agent37 = {
  baseUrl: v.providerBaseUrl,
  apiKey: v.starterToken,
  api: "openai-completions",
  models: [{ id: v.modelId, name: "Agent37 Default", input: ["text", "image"] }],
};
c.agents = obj(c.agents);
c.agents.defaults = obj(c.agents.defaults);
// OpenClaw allows the string shorthand for the default model — preserve it as { primary }.
const model = c.agents.defaults.model;
c.agents.defaults.model = typeof model === "string" ? { primary: model } : obj(model);
if (!c.agents.defaults.model.primary) c.agents.defaults.model.primary = "agent37/" + v.modelId;
c.agents.defaults.models = obj(c.agents.defaults.models);
c.agents.defaults.models["agent37/" + v.modelId] = { alias: "agent37-default" };
c.agents.defaults.models["agent37/*"] = {};
if (v.mcpUrl && v.mcpToken) {
  c.mcp = obj(c.mcp);
  c.mcp.servers = obj(c.mcp.servers);
  c.mcp.servers.apps = {
    url: v.mcpUrl,
    transport: "streamable-http",
    headers: { Authorization: "Bearer " + v.mcpToken },
  };
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\\n");
`;
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const result = await agent37.exec(
    agentId,
    `echo ${b64} | base64 -d > /tmp/a37-composio-config.js && node /tmp/a37-composio-config.js && rm -f /tmp/a37-composio-config.js`
  );
  if (result.exit_code !== 0) {
    throw new Error(`openclaw config merge failed: ${result.stderr || result.stdout}`);
  }
}
