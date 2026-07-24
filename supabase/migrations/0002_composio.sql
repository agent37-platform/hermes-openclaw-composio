-- Bring-your-own-Composio additions.
--
-- proxy_token_hash: SHA-256 of the per-agent MCP proxy token. The raw token is written only into
-- the instance's agent config (never logged); the /api/composio-mcp route reverse-looks-up the
-- presented Bearer token by this hash on every tool call.
-- bootstrapped_at: set when post-create bootstrap (model provider + Composio MCP wiring + restart)
-- has completed. Null on a running agent means bootstrap is owed — the fleet GET re-kicks it.
-- composio_mcp_url: the proxy URL the agent is wired with (null = not wired, e.g. Composio creds
-- or the public URL were missing at bootstrap time). When it differs from the app's current
-- public URL (dev tunnels change every run), the fleet GET re-wires the agent.
-- bootstrap_claimed_at: a short lease so only one server instance bootstraps an agent at a time
-- (serverless deploys run many instances; in-memory single-flight isn't enough).
alter table public.agents add column if not exists proxy_token_hash text;
alter table public.agents add column if not exists bootstrapped_at timestamptz;
alter table public.agents add column if not exists composio_mcp_url text;
alter table public.agents add column if not exists bootstrap_claimed_at timestamptz;

create index if not exists agents_proxy_token_hash_idx on public.agents (proxy_token_hash);

-- Per-agent Composio tool-call metering, one row per (agent, tool, day). The MCP proxy increments
-- it on every billable tools/call it forwards — this is what "how much is each user using" reads.
create table if not exists public.composio_usage (
  agent37_id text not null references public.agents (agent37_id) on delete cascade,
  tool       text not null,
  day        date not null default current_date,
  calls      integer not null default 0,
  primary key (agent37_id, tool, day)
);

create index if not exists composio_usage_agent_idx on public.composio_usage (agent37_id, day);

-- Atomic increment for the proxy (an upsert from two concurrent calls must not lose a count).
create or replace function public.increment_composio_usage(p_agent37_id text, p_tool text, p_calls integer)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.composio_usage (agent37_id, tool, day, calls)
  values (p_agent37_id, p_tool, current_date, p_calls)
  on conflict (agent37_id, tool, day)
  do update set calls = composio_usage.calls + excluded.calls;
$$;

alter table public.composio_usage enable row level security;
grant all on public.composio_usage to service_role;
-- SECURITY DEFINER + Postgres's default EXECUTE-to-PUBLIC would let anon callers inflate the
-- meter through PostgREST /rpc — service_role only.
revoke execute on function public.increment_composio_usage(text, text, integer) from public, anon, authenticated;
grant execute on function public.increment_composio_usage(text, text, integer) to service_role;
