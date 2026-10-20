/** Notification persistence, leased fanout and durable grouped Web/Native Push.
 * Producers only enqueue. Every disclosure rechecks current authorization.
 * Leases, unique recipient/device keys and stable batch tags recover crashes;
 * provider acceptance is observable, browser presentation is not guaranteed.
 */
import { accessibleLocationIds } from "./location-access";
import type { Role } from "./auth";
import { query, withoutTenantScope, withTenant, withTenantTransaction } from "./db";
import { pushEndpoint, postWebPush } from "./notification-transport";
import {
  canReceiveNotification,
  notificationAuthorizationCache,
} from "./notification-authorization";
import { isUuid } from "./uuid";
import { randomUUID, ECDH } from "node:crypto";
import {
  defaultRuleFor,
  isNotificationChannel,
  isNotificationEventKey,
  isNotificationSeverity,
  localMinutesOfDay,
  NOTIFICATION_EVENTS,
  pushPayloadFor,
  notificationDigestContent,
  resolveRecipients,
  validateRuleInput,
  type NotificationChannel,
  type NotificationEventKey,
  type NotificationMember,
  type NotificationRule,
  type NotificationRuleInput,
  type NotificationSeverity,
} from "./notifications";
import {
  buildPushRequest,
  classifyPushStatus,
  fromBase64Url,
  generateVapidKeys,
  type PushOutcome,
} from "./web-push";

export { recordNotification } from "./notification-events";

/** How often the outbox is drained. A notification that matters is worth ~15s. */
export const NOTIFICATION_TICK_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// The VAPID identity
// ---------------------------------------------------------------------------

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * The deployment's VAPID pair, generated on first use.
 *
 * `withoutTenantScope("platform")` for the same reason the platform AI config
 * uses it: `platform_push_config` holds one deployment-wide key pair, carries no
 * `business_id`, and is administered across every tenant by definition.
 *
 * Generated rather than configured because the alternative is worse than it
 * looks: an on-site install has no operator to run a key-generation step, so a
 * notification system that required one would simply be switched off on every
 * such install, silently. `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` still win when
 * set, which is what lets a fleet share one identity.
 *
 * Rotating the pair invalidates every existing subscription, so the row is
 * written exactly once — `ON CONFLICT DO NOTHING` plus a re-read, not an upsert.
 */
export async function getPushConfig(): Promise<PushConfig | null> {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:admin@example.com";
  if (envPublic && envPrivate) {
    return { publicKey: envPublic, privateKey: envPrivate, subject };
  }

  return withoutTenantScope("platform", async () => {
    const existing = await query<{ public_key: string; private_key: string; subject: string }>(
      "SELECT public_key, private_key, subject FROM platform_push_config WHERE id = true",
    );
    if (existing.rows[0]) {
      return {
        publicKey: existing.rows[0].public_key,
        privateKey: existing.rows[0].private_key,
        subject: existing.rows[0].subject,
      };
    }

    const keys = generateVapidKeys();
    await query(
      `INSERT INTO platform_push_config (id, public_key, private_key, subject)
       VALUES (true, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [keys.publicKey, keys.privateKey, subject],
    );
    // Re-read rather than returning what we just generated: another process may
    // have won the insert, and handing out a public key that is not the stored
    // one would mint subscriptions nothing can ever push to.
    const stored = await query<{ public_key: string; private_key: string; subject: string }>(
      "SELECT public_key, private_key, subject FROM platform_push_config WHERE id = true",
    );
    const row = stored.rows[0];
    return row
      ? { publicKey: row.public_key, privateKey: row.private_key, subject: row.subject }
      : null;
  });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type DevicePlatform = "ios" | "android" | "windows" | "macos" | "linux" | "other";

const DEVICE_PLATFORMS: readonly string[] = [
  "ios",
  "android",
  "windows",
  "macos",
  "linux",
  "other",
];

export interface NotificationDevice {
  id: string;
  endpoint: string;
  disabledAt: string | null;
  platform: DevicePlatform;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  lastError: string | null;
}

const DEVICE_COLUMNS = `id, endpoint, platform, label, created_at::text AS created_at,
                        last_success_at::text AS last_success_at, failure_count, last_error, disabled_at::text AS disabled_at, last_failure_at::text AS last_failure_at`;

export async function listNotificationDevices(
  businessId: string,
  userId: string,
): Promise<NotificationDevice[]> {
  const { rows } = await query<{
    id: string;
    endpoint: string;
    platform: string;
    label: string;
    created_at: string;
    last_success_at: string | null;
    last_failure_at: string | null;
    failure_count: number;
    last_error: string | null;
    disabled_at: string | null;
  }>(
    `SELECT ${DEVICE_COLUMNS.replace(
      "disabled_at::text AS disabled_at",
      `CASE WHEN disabled_at IS NOT NULL THEN disabled_at::text
        WHEN NOT EXISTS (SELECT 1 FROM employee_sessions s WHERE s.id=session_id AND s.business_id=notification_devices.business_id
          AND s.employee_id=user_id AND s.revoked_at IS NULL AND s.expires_at>now()) THEN now()::text ELSE NULL END AS disabled_at`,
    )} FROM notification_devices
      WHERE business_id = $1 AND user_id = $2
      ORDER BY created_at DESC`,
    [businessId, userId],
  );
  return rows.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    disabledAt: row.disabled_at,
    platform: row.platform as DevicePlatform,
    label: row.label,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    failureCount: row.failure_count,
    lastError: row.last_error,
  }));
}

export interface RegisterDeviceInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  platform?: string;
  label?: string;
  userAgent?: string;
  sessionId?: string;
}

export type RegisterDeviceResult =
  { ok: true; device: NotificationDevice } | { ok: false; error: string };

/**
 * Claims a browser's push subscription for this member.
 *
 * Keyed on the endpoint, which is globally unique and is the push service's own
 * name for the subscription — so re-subscribing (which a browser does on its own
 * schedule) updates the row rather than accumulating dead ones, and a shared
 * tablet that changes hands moves to the new person instead of quietly pushing
 * one member's till figures to another's lock screen.
 */
export async function registerNotificationDevice(
  businessId: string,
  userId: string,
  input: RegisterDeviceInput,
): Promise<RegisterDeviceResult> {
  const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
  const p256dh = typeof input.p256dh === "string" ? input.p256dh.trim() : "";
  const auth = typeof input.auth === "string" ? input.auth.trim() : "";
  if (!endpoint || !p256dh || !auth) return { ok: false, error: "notification_device_invalid" };
  // `https://` was the whole check here, which made this the app's most reachable
  // SSRF: any signed-in member could register an "endpoint" of
  // `https://10.0.0.5:8120/` and have the notification tick POST to it from inside
  // the private network, learning from `notification_deliveries.last_error` which
  // internal ports answered. A real push endpoint is a public URL belonging to
  // Apple, Google, Microsoft or Mozilla. Keep the provider policy in one
  // place so registration and delivery accept the same browser endpoint forms.
  if (!pushEndpoint(endpoint) || !input.sessionId) {
    return { ok: false, error: "notification_device_invalid" };
  }
  // Reject a subscription whose keys cannot encrypt, here rather than at send
  // time: a stored row that can never be pushed to is a device the settings
  // screen would show as working forever.
  if (
    !/^[A-Za-z0-9_-]{87}$/.test(p256dh) ||
    !/^[A-Za-z0-9_-]{22}$/.test(auth) ||
    fromBase64Url(p256dh).length !== 65 ||
    fromBase64Url(auth).length !== 16
  ) {
    return { ok: false, error: "notification_device_invalid" };
  }

  try {
    ECDH.convertKey(fromBase64Url(p256dh), "prime256v1");
  } catch {
    return { ok: false, error: "notification_device_invalid" };
  }
  const { rows: counts } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notification_devices
    WHERE business_id=$1 AND user_id=$2 AND endpoint<>$3`,
    [businessId, userId, endpoint],
  );
  if (counts[0].n >= 20) return { ok: false, error: "notification_device_limit" };

  const platform = DEVICE_PLATFORMS.includes(input.platform ?? "") ? input.platform! : "other";

  const { rows } = await query<{
    id: string;
    endpoint: string;
    platform: string;
    label: string;
    created_at: string;
    last_success_at: string | null;
    last_failure_at: string | null;
    failure_count: number;
    last_error: string | null;
    disabled_at: string | null;
  }>(
    `INSERT INTO notification_devices
       (business_id, user_id, endpoint, p256dh, auth, platform, label, user_agent, session_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, id FROM employee_sessions
     WHERE id = $9 AND business_id = $1 AND employee_id = $2 AND revoked_at IS NULL AND expires_at > now()
     ON CONFLICT (endpoint) DO UPDATE
       SET business_id = EXCLUDED.business_id,
           user_id = EXCLUDED.user_id,
           session_id = EXCLUDED.session_id,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           platform = EXCLUDED.platform,
           label = EXCLUDED.label,
           user_agent = EXCLUDED.user_agent,
           last_seen_at = now(),
           -- A browser that re-subscribed is alive, whatever the old row said.
           failure_count = 0,
           last_error = NULL,
           disabled_at = NULL
     RETURNING ${DEVICE_COLUMNS}`,
    [
      businessId,
      userId,
      endpoint,
      p256dh,
      auth,
      platform,
      (input.label ?? "").slice(0, 100),
      (input.userAgent ?? "").slice(0, 400),
      input.sessionId,
    ],
  );

  const row = rows[0];
  if (!row) return { ok: false, error: "notification_device_invalid" };
  return {
    ok: true,
    device: {
      id: row.id,
      endpoint: row.endpoint,
      disabledAt: row.disabled_at,
      platform: row.platform as DevicePlatform,
      label: row.label,
      createdAt: row.created_at,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      failureCount: row.failure_count,
      lastError: row.last_error,
    },
  };
}

/** Forgets one of the caller's own devices — "stop notifying this phone". */
export async function removeNotificationDevice(
  businessId: string,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM notification_devices WHERE business_id = $1 AND user_id = $2 AND id = $3`,
    [businessId, userId, deviceId],
  );
  return (rowCount ?? 0) > 0;
}

/** Same, keyed on the endpoint — what the browser has when a subscription lapses. */
export async function removeNotificationDeviceByEndpoint(
  businessId: string,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM notification_devices WHERE business_id = $1 AND user_id = $2 AND endpoint = $3`,
    [businessId, userId, endpoint],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface RuleRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  event_key: string;
  location_id: string | null;
  enabled: boolean;
  channels: string[];
  min_severity: string;
  min_amount_rial: string | number | null;
  quiet_from_minutes: number | null;
  quiet_to_minutes: number | null;
}

function toRule(row: RuleRow): NotificationRule {
  return {
    id: row.id,
    userId: row.user_id,
    eventKey: row.event_key as NotificationEventKey,
    locationId: row.location_id,
    enabled: row.enabled,
    channels: row.channels.filter(isNotificationChannel),
    minSeverity: row.min_severity as NotificationSeverity,
    // bigint arrives as a string from node-postgres; a rule threshold silently
    // becoming "50000000" and comparing as a string is the classic bug here.
    minAmountRial: row.min_amount_rial === null ? null : Number(row.min_amount_rial),
    quietFromMinutes: row.quiet_from_minutes,
    quietToMinutes: row.quiet_to_minutes,
  };
}

const RULE_COLUMNS = `id, user_id, event_key, location_id, enabled, channels, min_severity,
                      min_amount_rial, quiet_from_minutes, quiet_to_minutes`;

/** One member's own rules — what the settings screen renders. */
export async function listNotificationRules(
  businessId: string,
  userId: string,
): Promise<NotificationRule[]> {
  const { rows } = await query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM notification_rules
      WHERE business_id = $1 AND user_id = $2
      ORDER BY event_key, location_id NULLS FIRST`,
    [businessId, userId],
  );
  return rows.map(toRule);
}

export type SaveRuleResult = { ok: true; rule: NotificationRule } | { ok: false; errors: string[] };

/**
 * Writes one member's rule for one event (and optionally one branch).
 *
 * An upsert rather than create/update, because from the settings screen's point
 * of view there is only ever "this is what I want for this event" — the UNIQUE
 * (user, event, location) index is what makes that one row.
 */
export async function saveNotificationRule(
  businessId: string,
  userId: string,
  input: Partial<NotificationRuleInput>,
): Promise<SaveRuleResult> {
  if (input.locationId != null && !isUuid(input.locationId))
    return { ok: false, errors: ["notification_rule_invalid"] };
  if (input.locationId) {
    const member = (await businessMembers(businessId)).find((m) => m.userId === userId);
    if (!member?.locationIds.includes(input.locationId))
      return { ok: false, errors: ["notification_rule_invalid"] };
  }
  const errors = validateRuleInput(input);
  if (errors.length > 0) return { ok: false, errors };

  const channels = (input.channels ?? []).filter(isNotificationChannel);
  const { rows } = await query<RuleRow>(
    `INSERT INTO notification_rules
       (business_id, user_id, event_key, location_id, enabled, channels, min_severity,
        min_amount_rial, quiet_from_minutes, quiet_to_minutes)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10)
     ON CONFLICT (user_id, event_key, location_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           channels = EXCLUDED.channels,
           min_severity = EXCLUDED.min_severity,
           min_amount_rial = EXCLUDED.min_amount_rial,
           quiet_from_minutes = EXCLUDED.quiet_from_minutes,
           quiet_to_minutes = EXCLUDED.quiet_to_minutes,
           updated_at = now()
     RETURNING ${RULE_COLUMNS}`,
    [
      businessId,
      userId,
      input.eventKey,
      input.locationId ?? null,
      input.enabled ?? true,
      channels,
      input.minSeverity ?? "info",
      input.minAmountRial ?? null,
      input.quietFromMinutes ?? null,
      input.quietToMinutes ?? null,
    ],
  );
  return { ok: true, rule: toRule(rows[0]) };
}

/** Deleting a rule restores the catalogue default for that event — it is not "off". */
export async function deleteNotificationRule(
  businessId: string,
  userId: string,
  ruleId: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM notification_rules WHERE business_id = $1 AND user_id = $2 AND id = $3`,
    [businessId, userId, ruleId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * What the settings screen shows: every event in the catalogue, with the rule
 * governing it — the member's own if they wrote one, otherwise the default
 * they are currently living under. Resolving that here rather than in the
 * component is what keeps the screen from having to re-implement
 * `defaultRuleFor` and drift from it.
 */
export async function notificationPreferences(
  businessId: string,
  userId: string,
  role: Role,
  locationId: string | null = null,
): Promise<
  {
    eventKey: NotificationEventKey;
    ruleId: string | null;
    isDefault: boolean;
    enabled: boolean;
    channels: NotificationChannel[];
    minSeverity: NotificationSeverity;
    minAmountRial: number | null;
    quietFromMinutes: number | null;
    quietToMinutes: number | null;
  }[]
> {
  const rules = await listNotificationRules(businessId, userId);
  // Branch-specific rule > all-branch rule > role default.
  const byEvent = new Map(
    rules.filter((rule) => rule.locationId === null).map((rule) => [rule.eventKey, rule]),
  );
  const scoped = new Map(
    rules.filter((rule) => rule.locationId === locationId).map((rule) => [rule.eventKey, rule]),
  );

  return Object.values(NOTIFICATION_EVENTS)
    .filter((meta) => meta.key !== "system.test")
    .map((meta) => {
      const ownRule = scoped.get(meta.key);
      const rule = ownRule ?? byEvent.get(meta.key);
      if (rule) {
        return {
          eventKey: meta.key,
          ruleId: ownRule?.id ?? null,
          isDefault: !ownRule,
          enabled: rule.enabled,
          channels: rule.channels,
          minSeverity: rule.minSeverity,
          minAmountRial: rule.minAmountRial,
          quietFromMinutes: rule.quietFromMinutes,
          quietToMinutes: rule.quietToMinutes,
        };
      }
      const fallback = defaultRuleFor(meta.key, role);
      return {
        eventKey: meta.key,
        ruleId: null,
        isDefault: true,
        enabled: fallback.enabled,
        channels: fallback.channels,
        minSeverity: fallback.minSeverity,
        minAmountRial: fallback.minAmountRial,
        quietFromMinutes: fallback.quietFromMinutes,
        quietToMinutes: fallback.quietToMinutes,
      };
    });
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

export interface InboxEntry {
  id: string;
  eventKey: NotificationEventKey;
  severity: NotificationSeverity;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  readAt: string | null;
}

async function authorizedInboxRows(businessId: string, userId: string) {
  const { rows } = await query<
    OutboxRow & { recipient_id: string; created_at: string; read_at: string | null }
  >(
    `SELECT e.*,r.id AS recipient_id,r.created_at::text AS created_at,r.read_at::text AS read_at
     FROM notification_recipients r JOIN notification_events e ON e.id=r.event_id AND e.business_id=r.business_id
     WHERE r.business_id=$1 AND r.user_id=$2 ORDER BY r.created_at DESC`,
    [businessId, userId],
  );
  const visible = [];
  const canReceive = notificationAuthorizationCache();
  for (const row of rows) {
    if (await canReceive(businessId, userId, row)) visible.push(row);
  }
  return visible;
}

export async function listNotificationInbox(
  businessId: string,
  userId: string,
  limit = 50,
): Promise<{ entries: InboxEntry[]; unread: number }> {
  const visible = await authorizedInboxRows(businessId, userId);
  return {
    entries: visible.slice(0, Math.min(Math.max(limit, 1), 200)).map((row) => ({
      id: row.recipient_id,
      eventKey: row.event_key as NotificationEventKey,
      severity: row.severity as NotificationSeverity,
      title: row.title,
      body: row.body,
      url: safeNotificationPath(row.url),
      createdAt: row.created_at,
      readAt: row.read_at,
    })),
    unread: visible.filter((row) => !row.read_at).length,
  };
}

/** Marks one entry read, or every unread entry when `id` is omitted. */
export async function markNotificationsRead(
  businessId: string,
  userId: string,
  id?: string,
): Promise<number> {
  if (id !== undefined && !isUuid(id)) return 0;
  const rows = await authorizedInboxRows(businessId, userId);
  const ids = rows
    .filter((row) => !row.read_at && (id === undefined || row.recipient_id === id))
    .map((row) => row.recipient_id);
  if (!ids.length) return 0;
  const { rowCount } = await query(
    `UPDATE notification_recipients SET read_at=now()
    WHERE business_id=$1 AND user_id=$2 AND id=ANY($3::uuid[]) AND read_at IS NULL`,
    [businessId, userId, ids],
  );
  return rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

interface DeviceRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  endpoint: string;
  native_token?: string;
  native_channels?: string[];
  p256dh: string;
  auth: string;
}

interface SendResult {
  outcome: PushOutcome;
  status: number | null;
  error: string | null;
}

/**
 * One HTTPS POST to one push service.
 *
 * Never throws: a push service being unreachable is an ordinary Tuesday, and it
 * must degrade to a recorded failure rather than aborting the rest of the
 * batch. The timeout matters for the same reason — an unresponsive endpoint
 * would otherwise hold the tick open until Node's default gives up.
 */
async function sendPush(input: {
  device: DeviceRow;
  config: PushConfig;
  payload: string;
  urgency: "very-low" | "low" | "normal" | "high";
  topic: string;
}): Promise<SendResult> {
  let request;
  try {
    request = buildPushRequest({
      subscription: {
        endpoint: input.device.endpoint,
        p256dh: input.device.p256dh,
        auth: input.device.auth,
      },
      payload: input.payload,
      vapid: input.config,
      urgency: input.urgency,
      topic: input.topic,
    });
  } catch (error) {
    // A subscription whose keys will not encrypt is permanently unusable, so
    // this is `rejected`, not something to retry until the heat death.
    return {
      outcome: "rejected",
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Re-checked here and not only at registration: this is the moment the request
  // actually leaves, and the name in a row stored days ago may resolve somewhere
  // else by now.
  if (!pushEndpoint(request.url)) {
    return { outcome: "rejected", status: null, error: "notification_endpoint_rejected" };
  }

  try {
    const status = await postWebPush(request.url, request.headers, request.body);
    return {
      outcome: classifyPushStatus(status),
      status,
      error: status >= 200 && status < 300 ? null : `HTTP ${status}`,
    };
  } catch (error) {
    return {
      outcome: "retry",
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

interface OutboxRow extends Record<string, unknown> {
  id: string;
  location_id: string | null;
  event_key: string;
  severity: string;
  title: string;
  body: string;
  url: string;
  amount_rial: string | number | null;
  dedupe_key: string;
  payload: Record<string, unknown>;
}

/** Every active member of the business, with the branches they may act in. */
async function businessMembers(businessId: string): Promise<NotificationMember[]> {
  const [{ rows: users }, { rows: locations }, { rows: assignments }] = await Promise.all([
    query<{
      id: string;
      role: Role;
      location_id: string | null;
      location_scope: "all" | "selected" | "home" | "none";
    }>(
      `SELECT id, role, location_id, location_scope
         FROM users
        WHERE business_id = $1 AND is_active AND membership_status = 'active'`,
      [businessId],
    ),
    query<{ id: string }>(
      `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at`,
      [businessId],
    ),
    query<{ user_id: string; location_id: string }>(
      `SELECT ul.user_id, ul.location_id
         FROM user_locations ul
         JOIN users u ON u.id = ul.user_id
        WHERE u.business_id = $1`,
      [businessId],
    ),
  ]);

  const businessLocationIds = locations.map((row) => row.id);
  const assigned = new Map<string, string[]>();
  for (const row of assignments) {
    const list = assigned.get(row.user_id) ?? [];
    list.push(row.location_id);
    assigned.set(row.user_id, list);
  }

  return users.map((user) => ({
    userId: user.id,
    role: user.role,
    locationIds: accessibleLocationIds(
      {
        role: user.role,
        locationScope: user.location_scope,
        defaultLocationId: user.location_id,
        assignedLocationIds: assigned.get(user.id) ?? [],
      },
      businessLocationIds,
    ),
  }));
}

async function branchTimezone(businessId: string, locationId: string | null): Promise<string> {
  const { rows } = locationId
    ? await query<{ timezone: string }>(
        `SELECT timezone FROM locations WHERE id = $1 AND business_id = $2`,
        [locationId, businessId],
      )
    : await query<{ timezone: string }>(
        `SELECT timezone FROM locations WHERE business_id = $1 AND is_active
          ORDER BY created_at LIMIT 1`,
        [businessId],
      );
  // A business with no branch yet still has notifications worth sending (a
  // failed backup during setup); Tehran is the product's own default.
  return rows[0]?.timezone || "Asia/Tehran";
}

function urgencyFor(severity: NotificationSeverity): "low" | "normal" | "high" {
  if (severity === "critical") return "high";
  return severity === "important" ? "normal" : "low";
}

export type NativeFcmCategory =
  "orders" | "payments" | "crm" | "inventory" | "approvals" | "operations" | "security";

export function mapNotificationEventToNativeCategory(eventKey: string): NativeFcmCategory {
  if (eventKey.startsWith("orders.") || eventKey.startsWith("pos.")) return "orders";
  if (
    eventKey.startsWith("accounting.") ||
    eventKey.startsWith("receipts.") ||
    eventKey.startsWith("payments.") ||
    eventKey.startsWith("checks.")
  ) {
    return "payments";
  }
  if (eventKey.startsWith("crm.") || eventKey.startsWith("customers.")) return "crm";
  if (eventKey.startsWith("inventory.") || eventKey.startsWith("stock.")) return "inventory";
  if (eventKey.startsWith("approvals.") || eventKey.startsWith("shift.")) return "approvals";
  if (eventKey.startsWith("security.") || eventKey.startsWith("auth.")) return "security";
  return "operations";
}

export function buildNativeFcmPayload(input: {
  businessId: string;
  eventId: string;
  eventKey: string;
  title: string;
  body: string;
  url: string;
  pushToken: string;
}): {
  message: {
    token: string;
    data: {
      businessId: string;
      eventId: string;
      eventType: string;
      category: NativeFcmCategory;
      title: string;
      body: string;
      path: string;
    };
  };
} {
  const category = mapNotificationEventToNativeCategory(input.eventKey);
  const cleanPath =
    input.url.startsWith("/") && !input.url.startsWith("//") ? input.url : "/dashboard";
  return {
    message: {
      token: input.pushToken,
      data: {
        businessId: input.businessId,
        eventId: input.eventId,
        eventType: input.eventKey,
        category,
        title: input.title.slice(0, 120),
        body: input.body.slice(0, 240),
        path: cleanPath.slice(0, 256),
      },
    },
  };
}

async function sendNativePush(
  businessId: string,
  device: DeviceRow,
  event: OutboxRow,
): Promise<SendResult> {
  const projectId =
    process.env.BIZA_FIREBASE_PROJECT_ID?.trim() || process.env.FIREBASE_PROJECT_ID?.trim();
  const accessToken = process.env.BIZA_FCM_ACCESS_TOKEN?.trim();
  if (!projectId || !accessToken)
    return { outcome: "retry", status: null, error: "notification_native_unconfigured" };
  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
      {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(
          buildNativeFcmPayload({
            businessId,
            eventId: event.id,
            eventKey: event.event_key,
            title: event.title,
            body: event.body,
            url: event.url,
            pushToken: device.native_token!,
          }),
        ),
        signal: AbortSignal.timeout(10_000),
      },
    );
    return {
      outcome: classifyPushStatus(response.status),
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch {
    return { outcome: "retry", status: null, error: "notification_native_network" };
  }
}

/**
 * Fans one outbox row out to its recipients, then pushes.
 *
 * The bell row is written for everyone the rules admit, including anybody whose
 * quiet window covers this moment — «ساکت» means "do not wake me", not "do not
 * tell me". Only the push is suppressed, and that suppression is recorded as a
 * `quiet` delivery so "why didn't my phone buzz" has an answer.
 */
async function deliverEvent(
  businessId: string,
  event: OutboxRow,
  config: PushConfig | null,
  now: Date,
): Promise<number> {
  if (!isNotificationEventKey(event.event_key) || !isNotificationSeverity(event.severity)) {
    // An event key this build does not know about — a row left by a newer
    // version during a rolling deploy. Dropping it is right; guessing is not.
    return 0;
  }

  const [members, rules, timezone] = await Promise.all([
    businessMembers(businessId),
    query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM notification_rules WHERE business_id = $1 AND event_key = $2`,
      [businessId, event.event_key],
    ).then(({ rows }) => rows.map(toRule)),
    branchTimezone(businessId, event.location_id),
  ]);

  // Quiet hours are evaluated in each recipient's timezone, never discarded.
  for (const member of members) {
    if (!(await canReceiveNotification(businessId, member.userId, event))) continue;
    const preference = await deliveryPreference(businessId, member.userId);
    const [recipient] = resolveRecipients({
      event: {
        eventKey: event.event_key,
        severity: event.severity,
        locationId: event.location_id,
        amountRial: event.amount_rial === null ? null : Number(event.amount_rial),
      },
      members: [member],
      rules,
      minutesOfDay: localMinutesOfDay(now, preference.timezone || timezone),
    });
    if (!recipient) continue;
    // Every admitted event retains detail in-app, including push-only/quiet.
    await query(
      `INSERT INTO notification_recipients (business_id, event_id, user_id)
      VALUES ($1,$2,$3) ON CONFLICT (event_id,user_id) DO NOTHING`,
      [businessId, event.id, recipient.userId],
    );
    if (!recipient.channels.includes("push") || preference.mode === "inapp") continue;
    const { rows: devices } = await query<DeviceRow>(
      `SELECT d.id,d.user_id,d.endpoint,d.p256dh,d.auth
      FROM notification_devices d JOIN employee_sessions s ON s.id = d.session_id
      WHERE d.business_id=$1 AND d.user_id=$2 AND d.disabled_at IS NULL
        AND s.revoked_at IS NULL AND s.expires_at > now() AND s.employee_id=d.user_id AND s.business_id=d.business_id`,
      [businessId, recipient.userId],
    );
    const delay =
      event.severity === "critical" || preference.mode === "immediate"
        ? 0
        : event.severity === "info"
          ? Math.max(15, preference.digest_minutes)
          : preference.digest_minutes;
    for (const device of devices) {
      await query(
        `INSERT INTO notification_deliveries (business_id,event_id,device_id,user_id,status,available_at)
        VALUES ($1,$2,$3,$4,'queued',$5::timestamptz + $6 * interval '1 minute')
        ON CONFLICT (event_id,device_id) DO NOTHING`,
        [businessId, event.id, device.id, recipient.userId, now, delay],
      );
    }
    await query(
      `INSERT INTO notification_deliveries(business_id,event_id,native_device_id,user_id,status,available_at)
      SELECT $1,$2,id,$3,'queued',$4::timestamptz+$5*interval '1 minute' FROM native_app_devices
      WHERE business_id=$1 AND user_id=$3 AND revoked_at IS NULL AND push_provider='fcm' AND push_token IS NOT NULL
      ON CONFLICT DO NOTHING`,
      [businessId, event.id, recipient.userId, now, delay],
    );
  }
  return 0;
}

/** One business's pending notifications. Exported for the integration test. */
export async function runBusinessNotificationDelivery(
  businessId: string,
  config: PushConfig | null,
  limit = 50,
  now: Date = new Date(),
): Promise<number> {
  const { rows } = await query<OutboxRow>(
    `SELECT id,location_id,event_key,severity,title,body,url,amount_rial,dedupe_key,payload
    FROM notification_events WHERE business_id=$1 AND processed_at IS NULL
      AND (lease_until IS NULL OR lease_until < now()) ORDER BY created_at LIMIT $2`,
    [businessId, limit],
  );
  for (const event of rows) {
    const token = new Date(Date.now() + 300_000);
    const { rowCount } = await query(
      `UPDATE notification_events SET lease_until=$3
      WHERE id=$1 AND business_id=$2 AND processed_at IS NULL AND (lease_until IS NULL OR lease_until < now())`,
      [event.id, businessId, token],
    );
    if (!rowCount) continue;
    try {
      await deliverEvent(businessId, event, config, now);
      await query(
        `UPDATE notification_events SET processed_at=now(),lease_until=NULL WHERE id=$1 AND business_id=$2 AND lease_until=$3`,
        [event.id, businessId, token],
      );
    } catch (error) {
      console.error(
        "notification fanout retry scheduled",
        error instanceof Error ? error.message : "unknown",
      );
      // Lease expiry recovers partial fanout; unique recipient/device keys dedupe.
    }
  }
  const pushed = await drainPushQueue(businessId, config, now);
  // Explicit inbox/event retention. Pending work is never removed by cleanup.
  const days = Math.min(3650, Math.max(30, Number(process.env.NOTIFICATION_RETENTION_DAYS) || 90));
  await query(
    `DELETE FROM notification_events e WHERE business_id=$1 AND processed_at < now()-$2*interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id=e.id AND d.status='queued')`,
    [businessId, days],
  );
  return pushed;
}

export async function deliveryPreference(businessId: string, userId: string) {
  const { rows } = await query<{
    mode: "immediate" | "digest" | "inapp";
    timezone: string | null;
    digest_minutes: number;
  }>(
    `SELECT mode,timezone,digest_minutes FROM notification_preferences WHERE business_id=$1 AND user_id=$2`,
    [businessId, userId],
  );
  return rows[0] ?? { mode: "digest" as const, timezone: null, digest_minutes: 5 };
}

/** Claims and budgets commit BEFORE network I/O. An expired lease is retryable.
 * Provider acceptance cannot be made atomic with our database: a crash after
 * acceptance can replay, using the same stable browser tag to replace, not pile up. */
async function drainPushQueue(
  businessId: string,
  config: PushConfig | null,
  now: Date,
): Promise<number> {
  await query(
    `UPDATE notification_deliveries d SET status='expired',error='stale'
    FROM notification_events e WHERE d.event_id=e.id AND d.business_id=$1 AND d.status='queued'
    AND e.created_at < $2::timestamptz - CASE WHEN e.severity='critical' THEN interval '30 days' ELSE interval '7 days' END`,
    [businessId, now],
  );
  let sent = 0;
  const { rows: groups } = await query<{
    device_id: string;
    user_id: string;
    critical: boolean;
    native_device_id: string | null;
  }>(
    `
    SELECT COALESCE(d.device_id,d.native_device_id) AS device_id,d.native_device_id,d.user_id,bool_or(e.severity='critical') AS critical FROM notification_deliveries d
    JOIN notification_events e ON e.id=d.event_id WHERE d.business_id=$1 AND d.status='queued'
    AND d.available_at <= $2 AND (d.lease_until IS NULL OR d.lease_until < now())
    GROUP BY d.device_id,d.native_device_id,d.user_id ORDER BY critical DESC,min(e.created_at) LIMIT 100`,
    [businessId, now],
  );
  for (const group of groups) {
    const batch = await withTenantTransaction(businessId, async () => {
      // All workers serialize budget allocation for this tenant only.
      await query(`SELECT pg_advisory_xact_lock(hashtextextended($1,931))`, [businessId]);
      const { rows: devices } = await query<DeviceRow>(
        `SELECT d.id,d.user_id,d.endpoint,d.p256dh,d.auth,NULL::text AS native_token,NULL::jsonb AS native_channels FROM notification_devices d
        JOIN employee_sessions s ON s.id=d.session_id WHERE d.id=$1 AND d.business_id=$2 AND d.user_id=$3
        AND d.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>now()
        AND s.employee_id=d.user_id AND s.business_id=d.business_id
        UNION ALL SELECT id,user_id,'' AS endpoint,'' AS p256dh,'' AS auth,push_token AS native_token,push_channels AS native_channels
          FROM native_app_devices WHERE id=$1 AND business_id=$2 AND user_id=$3 AND revoked_at IS NULL AND push_token IS NOT NULL AND push_provider='fcm'`,
        [group.device_id, businessId, group.user_id],
      );
      const preference = await deliveryPreference(businessId, group.user_id);
      if (!devices[0] || preference.mode === "inapp") {
        await query(
          `UPDATE notification_deliveries SET status='expired',error='registration_or_preference_revoked'
          WHERE business_id=$1 AND (device_id=$2 OR native_device_id=$2) AND status='queued'`,
          [businessId, group.device_id],
        );
        return null;
      }
      if (!group.native_device_id && !config) return null;
      const { rows: pending } = await query<
        OutboxRow & { delivery_id: string; attempts: number; batch_id: string | null }
      >(
        `
        SELECT e.*,d.id AS delivery_id,d.attempts,d.batch_id FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id
        WHERE d.business_id=$1 AND (d.device_id=$2 OR d.native_device_id=$2) AND d.user_id=$3 AND d.status='queued' AND d.available_at<=$4
        AND (d.lease_until IS NULL OR d.lease_until < now()) AND (e.severity='critical')=$5
        ORDER BY e.created_at LIMIT 500`,
        [businessId, group.device_id, group.user_id, now, group.critical],
      );
      const allowed = [];
      const canReceive = notificationAuthorizationCache();
      for (const event of pending) {
        if (!(await canReceive(businessId, group.user_id, event))) {
          await query(
            `UPDATE notification_deliveries SET status='expired',error='authorization_revoked' WHERE id=$1 AND business_id=$2`,
            [event.delivery_id, businessId],
          );
          continue;
        }
        // Re-evaluate rules and quiet hours on retry, in the user's timezone.
        const [members, rules, fallback] = await Promise.all([
          businessMembers(businessId),
          listNotificationRules(businessId, group.user_id),
          branchTimezone(businessId, event.location_id),
        ]);
        if (!isNotificationEventKey(event.event_key) || !isNotificationSeverity(event.severity))
          continue;
        const [recipient] = resolveRecipients({
          event: {
            eventKey: event.event_key,
            severity: event.severity,
            locationId: event.location_id,
            amountRial: event.amount_rial === null ? null : Number(event.amount_rial),
          },
          members: members.filter((m) => m.userId === group.user_id),
          rules,
          minutesOfDay: localMinutesOfDay(now, preference.timezone || fallback),
        });
        const category = mapNotificationEventToNativeCategory(event.event_key);
        const nativeChannels = devices[0].native_channels;
        const nativeDenied =
          !!group.native_device_id &&
          category !== "security" &&
          nativeChannels?.length &&
          !nativeChannels.includes(category);
        if (!recipient?.channels.includes("push") || nativeDenied) {
          await query(
            `UPDATE notification_deliveries SET status='expired',error='rule_revoked' WHERE id=$1 AND business_id=$2`,
            [event.delivery_id, businessId],
          );
        } else if (recipient.quiet) {
          await query(
            `UPDATE notification_deliveries SET available_at=$3::timestamptz+interval '1 minute',error='quiet_hours' WHERE id=$1 AND business_id=$2`,
            [event.delivery_id, businessId, now],
          );
        } else allowed.push(event);
      }
      if (!allowed.length) return null;
      const lane = group.critical ? "critical" : "ordinary";
      const scopes = [
        `${lane}:business`,
        `${lane}:user:${group.user_id}`,
        `${lane}:device:${group.device_id}`,
      ];
      const { rows: budgets } = await query<{ next_at: Date }>(
        `SELECT next_at FROM notification_push_budgets
        WHERE business_id=$1 AND scope=ANY($2::text[]) AND next_at>$3`,
        [businessId, scopes, now],
      );
      const ids = allowed.map((e) => e.delivery_id);
      if (budgets.length) {
        const next = new Date(Math.max(...budgets.map((b) => new Date(b.next_at).getTime())));
        await query(
          `UPDATE notification_deliveries SET available_at=$3,error='throttled' WHERE business_id=$1 AND id=ANY($2::uuid[])`,
          [businessId, ids, next],
        );
        return null;
      }
      // Tunable product defaults, NOT a browser spam threshold. Critical has
      // its own lane so ordinary backlog cannot block urgent alerts.
      const seconds = group.critical
        ? 10
        : Math.max(30, Number(process.env.NOTIFICATION_PUSH_INTERVAL_SECONDS) || 300);
      for (const scope of scopes) {
        if (scope.endsWith(":business")) {
          const quota = group.critical
            ? 120
            : Math.max(1, Number(process.env.NOTIFICATION_BUSINESS_PUSH_PER_MINUTE) || 60);
          await query(
            `INSERT INTO notification_push_budgets(business_id,scope,next_at,used,window_start)
            VALUES ($1,$2,CASE WHEN $4<=1 THEN $3::timestamptz+interval '1 minute' ELSE $3 END,1,$3) ON CONFLICT(business_id,scope) DO UPDATE SET
            used=CASE WHEN notification_push_budgets.window_start <= $3::timestamptz-interval '1 minute' THEN 1 ELSE notification_push_budgets.used+1 END,
            next_at=CASE WHEN notification_push_budgets.window_start > $3::timestamptz-interval '1 minute' AND notification_push_budgets.used+1 >= $4
              THEN notification_push_budgets.window_start+interval '1 minute' ELSE $3 END,
            window_start=CASE WHEN notification_push_budgets.window_start <= $3::timestamptz-interval '1 minute' THEN $3 ELSE notification_push_budgets.window_start END`,
            [businessId, scope, now, quota],
          );
        } else
          await query(
            `INSERT INTO notification_push_budgets(business_id,scope,next_at)
          VALUES ($1,$2,$3::timestamptz+$4*interval '1 second') ON CONFLICT(business_id,scope) DO UPDATE SET next_at=EXCLUDED.next_at`,
            [businessId, scope, now, seconds],
          );
      }
      const batchId = allowed[0].batch_id || randomUUID();
      const leaseToken = randomUUID();
      await query(
        `UPDATE notification_deliveries SET lease_until=now()+interval '2 minutes',attempts=attempts+1,batch_id=$3,lease_token=$4
        WHERE business_id=$1 AND id=ANY($2::uuid[])`,
        [businessId, ids, batchId, leaseToken],
      );
      return { device: devices[0], events: allowed, ids, batchId, leaseToken };
    });
    if (!batch) continue;
    const first = batch.events[0];
    const single = batch.events.length === 1;
    const content = notificationDigestContent(batch.events);
    const payload = JSON.stringify({
      identity: `${businessId}:${group.user_id}`,
      ...pushPayloadFor({
        eventKey: first.event_key as NotificationEventKey,
        severity: first.severity as NotificationSeverity,
        ...content,
        url: single ? safeNotificationPath(first.url) : "/settings/notifications?inbox=1",
        notificationId: batch.batchId,
        dedupeKey: `digest:${group.device_id}:${batch.batchId}`,
      }),
    });
    const result = group.native_device_id
      ? await sendNativePush(businessId, batch.device, {
          ...first,
          id: batch.batchId,
          ...content,
          url: single ? safeNotificationPath(first.url) : "/settings/notifications?inbox=1",
        })
      : await sendPush({
          device: batch.device,
          config: config!,
          payload,
          urgency: urgencyFor(first.severity as NotificationSeverity),
          topic: `digest:${batch.batchId}`,
        });
    for (const event of batch.events) {
      await query(
        `UPDATE notification_deliveries SET status=$3,lease_until=NULL,http_status=$4,error=$5,
        sent_at=CASE WHEN $3='sent' THEN now() ELSE sent_at END,
        available_at=$6::timestamptz + LEAST(3600,30*power(2,LEAST(attempts,7)))*interval '1 second'
        WHERE business_id=$1 AND id=$2 AND lease_token=$7`,
        [
          businessId,
          event.delivery_id,
          result.outcome === "sent"
            ? "sent"
            : result.outcome === "retry"
              ? "queued"
              : result.outcome === "gone"
                ? "expired"
                : "failed",
          result.status,
          result.error,
          now,
          batch.leaseToken,
        ],
      );
    }
    if (group.native_device_id) {
      if (result.outcome === "sent") sent++;
      if (result.outcome === "gone")
        await query(
          `UPDATE native_app_devices SET push_token=NULL,push_provider=NULL,push_updated_at=now() WHERE id=$1 AND business_id=$2`,
          [group.device_id, businessId],
        );
      continue;
    }
    // One failure per request, not one per grouped fact.
    if (result.outcome === "sent") {
      sent++;
      await query(
        `UPDATE notification_devices SET last_success_at=now(),failure_count=0,last_error=NULL WHERE id=$1 AND business_id=$2`,
        [batch.device.id, businessId],
      );
    } else {
      await query(
        `UPDATE notification_devices SET failure_count=LEAST(failure_count+1,32767),last_error=$3,last_failure_at=now(),
        disabled_at=CASE WHEN $4 THEN now() ELSE disabled_at END WHERE id=$1 AND business_id=$2`,
        [
          batch.device.id,
          businessId,
          result.error,
          result.outcome === "gone" || result.outcome === "rejected",
        ],
      );
    }
  }
  return sent;
}

let tickInFlight = false;

/**
 * The background tick (server.ts).
 *
 * Enumerates businesses under the documented platform bypass and then wraps
 * each one's fan-out in `withTenant` — the same shape as every other tick here.
 * The in-flight guard matters more than usual: a tick that overran because one
 * push service was slow must not start a second pass over the same rows.
 */
export async function runNotificationTick(): Promise<number> {
  if (tickInFlight) return 0;
  tickInFlight = true;
  try {
    const [config, businessIds] = await Promise.all([
      getPushConfig(),
      withoutTenantScope("platform", async () => {
        const { rows } = await query<{ id: string }>(
          `SELECT business_id AS id FROM notification_events WHERE processed_at IS NULL OR processed_at < now()-$1*interval '1 day' UNION SELECT business_id AS id FROM notification_deliveries WHERE status='queued'`,
          [Math.min(3650, Math.max(30, Number(process.env.NOTIFICATION_RETENTION_DAYS) || 90))],
        );
        return rows.map((row) => row.id);
      }),
    ]);

    let pushed = 0;
    for (const businessId of businessIds) {
      try {
        pushed += await withTenant(businessId, () =>
          runBusinessNotificationDelivery(businessId, config),
        );
      } catch (error) {
        console.error(
          `notification tick failed for business ${businessId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return pushed;
  } finally {
    tickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// The test notification
// ---------------------------------------------------------------------------

export interface TestNotificationResult {
  devices: number;
  sent: number;
  errors: string[];
}

/**
 * Pushes straight to the caller's own devices, bypassing the outbox and the
 * rules entirely.
 *
 * That bypass is the point: this button answers "is this phone set up
 * correctly", and routing it through the rules would make a correctly
 * configured device look broken because the person had switched the event off.
 * It is also why `system.test` has no default roles — nothing else ever sends it.
 */
export async function sendTestNotification(
  businessId: string,
  userId: string,
): Promise<TestNotificationResult> {
  const config = await getPushConfig();
  const { rows: devices } = await query<DeviceRow>(
    `SELECT d.id,d.user_id,d.endpoint,d.p256dh,d.auth FROM notification_devices d JOIN employee_sessions s ON s.id=d.session_id
      WHERE d.business_id=$1 AND d.user_id=$2 AND d.disabled_at IS NULL AND s.revoked_at IS NULL AND s.expires_at>now() AND s.employee_id=d.user_id AND s.business_id=d.business_id`,
    [businessId, userId],
  );
  if (!config)
    return { devices: devices.length, sent: 0, errors: ["notification_push_unconfigured"] };

  const payload = JSON.stringify({
    identity: `${businessId}:${userId}`,
    ...pushPayloadFor({
      eventKey: "system.test",
      severity: "info",
      title: "اعلان آزمایشی",
      body: "اگر این پیام را می‌بینید، اعلان‌های این دستگاه درست کار می‌کند.",
      url: "/settings/notifications",
      notificationId: "test",
      dedupeKey: `system.test:${userId}`,
    }),
  });

  let sent = 0;
  const errors: string[] = [];
  for (const device of devices) {
    const result = await sendPush({
      device,
      config,
      payload,
      urgency: "high",
      topic: `system.test:${userId}`,
    });
    if (result.outcome === "sent") {
      sent += 1;
      await query(
        `UPDATE notification_devices SET last_success_at = now(), failure_count = 0, last_error = NULL
          WHERE id = $1 AND business_id = $2`,
        [device.id, businessId],
      );
    } else {
      if (result.error) errors.push(result.error);
      await query(
        `UPDATE notification_devices SET last_failure_at=now(),last_error=$3,
        failure_count=LEAST(failure_count+1,32767),disabled_at=CASE WHEN $4 THEN now() ELSE disabled_at END
        WHERE id=$1 AND business_id=$2`,
        [
          device.id,
          businessId,
          result.error,
          result.outcome === "gone" || result.outcome === "rejected",
        ],
      );
    }
  }
  return { devices: devices.length, sent, errors };
}

/** Do not turn a notification into an open redirect (including // or backslashes). */
export function safeNotificationPath(value: string): string {
  return /^\/(?!\/)/.test(value) && !/[\\\x00-\x20]/.test(value)
    ? value
    : "/settings/notifications";
}

export async function notificationRuleLocations(businessId: string, userId: string) {
  const member = (await businessMembers(businessId)).find((m) => m.userId === userId);
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id,name FROM locations WHERE business_id=$1 AND id=ANY($2::uuid[]) AND is_active`,
    [businessId, member?.locationIds ?? []],
  );
  return rows;
}

/** Provider acceptance is "sent"; this is not a browser-delivered/spam verdict. */
export async function notificationDeliveryStats(businessId: string, userId: string) {
  const { rows } = await query(
    `SELECT status,count(*)::int AS count,
    count(*) FILTER (WHERE error='throttled')::int AS throttled,
    count(*) FILTER (WHERE attempts>0)::int AS attempted,
    count(DISTINCT batch_id)::int AS batches
    FROM notification_deliveries WHERE business_id=$1 AND user_id=$2 GROUP BY status`,
    [businessId, userId],
  );
  return rows;
}
