# Hermes agent + OpenClaw with your own Composio

Run [Hermes agent](https://github.com/NousResearch/hermes-agent) and [OpenClaw](https://openclaw.ai) agents on [Agent37](https://www.agent37.com) Cloud using **your own Composio account** — your `COMPOSIO_API_KEY`, your Composio project, your users' connected accounts (Gmail, Slack, Notion, GitHub, 1,000+ apps via MCP). Nothing integration-related routes through Agent37's managed Composio.

It's a full app, not a snippet: auth, workspaces, chat, files, an integrations catalog with OAuth connect, and per-agent tool-call metering. Fork it, rebrand it, ship it.

## How it works

```
agent instance (Hermes or OpenClaw, on Agent37 Cloud)
  └─ MCP client: apps → https://your-app.com/api/composio-mcp   (per-agent token)
        └─ this app: token → agent → Composio tool-router session
             scoped to agent:{id} — isolated accounts per agent    (your COMPOSIO_API_KEY,
             tools/call metered per agent per day                   never leaves this server)
                └─ Composio → Gmail / Slack / Notion / …
```

- **Your key stays home.** The instance only ever holds a revocable per-agent proxy token; the Composio API key lives in this app's env.
- **Per-user isolation.** Each agent maps to its own Composio user (`agent:{id}`) — Composio binds account resolution server-side, so one user's Gmail can never surface in another's agent.
- **Per-user metering.** The MCP proxy counts every billable `tools/call` into Postgres (`composio_usage`), shown in the Integrations tab — the basis for your own limits or billing.
- **Agent37's managed model still works.** Agents chat on the managed LLM out of the box (billed per instance); only Composio is yours.
- **Clean base images.** The kit publishes two workspace templates built on Agent37's `hermes-base` / `openclaw-base` — the stock templates would rewrite the Composio wiring at every boot; these never do.

## Setup

**1. Get three keys** (each behind a login, so only you can fetch them):

- `AGENT37_API_KEY` — Agent37 dashboard → **Cloud → API keys**, then **fund the wallet** (Cloud → Billing).
- `COMPOSIO_API_KEY` — [platform.composio.dev](https://platform.composio.dev) → your project → API key.
- `SUPABASE_ACCESS_TOKEN` — [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens).

**2. Hand it to your coding agent.** Open this folder in Claude Code / Codex and paste:

```
Set this repo up and run it locally, end to end — follow SETUP.md. Ask me for the three
login-gated keys it needs, then do everything else and tell me the local URL.
```

It writes your keys, configures Supabase, publishes the two agent templates, and starts the app. Prefer to do it yourself? **[SETUP.md](SETUP.md)** has the command path and deploy steps too.

> **One deployment note:** agents reach your Composio through `https://your-app/api/composio-mcp`, so that URL must be public. Everything else works on localhost; for agent tool calls, deploy to Vercel first (or point `NEXT_PUBLIC_SITE_URL` at a tunnel). SETUP.md covers it.

## What's inside

| Piece | Where |
| --- | --- |
| Composio MCP transport proxy (token auth, session mint, streaming, metering) | `src/app/api/composio-mcp/route.ts` |
| Composio calls: toolkit catalog, OAuth connect, connections, sessions | `src/lib/composio.ts` |
| Post-create bootstrap: managed model + Composio wiring into the instance config | `src/lib/bootstrap.ts` |
| Hermes template: clean base + a plugin steering SaaS intents to your Composio tools | `hermes-template/` |
| Template publishing (Agent37 cloud build — no local Docker) | `scripts/templates.mjs` |
| Integrations UI: browse 1,000+ apps, OAuth connect, usage | `src/components/IntegrationsTab.tsx` |
| Per-agent metering schema | `supabase/migrations/0002_composio.sql` |

Based on the [Agent37 Starter Kit](https://github.com/agent37-platform/starter-kit) (managed-Composio variant) — same chat, files, and fleet experience. Licensed MIT.
