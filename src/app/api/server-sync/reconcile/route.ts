import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireRole } from "@/lib/auth";
import { reconcileDeferredSyncEvents } from "@/lib/sync-events";
import { updateSyncDeadLetter } from "@/lib/server-sync";

/** Owner-only operational controls; event payloads and credentials never leave the server. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  let body: { action?: "retry-deferred" | "retry-dead-letter" | "discard-dead-letter"; id?: number; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.action === "retry-deferred") {
    return NextResponse.json({ ok: true, reconciliation: await reconcileDeferredSyncEvents(session.businessId, 200) });
  }
  if (body.action === "retry-dead-letter" || body.action === "discard-dead-letter") {
    if (!Number.isSafeInteger(body.id) || Number(body.id) < 1) {
      return NextResponse.json({ error: "invalid_dead_letter" }, { status: 400 });
    }
    const updated = await updateSyncDeadLetter(
      session.businessId,
      Number(body.id),
      body.action === "retry-dead-letter" ? "retry" : "discard",
      session.sub,
      typeof body.note === "string" ? body.note : null,
    );
    if (!updated) return NextResponse.json({ error: "dead_letter_not_found" }, { status: 404 });
    const reconciliation = body.action === "retry-dead-letter"
      ? await reconcileDeferredSyncEvents(session.businessId, 200)
      : null;
    return NextResponse.json({ ok: true, reconciliation });
  }
  return NextResponse.json({ error: "invalid_action" }, { status: 400 });
});
