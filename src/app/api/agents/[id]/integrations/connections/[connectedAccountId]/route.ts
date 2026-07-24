import { deleteConnection } from "@/lib/composio";
import { requireAgentAccess } from "@/lib/auth";
import { ApiError, handleError, json } from "@/lib/http";

type Ctx = { params: Promise<{ id: string; connectedAccountId: string }> };

export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const { id, connectedAccountId } = await params;
    if (!connectedAccountId) {
      throw new ApiError(400, "invalid_request", "connectedAccountId is required");
    }

    // Disconnecting an integration is a destructive mutation — admin-only. Ownership of the
    // account to THIS agent's Composio user is enforced inside deleteConnection.
    await requireAgentAccess(id, "admin");

    return json(await deleteConnection(id, connectedAccountId));
  } catch (e) {
    return handleError(e);
  }
}
