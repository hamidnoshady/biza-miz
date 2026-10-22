import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/employee-service";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import { businessHost, hostRoutingEnabled, parseHost, requestHost } from "@/lib/host";
import { deploymentRole } from "@/lib/deployment-role";
import {
  consumeTelegramInitData,
  isTelegramIdentitySessionActive,
  telegramAccountForSessionExchange,
  telegramBusinessAvailability,
} from "@/lib/telegram-service";
import { telegramConfig, verifyTelegramInitData } from "@/lib/telegram-contract";
import {
  checkAuthLockout,
  recordAuthSuccess,
} from "@/lib/login-lockout-service";
import { PASSWORD_LOCKOUT_POLICY } from "@/lib/login-lockout";
import {
  filterActiveMfaEnrolments,
  getAccountMfaEnrolments,
  getMfaGracePeriod,
  markMfaGracePeriod,
  signMfaPendingToken,
} from "@/lib/mfa-service";
import {
  MFA_GRACE_DAYS_TENANT,
  enrolmentRequirement,
  graceDaysRemaining,
  mfaAppliesToRole,
  shouldChallengeMfaOnLogin,
} from "@/lib/mfa";
import { getMfaPolicy } from "@/lib/mfa-policy";

const MAX_SESSION_REQUEST_BYTES = 10 * 1024;

function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

async function readBody(request: NextRequest): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SESSION_REQUEST_BYTES) return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SESSION_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  if (deploymentRole() !== "central" || !hostRoutingEnabled()) {
    return json({ error: "deployment_unsupported" }, 404);
  }
  const bot = telegramConfig();
  if (!bot.enabled) {
    return json({ error: bot.reason === "configuration_incomplete" ? "telegram_not_configured" : "telegram_disabled" },
      bot.reason === "configuration_incomplete" ? 503 : 404);
  }

  const rootDomain = process.env.ROOT_DOMAIN?.trim() ?? "";
  const parsedHost = parseHost(requestHost(request.headers), rootDomain);
  if (parsedHost.kind !== "business") return json({ error: "business_host_required" }, 400);
  const business = await resolveBusinessByLabel(parsedHost.label);
  if (!business || business.status === "archived") return json({ error: "business_unavailable" }, 404);
  if (business.viaAlias) {
    return json({
      error: "canonical_host_required",
      canonicalUrl: `https://${businessHost(business.subdomain, rootDomain)}/telegram`,
    }, 409);
  }
  if (business.status !== "active") return json({ error: "business_unavailable" }, 403);

  const availability = await telegramBusinessAvailability(business.businessId);
  if (!availability.available) {
    const status = availability.error === "telegram_not_configured" ? 503 : 403;
    return json({ error: availability.error }, status);
  }

  const rawBody = await readBody(request);
  if (rawBody === null) return json({ error: "bad_request" }, 400);
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const initData = isObject(body) && typeof body.initData === "string" ? body.initData : "";
  if (initData.length === 0 || initData.length > 8192) return json({ error: "invalid_init_data" }, 400);

  const verified = verifyTelegramInitData(initData, bot.config.botToken);
  if (!verified.ok) return json({ error: verified.error }, 401);

  const account = await telegramAccountForSessionExchange({
    telegramUserId: verified.value.telegramUserId,
    businessId: business.businessId,
  });
  if (!account) return json({ error: "account_unlinked_or_membership_unavailable" }, 403);

  const linkIsActive = await isTelegramIdentitySessionActive({
    linkId: account.linkId,
    platformUserId: account.platformUserId,
    generation: account.linkGeneration,
    businessId: business.businessId,
  });
  if (!linkIsActive) return json({ error: "account_unlinked_or_membership_unavailable" }, 403);

  const lockout = await checkAuthLockout("tenant_telegram", account.email, PASSWORD_LOCKOUT_POLICY);
  if (lockout.locked) return json({ error: "account_locked" }, 423);

  const allEnrolments = await getAccountMfaEnrolments("platform_user", account.platformUserId);
  const activeEnrolments = filterActiveMfaEnrolments(allEnrolments);
  const primaryEnrolment = activeEnrolments[0] ?? null;
  const mfaPolicy = await withoutTenantScope("login", () => getMfaPolicy(business.businessId));
  const requiresMfa = mfaAppliesToRole(account.membership.role, mfaPolicy);
  let graceUntil = await getMfaGracePeriod("platform_user", account.platformUserId);
  const hasGraceRecord = graceUntil !== null;

  if (requiresMfa && !hasGraceRecord && activeEnrolments.length === 0) {
    await markMfaGracePeriod("platform_user", account.platformUserId, MFA_GRACE_DAYS_TENANT);
    graceUntil = await getMfaGracePeriod("platform_user", account.platformUserId);
  }
  const mfaState = enrolmentRequirement({
    hasPrimary: activeEnrolments.length > 0,
    graceUntil,
    hasGraceRecord,
    role: account.membership.role,
  });
  const challengeDue = shouldChallengeMfaOnLogin({
    hasConfirmedEnrolment: activeEnrolments.length > 0,
    appliesToRole: requiresMfa,
    requirement: mfaState,
  });

  // A Telegram initData HMAC is a primary login credential, not an MFA or
  // trusted-device grant. Consume its canonical signed form exactly once.
  const consumed = await consumeTelegramInitData({
    replayKey: verified.value.replayKey,
    telegramUserId: verified.value.telegramUserId,
    linkId: account.linkId,
    expiresAt: verified.value.expiresAt,
  });
  if (!consumed) {
    const currentLink = await isTelegramIdentitySessionActive({
      linkId: account.linkId,
      platformUserId: account.platformUserId,
      generation: account.linkGeneration,
      businessId: business.businessId,
    });
    return currentLink
      ? json({ error: "telegram_init_data_replayed" }, 409)
      : json({ error: "account_unlinked_or_membership_unavailable" }, 403);
  }

  await recordAuthSuccess("tenant_telegram", account.email);
  await withoutTenantScope("login", () =>
    query(`UPDATE platform_users SET last_login_at = now() WHERE id = $1 AND is_active = true`, [account.platformUserId]),
  );

  if (challengeDue) {
    const mfaToken = await signMfaPendingToken({
      sub: account.platformUserId,
      method: primaryEnrolment?.method ?? null,
      authRealm: "tenant_telegram",
      businessId: business.businessId,
      primaryAuth: "telegram",
      telegramIdentityLinkId: account.linkId,
      telegramIdentityGeneration: account.linkGeneration,
      telegramTokenVersion: account.tokenVersion,
    });
    return json({
      mfaRequired: true,
      mfaState,
      mfaToken,
      mfaMethod: primaryEnrolment?.method ?? null,
      availableMethods: activeEnrolments.map((enrolment) => enrolment.method),
    });
  }

  const { session: employeeSession } = await withTenant(business.businessId, () =>
    createSession(account.membership.userId, business.businessId, {
      locationId: account.membership.locationId,
      deviceLabel: "Telegram Mini App",
      userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
      loginMethod: "telegram",
    }),
  );
  const sessionToken = await signSession({
    sub: account.membership.userId,
    role: account.membership.role,
    businessId: account.membership.businessId,
    businessSlug: account.membership.businessSlug,
    businessSubdomain: account.membership.businessSubdomain,
    locationId: account.membership.locationId,
    fullName: account.membership.fullName,
    platformUserId: account.platformUserId,
    tokenVersion: account.tokenVersion,
    employeeSessionId: employeeSession.id,
    telegramIdentityLinkId: account.linkId,
    telegramIdentityGeneration: account.linkGeneration,
    mfaVerified: false,
    recentAuthAt: Math.floor(Date.now() / 1000),
  });

  const graceNotice = requiresMfa && mfaState === "grace"
    ? {
        mfaState,
        graceUntil: graceUntil ? graceUntil.toISOString() : null,
        graceDaysLeft: graceDaysRemaining(graceUntil),
      }
    : {};
  const response = json({
    status: "verified",
    user: { id: account.membership.userId, role: account.membership.role, fullName: account.membership.fullName },
    business: { id: business.businessId, name: account.membership.businessName },
    ...graceNotice,
  });
  response.cookies.set(
    SESSION_COOKIE,
    sessionToken,
    sessionCookieOptions({
      telegramIdentityLinkId: account.linkId,
      telegramIdentityGeneration: account.linkGeneration,
    }),
  );
  return response;
}
