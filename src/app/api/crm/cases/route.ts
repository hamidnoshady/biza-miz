import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listCases, upsertCase } from "@/lib/crm-service";
import { caseSlaSummary } from "@/lib/crm-case-service";
import { isUuid } from "@/lib/uuid";
import {
  isCasePriority,
  isCaseStatus,
  type CasePriority,
  type CaseStatus,
} from "@/lib/crm-shared";

/**
 * Service cases — complaints and requests (Phase 36).
 *
 * Floor-accessible on purpose. The person who hears the complaint is the person
 * at the counter, and a service desk a cashier cannot open is a service desk
 * that never gets used: the complaint stays in someone's head and the customer
 * never hears back.
 *
 * Priority drives a target response time (`CASE_PRIORITY_TARGET_HOURS`), not a
 * contractual SLA — a café signs none. It exists so «کدام شکایت معطل مانده؟»
 * has an answer that does not require reading every ticket.
 *
 * That answer subtracts time spent **waiting on the customer**. A case parked
 * for four days because the shopper never sent their order number is not a
 * failure of the team, and counting it as one makes the whole report ignorable
 * — and makes "never ask the customer anything" the fastest way to protect the
 * number. `waitingOnCustomer` is reported as its own figure, never folded into
 * `breached`.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const status = search.get("status");
  const cases = await listCases(session.businessId, {
    customerId: search.get("customerId") ?? undefined,
    status: status && isCaseStatus(status) ? (status as CaseStatus) : undefined,
    openOnly: search.get("open") === "1",
    // «تیکت‌های من» — from the session, never from the query string.
    assigneeUserId: search.get("mine") === "1" ? session.sub : undefined,
  });
  return NextResponse.json({
    cases,
    // Alongside the list, because the list alone cannot show it: the SLA
    // position depends on accumulated waiting time, which no single row
    // renders.
    sla: await caseSlaSummary(session.businessId),
  });
});

interface CaseBody {
  id?: string;
  customerId?: string | null;
  subject?: string;
  body?: string;
  status?: string;
  priority?: string;
  category?: string;
  orderId?: string | null;
  /** The handler as a member id; `""` unassigns. */
  assigneeUserId?: string | null;
  /** A name, for legacy clients — resolved server-side, never trusted. */
  assignedTo?: string;
  resolution?: string;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
  if (error) return error;

  let body: CaseBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const subject = body.subject?.trim();
  if (!subject) return NextResponse.json({ error: "case_subject_required" }, { status: 400 });
  if (body.status !== undefined && !isCaseStatus(body.status)) {
    return NextResponse.json({ error: "case_status_invalid" }, { status: 400 });
  }
  if (body.priority !== undefined && !isCasePriority(body.priority)) {
    return NextResponse.json({ error: "case_priority_invalid" }, { status: 400 });
  }
  // A handler is a member of this business or nobody: a non-uuid cannot name
  // one, and asking Postgres would answer with a cast error instead.
  if (body.assigneeUserId != null && body.assigneeUserId !== "" && !isUuid(body.assigneeUserId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const record = await upsertCase(session.businessId, {
    id: body.id,
    customerId: body.customerId ?? null,
    subject,
    body: body.body,
    status: body.status as CaseStatus | undefined,
    priority: body.priority as CasePriority | undefined,
    category: body.category,
    // `undefined` (field absent) means "keep the existing link" on update;
    // only an explicit null clears it. Coercing absent → null here would make
    // every edit from a client that doesn't know about orders unlink the
    // ticket from the order the complaint was about.
    orderId: body.orderId,
    assigneeUserId: body.assigneeUserId ?? null,
    assignedTo: body.assignedTo,
    resolution: body.resolution,
    createdBy: session.fullName,
    createdById: session.sub,
  });
  return NextResponse.json({ case: record }, { status: body.id ? 200 : 201 });
});
