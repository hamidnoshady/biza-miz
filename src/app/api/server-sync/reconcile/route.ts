import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requireRole } from "@/lib/auth";
import { reconcileDeferredSyncEvents } from "@/lib/sync-events";
import {
  runOperationalSyncGate,
  runServerPull,
  runServerPush,
  updateSyncDeadLetter,
} from "@/lib/server-sync";
import { runMasterSync } from "@/lib/master-sync-transport";
import { resolveMasterConflict } from "@/lib/master-sync-service";
import { runSiteProfileSync } from "@/lib/site-profile-service";

/** Owner-only operational controls; event payloads and credentials never leave the server. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;
  let body: {
    action?:
      | "retry-deferred"
      | "retry-dead-letter"
      | "discard-dead-letter"
      | "resolve-master-conflict"
      | "sync-now";
    id?: number;
    note?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  /*
   * Issue #1115 F1/F3 — the only owner control that actually moves data.
   * The security gate runs first, exactly as the 30 s tick does, so a click can
   * never bypass a revocation; everything after it is the same master → push →
   * pull order, run once, with its outcome returned instead of a blanket
   * «انجام شد». A blocked gate answers 409 and names the step.
   */
  if (body.action === "sync-now") {
    const gate = await runOperationalSyncGate(session.businessId);
    if (!gate.ready) {
      return NextResponse.json(
        { error: `sync_blocked: ${gate.reason}`, blocked: gate.reason },
        { status: 409 },
      );
    }
    /*
     * The branch profile first, as the tick does: it carries the tax rate,
     * pricing policy, order controls and the print behavior the cloud owns, and
     * the bills pulled below land on the cloud's business day. Forced, because
     * the operator asked now and the tick's 30-second gate is not an answer.
     */
    const profile = await runSiteProfileSync(session.businessId, new Date(), { force: true });
    const master = await runMasterSync(session.businessId).catch((error) => ({
      status: "error" as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    const push = await runServerPush(session.businessId);
    const pull = await runServerPull(session.businessId);
    return NextResponse.json({ ok: true, profile, master, push, pull });
  }
  if (body.action === "retry-deferred") {
    return NextResponse.json({ ok: true, reconciliation: await reconcileDeferredSyncEvents(session.businessId, 200) });
  }
  if (body.action === "resolve-master-conflict") {
    // Issue #1446: a master-data conflict that exhausted its bounded retries is
    // quarantined and visible, never silently skipped. This acknowledges it
    // after the operator has reconciled the data — it never merges parties or
    // rewrites either side's rows.
    if (!Number.isSafeInteger(body.id) || Number(body.id) < 1) {
      return NextResponse.json({ error: "invalid_conflict" }, { status: 400 });
    }
    const resolved = await resolveMasterConflict(
      session.businessId,
      Number(body.id),
      session.sub,
      typeof body.note === "string" ? body.note : null,
    );
    if (!resolved) return NextResponse.json({ error: "conflict_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
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
