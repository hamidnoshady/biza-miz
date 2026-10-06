import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  automationCounts,
  listAutomationRuns,
  listAutomations,
  saveAutomation,
  type SaveAutomationInput,
} from "@/lib/crm-automation-service";
import type { CrmAutomationConditionValue } from "@/lib/crm-automation-rules";
import { isUuid } from "@/lib/uuid";

/**
 * The CRM's automations — «وقتی → اگر → آنگاه».
 *
 * ## Who may write one
 *
 * `crm.configure`, the same key that reshapes the pipeline and defines a
 * business field. A rule is configuration that acts on real records without
 * being watched: it assigns work to colleagues and files follow-ups against
 * customers, so it sits with the other decisions that change how the CRM behaves
 * rather than on the floor. Reading the rules is the same capability — a rule
 * that names a colleague and a condition is not floor information.
 *
 * ## What the client may and may not choose
 *
 * The body names a trigger, a list of conditions, and an action from **closed
 * vocabularies** validated in `crm-automation-rules.ts` — not here, and never in
 * SQL. A phrase from a person never becomes a query: the worst a bad body can do
 * is compose parts the product already has, and every part is a CRM write that
 * the engine performs within this business.
 *
 * `GET` serves the rules, the recent runs and the counters in one response: the
 * screen shows all three together, and three round trips for one page would be
 * three chances to render a rule beside a stale run list.
 */
export const GET = withTenantScope(async (_request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  const [automations, runs, counts] = await Promise.all([
    listAutomations(session.businessId),
    listAutomationRuns(session.businessId, { limit: 20 }),
    automationCounts(session.businessId),
  ]);

  return NextResponse.json({ automations, runs, counts });
});

interface AutomationBody {
  id?: string | null;
  name?: string;
  triggerKey?: string;
  conditions?: CrmAutomationConditionValue[];
  actionKey?: string;
  actionConfig?: { memberId?: string | null; offsetDays?: number | null; signal?: string | null };
  isActive?: boolean;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  let body: AutomationBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Shape only: an id that is not an id would reach a uuid column, and a
  // `conditions` that is not a list cannot be a condition document. The
  // *values* are validated by the shared validator inside `saveAutomation`, so
  // an API caller and the test suite are checked by the same code.
  if (body.id !== undefined && body.id !== null && !isUuid(body.id)) {
    return NextResponse.json({ error: "automation_not_found" }, { status: 404 });
  }
  if (body.conditions !== undefined && !Array.isArray(body.conditions)) {
    return NextResponse.json({ error: "automation_condition_invalid" }, { status: 400 });
  }
  if (body.actionConfig !== undefined && typeof body.actionConfig !== "object") {
    return NextResponse.json({ error: "automation_action_config_invalid" }, { status: 400 });
  }

  const result = await saveAutomation(
    session.businessId,
    {
      id: body.id ?? null,
      name: body.name ?? "",
      triggerKey: body.triggerKey ?? "",
      conditions: body.conditions ?? [],
      actionKey: body.actionKey ?? "",
      actionConfig: body.actionConfig ?? {},
      isActive: body.isActive,
    } satisfies SaveAutomationInput,
    { name: session.fullName, userId: session.sub },
  );
  if (!result.ok) {
    const status = result.error === "automation_not_found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  // Just the rule: the screen reloads the list, the runs and the counters
  // together, so returning a slice of them here would only be a second, faster
  // way to render a stale page.
  return NextResponse.json({ automation: result.rule });
});
