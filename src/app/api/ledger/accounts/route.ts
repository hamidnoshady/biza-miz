import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { createAccount, listAccounts, AccountsError } from "@/lib/accounts-service";

/**
 * GET without ?all returns the active chart, for populating account pickers
 * (manual entries, …) — unchanged from before this phase. ?all=1 returns
 * every account, active or archived, with the postings/children flags the
 * management UI needs to decide what's safe to archive or delete.
 *
 * `parent_id` travels with the picker rows because an account's *meaning* is
 * inherited: `src/lib/account-classification.ts` resolves a custom sub-account
 * through its parent, and the Expenses payment-source picker applies that rule in
 * the browser (issue #832 §2). A code alone would not be enough — and shipping
 * the same ids the server classifies is what makes the two lists unable to
 * disagree about what «پرداخت از» may offer.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const all = new URL(request.url).searchParams.get("all");
  if (all) {
    const accounts = await listAccounts(session.businessId);
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
            a.currency_code,
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

  let body: {
    code?: string;
    name?: string;
    type?: string;
    parentId?: string | null;
    isContra?: boolean;
    currencyCode?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await createAccount({
      businessId: session.businessId,
      code: String(body.code ?? ""),
      name: String(body.name ?? ""),
      type: String(body.type ?? ""),
      parentId: body.parentId ?? null,
      isContra: Boolean(body.isContra),
      // A foreign-currency financial account names its currency at creation
      // (issue #863); the service validates the shape and NULLs anything else.
      currencyCode: typeof body.currencyCode === "string" ? body.currencyCode : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof AccountsError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
