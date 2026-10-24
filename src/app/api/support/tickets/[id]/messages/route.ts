import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { callCloudOnlineSupportFromSite } from "@/lib/local-activation-site-service";
import {
  addMemberMessage,
  TicketAccessError,
  validateTicketInput,
  type SupportTicketMessage,
} from "@/lib/support-service";

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

/** A member's follow-up on one of their tickets. */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
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

  const text = typeof body.body === "string" ? body.body.trim() : "";
  const attachment = typeof body.attachment === "string" ? body.attachment : null;
  const validation = validateTicketInput({ body: text, attachment });
  if (validation.error) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  if (await isFullOfflineSite(session.businessId)) {
    const cloudRes = await callCloudOnlineSupportFromSite<{
      message: SupportTicketMessage;
    }>(session.businessId, {
      method: "POST",
      body: {
        action: "support_ticket_reply",
        ticketId: id,
        body: text,
        attachment,
        senderName: session.fullName,
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
       VALUES ($1, $2, 'support.online_reply_submitted', 'support_ticket', $3, '{}'::jsonb)`,
      [session.businessId, session.sub, id],
    );
    return NextResponse.json(
      { message: cloudRes.data.message, onlineOnly: true },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const message = await addMemberMessage({
      businessId: session.businessId,
      userId: session.sub,
      role: session.role,
      ticketId: id,
      body: text,
      attachment,
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (err) {
    if (err instanceof TicketAccessError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw err;
  }
});
