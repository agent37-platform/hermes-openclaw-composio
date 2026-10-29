# AGENTS.md

Guidance for AI coding agents (and humans) working in **hermes-openclaw-composio** — the
bring-your-own-Composio agent app on Agent37. `CLAUDE.md` imports this file via `@AGENTS.md`,
so this is the single source of truth — edit here, not there.

## First-time setup

Setting this up from a fresh clone? Follow **[`SETUP.md`](SETUP.md)** — the complete runbook
(it's what the README tells adopters to hand you). Three login-gated secrets are human-supplied:
`AGENT37_API_KEY` (plus a **funded** Agent37 wallet), `COMPOSIO_API_KEY`, and
`SUPABASE_ACCESS_TOKEN`; `npm run setup` + `npm run templates:publish` do the rest. Never print
or commit any of them.

## What this project is

A full-stack agent app built on the public **[Agent37](https://www.agent37.com) B2B Agents
API**, where every integration runs on **the operator's own Composio project** instead of
Agent37's managed Composio: email + password auth (open signup, no verification), a multi-agent
fleet, and — for each agent — native in-dashboard **Chat**, a **Files** browser,
**Integrations** (your Composio: browse, OAuth connect, per-agent usage metering), and a
**Settings** tab. Forkers rebrand it (`src/config/branding.ts`) and ship it.

It is the sibling of the [Agent37 Starter Kit](https://github.com/agent37-platform/starter-kit)
(which uses Agent37's managed Composio). The differences are exactly the bring-your-own pieces:

1. **Templates on the clean bases.** Agents run on two workspace templates this repo publishes
   (`scripts/templates.mjs`): `hermes-composio` (cloud-built from `hermes-template/` — Agent37's
   `hermes-base` plus a prompt plugin that steers SaaS intents to the Composio tools) and
   `openclaw-composio` (registered straight from `openclaw-base`). The stock system templates
   are NOT usable here: their managed layer rewrites the Composio MCP server in the agent's
   config at every boot, which would fight this kit's wiring.
2. **Post-create bootstrap** (`src/lib/bootstrap.ts`). The clean bases inject nothing at boot,
   so after create the app writes the agent's config over `/v1` exec: Agent37's managed model
   (from the starter credentials in the instance env — chat works with zero model setup) plus
   an `apps` MCP server pointing at this app's `/api/composio-mcp` with a per-agent token; then
   restarts the instance. Because the starter credential rotates on every container recreate,
   bootstrap also installs a provider-refresh script chained into the base image's
   `~/.agent37/hooks/post-restart.sh`, which re-reads the current env at every boot (the kit's
   own `cpx_` token never rotates, so the `apps` block stays static). Config + hook live on the
   persistent volume — one bootstrap survives restarts, image updates, and resizes. Runs in the
   background; the fleet GET overlays "starting" until `bootstrapped_at` lands and re-kicks
   bootstrap when it's owed (server died mid-run, or Composio creds appeared later).
3. **The Composio MCP transport proxy** (`src/app/api/composio-mcp/route.ts`). The ONLY place
   agent tool traffic meets `COMPOSIO_API_KEY`: per-agent Bearer token → agent lookup →
   Composio tool-router session scoped to `agent:{id}` (server-derived — agents can't reach
   each other's connected accounts) → stream MCP through verbatim, metering billable
   `tools/call`s into `composio_usage` (per agent, per tool, per day).
4. **Integrations BFF on your project** (`src/lib/composio.ts`). Toolkit catalog, OAuth
   connect (`toolRouter.create` + `authorize`), connections list/delete (ownership enforced
   app-side), and the usage endpoint — all direct Composio SDK/REST calls with your key.
   Toolkits without Composio-managed auth return 422 `custom_auth_required`: the fix is an
   auth config in YOUR Composio dashboard, then retry.

Everything else this app does is a **subset of the Agent37 `/v1` API** — control plane *and*
data plane. This repo is a *client* of that API; **the API docs, not this code, are the
authority on what an agent can and cannot do.**

## The API this is built on — read the docs first

- **<https://www.agent37.com/docs/llms.txt>** — concise index of every doc page. *Start here.*
- **<https://www.agent37.com/docs/llms-full.txt>** — the entire documentation in one file.
- Human-browsable docs: **<https://www.agent37.com/docs>** (append `.md` for raw markdown).

Key pages: [Core concepts](https://www.agent37.com/docs/agents-api/concepts),
[Instances](https://www.agent37.com/docs/agents-api/instances),
[Templates](https://www.agent37.com/docs/agents-api/templates) (incl. building on the base
images), [Run commands](https://www.agent37.com/docs/agents-api/exec) (bootstrap rides this),
[Instance URLs](https://www.agent37.com/docs/agents-api/urls),
[Budgets](https://www.agent37.com/docs/agents-api/budgets),
[Chat](https://www.agent37.com/docs/agents-api/chat) /
[Streaming](https://www.agent37.com/docs/agents-api/streaming) /
[Sessions](https://www.agent37.com/docs/agents-api/sessions) /
[Files](https://www.agent37.com/docs/agents-api/files) (the data plane behind the Chat and
Files tabs), [Errors](https://www.agent37.com/docs/agents-api/errors).

For Composio surfaces (tool router, connected accounts, auth configs), the authority is
**<https://docs.composio.dev>** — the SDK in use is `@composio/core`.

## How this app fits together

```
Browser ─▶ Next.js (this app) ─▶ control plane  https://api.agent37.com/v1        (instances)
   │            │              └▶ sandbox        https://sandbox.agent37.app/v1     (exec)
   │            │              └▶ data plane     https://{instance}.agent37.app/v1  (chat, files)
   │            │              └▶ Composio       https://backend.composio.dev       (YOUR key: catalog,
   │            │                                                                    connect, sessions)
   │            └─▶ Supabase: Auth (browser, anon key) + Postgres (server-only, service-role key):
   │                          users, workspaces, members, agent mirror, composio_usage
   │
agent instance ─▶ https://your-app/api/composio-mcp   (per-agent token; the MCP transport proxy
                                                       forwards to the agent's Composio session)
```

- **One `sk_live_` key, many app workspaces**, server-side only; agents tagged
  `metadata.app_workspace`, mirrored in Supabase.
- **One `COMPOSIO_API_KEY`, one Composio user per agent** (`agent:{agent37_id}`), server-side
  only; instances hold only the revocable `cpx_` proxy token.
- **Isolation is enforced in the server (BFF), not the browser.** Clients have no direct table
  access; the TypeScript checks in `src/lib/auth.ts` are the authorization boundary (RLS stays
  on as a dormant backstop).
- **Naming:** the upstream API calls these resources **instances**; this app brands them
  **agents**. Paths stay `/instances`; the client methods read `agent…`.

## Where things live

| Path | What |
|---|---|
| `src/lib/agent37.ts` | The Agent37 `/v1` client — the single egress to both planes (incl. `exec`) |
| `src/lib/composio.ts` | The Composio egress: catalog, connect, connections, MCP sessions, metering parse |
| `src/lib/bootstrap.ts` | Post-create instance config (managed model + Composio MCP) over exec |
| `src/lib/proxy-token.ts` | Per-agent `cpx_` token mint + SHA-256 hash |
| `src/app/api/composio-mcp/route.ts` | The MCP transport proxy (token auth, session cache, streaming, metering) |
| `src/app/api/agents/[id]/integrations/**` | Integrations BFF: toolkits / connect / connections / usage |
| `src/app/api/agents/[id]/{chat,files}/**` | Data-plane BFF: native Chat + Files proxied to the instance |
| `hermes-template/` | The Hermes image: `FROM hermes-base` + the `composio-environment` steering plugin |
| `scripts/templates.mjs` | Publishes both workspace templates (`npm run templates:publish`) |
| `src/config/agents.ts` | `TEMPLATE_NAMES`, `AGENT_TYPES`, shapes, `SERVICE_PORTS`, `PORT_LABELS` |
| `src/config/branding.ts` | `appName` / `logoUrl` code constants |
| `supabase/migrations/` | `0001_init.sql` (schema, dormant RLS, RPCs) + `0002_composio.sql` (tokens, metering) |
| `scripts/setup.mjs` | One-command Supabase setup (`npm run setup`) |

## Commands

```bash
npm install
npm run setup               # configure Supabase end-to-end (idempotent)
npm run templates:publish   # register/refresh the two agent templates (cloud build, no Docker)
npm run dev                 # http://localhost:3000
npm run build
npm run typecheck           # tsc --noEmit
```

There is no test suite; the gate before shipping is a clean `npm run typecheck` and
`npm run build`. Remember the deployment nuance from SETUP.md: agent tool calls need
`NEXT_PUBLIC_SITE_URL` on a publicly reachable URL (the instance calls back into this app).

## House rules

- **The API is the final authority.** Shapes, disks, templates, budgets — the `/v1` API can
  reject anything your account's tier disallows, regardless of what `src/config` lists.
- **Never expose `AGENT37_API_KEY`, `COMPOSIO_API_KEY`, or the service-role key to the
  browser** — all egress goes through `src/app/api/**`.
- **Don't point agents at the stock system templates** (`agent37-hermes` / `agent37-openclaw`):
  their boot script overwrites the Composio MCP config with Agent37's managed proxy on every
  restart. The kit's templates exist precisely to avoid that.
- **The `apps` MCP server name is deliberate** — Agent37's managed images own the `composio`
  key (and the clean OpenClaw base deletes it at every boot); `apps` is never touched.
- **Payments are intentionally excluded.** The create route has a commented `canCreateAgent()`
  seam where an entitlement gate would go; `composio_usage` is the metering you'd bill from.
- Keep changes small and focused; don't add unrequested features or touch unrelated code.
