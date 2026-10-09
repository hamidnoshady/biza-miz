/**
 * Phase 35 — the database half of notifications.
 *
 * Registers the devices a person wants to be reached on, stores the rules that
 * say what they want to hear about, drains the outbox, and performs the actual
 * Web Push requests.
 *
 * Four properties this file is responsible for:
 *
 *   * **Nothing is sent inline.** Producers only INSERT into
 *     `notification_events` (see notification-events.ts); this file's tick is
 *     the only thing that talks to a push service. A cashier closing their till
 *     must not wait on — or fail because of — an HTTPS round trip to a server
 *     in another country.
 *   * **The fan-out is claimed before it is performed.** The tick marks an
 *     event processed with a conditional `UPDATE` and only proceeds if it won
 *     that row, so two app instances ticking at once send one notification
 *     rather than two.
 *   * **Branch access is Phase 14's answer, not a second one.** Who may hear
 *     about branch X is `accessibleLocationIds`, the same function that decides
 *     who may act in branch X.
 *   * **A dead subscription is deleted.** A push service answering 404/410 is
 *     saying the browser is gone; keeping the row would mean failing forever.
 *
 * Everything runs inside an ambient tenant scope (a request's `withTenantScope`,
 * or the tick's `withTenant`) — except the VAPID key pair, which is
 * deployment-wide and has no business to scope to.
 */
import { accessibleLocationIds } from "./location-access";
import type { Role } from "./auth";
import { query, withoutTenantScope, withTenant } from "./db";
import { assertPublicHttpsUrl } from "./ssrf";
import {
  defaultRuleFor,
  isNotificationChannel,
  isNotificationEventKey,
  isNotificationSeverity,
  localMinutesOfDay,
  NOTIFICATION_EVENTS,
  pushPayloadFor,
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

/** Beyond this a device is presumed dead even without a definitive 404/410. */
const MAX_DEVICE_FAILURES = 8;

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

const DEVICE_PLATFORMS: readonly string[] = ["ios", "android", "windows", "macos", "linux", "other"];

export interface NotificationDevice {
  id: string;
  endpoint: string;
  platform: DevicePlatform;
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
  lastError: string | null;
}

const DEVICE_COLUMNS = `id, endpoint, platform, label, created_at::text AS created_at,
                        last_success_at::text AS last_success_at, failure_count, last_error`;

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
    failure_count: number;
    last_error: string | null;
  }>(
    `SELECT ${DEVICE_COLUMNS} FROM notification_devices
      WHERE business_id = $1 AND user_id = $2 AND disabled_at IS NULL
      ORDER BY created_at DESC`,
    [businessId, userId],
  );
  return rows.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    platform: row.platform as DevicePlatform,
    label: row.label,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
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
}

export type RegisterDeviceResult =
  | { ok: true; device: NotificationDevice }
  | { ok: false; error: string };

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
  // Apple, Google or Mozilla, so requiring one costs nothing.
  if ((await assertPublicHttpsUrl(endpoint)).ok === false) {
    return { ok: false, error: "notification_device_invalid" };
  }
  // Reject a subscription whose keys cannot encrypt, here rather than at send
  // time: a stored row that can never be pushed to is a device the settings
  // screen would show as working forever.
  if (fromBase64Url(p256dh).length !== 65 || fromBase64Url(auth).length !== 16) {
    return { ok: false, error: "notification_device_invalid" };
  }

  const platform = DEVICE_PLATFORMS.includes(input.platform ?? "") ? input.platform! : "other";

  const { rows } = await query<{
    id: string;
    endpoint: string;
    platform: string;
    label: string;
    created_at: string;
    last_success_at: string | null;
    failure_count: number;
    last_error: string | null;
  }>(
    `INSERT INTO notification_devices
       (business_id, user_id, endpoint, p256dh, auth, platform, label, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (endpoint) DO UPDATE
       SET business_id = EXCLUDED.business_id,
           user_id = EXCLUDED.user_id,
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
    ],
  );

  const row = rows[0];
  return {
    ok: true,
    device: {
      id: row.id,
      endpoint: row.endpoint,
      platform: row.platform as DevicePlatform,
      label: row.label,
      createdAt: row.created_at,
      lastSuccessAt: row.last_success_at,
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

export type SaveRuleResult =
  | { ok: true; rule: NotificationRule }
  | { ok: false; errors: string[] };

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
  // The settings screen edits the all-branch rule; a per-branch override is a
  // public-API/advanced concern and is not offered a second, confusing form.
  const byEvent = new Map(rules.filter((rule) => rule.locationId === null).map((rule) => [rule.eventKey, rule]));

  return Object.values(NOTIFICATION_EVENTS)
    .filter((meta) => meta.key !== "system.test")
    .map((meta) => {
      const rule = byEvent.get(meta.key);
      if (rule) {
        return {
          eventKey: meta.key,
          ruleId: rule.id,
          isDefault: false,
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

export async function listNotificationInbox(
  businessId: string,
  userId: string,
  limit = 50,
): Promise<{ entries: InboxEntry[]; unread: number }> {
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query<{
      id: string;
      event_key: string;
      severity: string;
      title: string;
      body: string;
      url: string;
      created_at: string;
      read_at: string | null;
    }>(
      `SELECT r.id, e.event_key, e.severity, e.title, e.body, e.url,
              r.created_at::text AS created_at, r.read_at::text AS read_at
         FROM notification_recipients r
         JOIN notification_events e ON e.id = r.event_id
        WHERE r.business_id = $1 AND r.user_id = $2
        ORDER BY r.created_at DESC
        LIMIT $3`,
      [businessId, userId, Math.min(Math.max(limit, 1), 200)],
    ),
    query<{ unread: string }>(
      `SELECT count(*)::text AS unread FROM notification_recipients
        WHERE business_id = $1 AND user_id = $2 AND read_at IS NULL`,
      [businessId, userId],
    ),
  ]);

  return {
    entries: rows.map((row) => ({
      id: row.id,
      eventKey: row.event_key as NotificationEventKey,
      severity: row.severity as NotificationSeverity,
      title: row.title,
      body: row.body,
      url: row.url,
      createdAt: row.created_at,
      readAt: row.read_at,
    })),
    unread: Number(countRows[0]?.unread ?? 0),
  };
}

/** Marks one entry read, or every unread entry when `id` is omitted. */
export async function markNotificationsRead(
  businessId: string,
  userId: string,
  id?: string,
): Promise<number> {
  const { rowCount } = id
    ? await query(
        `UPDATE notification_recipients SET read_at = now()
          WHERE business_id = $1 AND user_id = $2 AND id = $3 AND read_at IS NULL`,
        [businessId, userId, id],
      )
    : await query(
        `UPDATE notification_recipients SET read_at = now()
          WHERE business_id = $1 AND user_id = $2 AND read_at IS NULL`,
        [businessId, userId],
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
  const target = await assertPublicHttpsUrl(request.url);
  if (!target.ok) {
    return { outcome: "rejected", status: null, error: `endpoint_not_public: ${target.reason}` };
  }

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: new Uint8Array(request.body),
      signal: AbortSignal.timeout(10_000),
    });
    return {
      outcome: classifyPushStatus(response.status),
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      outcome: "retry",
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function recordDeliveryOutcome(
  businessId: string,
  deliveryId: string,
  device: DeviceRow,
  result: SendResult,
): Promise<void> {
  const status =
    result.outcome === "sent" ? "sent" : result.outcome === "gone" ? "expired" : "failed";

  await query(
    `UPDATE notification_deliveries
        SET status = $3, http_status = $4, error = $5,
            sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END
      WHERE id = $1 AND business_id = $2`,
    [deliveryId, businessId, status, result.status, result.error?.slice(0, 300) ?? null],
  );

  if (result.outcome === "sent") {
    await query(
      `UPDATE notification_devices
          SET last_success_at = now(), failure_count = 0, last_error = NULL
        WHERE id = $1 AND business_id = $2`,
      [device.id, businessId],
    );
    return;
  }

  if (result.outcome === "gone") {
    // The push service is telling us the browser is gone. Keeping the row would
    // mean failing against it forever, and the person's other devices still work.
    await query(`DELETE FROM notification_devices WHERE id = $1 AND business_id = $2`, [
      device.id,
      businessId,
    ]);
    return;
  }

  await query(
    `UPDATE notification_devices
        SET failure_count = failure_count + 1,
            last_error = $3,
            disabled_at = CASE WHEN failure_count + 1 >= $4 THEN now() ELSE disabled_at END
      WHERE id = $1 AND business_id = $2`,
    [device.id, businessId, result.error?.slice(0, 300) ?? "unknown", MAX_DEVICE_FAILURES],
  );
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

  const recipients = resolveRecipients({
    event: {
      eventKey: event.event_key,
      severity: event.severity,
      locationId: event.location_id,
      amountRial: event.amount_rial === null ? null : Number(event.amount_rial),
    },
    members,
    rules,
    minutesOfDay: localMinutesOfDay(now, timezone),
  });
  if (recipients.length === 0) return 0;

  let pushed = 0;
  for (const recipient of recipients) {
    if (recipient.channels.includes("inapp")) {
      await query(
        `INSERT INTO notification_recipients (business_id, event_id, user_id)
         VALUES ($1, $2, $3) ON CONFLICT (event_id, user_id) DO NOTHING`,
        [businessId, event.id, recipient.userId],
      );
    }
    if (!recipient.channels.includes("push")) continue;

    const { rows: devices } = await query<DeviceRow>(
      `SELECT id, user_id, endpoint, p256dh, auth FROM notification_devices
        WHERE business_id = $1 AND user_id = $2 AND disabled_at IS NULL`,
      [businessId, recipient.userId],
    );

    for (const device of devices) {
      const { rows: claimed } = await query<{ id: string }>(
        `INSERT INTO notification_deliveries (business_id, event_id, device_id, user_id, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_id, device_id) DO NOTHING
         RETURNING id`,
        [businessId, event.id, device.id, recipient.userId, recipient.quiet ? "quiet" : "queued"],
      );
      const deliveryId = claimed[0]?.id;
      if (!deliveryId || recipient.quiet) continue;

      if (!config) {
        await query(
          `UPDATE notification_deliveries SET status = 'failed', error = $3
            WHERE id = $1 AND business_id = $2`,
          [deliveryId, businessId, "notification_push_unconfigured"],
        );
        continue;
      }

      const payload = JSON.stringify(
        pushPayloadFor({
          eventKey: event.event_key,
          severity: event.severity,
          title: event.title,
          body: event.body,
          url: event.url,
          notificationId: event.id,
          dedupeKey: event.dedupe_key,
        }),
      );
      const result = await sendPush({
        device,
        config,
        payload,
        urgency: urgencyFor(event.severity),
        topic: event.dedupe_key,
      });
      await recordDeliveryOutcome(businessId, deliveryId, device, result);
      if (result.outcome === "sent") pushed += 1;
    }
  }

  return pushed;
}

/** One business's pending notifications. Exported for the integration test. */
export async function runBusinessNotificationDelivery(
  businessId: string,
  config: PushConfig | null,
  limit = 50,
  /**
   * The moment delivery runs for — the quiet-hours check reads the branch's
   * local time from it. Tests pass a fixed clock: "quiet all day" cannot be
   * expressed through the rule API (minutes are 0–1439 and the window is
   * half-open), so a wall-clock run fails whenever it lands on 23:59 local.
   */
  now: Date = new Date(),
): Promise<number> {
  const { rows } = await query<OutboxRow>(
    `SELECT id, location_id, event_key, severity, title, body, url, amount_rial, dedupe_key
       FROM notification_events
      WHERE business_id = $1 AND processed_at IS NULL
      ORDER BY created_at
      LIMIT $2`,
    [businessId, limit],
  );
  if (rows.length === 0) return 0;

  let pushed = 0;
  for (const event of rows) {
    // Claim before delivering: two app instances ticking at once must produce
    // one fan-out, not two notifications on the owner's phone. A crash between
    // the claim and the send loses that one push rather than replaying it —
    // which is the right trade for a notification, where a duplicate at 03:00
    // costs more than a miss the dashboard still records.
    const { rowCount } = await query(
      `UPDATE notification_events SET processed_at = now()
        WHERE id = $1 AND business_id = $2 AND processed_at IS NULL`,
      [event.id, businessId],
    );
    if ((rowCount ?? 0) === 0) continue;

    try {
      pushed += await deliverEvent(businessId, event, config, now);
    } catch (error) {
      console.error(
        `notification ${event.event_key} delivery failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Keep the outbox bounded. The recipient rows are the durable record, and
  // they outlive this by their own retention below.
  await query(
    `DELETE FROM notification_events
      WHERE business_id = $1 AND processed_at < now() - interval '30 days'`,
    [businessId],
  );
  return pushed;
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
          `SELECT DISTINCT business_id AS id FROM notification_events WHERE processed_at IS NULL`,
        );
        return rows.map((row) => row.id);
      }),
    ]);

    let pushed = 0;
    for (const businessId of businessIds) {
      try {
        pushed += await withTenant(businessId, () => runBusinessNotificationDelivery(businessId, config));
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
    `SELECT id, user_id, endpoint, p256dh, auth FROM notification_devices
      WHERE business_id = $1 AND user_id = $2 AND disabled_at IS NULL`,
    [businessId, userId],
  );
  if (!config) return { devices: devices.length, sent: 0, errors: ["notification_push_unconfigured"] };

  const payload = JSON.stringify(
    pushPayloadFor({
      eventKey: "system.test",
      severity: "info",
      title: "اعلان آزمایشی",
      body: "اگر این پیام را می‌بینید، اعلان‌های این دستگاه درست کار می‌کند.",
      url: "/settings/notifications",
      notificationId: "test",
      dedupeKey: `system.test:${userId}`,
    }),
  );

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
      if (result.outcome === "gone") {
        await query(`DELETE FROM notification_devices WHERE id = $1 AND business_id = $2`, [
          device.id,
          businessId,
        ]);
      }
    }
  }
  return { devices: devices.length, sent, errors };
}
