import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  CUSTOM_FIELD_TARGETS,
  listCustomFields,
  saveCustomField,
  type CustomFieldTarget,
  type CustomFieldType,
  type CustomFieldRow,
} from "@/lib/crm-custom-fields-service";

/**
 * Business fields — the business's own extra questions, asked of a person, a
 * lead, a deal or a case.
 *
 * ## Why this is `crm.configure`
 *
 * A field definition is a structural decision, not a customer record: it
 * changes what every form in the app asks everybody, and archiving one stops a
 * question being asked at all (without destroying the answers already given).
 * Guarding reads at the same level keeps the rule single — this is a settings
 * endpoint, and the settings section is `crm.configure` — rather than a route
 * that needs `crm.configure` to write but only `crm.view` to read, which is how
 * a member ends up looking at a screen whose save button they cannot use.
 *
 * ## One field engine
 *
 * `saveCustomField` is the CRM's only custom-field writer. Typed values are
 * stored in typed shadow columns by `coerceCustomValue`, and a field's type is
 * frozen once values exist — see `docs/crm-architecture.md`. A second
 * "Business Fields" implementation would be a second place a type could change
 * under stored answers, which is the failure the first one exists to prevent.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const targets = search.get("target")
    ? [search.get("target") as CustomFieldTarget].filter((target) =>
        (CUSTOM_FIELD_TARGETS as readonly string[]).includes(target),
      )
    : [...CUSTOM_FIELD_TARGETS];

  const groups = await Promise.all(
    targets.map(async (target) => ({
      target,
      fields: await listCustomFields(session.businessId, target, {
        // The configurator is exactly the screen that must show archived
        // fields: it is where somebody checks what was archived last year.
        includeArchived: search.get("includeArchived") !== "0",
      }),
    })),
  );
  return NextResponse.json({ groups });
});

interface FieldBody {
  id?: string;
  target?: string;
  key?: string;
  label?: string;
  fieldType?: string;
  options?: unknown;
  isRequired?: boolean;
  helpText?: string;
  displayOrder?: number;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  let body: FieldBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.target || !(CUSTOM_FIELD_TARGETS as readonly string[]).includes(body.target)) {
    return NextResponse.json({ error: "custom_field_target_invalid" }, { status: 400 });
  }

  const result = await saveCustomField(
    session.businessId,
    {
      id: body.id,
      target: body.target as CustomFieldTarget,
      key: body.key,
      label: body.label ?? "",
      // The service validates the type; a wrong string here is a 400 from it,
      // not an invented one from a cast.
      fieldType: (body.fieldType ?? "text") as CustomFieldType,
      options: Array.isArray(body.options)
        ? body.options.filter((option): option is string => typeof option === "string")
        : undefined,
      isRequired: body.isRequired,
      helpText: body.helpText,
      displayOrder: body.displayOrder,
    },
    { name: session.fullName, userId: session.sub },
  );
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ field: result.field satisfies CustomFieldRow }, { status: body.id ? 200 : 201 });
});
