import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { callCloudOnlineSupportFromSite } from "@/lib/local-activation-site-service";
import {
  createMemberTicket,
  listMemberTickets,
  validateTicketInput,
  SUPPORT_SUBJECT_MAX,
  type SupportTicketDetail,
  type SupportTicketSummary,
} from "@/lib/support-service";
import { isTicketCategory, isTicketPriority } from "@/lib/support-tickets";

async function isFullOfflineSite(businessId: string): Promise<boolean> {
  if (deploymentRole() !== "site") return false;
  const deployment = await readDeploymentProfile(businessId);
  return deployment.profile === "local" && deployment.source !== "inferred";
}

/**
 * The member's support tickets (migration 0130).
 *
 * Issue #974: on Full Offline (`local`) site installations, Support tickets are
 * strictly online-only against the authenticated Cloud endpoint — never queued
 * locally while offline.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get("status") ?? "";

  if (await isFullOfflineSite(session.businessId)) {
    const cloudRes = await callCloudOnlineSupportFromSite<{
      tickets: SupportTicketSummary[];
    }>(session.businessId, {
      method: "GET",
      queryParams: { action: "support_tickets", status },
    });
    if (!cloudRes.ok) {
      return NextResponse.json(
        { error: cloudRes.error, onlineOnly: true },
        { status: cloudRes.httpStatus, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { tickets: cloudRes.data.tickets ?? [], onlineOnly: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const rawLimit = Number(searchParams.get("limit"));
  return NextResponse.json({
    tickets: await listMemberTickets({
      businessId: session.businessId,
      userId: session.sub,
      role: session.role,
      status,
      limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200,
    }),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const subject =
    typeof body.subject === "string"
      ? body.subject.trim().slice(0, SUPPORT_SUBJECT_MAX)
      : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const attachment = typeof body.attachment === "string" ? body.attachment : null;
  const category = typeof body.category === "string" ? body.category : "other";
  const priority = typeof body.priority === "string" ? body.priority : "normal";

  const validation = validateTicketInput({ subject, body: description, attachment });
  if (validation.error) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  if (await isFullOfflineSite(session.businessId)) {
    const cloudRes = await callCloudOnlineSupportFromSite<{
      ticket: SupportTicketDetail;
    }>(session.businessId, {
      method: "POST",
      body: {
        action: "support_ticket_create",
        subject,
        category: isTicketCategory(category) ? category : "other",
        priority: isTicketPriority(priority) ? priority : "normal",
        description,
        attachment,
        senderName: session.fullName,
        senderRole: session.role,
      },
    });
    if (!cloudRes.ok) {
      return NextResponse.json(
        { error: cloudRes.error, onlineOnly: true },
        { status: cloudRes.httpStatus, headers: { "Cache-Control": "no-store" } },
      );
    }
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'support.online_ticket_submitted', 'support_ticket', $3, $4)`,
      [
        session.businessId,
        session.sub,
        cloudRes.data.ticket.id,
        JSON.stringify({ category, priority }),
      ],
    );
    return NextResponse.json(
      { ticket: cloudRes.data.ticket, onlineOnly: true },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  const ticket = await createMemberTicket({
    businessId: session.businessId,
    locationId: session.locationId ?? null,
    userId: session.sub,
    subject,
    category: isTicketCategory(category) ? category : "other",
    priority: isTicketPriority(priority) ? priority : "normal",
    body: description,
    attachment,
  });

  return NextResponse.json({ ticket }, { status: 201 });
});
