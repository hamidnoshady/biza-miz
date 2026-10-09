import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { createAccount, listAccounts, AccountsError } from "@/lib/accounts-service";
import { isUuid } from "@/lib/uuid";

/**
 * Query-boolean helper: returns true only for an explicit `?key=1`.
 *
 * Any other value — `?key=0`, `?key=false`, `?key=anything`, or absent — is
 * treated as false. Without this, the GET route previously exposed archived
 * accounts for every non-empty `all` parameter (issue #824 §11), because
 * JavaScript treats any non-empty string as truthy.
 */
function isQueryTruthy(value: string | null): boolean {
  return value === "1";
}

/**
 * GET without ?all=1 returns the active chart, for populating account pickers
 * (manual entries, …). ?all=1 returns every account, active or archived, with
 * the management metadata flags (postings / draft-postings / children) the
 * management UI needs to decide what's safe to archive or delete.
 *
 * ?all=0 (or any other value) behaves the same as omitting the parameter — it
 * returns active accounts only. This is explicit so a typo cannot leak
 * archived accounts into a picker.
 *
 * Picker rows carry `parent_id`, `has_children` and `is_postable`, all decided
 * by the server over the whole chart (issue #832 §2 and the approval path in
 * `manual-journal-service.ts`), so the client never re-derives them.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const all = isQueryTruthy(searchParams.get("all"));

  if (all) {
    const accounts = await listAccounts(session.businessId, { all: true });
    return NextResponse.json({ accounts });
  }

  /*
   * `is_postable` is decided by the server, over the *whole* chart, and
   * handed to the client — because the client used to guess.
   *
   * The picker derived "leaf" itself: from the active accounts this endpoint
   * returned, the leaves were the codes nothing else named as a parent. But
   * the postability check in `manual-journal-service.ts` asks whether the
   * account has *any* child, including an archived one. An account whose only
   * child had been archived therefore looked selectable (it is not a parent in
   * the active-only subset) and was refused at approval time with
   * `not_a_leaf_account` — a draft that cannot be approved, discovered by the
   * person trying to approve it rather than by the person typing it.
   *
   * `has_children` is the same query's own answer, so the picker and the
   * approval path can no longer disagree, and the client stops re-deriving an
   * invariant it does not have the data for.
   *
   * `a.parent_id` rides along for the same reason: the Expenses screen decides
   * «is this a cash account?» by walking the parent chain, which it can only do
   * with the edge itself and not with the parent's code (issue #832 §2).
   */
  const { rows } = await query(
    `SELECT a.id, a.code, a.name, a.type, a.parent_id, p.code AS parent_code,
            EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id) AS has_children,
            NOT EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id) AS is_postable
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.business_id = $1 AND a.is_active ORDER BY a.code`,
    [session.businessId],
  );
  return NextResponse.json({ accounts: rows });
});

/** Adds an account (optionally a sub-account) to the chart. Gated on accounts.edit. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  let body: { code?: unknown; name?: unknown; type?: unknown; parentId?: unknown; isContra?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (typeof body.code !== "string" || typeof body.name !== "string" || typeof body.type !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.parentId !== undefined && body.parentId !== null && !isUuid(body.parentId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Issue #824 §10: `isContra` must be a real boolean when present. The old
  // code did `Boolean(body.isContra)` which turned the string "false" into
  // true — every non-empty, non-null, non-zero/non-false-but-actually-truthy
  // value silently became a contra account.
  if (body.isContra !== undefined && typeof body.isContra !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const parentId = body.parentId === undefined ? null : (body.parentId as string | null);

  try {
    const result = await createAccount({
      businessId: session.businessId,
      code: body.code,
      name: body.name,
      type: body.type,
      parentId,
      isContra: body.isContra === undefined ? undefined : (body.isContra as boolean),
      actorId: session.sub,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof AccountsError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
