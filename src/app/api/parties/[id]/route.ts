import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PartyValidationError, getParty, removeParty, updateParty } from "@/lib/parties-service";
import { parsePartyRequestBody } from "@/lib/parties";
import { projectPartyForRead } from "@/lib/party-read-projection";

/**
 * One party: the file a directory row opens, and the record a picker's
 * «افزودن» writes back into.
 *
 * Same contract as the collection route — flat fields at the root, one nested
 * object per tab — so a screen that can create a party can edit one without
 * learning a second shape. A tab the request does not mention is left alone; a tab
 * it sends as `{}` is cleared, which is the difference between "this client has no
 * address tab" and "the owner deleted the address" (see `updateParty`).
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesView);
    if (error) return error;

    const { id } = await params;
    const party = await getParty(session.businessId, id);
    if (!party) return NextResponse.json({ error: "party_not_found" }, { status: 404 });
    const [team, payroll, ledger] = await Promise.all([
      requirePermission(PERMISSIONS.teamManage),
      requirePermission(PERMISSIONS.payrollView),
      requirePermission(PERMISSIONS.ledgerView),
    ]);
    const projected = projectPartyForRead(party, {
      personnelSensitive: !team.error || !payroll.error,
      financial: !ledger.error,
    });
    return NextResponse.json({ party: projected, customer: projected });
  },
);

/**
 * The ledger-owned fields, refused without `ledger.view`.
 *
 * Checked on the *body*, not on a header or a scope the client declares: a form
 * sends the whole record back when it saves, so "it sent taxPercentage" is exactly
 * the question "is it trying to change the tax rate". A client that must round-trip
 * an unchanged value can omit the key — the service keeps what is stored, which is
 * what the party form does outside the Accounting app.
 *
 * Only the code, the rate and the bank tab are gated. The identity numbers are
 * the CRM's half of the record («who the person is»), so they stay writable with
 * `parties.manage` alone — gated identically on the collection route, or a create
 * could write what an edit refuses to change.
 */
function accountingFieldsIn(body: Record<string, unknown>): { field: string } | null {
  const blocked = ["accountingCode", "accountingCodeMode"];
  for (const key of blocked) {
    if (body[key] !== undefined) return { field: key };
  }
  const general = (body.general_info ?? body.generalInfo) as Record<string, unknown> | undefined;
  if (general && general.taxPercentage !== undefined) return { field: "general_info.taxPercentage" };
  if (body.financial_info !== undefined || body.financialInfo !== undefined) {
    return { field: "financial_info" };
  }
  return null;
}

export const PUT = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
    if (error) return error;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const accounting = accountingFieldsIn(body);
    if (accounting) {
      const { error: ledgerError } = await requirePermission(PERMISSIONS.ledgerView);
      if (ledgerError) {
        return NextResponse.json(
          { error: "accounting_fields_forbidden", fieldErrors: { [accounting.field]: "accounting_fields_forbidden" } },
          { status: 403 },
        );
      }
    }

    const { input, errors } = parsePartyRequestBody(body, { partial: true });
    if (Object.keys(errors).length > 0) {
      return NextResponse.json({ error: "validation_failed", fieldErrors: errors }, { status: 400 });
    }

    const { id } = await params;
    try {
      const party = await updateParty(session.businessId, id, input);
      if (!party) return NextResponse.json({ error: "party_not_found" }, { status: 404 });
      return NextResponse.json({ party, customer: party });
    } catch (err) {
      if (err instanceof PartyValidationError) {
        return NextResponse.json(
          { error: err.code, fieldErrors: err.field ? { [err.field]: err.code } : undefined },
          { status: 409 },
        );
      }
      throw err;
    }
  },
);

/**
 * Removes a party. Returns which happened: `deleted` (no history — the row is
 * gone) or `archived` (orders, AR receipts, loyalty points, a branch's supplier
 * alias, or a membership link — kept for the ledger's sake, hidden from the
 * pickers and the default listings). See `removeParty`'s doc comment.
 */
export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
    if (error) return error;

    const { id } = await params;
    const result = await removeParty(session.businessId, id);
    if (result === "not_found") return NextResponse.json({ error: "party_not_found" }, { status: 404 });
    return NextResponse.json({ result });
  },
);
