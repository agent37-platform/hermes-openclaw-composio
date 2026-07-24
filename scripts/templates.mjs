#!/usr/bin/env node
// Publish the kit's two workspace templates to your Agent37 workspace — run once before creating
// agents (`npm run templates:publish`), and again whenever you change hermes-template/ or bump a
// base-image tag.
//
//   hermes-composio   — Agent37 cloud build of hermes-template/ (the clean Hermes base plus the
//                       composio-environment steering plugin). No local Docker needed; the build
//                       log streams here.
//   openclaw-composio — registered straight from Agent37's public clean OpenClaw base image
//                       (no build at all; Agent37 pins it by digest).
//
// Both build on the CLEAN base images on purpose: the stock agent37-hermes / agent37-openclaw
// templates rewrite the Composio MCP config at every boot to point at Agent37's managed Composio,
// which would fight this kit's bring-your-own wiring. Names must match TEMPLATE_NAMES in
// src/config/agents.ts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERMES_TEMPLATE = "hermes-composio";
const OPENCLAW_TEMPLATE = "openclaw-composio";
// The current clean OpenClaw base release. Newer tags: https://www.agent37.com/docs/agents-api/templates
const OPENCLAW_BASE_IMAGE = "ghcr.io/agent37-platform/openclaw-base:2026.07.16b";

const API = process.env.AGENT37_API_BASE || "https://api.agent37.com";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readEnvLocal(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(path.join(root, ".env.local"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith(`${name}=`))
      .pop();
    return line ? line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, "") : "";
  } catch {
    return "";
  }
}

const apiKey = readEnvLocal("AGENT37_API_KEY");
if (!apiKey || !apiKey.startsWith("sk_live_")) {
  console.error("AGENT37_API_KEY missing — set it in .env.local (dashboard → Cloud → API keys).");
  process.exit(1);
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API}/v1${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  return { status: res.status, data };
}

async function publishOpenclaw() {
  console.log(`\n→ ${OPENCLAW_TEMPLATE}: registering ${OPENCLAW_BASE_IMAGE}`);
  const existing = await api(`/templates/${OPENCLAW_TEMPLATE}`);
  if (existing.status === 200) {
    const res = await api(`/templates/${OPENCLAW_TEMPLATE}`, {
      method: "PATCH",
      body: JSON.stringify({ image_ref: OPENCLAW_BASE_IMAGE }),
    });
    if (res.status !== 200) throw new Error(`PATCH failed (${res.status}): ${JSON.stringify(res.data)}`);
    console.log(`  updated (revision ${res.data.revision ?? "?"})`);
  } else if (existing.status === 404) {
    const res = await api("/templates", {
      method: "POST",
      body: JSON.stringify({
        name: OPENCLAW_TEMPLATE,
        image_ref: OPENCLAW_BASE_IMAGE,
        description: "OpenClaw on the clean base — bring-your-own Composio",
      }),
    });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`create failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    console.log("  created");
  } else {
    throw new Error(`template check failed (${existing.status}): ${JSON.stringify(existing.data)}`);
  }
}

function publishHermes() {
  console.log(`\n→ ${HERMES_TEMPLATE}: cloud-building hermes-template/ (streams the build log; a few minutes)`);
  const result = spawnSync(
    "npx",
    ["--yes", "agent37", "templates", "build", path.join(root, "hermes-template"), "--name", HERMES_TEMPLATE],
    { stdio: "inherit", env: { ...process.env, AGENT37_API_KEY: apiKey } }
  );
  if (result.status !== 0) {
    throw new Error("hermes cloud build failed — see the log above");
  }
}

try {
  await publishOpenclaw();
  publishHermes();
  console.log(`\nDone. Both templates are published to your workspace — create agents away.`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exit(1);
}
