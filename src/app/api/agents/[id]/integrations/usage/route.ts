import { requireAgentAccess } from "@/lib/auth";
import { ApiError, handleError, json } from "@/lib/http";
import type { ComposioUsageRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

// Per-tool Composio call counts for this agent, metered by the MCP proxy — the "how much is each
// user using" read. Rolls up the last 30 days; the composio_usage table keeps the full per-day
// history for anything fancier (per-user billing, limits, exports).
export async function GET(_request: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const { db } = await requireAgentAccess(id, "member");

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data, error } = await db
      .from("composio_usage")
      .select("tool, day, calls")
      .eq("agent37_id", id)
      .gte("day", since)
      .order("day", { ascending: false });
    if (error) throw new ApiError(500, "db_error", error.message);

    const rows = (data ?? []) as ComposioUsageRow[];
    const byTool = new Map<string, number>();
    for (const row of rows) byTool.set(row.tool, (byTool.get(row.tool) ?? 0) + row.calls);

    return json({
      since,
      total: rows.reduce((n, r) => n + r.calls, 0),
      tools: [...byTool.entries()]
        .map(([tool, calls]) => ({ tool, calls }))
        .sort((a, b) => b.calls - a.calls),
    });
  } catch (e) {
    return handleError(e);
  }
}
