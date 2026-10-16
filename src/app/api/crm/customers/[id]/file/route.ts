import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getCustomerFile, listCustomerNotes } from "@/lib/crm-service";
import { partyReadAudienceForPermissions } from "@/lib/personnel-access";
import { isUuid } from "@/lib/uuid";

/**
 * The 360° customer file (Phase 36) — the record plus its aggregates.
 *
 * The aggregates here are computed with the *same* "completed orders only,
 * bucketed by business day" rule the segment compiler uses, which is why they
 * are one service call rather than a few counts assembled in the page: a file
 * that says «۱۲ خرید» while the «حداقل ۱۲ خرید» segment excludes the customer
 * is a bug nobody can debug from the UI.
 *
 * Notes ride along because the file always shows them; the timeline does not,
 * because it is paginated and filtered separately.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, membership, error } = await requirePermission(PERMISSIONS.partiesView);
    if (error) return error;

    /*
     * Issue #947 (TEAM-F01) — this route's gate is `parties.view`, the same one the
     * directory has, so it carries the same field projection: a member of staff who is
     * also a customer is one record, and the address and notes the directory withholds
     * for that row must not come back through the CRM's door.
     */
    const audience = partyReadAudienceForPermissions([...membership.permissions]);

    const { id } = await params;
    // A non-uuid id (a stray path segment, a bookmark to a since-changed
    // route) would otherwise reach `WHERE c.id = $2` against a `uuid` column
    // and raise `invalid input syntax for type uuid` — a 500 with the generic
    // «خطای غیرمنتظره» — for what is simply a customer that cannot exist.
    if (!isUuid(id)) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

    const file = await getCustomerFile(session.businessId, id, audience);
    if (!file) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });

    const notes = await listCustomerNotes(session.businessId, id);
    return NextResponse.json({ file, notes });
  },
);
