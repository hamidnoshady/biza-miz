import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/auth";
import {
  AUTOMATION_EVENT_KINDS,
  AUTOMATION_FIELDS,
  AUTOMATION_FIELD_LABELS,
  AUTOMATION_OPERATORS,
  automationErrorMessage,
  selectableAutomationActions,
  type AutomationInput,
} from "@/lib/ai-automations";
import { createAutomation, listAutomations } from "@/lib/ai-automations-service";

/**
 * Automations — the business's own WHEN/IF/THEN rules.
 *
 * A manager may list and create them; the GET also returns the selectable
 * fields, operators, event kinds and actions so the editor renders from the
 * live vocabulary rather than a hard-coded copy that could drift.
 */
export const GET = withTenantScope(async () => {
  const guard = await requirePermission(PERMISSIONS.aiAutomationsManage);
  if (guard.error) return guard.error;
  return NextResponse.json({
    automations: await listAutomations(guard.session.businessId),
    selectableFields: AUTOMATION_FIELDS.map((field) => ({ field, label: AUTOMATION_FIELD_LABELS[field] })),
    selectableOperators: AUTOMATION_OPERATORS,
    selectableEventKinds: AUTOMATION_EVENT_KINDS,
    selectableActions: selectableAutomationActions(),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiAutomationsManage);
  if (guard.error) return guard.error;

  let body: AutomationInput;
  try {
    body = (await request.json()) as AutomationInput;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Unattended writes are the owner's call, the same rule the coworker and the
  // autopilot money category follow: a manager may create an automation, but
  // only an owner may set one to apply without asking.
  if (body.approvalMode === "auto" && guard.session.role !== "owner") {
    return NextResponse.json({ error: "owner_required" }, { status: 403 });
  }

  const created = await createAutomation(guard.session.businessId, body, {
    userId: guard.session.sub,
    authorizedBy: guard.session.sub,
  });
  if (!created.ok) {
    return NextResponse.json(
      {
        error: created.errors[0],
        errors: created.errors,
        messages: created.errors.map(automationErrorMessage),
      },
      { status: 400 },
    );
  }
  return NextResponse.json({ automation: created.automation }, { status: 201 });
});
