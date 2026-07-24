# Injected into every LLM call (pre_llm_call hook), mirroring the stock image's
# agent37-environment plugin. The Composio block is what routes "connect to gmail"
# to the MCP tools instead of the bundled himalaya/google-workspace skills — those
# skills otherwise win the intent match and walk the user through app passwords.
from __future__ import annotations

import os

_CONFIG_PATH = os.path.expanduser("~/.hermes/config.yaml")

_BASE_CONTEXT = """\
<composio-environment>\
"""

_COMPOSIO_CONTEXT = """
- Third-party app integrations (the `apps` MCP server, backed by Composio) are the ONLY
  supported path for general SaaS apps: Gmail, Google Calendar, Google Drive, Notion, GitHub,
  Linear, Jira, HubSpot, Salesforce, Airtable, and similar. Its tools are self-describing —
  discover them via that server's search tool; do not assume tool names.
    - To connect an app, start the connection flow with the manage-connections tool, show the
      returned OAuth link as a markdown link, and wait for the user to come back and confirm
      before checking connection status. Connections persist for this instance — reuse them.
    - NEVER route these apps through local skills or CLIs that ask the user for app passwords,
      API keys, or Google Cloud OAuth credentials (e.g. the himalaya or google-workspace skills).
      The connection flow is one click; manual credentials are never needed for a supported app.\
"""

_FOOTER = """
</composio-environment>"""


def _composio_configured() -> bool:
    # The app's bootstrap writes the `apps` MCP server (URL path /api/composio-mcp) into
    # config.yaml; without it there are no Composio tools to steer toward, so stay silent.
    try:
        with open(_CONFIG_PATH) as f:
            return "composio-mcp" in f.read()
    except OSError:
        return False


def _build_prompt_context() -> str:
    composio = _COMPOSIO_CONTEXT if _composio_configured() else ""
    return f"{_BASE_CONTEXT}{composio}{_FOOTER}"


PROMPT_CONTEXT = _build_prompt_context()


def inject_prompt_context(**kwargs):
    del kwargs
    return {"context": PROMPT_CONTEXT}
