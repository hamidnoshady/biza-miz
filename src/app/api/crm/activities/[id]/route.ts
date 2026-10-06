import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteActivity, updateActivity } from "@/lib/crm-service";
import {
  ACTIVITY_ASSIGNEE_MAX,
  ACTIVITY_BODY_MAX,
  ACTIVITY_SUBJECT_MAX,
  isActivityKind,
  type ActivityKind,
} from "@/lib/crm-shared";
import { isUuid } from "@/lib/uuid";

/**
 * One activity.
 *
 * `PATCH { completed }` is the list's tick-box; the same route also takes the
 * edit dialog's fields, because a follow-up whose date or owner changed is the
 * same commitment, not a new one. Only the keys present are written, so a tick
 * never silently blanks a moeed.
 *
 * No `GET`: the list screen holds every row it shows, and a single-activity
 * read existed only as an unused twin of the list's own data.
 */
interface PatchBody {
  completed?: boolean;
  kind?: string;
  subject?: string;
  body?: string;
  dueAt?: string | null;
  /** The assignee as a member id; `""` unassigns. */
  assigneeUserId?: string | null;
  /** A name, for legacy clients — resolved server-side. */
  assignedTo?: string;
  customerId?: string | null;
}

export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
    if (error) return error;

    let body: PatchBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const patch: Parameters<typeof updateActivity>[2] = {};

    if (body.completed !== undefined) {
      if (typeof body.completed !== "boolean") {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      patch.completed = body.completed;
    }
    if (body.kind !== undefined) {
      if (!isActivityKind(body.kind)) {
        return NextResponse.json({ error: "activity_kind_invalid" }, { status: 400 });
      }
      patch.kind = body.kind as ActivityKind;
    }
    if (body.subject !== undefined) {
      const subject = typeof body.subject === "string" ? body.subject.trim() : "";
      if (!subject) return NextResponse.json({ error: "activity_subject_required" }, { status: 400 });
      if (subject.length > ACTIVITY_SUBJECT_MAX) {
        return NextResponse.json({ error: "activity_subject_too_long" }, { status: 400 });
      }
      patch.subject = subject;
    }
    if (body.body !== undefined) {
      if (typeof body.body !== "string" || body.body.length > ACTIVITY_BODY_MAX) {
        return NextResponse.json({ error: "activity_body_too_long" }, { status: 400 });
      }
      patch.body = body.body;
    }
    if (body.assignedTo !== undefined) {
      if (typeof body.assignedTo !== "string" || body.assignedTo.length > ACTIVITY_ASSIGNEE_MAX) {
        return NextResponse.json({ error: "activity_assignee_too_long" }, { status: 400 });
      }
      patch.assignedTo = body.assignedTo;
    }
    if (body.assigneeUserId !== undefined) {
      if (body.assigneeUserId !== null && body.assigneeUserId !== "" && !isUuid(body.assigneeUserId)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      patch.assigneeUserId = body.assigneeUserId;
    }
    if (body.customerId !== undefined) {
      if (body.customerId !== null && !isUuid(body.customerId)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      patch.customerId = body.customerId;
    }
    if (body.dueAt !== undefined) {
      if (body.dueAt === null || body.dueAt === "") {
        patch.dueAt = null;
      } else {
        const parsed = typeof body.dueAt === "string" ? new Date(body.dueAt) : new Date(NaN);
        if (Number.isNaN(parsed.getTime())) {
          return NextResponse.json({ error: "activity_due_invalid" }, { status: 400 });
        }
        patch.dueAt = parsed.toISOString();
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const { id } = await params;
    const activity = await updateActivity(session.businessId, id, patch);
    if (!activity) return NextResponse.json({ error: "activity_not_found" }, { status: 404 });
    return NextResponse.json({ activity });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
    if (error) return error;

    const { id } = await params;
    const deleted = await deleteActivity(session.businessId, id);
    if (!deleted) return NextResponse.json({ error: "activity_not_found" }, { status: 404 });
    return NextResponse.json({ result: "deleted" });
  },
);
