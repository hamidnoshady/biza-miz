import { NextRequest, NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import { clientIpFrom, hashKey } from "@/lib/rate-limit";
import { LOCAL_ACTIVATION_PROTOCOL_VERSION } from "@/lib/local-activation-contract";
import {
  acknowledgeLocalEnrollmentOnCloud,
  authenticateLocalInstallationBearer,
  createCloudBugReportFromLocalInstallation,
  createCloudSupportTicketFromLocalInstallation,
  enrollLocalInstallationOnCloud,
  getCloudSupportTicketDetailForLocalInstallation,
  listCloudSupportTicketsForLocalInstallation,
  replyCloudSupportTicketFromLocalInstallation,
  updateCloudSupportTicketStatusFromLocalInstallation,
  validateLocalInstallationOnCloud,
  verifyLocalEnrollmentTokenOnCloud,
} from "@/lib/local-activation-cloud-service";
import {
  handleSiteSupportCommandResultOnCloud,
  handleSiteSupportConsentOnCloud,
  handleSiteSupportPollOnCloud,
  handleSiteSupportRevokeOnCloud,
} from "@/lib/local-remote-support-service";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
};

function isExplicitSiteProcess(): boolean {
  return process.env.DEPLOYMENT_ROLE?.trim().toLowerCase() === "site";
}

function extractBearerToken(request: NextRequest): string {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function consumeDurableRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  try {
    return await withoutTenantScope("platform", async () => {
      const { rows } = await query<{ count: number; window_start_ms: string }>(
        `INSERT INTO rate_limits (key, count, window_start)
         VALUES ($1, 1, now())
         ON CONFLICT (key) DO UPDATE
         SET count = CASE
                       WHEN rate_limits.window_start <= now() - ($2::bigint * interval '1 millisecond')
                       THEN 1
                       ELSE rate_limits.count + 1
                     END,
             window_start = CASE
                              WHEN rate_limits.window_start <= now() - ($2::bigint * interval '1 millisecond')
                              THEN now()
                              ELSE rate_limits.window_start
                            END
         RETURNING count, EXTRACT(EPOCH FROM window_start) * 1000 AS window_start_ms`,
        [key.slice(0, 250), windowMs],
      );
      const count = Number(rows[0].count);
      const windowStartMs = Number(rows[0].window_start_ms);
      const allowed = count <= limit;
      return {
        allowed,
        retryAfterMs: allowed ? 0 : Math.max(1000, windowMs - (Date.now() - windowStartMs)),
      };
    });
  } catch {
    return { allowed: true, retryAfterMs: 0 };
  }
}

function jsonNoStore(body: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE_HEADERS, ...(extraHeaders ?? {}) },
  });
}

function denialStatusFor(code: string): number {
  switch (code) {
    case "invalid_token":
    case "token_revoked":
    case "token_expired":
    case "token_already_used":
      return 401;
    default:
      return 403;
  }
}

export async function GET(request: NextRequest) {
  if (isExplicitSiteProcess()) {
    return jsonNoStore({ error: "central_only" }, 404);
  }

  const bearer = extractBearerToken(request);
  const installationId = (request.headers.get("x-installation-id") ?? "").trim();
  const expectedBusinessId = (request.headers.get("x-cloud-business-id") ?? "").trim() || null;

  if (!bearer || !installationId) {
    return jsonNoStore(
      {
        ok: false,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        code: "invalid_token",
      },
      401,
    );
  }

  const rl = await consumeDurableRateLimit(`local_act_get:${hashKey(bearer)}`, 120, 60_000);
  if (!rl.allowed) {
    return jsonNoStore(
      { error: "rate_limited" },
      429,
      { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    );
  }

  const auth = await authenticateLocalInstallationBearer(bearer, installationId);
  if (!auth.ok) {
    return jsonNoStore(
      {
        ok: false,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        code: auth.code,
      },
      auth.httpStatus,
    );
  }
  if (expectedBusinessId && auth.installation.businessId !== expectedBusinessId) {
    return jsonNoStore(
      {
        ok: false,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        code: "business_mismatch",
      },
      403,
    );
  }

  const action = request.nextUrl.searchParams.get("action") ?? "";
  if (action === "support_tickets") {
    const status = request.nextUrl.searchParams.get("status");
    const tickets = await listCloudSupportTicketsForLocalInstallation(
      auth.installation,
      status,
    );
    return jsonNoStore({ ok: true, protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION, tickets });
  }

  if (action === "support_ticket_detail") {
    const ticketId = (request.nextUrl.searchParams.get("ticketId") ?? "").trim();
    if (!ticketId) return jsonNoStore({ error: "invalid_fields" }, 400);
    const detail = await getCloudSupportTicketDetailForLocalInstallation(
      auth.installation,
      ticketId,
    );
    if (!detail) return jsonNoStore({ error: "not_found" }, 404);
    return jsonNoStore({ ok: true, protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION, ticket: detail });
  }

  return jsonNoStore({ error: "unknown_action" }, 400);
}

export async function POST(request: NextRequest) {
  if (isExplicitSiteProcess()) {
    return jsonNoStore({ error: "central_only" }, 404);
  }

  const trustedHops = Number(process.env.TRUSTED_PROXY_HOPS ?? "1") || 1;
  const ip = clientIpFrom(request.headers, trustedHops);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonNoStore({ error: "bad_request" }, 400);
  }

  const action = typeof body.action === "string" ? body.action : "";

  // ── Enrollment-code actions (pre-bearer exchange) ──────────────────────────
  if (action === "verify_token" || action === "enroll") {
    const rl = await consumeDurableRateLimit(`local_enroll_ip:${ip}`, 20, 60_000);
    if (!rl.allowed) {
      return jsonNoStore(
        { error: "rate_limited" },
        429,
        { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      );
    }

    const rawCode = typeof body.code === "string" ? body.code : "";
    const installationId = typeof body.installationId === "string" ? body.installationId : "";
    const expectedBusinessId =
      typeof body.expectedBusinessId === "string" ? body.expectedBusinessId : null;

    if (action === "verify_token") {
      const res = await verifyLocalEnrollmentTokenOnCloud({
        code: rawCode,
        installationId,
        expectedBusinessId,
      });
      if (!res.ok) {
        return jsonNoStore(
          {
            ok: false,
            protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
            code: res.code,
          },
          res.httpStatus,
        );
      }
      return jsonNoStore({
        ok: true,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        businessBundle: res.businessBundle,
        locationId: res.businessBundle.location.id,
        enforceOfflineLease: res.businessBundle.policy.enforceOfflineLease,
        offlineLeaseDays: res.businessBundle.policy.offlineLeaseDays,
      });
    }

    const enrollRes = await enrollLocalInstallationOnCloud({
      code: rawCode,
      installationId,
      deviceName: typeof body.deviceName === "string" ? body.deviceName : null,
      appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
      clientIp: ip,
      expectedBusinessId,
    });
    if (!enrollRes.ok) {
      return jsonNoStore(
        {
          ok: false,
          protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
          code: enrollRes.code,
        },
        enrollRes.httpStatus,
      );
    }
    return jsonNoStore({
      ok: true,
      protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
      installationPublicId: enrollRes.installationPublicId,
      credentialId: enrollRes.credentialId,
      token: enrollRes.token,
      lease: enrollRes.lease,
      businessBundle: enrollRes.businessBundle,
      resumed: enrollRes.resumed,
    });
  }

  // ── Scoped installation bearer (`LOC1-…`) actions ──────────────────────────
  const bearer = extractBearerToken(request);
  const installationId =
    (typeof body.installationId === "string" ? body.installationId : "") ||
    (request.headers.get("x-installation-id") ?? "");
  const expectedBusinessId =
    typeof body.expectedBusinessId === "string"
      ? body.expectedBusinessId
      : typeof body.cloudBusinessId === "string"
        ? body.cloudBusinessId
        : null;

  if (!bearer || !installationId.trim()) {
    return jsonNoStore(
      {
        ok: false,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        code: "invalid_token",
      },
      401,
    );
  }

  const rlKey =
    action === "support_ticket_create" || action === "bug_report_create"
      ? `local_act_submit:${hashKey(bearer)}`
      : `local_act_post:${hashKey(bearer)}`;
  const rlLimit =
    action === "support_ticket_create" || action === "bug_report_create" ? 15 : 180;
  const rl = await consumeDurableRateLimit(rlKey, rlLimit, 60_000);
  if (!rl.allowed) {
    return jsonNoStore(
      { error: "rate_limited" },
      429,
      { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    );
  }

  if (action === "acknowledge") {
    const ack = await acknowledgeLocalEnrollmentOnCloud({
      token: bearer,
      installationId: installationId.trim(),
    });
    if (!ack.ok) {
      return jsonNoStore(
        {
          ok: false,
          protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
          code: ack.code,
        },
        ack.httpStatus,
      );
    }
    return jsonNoStore({ ok: true, protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION });
  }

  if (action === "validate") {
    const val = await validateLocalInstallationOnCloud({
      token: bearer,
      installationId: installationId.trim(),
      expectedBusinessId,
      currentBusinessDigest:
        typeof body.currentBusinessDigest === "string" ? body.currentBusinessDigest : null,
      appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
      healthSummary:
        body.healthSummary && typeof body.healthSummary === "object"
          ? (body.healthSummary as Record<string, unknown>)
          : null,
      acknowledgeStagedToken: Boolean(body.acknowledgeStagedToken),
    });
    if (!val.ok) {
      return jsonNoStore(
        {
          ok: false,
          protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
          code: val.code,
        },
        val.httpStatus,
      );
    }
    return jsonNoStore({
      ok: true,
      protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
      unchanged: val.unchanged,
      businessBundle: val.businessBundle,
      lease: val.lease,
      stagedCredential: val.stagedCredential,
      rotationCompleted: val.rotationCompleted,
    });
  }

  const auth = await authenticateLocalInstallationBearer(bearer, installationId.trim());
  if (!auth.ok) {
    return jsonNoStore(
      {
        ok: false,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        code: auth.code,
      },
      auth.httpStatus,
    );
  }
  if (expectedBusinessId && auth.installation.businessId !== expectedBusinessId) {
    return jsonNoStore(
      {
        ok: false,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        code: "business_mismatch",
      },
      403,
    );
  }

  if (action === "support_ticket_create") {
    const res = await createCloudSupportTicketFromLocalInstallation(auth.installation, {
      subject: String(body.subject ?? ""),
      category: String(body.category ?? "other"),
      priority: typeof body.priority === "string" ? body.priority : "normal",
      description: String(body.description ?? body.body ?? ""),
      attachment: body.attachment ?? null,
      reporterName: typeof body.senderName === "string" ? body.senderName : null,
      reporterRole: typeof body.senderRole === "string" ? body.senderRole : null,
    });
    if (!res.ok) return jsonNoStore({ error: res.error }, 400);
    return jsonNoStore(
      {
        ok: true,
        protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION,
        ticket: res.ticket,
      },
      201,
    );
  }

  if (action === "support_ticket_reply") {
    const res = await replyCloudSupportTicketFromLocalInstallation(auth.installation, {
      ticketId: String(body.ticketId ?? ""),
      body: typeof body.body === "string" ? body.body : "",
      attachment: body.attachment ?? null,
      reporterName: typeof body.senderName === "string" ? body.senderName : null,
    });
    if (!res.ok) {
      return jsonNoStore({ error: res.error }, res.error === "not_found" ? 404 : 400);
    }
    const lastMessage = res.ticket.messages[res.ticket.messages.length - 1] ?? null;
    return jsonNoStore(
      { ok: true, ticket: res.ticket, message: lastMessage },
      201,
    );
  }

  if (action === "support_ticket_status") {
    const res = await updateCloudSupportTicketStatusFromLocalInstallation(
      auth.installation,
      String(body.ticketId ?? ""),
      String(body.status ?? ""),
    );
    if (!res.ok) {
      return jsonNoStore({ error: res.error }, res.error === "not_found" ? 404 : 400);
    }
    return jsonNoStore({ ok: true, ticket: res.ticket });
  }

  if (action === "bug_report_create") {
    const res = await createCloudBugReportFromLocalInstallation(auth.installation, {
      description: String(body.description ?? ""),
      screenshot: body.screenshot ?? null,
      pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : null,
      userAgent: typeof body.userAgent === "string" ? body.userAgent : null,
      viewport: typeof body.viewport === "string" ? body.viewport : null,
      reporterName: typeof body.reporterName === "string" ? body.reporterName : null,
    });
    if (!res.ok) return jsonNoStore({ error: res.error }, 400);
    return jsonNoStore({ ok: true, id: res.id, createdAt: res.createdAt }, 201);
  }

  if (action === "support_poll") {
    const polled = await handleSiteSupportPollOnCloud(auth.installation);
    return jsonNoStore({ ok: true, protocol: LOCAL_ACTIVATION_PROTOCOL_VERSION, ...polled });
  }

  if (action === "support_consent") {
    const consentRes = await handleSiteSupportConsentOnCloud(auth.installation, {
      sessionId: String(body.sessionId ?? ""),
      sessionNonce: String(body.sessionNonce ?? ""),
      approved: Boolean(body.approved),
      approvedByLocalUserId: String(body.approvedByLocalUserId ?? ""),
      installationLocked: Boolean(body.installationLocked),
    });
    if (!consentRes.ok) {
      return jsonNoStore({ ok: false, error: consentRes.error }, 409);
    }
    return jsonNoStore(consentRes);
  }

  if (action === "support_revoke") {
    await handleSiteSupportRevokeOnCloud(auth.installation, {
      sessionId: String(body.sessionId ?? ""),
    });
    return jsonNoStore({ ok: true });
  }

  if (action === "support_command_result") {
    await handleSiteSupportCommandResultOnCloud(auth.installation, {
      sessionId: String(body.sessionId ?? ""),
      commandId: String(body.commandId ?? ""),
      ok: Boolean(body.ok),
      result: body.result,
      errorCode: typeof body.errorCode === "string" ? body.errorCode : null,
    });
    return jsonNoStore({ ok: true });
  }

  return jsonNoStore({ error: "unknown_action" }, 400);
}
