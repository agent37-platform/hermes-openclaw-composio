import "server-only";
import { createHash, randomBytes } from "node:crypto";

// The per-agent token that authenticates the instance's MCP client to /api/composio-mcp. The
// `cpx_` prefix makes a leaked value recognisable in a config file; hex keeps it YAML/JSON-safe.
export function mintProxyToken(): string {
  return `cpx_${randomBytes(24).toString("hex")}`;
}

// Plain SHA-256 (no pepper): deterministic so a presented token re-hashes to the stored value for
// a direct indexed lookup. The token is 192 bits of entropy — rainbow tables don't apply.
export function hashProxyToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
