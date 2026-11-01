import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { organizationStructureFor } from "@/lib/crm-relationship-service";

/**
 * One client's organisation structure — «ساختار سازمانی» (issue #1128 §A).
 *
 * Which party is the group, which are its brands, and what each of them is
 * carrying. Read on `crm.view`, the same key the relationship graph beside it
 * uses, because this is a reading of that graph's own edges rather than new data:
 * nothing here is visible that `/relationships` does not already return.
 *
 * **Read-only, deliberately.** The edges are created and removed through
 * `/relationships`, which already gates writes on `crm.manage` and already audits
 * them. A second write path here would be a second place to get the audit and the
 * permission wrong, for no capability the CRM does not have.
 *
 * The structure arrives as a flat, depth-ordered list rather than a nested tree,
 * because every consumer draws it as an indented list and a nested payload would
 * only have to be flattened again. `parentId` and `childIds` are on each member
 * for anything that does want the shape.
 *
 * `isEmpty` is not an error and not a 404: a client that is not part of a group is
 * the common case, and the card renders nothing at all for it. A 404 here would
 * mean "this party is not yours", which is a different answer and is what
 * `organization === null` produces.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const { id } = await params;
    // A non-uuid id would otherwise reach a `uuid` column and raise
    // `invalid input syntax`, which is a 500 with a generic message for what is
    // simply a party that cannot exist.
    if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const organization = await organizationStructureFor(session.businessId, id);
    if (!organization) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({ organization });
  },
);
