export interface Shape {
  label: string;
  cpu: number;
  memory: number;
  diskMin: number;
  diskMax: number;
}

// Workspace (custom) templates take the standard shapes; the 1 vCPU small shape is reserved for
// Agent37's own lean system template, so it is not offered here.
export const SHAPE_PRESETS: Shape[] = [
  { label: "Standard · 2 vCPU / 4 GB", cpu: 2, memory: 4, diskMin: 6, diskMax: 20 },
  { label: "Pro · 4 vCPU / 8 GB", cpu: 4, memory: 8, diskMin: 20, diskMax: 40 },
  { label: "Max · 8 vCPU / 16 GB", cpu: 8, memory: 16, diskMin: 40, diskMax: 80 },
];

// The two workspace templates this kit publishes with `npm run templates:publish` (see
// scripts/templates.mjs — the names there must match these). They build on Agent37's CLEAN base
// images, so nothing rewrites the agent's config at boot and the bring-your-own-Composio wiring
// (src/lib/bootstrap.ts) sticks. Rename freely, but publish before creating agents.
export const TEMPLATE_NAMES = {
  hermes: "hermes-composio",
  openclaw: "openclaw-composio",
} as const;

export type AgentRuntime = "hermes" | "openclaw";

export const DEFAULT_AGENT = {
  template: TEMPLATE_NAMES.hermes,
  cpu: 2,
  memory: 4,
  disk: 6,
  monthlyCapUsd: 5,
} as const;

export interface AgentTypeOption {
  id: string;
  template: string;
  runtime: AgentRuntime;
  label: string;
  description: string;
  recommended?: boolean;
}

// The agent types offered on the create screen. Both run on YOUR Composio (each agent gets its
// own isolated Composio user; accounts connect via the Integrations tab or in chat).
export const AGENT_TYPES: AgentTypeOption[] = [
  {
    id: "hermes",
    template: TEMPLATE_NAMES.hermes,
    runtime: "hermes",
    label: "Hermes",
    description: "General agent: chat, browsing, code, files.",
    recommended: true,
  },
  {
    id: "openclaw",
    template: TEMPLATE_NAMES.openclaw,
    runtime: "openclaw",
    label: "OpenClaw",
    description: "General agent: headless browser, code, files.",
  },
];

export const AGENT_TEMPLATES = AGENT_TYPES.map((a) => a.template);

export function runtimeForTemplate(template: string | null | undefined): AgentRuntime | undefined {
  return AGENT_TYPES.find((a) => a.template === template)?.runtime;
}

// Web-service ports both base images run. The live API reports `ports: []` for instances on
// workspace templates (only system templates carry a service-port list), so the fleet GET
// synthesizes these for the open-in-new-tab buttons; signed URLs work for any listening port.
export const SERVICE_PORTS: Record<AgentRuntime, number[]> = {
  hermes: [9119, 7681, 8080],
  openclaw: [18789, 7681, 8080],
};

// Labels for the "open in new tab" buttons. This only prettifies known port numbers; any
// unrecognized port falls back to "Port {n}".
export const PORT_LABELS: Record<number, string> = {
  9119: "Dashboard",
  7681: "Terminal",
  8080: "Files",
  18789: "OpenClaw",
};
