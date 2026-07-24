#!/usr/bin/env node
// `npm run dev` — Next.js dev plus the one thing localhost can't do by itself: agents run in
// Agent37's cloud and reach this app's Composio MCP proxy over the public internet, so when
// COMPOSIO_API_KEY is set and no public URL is configured, this starts a free cloudflared quick
// tunnel and hands its URL to the app as NEXT_PUBLIC_SITE_URL. Agents wired to an older tunnel
// URL re-wire themselves on the next dashboard poll (src/lib/bootstrap.ts tracks the URL).
//
// No cloudflared? The app still runs — dashboard, chat, files, the Integrations tab all work;
// only agent-side tool calls wait until you install it (`brew install cloudflared`) or deploy.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = process.env.PORT || "3000";

function envLocal(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(path.join(root, ".env.local"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith(`${name}=`))
      .pop();
    return line ? line.slice(name.length + 1).trim() : "";
  } catch {
    return "";
  }
}

function isPublicUrl(url) {
  return /^https?:\/\//.test(url) && !url.includes("localhost") && !url.includes("127.0.0.1");
}

async function startTunnel() {
  const probe = spawnSync("cloudflared", ["--version"], { stdio: "ignore" });
  if (probe.error) {
    console.log(
      "\n! cloudflared not found — agent tool calls need this app on a public URL.\n" +
        "  Install it (`brew install cloudflared`) and rerun, set NEXT_PUBLIC_SITE_URL to a\n" +
        "  deployed/tunnel URL yourself, or just deploy. Everything else works without it.\n"
    );
    return null;
  }

  const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const url = await new Promise((resolve) => {
    let buffer = "";
    const timeout = setTimeout(() => resolve(null), 30_000);
    tunnel.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });
    tunnel.on("exit", () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
  if (!url) {
    console.log("\n! Tunnel did not come up; continuing without one (agent tool calls disabled).\n");
    try {
      tunnel.kill();
    } catch {}
    return null;
  }
  return { tunnel, url };
}

const composio = envLocal("COMPOSIO_API_KEY");
const configured = envLocal("NEXT_PUBLIC_SITE_URL");
let siteUrl = isPublicUrl(configured) ? configured : "";
let tunnel = null;

if (composio && !siteUrl) {
  const started = await startTunnel();
  if (started) {
    tunnel = started.tunnel;
    siteUrl = started.url;
    console.log(`\n→ Agent tool calls reach this app at ${siteUrl} (auto-tunnel; changes each run — agents re-wire themselves)\n`);
  }
} else if (composio && siteUrl) {
  console.log(`\n→ Agent tool calls reach this app at ${siteUrl} (NEXT_PUBLIC_SITE_URL)\n`);
} else if (!composio) {
  console.log("\n! COMPOSIO_API_KEY is not set — integrations are disabled (see .env.example).\n");
}

const next = spawn("npx", ["next", "dev", "--port", port], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ...(siteUrl ? { NEXT_PUBLIC_SITE_URL: siteUrl } : {}) },
});

function shutdown() {
  try {
    tunnel?.kill();
  } catch {}
  try {
    next.kill("SIGTERM");
  } catch {}
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
next.on("exit", (code) => {
  try {
    tunnel?.kill();
  } catch {}
  process.exit(code ?? 0);
});
