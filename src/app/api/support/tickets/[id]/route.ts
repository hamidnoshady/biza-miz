import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { callCloudOnlineSupportFromSite } from "@/lib/local-activation-site-service";
import {
  getMemberTicket,
  setMemberTicketStatus,
  TicketAccessError,
  type SupportTicketDetail,
} from "@/lib/support-service";
import { isMemberSettableStatus } from "@/lib/support-tickets";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function isFullOfflineSite(businessId: string): Promise<boolean> {
  if (deploymentRole() !== "site") return false;
  const deployment = await readDeploymentProfile(businessId);
  return deployment.profile === "local" && deployment.source !== "inferred";
}

export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (await isFullOfflineSite(session.businessId)) {
    const cloudRes = await callCloudOnlineSupportFromSite<{
      ticket: SupportTicketDetail;
    }>(session.businessId, {
      method: "GET",
      queryParams: { action: "support_ticket_detail", ticketId: id },
    });
    if (!cloudRes.ok) {
      return NextResponse.json(
        { error: cloudRes.error, onlineOnly: true },
        { status: cloudRes.httpStatus, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ticket: cloudRes.data.ticket, onlineOnly: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const ticket = await getMemberTicket({
    businessId: session.businessId,
    userId: session.sub,
    role: session.role,
    ticketId: id,
  });
  if (!ticket) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ticket });
});

export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireMember();
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const status = typeof body.status === "string" ? body.status : "";
  if (!isMemberSettableStatus(status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  if (await isFullOfflineSite(session.businessId)) {
    const cloudRes = await callCloudOnlineSupportFromSite<{
      ticket: SupportTicketDetail;
    }>(session.businessId, {
      method: "POST",
      body: { action: "support_ticket_status", ticketId: id, status },
    });
    if (!cloudRes.ok) {
      return NextResponse.json(
        { error: cloudRes.error, onlineOnly: true },
        { status: cloudRes.httpStatus, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ticket: cloudRes.data.ticket, onlineOnly: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    await setMemberTicketStatus({
      businessId: session.businessId,
      userId: session.sub,
      role: session.role,
      ticketId: id,
      status,
    });
  } catch (err) {
    if (err instanceof TicketAccessError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }

  const ticket = await getMemberTicket({
    businessId: session.businessId,
    userId: session.sub,
    role: session.role,
    ticketId: id,
  });
  return NextResponse.json({ ticket });
});
