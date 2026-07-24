import { agent37 } from "@/lib/agent37";
import { requireAgentAccess } from "@/lib/auth";
import { SERVICE_PORTS, runtimeForTemplate } from "@/config/agents";
import { ApiError, handleError, json, readJson } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { row } = await requireAgentAccess(id, "member");

    const { port, ttl_seconds } = await readJson<{ port?: number; ttl_seconds?: number }>(request);
    if (!port) throw new ApiError(400, "invalid_request", "port is required");

    // A member must not open an arbitrary internal port. Instances on workspace templates report
    // no live service ports, so the openable set is the runtime's known service ports plus
    // whatever the live instance does report.
    const runtime = runtimeForTemplate(row.template);
    const allowed = new Set<number>(runtime ? SERVICE_PORTS[runtime] : []);
    if (!allowed.has(port)) {
      const inst = await agent37.getAgent(id);
      if (!inst.ports.some((p) => p.port === port)) {
        throw new ApiError(400, "invalid_request", "port is not openable");
      }
    }

    const result = await agent37.signedUrl(id, port, ttl_seconds);
    return json(result);
  } catch (e) {
    return handleError(e);
  }
}
