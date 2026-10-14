import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getDraft, ManualJournalError, rejectDraft } from "@/lib/manual-journal-service";
import { isDraftAuthor } from "@/lib/manual-journal";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  const draft = await getDraft(session.businessId, id);
  if (!draft) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });
  return NextResponse.json({ draft });
});

/**
 * Discards a draft before it's ever posted.
 *
 * The gate is *not* `ledger.propose`, which is what it used to be — and which
 * was wrong in two directions:
 *
 *  - An approve-only role (custom, or an owner who revoked `ledger.propose`
 *    from an accountant) could see the draft, was the person the workflow
 *    exists to let decide, and was answered 403 by the reject button.
 *  - The drafter could not withdraw their own draft after losing
 *    `ledger.propose`, even though the documented rule is that a draft's
 *    author may always take it back.
 *
 * So: authenticate, load the draft, then allow it if the caller *is* the
 * drafter or holds `ledger.approve`. Both of those are the authorisations the
 * workflow actually means; the role list was a proxy for them that stopped
 * matching.
 *
 * The discard is recorded (`?reason=` optional), exactly like
 * `POST …/reject` — a draft that disappears from the queue with no row
 * anywhere saying who removed it is the audit gap issue #823 exists to close,
 * and it should not be reachable through whichever of the two endpoints a
 * client happened to call. `POST …/reject` is the reviewer's action and
 * therefore the one that *requires* the reason.
 */
export const DELETE = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  const draft = await getDraft(session.businessId, id);
  if (!draft) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });

  // Authorship decided by the shared rule, so this route, the reject route and
  // the review screen cannot disagree about who is looking at this draft.
  const isAuthor = isDraftAuthor({ actorId: session.sub, draftAuthorId: draft.createdBy });
  if (!isAuthor) {
    const approve = await requirePermission(PERMISSIONS.ledgerApprove);
    if (approve.error) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const reason = new URL(request.url).searchParams.get("reason");

  try {
    await rejectDraft({
      businessId: session.businessId,
      draftId: id,
      actorId: session.sub,
      reason,
      // No reason is a legitimate withdrawal of one's own draft; a reviewer
      // discarding somebody else's has to explain it, which is what the
      // dedicated reject endpoint enforces.
      requireReason: !isAuthor,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ManualJournalError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
