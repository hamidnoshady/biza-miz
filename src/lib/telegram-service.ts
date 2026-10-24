import { createHash, randomBytes, randomUUID } from "node:crypto";
import { query, withTenant, withTenantTransaction, withoutTenantScope, withoutTenantScopeTransaction } from "./db";
import { deploymentRole } from "./deployment-role";
import { readDeploymentProfile } from "./deployment-mode";
import { hostRoutingEnabled, businessHost } from "./host";
import { isFeatureEnabled } from "./features";
import { telegramConfig, TELEGRAM_LINK_CHALLENGE_SECONDS } from "./telegram-contract";
import type { SessionPayload } from "./auth-edge";
import { membershipForBusiness, membershipsForPlatformUser, type Membership } from "./memberships";
import {
  SECURITY_AUDIT_ACTIONS,
  recordSecurityAudit,
  transactionAuditExecutor,
} from "./security-audit";

export type TelegramUnavailableCode =
  | "telegram_disabled"
  | "telegram_not_configured"
  | "deployment_unsupported"
  | "cloud_only"
  | "feature_disabled";

export type TelegramAvailability =
  | { available: true; publicOrigin: string; rootDomain: string; botUsername: string }
  | { available: false; error: TelegramUnavailableCode };

/**
 * Fail closed unless this is the configured central Cloud service, the
 * business is explicitly Cloud (not Hybrid), and its existing integrations
 * entitlement is enabled.
 */
export async function telegramBusinessAvailability(
  businessId: string,
): Promise<TelegramAvailability> {
  const bot = telegramConfig();
  if (!bot.enabled) {
    return {
      available: false,
      error: bot.reason === "configuration_incomplete" ? "telegram_not_configured" : "telegram_disabled",
    };
  }
  if (deploymentRole() !== "central" || !hostRoutingEnabled()) {
    return { available: false, error: "deployment_unsupported" };
  }

  const businessAccess = await withTenant(businessId, async () => {
    const profile = await readDeploymentProfile(businessId);
    if (profile.profile !== "cloud") return "cloud_only" as const;
    if (!(await isFeatureEnabled(businessId, "integrations"))) return "feature_disabled" as const;
    return "available" as const;
  });
  if (businessAccess !== "available") return { available: false, error: businessAccess };

  return {
    available: true,
    publicOrigin: bot.config.publicOrigin,
    rootDomain: bot.config.rootDomain,
    botUsername: bot.config.botUsername,
  };
}

export interface TelegramLinkStatus {
  id: string;
  generation: number;
  linkedAt: Date;
  telegramUserId: string;
}

export async function activeTelegramLinkForPlatformUser(
  platformUserId: string,
): Promise<TelegramLinkStatus | null> {
  return withoutTenantScope("telegram-identity-auth", async () => {
    const { rows } = await query<{
      id: string;
      generation: number;
      linked_at: Date;
      telegram_user_id: string;
    }>(
      `SELECT id, generation, linked_at, telegram_user_id::text AS telegram_user_id
         FROM telegram_identity_links
        WHERE platform_user_id = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [platformUserId],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          generation: row.generation,
          linkedAt: row.linked_at,
          telegramUserId: row.telegram_user_id,
        }
      : null;
  });
}

export async function activeTelegramAccountForTelegramUser(telegramUserId: string): Promise<{
  linkId: string;
  platformUserId: string;
  generation: number;
  email: string;
  tokenVersion: number;
} | null> {
  return withoutTenantScope("telegram-identity-auth", async () => {
    const { rows } = await query<{
      link_id: string;
      platform_user_id: string;
      generation: number;
      email: string;
      token_version: number;
    }>(
      `SELECT l.id AS link_id, l.platform_user_id, l.generation,
              p.email::text AS email, p.token_version
         FROM telegram_identity_links l
         JOIN platform_users p ON p.id = l.platform_user_id
        WHERE l.telegram_user_id = $1
          AND l.revoked_at IS NULL
          AND p.is_active = true
        LIMIT 1`,
      [telegramUserId],
    );
    const row = rows[0];
    return row
      ? {
          linkId: row.link_id,
          platformUserId: row.platform_user_id,
          generation: row.generation,
          email: row.email,
          tokenVersion: row.token_version,
        }
      : null;
  });
}

export async function isTelegramIdentitySessionActive(input: {
  linkId: string;
  platformUserId: string;
  generation: number;
  businessId: string;
}): Promise<boolean> {
  if (deploymentRole() !== "central") return false;
  const linked = await withoutTenantScope("telegram-identity-auth", async () => {
    const { rows } = await query<{ active: boolean }>(
      `SELECT true AS active
         FROM telegram_identity_links
        WHERE id = $1
          AND platform_user_id = $2
          AND generation = $3
          AND revoked_at IS NULL
        LIMIT 1`,
      [input.linkId, input.platformUserId, input.generation],
    );
    return rows.length === 1;
  });
  if (!linked) return false;
  try {
    const membership = await withoutTenantScope("login", () =>
      membershipForBusiness(input.platformUserId, input.businessId),
    );
    if (!membership || membership.businessStatus !== "active") return false;
    return (await telegramBusinessAvailability(input.businessId)).available;
  } catch {
    return false;
  }
}

export async function issueTelegramLinkChallenge(
  session: SessionPayload,
): Promise<
  | { ok: true; challengeId: string; deepLink: string; expiresAt: string }
  | { ok: false; error: string }
> {
  const bot = telegramConfig();
  if (!bot.enabled) {
    return {
      ok: false,
      error: bot.reason === "configuration_incomplete" ? "telegram_not_configured" : "telegram_disabled",
    };
  }
  if (
    !session.platformUserId ||
    !session.employeeSessionId ||
    typeof session.tokenVersion !== "number" ||
    session.telegramIdentityLinkId
  ) {
    return { ok: false, error: "browser_identity_required" };
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await withTenantTransaction(session.businessId, async () => {
    await query(
      `DELETE FROM telegram_link_challenges
        WHERE business_id = $1 AND membership_id = $2
          AND (expires_at < now() - interval '1 day' OR consumed_at < now() - interval '1 day')`,
      [session.businessId, session.sub],
    );
    const { rows } = await query<{ id: string; expires_at: Date }>(
      `INSERT INTO telegram_link_challenges
         (business_id, membership_id, platform_user_id, employee_session_id,
          token_hash, token_version, expires_at)
       SELECT $1, u.id, p.id, es.id, $5, $6,
              now() + interval '1 second' * $7
         FROM users u
         JOIN platform_users p ON p.id = u.platform_user_id
         JOIN businesses b ON b.id = u.business_id
         JOIN employee_sessions es ON es.id = $4
                                  AND es.employee_id = u.id
                                  AND es.business_id = u.business_id
        WHERE u.business_id = $1
          AND u.id = $2
          AND p.id = $3
          AND p.is_active = true
          AND p.token_version = $6
          AND u.is_active = true
          AND b.status = 'active'
          AND es.revoked_at IS NULL
          AND es.expires_at > now()
       RETURNING id, expires_at`,
      [
        session.businessId,
        session.sub,
        session.platformUserId,
        session.employeeSessionId,
        tokenHash,
        session.tokenVersion,
        TELEGRAM_LINK_CHALLENGE_SECONDS,
      ],
    );
    const challenge = rows[0];
    if (!challenge) return { ok: false as const, error: "browser_identity_required" };
    await recordSecurityAudit(
      {
        realm: "tenant",
        action: SECURITY_AUDIT_ACTIONS.telegramLinkChallengeCreated,
        businessId: session.businessId,
        actorUserId: session.sub,
        platformUserId: session.platformUserId,
        entity: "telegram_link_challenge",
        entityId: challenge.id,
        payload: { expiresInSeconds: TELEGRAM_LINK_CHALLENGE_SECONDS },
      },
      transactionAuditExecutor(),
    );
    return challenge;
  });

  const deepLinkUrl = new URL(`https://t.me/${bot.config.botUsername}`);
  deepLinkUrl.searchParams.set("start", token);
  return {
    ok: true,
    challengeId: result.id,
    deepLink: deepLinkUrl.href,
    expiresAt: result.expires_at.toISOString(),
  };
}

export async function readTelegramConnectionStatus(input: {
  businessId: string;
  membershipId: string;
  platformUserId: string | null | undefined;
  challengeId?: string | null;
}): Promise<{
  linked: boolean;
  linkedAt: string | null;
  challenge: "pending" | "linked" | "expired" | null;
}> {
  if (!input.platformUserId) return { linked: false, linkedAt: null, challenge: null };
  const [link, challengeResult] = await Promise.all([
    activeTelegramLinkForPlatformUser(input.platformUserId),
    input.challengeId && isUuid(input.challengeId)
      ? query<{ state: "pending" | "linked" | "expired" }>(
          `SELECT CASE
                    WHEN consumed_at IS NOT NULL THEN 'linked'
                    WHEN expires_at <= now() THEN 'expired'
                    ELSE 'pending'
                  END AS state
             FROM telegram_link_challenges
            WHERE id = $1 AND business_id = $2 AND membership_id = $3
              AND platform_user_id = $4`,
          [input.challengeId, input.businessId, input.membershipId, input.platformUserId],
        )
      : Promise.resolve({ rows: [] as { state: "pending" | "linked" | "expired" }[] }),
  ]);
  return {
    linked: Boolean(link),
    linkedAt: link?.linkedAt.toISOString() ?? null,
    challenge: challengeResult.rows[0]?.state ?? null,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function revokeTelegramIdentityLink(session: SessionPayload): Promise<{
  unlinked: boolean;
  revokedSessionCount: number;
}> {
  if (!session.platformUserId) return { unlinked: false, revokedSessionCount: 0 };
  return withoutTenantScopeTransaction("telegram-identity-auth", async () => {
    const { rows: links } = await query<{ id: string }>(
      `UPDATE telegram_identity_links
          SET revoked_at = now(), generation = generation + 1
        WHERE platform_user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [session.platformUserId],
    );
    if (links.length === 0) return { unlinked: false, revokedSessionCount: 0 };

    const { rows: sessions } = await query<{ id: string }>(
      `UPDATE employee_sessions es
          SET revoked_at = now()
         FROM users u
        WHERE es.employee_id = u.id
          AND es.business_id = u.business_id
          AND u.platform_user_id = $1
          AND es.login_method = 'telegram'
          AND es.revoked_at IS NULL
        RETURNING es.id`,
      [session.platformUserId],
    );
    await recordSecurityAudit(
      {
        realm: "tenant",
        action: SECURITY_AUDIT_ACTIONS.telegramIdentityUnlinked,
        businessId: session.businessId,
        actorUserId: session.sub,
        platformUserId: session.platformUserId,
        entity: "telegram_identity_link",
        entityId: links[0].id,
        payload: { revokedSessionCount: sessions.length },
      },
      transactionAuditExecutor(),
    );
    return { unlinked: true, revokedSessionCount: sessions.length };
  });
}

export type TelegramLinkRedemption =
  | { ok: true; linkId: string; platformUserId: string; alreadyLinked: boolean }
  | { ok: false; error: "invalid_or_expired_link" | "identity_already_linked" | "telegram_account_already_linked" };

export async function redeemTelegramLinkChallenge(
  token: string,
  telegramUserId: string,
): Promise<TelegramLinkRedemption> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !/^\d{1,16}$/.test(telegramUserId)) {
    return { ok: false, error: "invalid_or_expired_link" };
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");

  return withoutTenantScopeTransaction("telegram-identity-auth", async () => {
    const { rows: challenges } = await query<{
      id: string;
      business_id: string;
      membership_id: string;
      platform_user_id: string;
      employee_session_id: string;
      token_version: number;
      session_live: boolean;
      consumed_at: Date | null;
      consumed_by_link_id: string | null;
    }>(
      `SELECT c.id, c.business_id, c.membership_id, c.platform_user_id,
              c.employee_session_id, c.token_version, c.consumed_at, c.consumed_by_link_id,
              (pu.is_active
               AND pu.token_version = c.token_version
               AND u.is_active
               AND b.status = 'active'
               AND es.revoked_at IS NULL
               AND es.expires_at > now()) AS session_live
         FROM telegram_link_challenges c
         JOIN platform_users pu ON pu.id = c.platform_user_id
         JOIN users u ON u.id = c.membership_id AND u.business_id = c.business_id
         JOIN businesses b ON b.id = c.business_id
         JOIN employee_sessions es ON es.id = c.employee_session_id
                                  AND es.employee_id = c.membership_id
                                  AND es.business_id = c.business_id
        WHERE c.token_hash = $1
          AND (c.consumed_at IS NOT NULL OR c.expires_at > now())
        FOR UPDATE OF c`,
      [tokenHash],
    );
    const challenge = challenges[0];
    if (!challenge) return { ok: false, error: "invalid_or_expired_link" };
    if (challenge.consumed_at) {
      if (!challenge.consumed_by_link_id) return { ok: false, error: "invalid_or_expired_link" };
      const { rows: activeConsumedLink } = await query<{ id: string }>(
        `SELECT id FROM telegram_identity_links
          WHERE id = $1 AND platform_user_id = $2 AND telegram_user_id = $3
            AND revoked_at IS NULL
          LIMIT 1`,
        [challenge.consumed_by_link_id, challenge.platform_user_id, telegramUserId],
      );
      return activeConsumedLink[0]
        ? {
            ok: true,
            linkId: activeConsumedLink[0].id,
            platformUserId: challenge.platform_user_id,
            alreadyLinked: true,
          }
        : { ok: false, error: "invalid_or_expired_link" };
    }
    if (!challenge.session_live) return { ok: false, error: "invalid_or_expired_link" };

    const { rows: identityLinks } = await query<{
      id: string;
      platform_user_id: string;
      telegram_user_id: string;
    }>(
      `SELECT id, platform_user_id, telegram_user_id::text AS telegram_user_id
         FROM telegram_identity_links
        WHERE platform_user_id = $1 AND revoked_at IS NULL
        FOR UPDATE`,
      [challenge.platform_user_id],
    );
    const existingForIdentity = identityLinks[0];
    if (existingForIdentity) {
      if (existingForIdentity.telegram_user_id !== telegramUserId) {
        return { ok: false, error: "identity_already_linked" };
      }
      await query(
        `UPDATE telegram_link_challenges
            SET consumed_at = now(), consumed_by_link_id = $2
          WHERE id = $1`,
        [challenge.id, existingForIdentity.id],
      );
      return {
        ok: true,
        linkId: existingForIdentity.id,
        platformUserId: challenge.platform_user_id,
        alreadyLinked: true,
      };
    }

    const { rows: identityForTelegram } = await query<{ id: string }>(
      `SELECT id FROM telegram_identity_links
        WHERE telegram_user_id = $1 AND revoked_at IS NULL
        FOR UPDATE`,
      [telegramUserId],
    );
    if (identityForTelegram.length > 0) {
      return { ok: false, error: "telegram_account_already_linked" };
    }

    const linkId = randomUUID();
    const { rows: inserted } = await query<{ id: string; generation: number }>(
      `INSERT INTO telegram_identity_links (id, platform_user_id, telegram_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id, generation`,
      [linkId, challenge.platform_user_id, telegramUserId],
    );
    if (inserted.length === 0) {
      return { ok: false, error: "telegram_account_already_linked" };
    }

    await query(
      `UPDATE telegram_link_challenges
          SET consumed_at = now(), consumed_by_link_id = $2
        WHERE id = $1`,
      [challenge.id, linkId],
    );
    const { rows: sessions } = await query<{ id: string }>(
      `UPDATE employee_sessions es
          SET revoked_at = now()
         FROM users u
        WHERE es.employee_id = u.id
          AND es.business_id = u.business_id
          AND u.platform_user_id = $1
          AND es.login_method = 'telegram'
          AND es.revoked_at IS NULL
        RETURNING es.id`,
      [challenge.platform_user_id],
    );
    await recordSecurityAudit(
      {
        realm: "tenant",
        action: SECURITY_AUDIT_ACTIONS.telegramIdentityLinked,
        businessId: challenge.business_id,
        actorUserId: challenge.membership_id,
        platformUserId: challenge.platform_user_id,
        entity: "telegram_identity_link",
        entityId: linkId,
        payload: { revokedSessionCount: sessions.length },
      },
      transactionAuditExecutor(),
    );
    return {
      ok: true,
      linkId,
      platformUserId: challenge.platform_user_id,
      alreadyLinked: false,
    };
  });
}

export async function consumeTelegramInitData(input: {
  replayKey: string;
  telegramUserId: string;
  linkId: string;
  expiresAt: Date;
}): Promise<boolean> {
  return withoutTenantScopeTransaction("telegram-identity-auth", async () => {
    await query(
      `DELETE FROM telegram_init_data_replays WHERE expires_at < now() - interval '15 minutes'`,
    );
    const { rows } = await query<{ init_data_hash: string }>(
      `INSERT INTO telegram_init_data_replays
         (init_data_hash, telegram_user_id, link_id, expires_at)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (
          SELECT 1 FROM telegram_identity_links
           WHERE id = $3 AND telegram_user_id = $2 AND revoked_at IS NULL
        )
       ON CONFLICT (init_data_hash) DO NOTHING
       RETURNING init_data_hash`,
      [input.replayKey, input.telegramUserId, input.linkId, input.expiresAt],
    );
    return rows.length === 1;
  });
}

export type TelegramWebhookReservation =
  | { status: "reserved"; attemptCount: number }
  | { status: "processed" | "in_progress" };

export async function reserveTelegramWebhookUpdate(updateId: number): Promise<TelegramWebhookReservation> {
  return withoutTenantScopeTransaction("telegram-identity-auth", async () => {
    await query(
      `DELETE FROM telegram_webhook_updates
        WHERE (created_at < now() - interval '30 days'
               AND status IN ('processed', 'failed'))
           OR (status = 'processing'
               AND processing_started_at < now() - interval '30 days')`,
    );
    const { rows } = await query<{ attempt_count: number }>(
      `INSERT INTO telegram_webhook_updates (update_id, status)
       VALUES ($1, 'processing')
       ON CONFLICT (update_id) DO UPDATE
         SET status = 'processing',
             attempt_count = telegram_webhook_updates.attempt_count + 1,
             processing_started_at = now(),
             finished_at = NULL,
             last_error_code = NULL,
             updated_at = now()
       WHERE telegram_webhook_updates.status = 'failed'
          OR (telegram_webhook_updates.status = 'processing'
              AND telegram_webhook_updates.processing_started_at < now() - interval '2 minutes')
       RETURNING attempt_count`,
      [updateId],
    );
    if (rows[0]) return { status: "reserved", attemptCount: rows[0].attempt_count };

    const { rows: existing } = await query<{ status: "processing" | "processed" | "failed" }>(
      `SELECT status FROM telegram_webhook_updates WHERE update_id = $1`,
      [updateId],
    );
    return existing[0]?.status === "processed"
      ? { status: "processed" }
      : { status: "in_progress" };
  });
}

export async function finishTelegramWebhookUpdate(
  updateId: number,
  attemptCount: number,
  result: { ok: true } | { ok: false; errorCode: string },
): Promise<void> {
  const errorCode = result.ok
    ? null
    : /^[a-z0-9_]{1,64}$/.test(result.errorCode)
      ? result.errorCode
      : "processing_failed";
  await withoutTenantScope("telegram-identity-auth", () =>
    query(
      `UPDATE telegram_webhook_updates
          SET status = $3,
              last_error_code = $4,
              finished_at = now(),
              updated_at = now()
        WHERE update_id = $1
          AND attempt_count = $2
          AND status = 'processing'`,
      [updateId, attemptCount, result.ok ? "processed" : "failed", errorCode],
    ),
  );
}

export async function listTelegramBusinessLaunches(platformUserId: string): Promise<{
  businesses: { name: string; url: string }[];
  publicOrigin: string;
}> {
  const bot = telegramConfig();
  if (!bot.enabled || deploymentRole() !== "central" || !hostRoutingEnabled()) {
    return { businesses: [], publicOrigin: bot.enabled ? bot.config.publicOrigin : "" };
  }
  const memberships = await withoutTenantScope("login", () =>
    membershipsForPlatformUser(platformUserId),
  );
  const active = memberships.filter((membership) => membership.businessStatus === "active");
  const availability = await Promise.all(
    active.map(async (membership) => ({
      membership,
      access: await telegramBusinessAvailability(membership.businessId),
    })),
  );
  const businesses = availability.flatMap(({ membership, access }) => {
    if (!access.available || !isSafeBusinessLabel(membership.businessSubdomain)) return [];
    const host = businessHost(membership.businessSubdomain, access.rootDomain);
    return [{ name: membership.businessName, url: `https://${host}/telegram` }];
  });
  return { businesses, publicOrigin: bot.config.publicOrigin };
}

function isSafeBusinessLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);
}

export async function telegramAccountForSessionExchange(input: {
  telegramUserId: string;
  businessId: string;
}): Promise<{
  platformUserId: string;
  linkId: string;
  linkGeneration: number;
  tokenVersion: number;
  email: string;
  membership: Membership;
} | null> {
  const linked = await activeTelegramAccountForTelegramUser(input.telegramUserId);
  if (!linked) return null;
  const membership = await withoutTenantScope("login", () =>
    membershipForBusiness(linked.platformUserId, input.businessId),
  );
  if (!membership || membership.businessStatus !== "active") return null;
  return {
    platformUserId: linked.platformUserId,
    linkId: linked.linkId,
    linkGeneration: linked.generation,
    tokenVersion: linked.tokenVersion,
    email: linked.email,
    membership,
  };
}
