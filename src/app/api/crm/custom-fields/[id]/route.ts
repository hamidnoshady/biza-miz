import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { archiveCustomField } from "@/lib/crm-custom-fields-service";

/**
 * Archive a business field.
 *
 * `DELETE` means **archive**, and the name is deliberate: the row and every
 * answer stored against it survive, because an answer somebody typed is still a
 * fact after the question stops being asked. `customValuesFor` keeps returning
 * archived fields' values on purpose. A hard delete here would silently empty
 * a column of the business's own data, which is why there is no hard delete.
 */
export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
    if (error) return error;

    const { id } = await params;
    const archived = await archiveCustomField(session.businessId, id, {
      name: session.fullName,
      userId: session.sub,
    });
    if (!archived) return NextResponse.json({ error: "custom_field_not_found" }, { status: 404 });
    return NextResponse.json({ result: "archived" });
  },
);
