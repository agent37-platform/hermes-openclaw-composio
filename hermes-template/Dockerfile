# The Hermes image for this kit: the clean Agent37 Hermes base plus one tiny plugin.
#
# Why not the stock `agent37-hermes` template? Its managed layer rewrites the
# `composio` MCP server in ~/.hermes/config.yaml on every boot to point at
# Agent37's managed Composio. This kit brings YOUR OWN Composio, so it builds on
# `hermes-base` — the clean target Agent37 publishes for exactly this purpose. It
# never touches your config, and Agent37's managed model still works (the app
# writes the provider block at agent creation; see src/lib/bootstrap.ts).
#
# The one addition is the `composio-environment` Hermes plugin: a prompt hook that
# routes "connect to Gmail"-type requests to your Composio MCP tools instead of the
# bundled email/google skills (which would otherwise win the intent match and walk
# users through app passwords).
#
# Build it with `npm run templates:publish` — an Agent37 cloud build, no local
# Docker needed. Pin note: this tag is the current hermes-base release; newer tags
# are listed at https://www.agent37.com/docs/agents-api/templates#build-on-the-hermes-base-image
FROM ghcr.io/agent37-platform/hermes-base:2026.07.16a

USER root

COPY plugin /usr/local/lib/hermes/plugins/composio-environment
RUN uv pip install --python /usr/local/lib/hermes/hermes-agent/venv/bin/python \
    /usr/local/lib/hermes/plugins/composio-environment

USER node
