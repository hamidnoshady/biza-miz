import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  AGENCY_BILLING_BASES,
  AGENCY_BILLING_BASE_DESCRIPTIONS,
  AGENCY_BILLING_BASE_LABELS,
  AGENCY_MILESTONE_KINDS,
  AGENCY_MILESTONE_KIND_LABELS,
  AGENCY_MILESTONE_REVENUE_ACCOUNTS,
} from "@/lib/agency-commercial";
import {
  createAgencySchedule,
  loadAgencyCommercial,
} from "@/lib/agency-commercial-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../../../guard";

/**
 * One project's commercial picture (issue #1128 §D): the engagement, its billing
 * schedule, its change requests, and the P&L with §D's two halves kept apart.
 *
 * GET  — everything a billing panel needs in one read, including the lookups the
 *        form is built from (the four engagement bases, the four milestone
 *        kinds, the trade's four revenue accounts). They are served rather than
 *        imported by the screen so the Persian labels have one home.
 * POST — lay a whole schedule out from an engagement's base: a deposit and a
 *        final settlement for a fixed price, delivery stages for a milestone
 *        engagement, one row per period for a retainer. Hourly work answers
 *        `schedule_empty`, because there is nothing to lay out before the time
 *        is tracked — an hourly engagement bills a period once that period's
 *        hours and pass-through cost are known.
 *
 * Authorization is the service's, not this route's: every entry point in
 * `agency-commercial-service.ts` asserts the trade and the caller's project
 * role itself, so a schedule cannot be written by a caller that reaches the
 * service some other way — an MCP tool or an AI executor — without the same
 * check. The platform permission here is what opens the door; `workspace.view`
 * to read, `workspace.manage` to write.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await agencyOwner(PERMISSIONS.workspaceView, _request);
    if (error) return error;
    const { id } = await context.params;
    try {
      const commercial = await loadAgencyCommercial(owner, id);
      return NextResponse.json({
        commercial,
        lookups: {
          bases: AGENCY_BILLING_BASES.map((base) => ({
            base,
            label: AGENCY_BILLING_BASE_LABELS[base],
            description: AGENCY_BILLING_BASE_DESCRIPTIONS[base],
          })),
          kinds: AGENCY_MILESTONE_KINDS.map((kind) => ({
            kind,
            label: AGENCY_MILESTONE_KIND_LABELS[kind],
          })),
          revenueAccounts: AGENCY_MILESTONE_REVENUE_ACCOUNTS,
        },
      });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await agencyOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      const commercial = await createAgencySchedule(owner, id, await readBody(request));
      return NextResponse.json({ commercial }, { status: 201 });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);
