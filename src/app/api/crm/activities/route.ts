import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { businessToday } from "@/lib/business-day-service";
import { createActivity, listActivities } from "@/lib/crm-service";
import {
  ACTIVITY_ASSIGNEE_MAX,
  ACTIVITY_BODY_MAX,
  ACTIVITY_SUBJECT_MAX,
  isActivityKind,
  type ActivityKind,
} from "@/lib/crm-shared";
import { isUuid } from "@/lib/uuid";
import { listAssignableMembers } from "@/lib/crm-ownership";
import {
  activityViewListOptions,
  activityViewQuery,
  parseActivityViewFilters,
} from "@/lib/crm-activity-views";

/**
 * Activities — calls, visits, messages and tasks (Phase 36).
 *
 * One table for both "what happened" and "what needs doing", because they are
 * the same thing at different times: an activity with a future `dueAt` and no
 * `completedAt` *is* the task model. Two tables would have meant copying a
 * completed task into a history row, and then reconciling the two.
 *
 * Floor-accessible (`parties.manage`): the person who takes the call is the
 * person who should log it and tick off the callback. A task list only the
 * office can write to is a task list that stops matching reality by Tuesday.
 *
 * The GET also answers "what day is it *here*" (`today`), resolved from the
 * branch's timezone and business-day start. The list's «عقب‌افتاده / امروز»
 * colouring is a statement about the shop's day, and deriving it from the
 * browser's clock turned tomorrow's work red at midnight for a café that
 * closes at 02:00 — or on any till whose clock is simply set wrong.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const today = await businessToday(session.businessId);
  const rawLimit = Number(search.get("limit"));

  // The list's own vocabulary, parsed by the list's own module
  // (`crm-activity-views.ts`) rather than read here name by name: the filter a
  // saved view stores, the chips it renders and the rows the server returns are
  // three readings of one document rather than three opinions.
  const { filters, error: filterError } = parseActivityViewFilters(search);
  if (filterError) {
    return NextResponse.json({ error: "bad_filter", field: filterError }, { status: 400 });
  }

  // The state vocabulary turns into date bounds here, against the business date
  // the server resolved — the same date the rows are coloured by, so a view
  // named «سررسیدشده» and the red rows below it cannot disagree about today.
  // The translation from the reader's document to the query lives in
  // `crm-activity-views.ts` — including that `mine` means the session's own
  // member id, and that the states are date bounds over the shop's own day. The
  // rows a queue card links to and the rows this route returns are therefore one
  // reading of one document. What stays here is what is not translation:
  // permissions, `limit`, and the legacy `customerId`/`dealId`/`caseId`/
  // `assignedTo` parameters other screens pass.
  const options = activityViewListOptions(filters, { viewerId: session.sub, today });
  const activities = await listActivities(session.businessId, {
    ...options,
    customerId: search.get("customerId") ?? undefined,
    dealId: search.get("dealId") ?? undefined,
    caseId: search.get("caseId") ?? undefined,
    assignedTo: search.get("assignedTo") ?? undefined,
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined,
  });

  return NextResponse.json({
    activities,
    today,
    // The filters actually applied, echoed in the vocabulary the screen sent
    // them in, so the chips render from the answer rather than from local state
    // and can never name a filter that was dropped on the way.
    applied: activityViewQuery(filters),
    members: (await listAssignableMembers(session.businessId)).map((member) => ({
      id: member.id,
      name: member.name,
      isActive: member.isActive,
    })),
  });
});

interface ActivityBody {
  customerId?: string | null;
  dealId?: string | null;
  caseId?: string | null;
  kind?: string;
  subject?: string;
  body?: string;
  dueAt?: string | null;
  /** The assignee as a member id (`/api/crm/members`); preferred. */
  assigneeUserId?: string | null;
  /** A name, for legacy clients — resolved server-side, never trusted. */
  assignedTo?: string;
  completed?: boolean;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
  if (error) return error;

  let body: ActivityBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!subject) return NextResponse.json({ error: "activity_subject_required" }, { status: 400 });
  if (subject.length > ACTIVITY_SUBJECT_MAX) {
    return NextResponse.json({ error: "activity_subject_too_long" }, { status: 400 });
  }
  if (!body.kind || !isActivityKind(body.kind)) {
    return NextResponse.json({ error: "activity_kind_invalid" }, { status: 400 });
  }
  const note = typeof body.body === "string" ? body.body : "";
  if (note.length > ACTIVITY_BODY_MAX) {
    return NextResponse.json({ error: "activity_body_too_long" }, { status: 400 });
  }
  const assignedTo = typeof body.assignedTo === "string" ? body.assignedTo.trim() : "";
  if (assignedTo.length > ACTIVITY_ASSIGNEE_MAX) {
    return NextResponse.json({ error: "activity_assignee_too_long" }, { status: 400 });
  }
  // An id that is not a uuid cannot name a member; a 400 here rather than a
  // cast error from the database (or, worse, a silently unassigned row).
  if (body.assigneeUserId != null && body.assigneeUserId !== "" && !isUuid(body.assigneeUserId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // An id that is not a uuid cannot name a row; checked here so the answer is a
  // 400 rather than a Postgres cast error surfacing as «خطای غیرمنتظره».
  for (const id of [body.customerId, body.dealId, body.caseId]) {
    if (id != null && !isUuid(id)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  // A due date is stored as an instant, so it has to *be* one. An unparseable
  // string reached the `timestamptz` column as a cast error (a 500); now it is
  // a 400 with a sentence the screen can show.
  let dueAt: string | null = null;
  if (body.dueAt != null && body.dueAt !== "") {
    if (typeof body.dueAt !== "string") {
      return NextResponse.json({ error: "activity_due_invalid" }, { status: 400 });
    }
    const parsed = new Date(body.dueAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "activity_due_invalid" }, { status: 400 });
    }
    dueAt = parsed.toISOString();
  }

  const activity = await createActivity(session.businessId, {
    customerId: body.customerId ?? null,
    dealId: body.dealId ?? null,
    caseId: body.caseId ?? null,
    kind: body.kind as ActivityKind,
    subject,
    body: note,
    dueAt,
    assigneeUserId: body.assigneeUserId ?? null,
    assignedTo,
    createdBy: session.fullName,
    completed: body.completed === true,
  });
  return NextResponse.json({ activity }, { status: 201 });
});
