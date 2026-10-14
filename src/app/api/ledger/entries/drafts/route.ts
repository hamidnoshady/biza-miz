import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createDraft,
  listDrafts,
  ManualJournalError,
  MANUAL_DRAFTS_PAGE_SIZE,
} from "@/lib/manual-journal-service";
import { parseManualDraftPayload } from "@/lib/manual-journal";

/**
 * The review queue: one page of pending drafts, newest first.
 *
 * Bounded (`?limit`, `?offset`, capped at `MANUAL_DRAFTS_PAGE_SIZE`) because
 * the queue is business-wide and open-ended — a business that has been
 * drafting journals for a year has a thousand of them, and the screen used to
 * load and render all of them at once. `total` is the real count, not a
 * "there may be more" flag, because the heading says «N سند».
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit"));
  const offset = Number(params.get("offset"));
  const [page, location] = await Promise.all([
    listDrafts(session.businessId, {
      limit: Number.isSafeInteger(limit) && limit > 0 ? limit : MANUAL_DRAFTS_PAGE_SIZE,
      offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
    }),
    // Which branch a draft created from this screen will post to. The queue is
    // business-wide, so without it the form cannot say — and a reviewer
    // approving a branch's document has no way to see whose books it lands in.
    resolveActiveLocation(session),
  ]);
  return NextResponse.json({
    ...page,
    activeLocation: location ? { id: location.id, name: location.name } : null,
  });
});

/**
 * Drafts a manual journal entry — same access as today's posting surface,
 * but this no longer takes effect on the ledger by itself. Posting it for
 * real requires review: see /api/ledger/entries/drafts/[id]/approve, gated
 * on ledger.approve rather than this role list.
 *
 * The body goes through `parseManualDraftPayload` — one strict, pure parser —
 * rather than being mapped with `String(...)`/`Number(...) || 0` at the
 * boundary. See that function for what the coercions used to swallow; what
 * matters here is that malformed input is now answered with a 400 naming the
 * field, and that an oversized line array is refused before a single row of it
 * is mapped.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parsed = parseManualDraftPayload(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.problem }, { status: 400 });

  const location = await resolveActiveLocation(session);

  try {
    const { id, duplicate } = await createDraft({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      entryDate: parsed.value.entryDate,
      memo: parsed.value.memo,
      lines: parsed.value.lines,
      createdBy: session.sub,
      idempotencyKey: parsed.value.idempotencyKey,
    });
    // A retry that hit the idempotency key is still a success — the draft the
    // caller asked for exists — but it is not a *new* resource, so it answers
    // 200 with `duplicate: true` rather than 201. Otherwise a client that
    // retries on a timeout would file what it believes are two documents.
    return NextResponse.json({ draft: { id }, duplicate }, { status: duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof ManualJournalError)
      return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
