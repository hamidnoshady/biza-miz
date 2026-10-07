import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getDraft, rejectDraft, ManualJournalError } from "@/lib/manual-journal-service";
import { isDraftAuthor } from "@/lib/manual-journal";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Rejects a pending draft, recording who did it, when, and why.
 *
 * The review queue's «رد کردن» used to be a bare DELETE: the draft row
 * disappeared and nothing anywhere in the system said who removed it or on
 * what grounds. Six months later the only remaining evidence that a document
 * had ever been proposed was the proposer's memory.
 *
 * The reason is **required** when the caller is rejecting somebody else's
 * draft, and optional when they are withdrawing their own («اشتباه تایپ
 * کردم» is a complete explanation to oneself, and not one at all to a
 * colleague). `journal_entry_draft_rejections` (migration 0211) keeps the
 * decision after the draft row is gone.
 *
 * Authorisation is the same rule as DELETE on the draft: the caller is either
 * the drafter or holds `ledger.approve`. It is checked *after* the draft is
 * loaded rather than being a permission the route demands up front, for the
 * reason documented on that route.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { reason?: unknown } = {};
  try {
    const json = await request.json();
    if (json && typeof json === "object" && !Array.isArray(json)) body = json as typeof body;
  } catch {
    // No body is fine: the drafter withdrawing their own draft owes no reason.
  }

  const draft = await getDraft(session.businessId, id);
  if (!draft) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });

  const isAuthor = isDraftAuthor({ actorId: session.sub, draftAuthorId: draft.createdBy });
  if (!isAuthor) {
    const approve = await requirePermission(PERMISSIONS.ledgerApprove);
    if (approve.error) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await rejectDraft({
      businessId: session.businessId,
      draftId: id,
      actorId: session.sub,
      reason: typeof body.reason === "string" ? body.reason : null,
      // A reviewer owes the drafter an explanation; the drafter owes nobody one.
      requireReason: !isAuthor,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ManualJournalError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
