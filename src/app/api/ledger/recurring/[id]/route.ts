import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  getRecurringTemplate,
  retryOccurrence,
  setRecurringTemplateStatus,
  skipOccurrence,
  updateRecurringTemplate,
  RecurringVoucherError,
} from "@/lib/recurring-voucher-service";
import { parseRecurringTemplateBody } from "@/lib/recurring-voucher-input";

const STATUS_ACTIONS = {
  pause: "paused",
  resume: "active",
  cancel: "cancelled",
} as const;

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
    if (error) return error;
    const { id } = await context.params;
    const template = await getRecurringTemplate(session.businessId, id);
    if (!template) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
    return NextResponse.json({ template });
  },
);

/**
 * One verb for every template mutation, discriminated by `action`:
 *
 *  - `edit` (or no action, with a full body) — prospective edit; prior
 *    occurrences, drafts and posted entries are untouched;
 *  - `pause` / `resume` / `cancel` — lifecycle;
 *  - `retry` / `skip` — one occurrence, identified by `occurrenceId`.
 *
 * All of them are `ledger.propose`; approving the resulting draft is a
 * separate `ledger.approve` decision made on the existing review queue.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.ledgerPropose);
    if (error) return error;
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const action = (body as Record<string, unknown>).action;
    const occurrenceId = (body as Record<string, unknown>).occurrenceId;

    try {
      if (typeof action === "string" && action in STATUS_ACTIONS) {
        const status = STATUS_ACTIONS[action as keyof typeof STATUS_ACTIONS];
        const result = await setRecurringTemplateStatus({
          businessId: session.businessId,
          templateId: id,
          actorId: session.sub,
          status,
        });
        return NextResponse.json(result);
      }
      if (action === "retry" || action === "skip") {
        if (typeof occurrenceId !== "string") {
          return NextResponse.json({ error: "occurrence_id_required" }, { status: 400 });
        }
        if (action === "retry") {
          const result = await retryOccurrence({
            businessId: session.businessId,
            occurrenceId,
            actorId: session.sub,
          });
          return NextResponse.json(result);
        }
        await skipOccurrence({
          businessId: session.businessId,
          occurrenceId,
          actorId: session.sub,
        });
        return NextResponse.json({ skipped: true });
      }

      const parsed = parseRecurringTemplateBody(body);
      if (!parsed.ok) return NextResponse.json({ error: parsed.problem }, { status: 400 });
      const result = await updateRecurringTemplate({
        businessId: session.businessId,
        templateId: id,
        actorId: session.sub,
        input: parsed.value,
      });
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof RecurringVoucherError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
