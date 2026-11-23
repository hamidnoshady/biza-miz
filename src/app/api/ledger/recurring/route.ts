import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createRecurringTemplate,
  listRecurringLocations,
  listRecurringTemplates,
  RecurringVoucherError,
  type RecurringTemplateStatus,
} from "@/lib/recurring-voucher-service";
import { parseRecurringTemplateBody } from "@/lib/recurring-voucher-input";

/**
 * The recurring-voucher register.
 *
 * Reading is `ledger.view` — the same door every other ledger read uses, so an
 * auditor can see what the business has scheduled. Writing a template is
 * `ledger.propose`: a template proposes documents, it does not post them, and
 * the approval capability (`ledger.approve`) still decides whether any of its
 * drafts reaches the ledger.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const status = request.nextUrl.searchParams.get("status");
  const [templates, location, locations] = await Promise.all([
    listRecurringTemplates(session.businessId, {
      status: (status as RecurringTemplateStatus | null) || null,
    }),
    resolveActiveLocation(session),
    listRecurringLocations(session.businessId),
  ]);
  return NextResponse.json({
    templates,
    locations,
    activeLocation: location ? { id: location.id, name: location.name } : null,
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseRecurringTemplateBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.problem }, { status: 400 });

  // A new template belongs to the member's active branch unless the form named
  // another. `createRecurringTemplate` re-checks that the branch is this
  // business's, so a foreign id is a refusal rather than a write.
  const location = parsed.value.locationId ? null : await resolveActiveLocation(session);

  try {
    const { id } = await createRecurringTemplate({
      businessId: session.businessId,
      actorId: session.sub,
      input: {
        ...parsed.value,
        locationId: parsed.value.locationId ?? location?.id ?? null,
        ownerUserId: parsed.value.ownerUserId ?? session.sub,
      },
    });
    return NextResponse.json({ template: { id } }, { status: 201 });
  } catch (err) {
    if (err instanceof RecurringVoucherError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
