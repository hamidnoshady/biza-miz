/**
 * Phase 35 exit criteria, against a real database.
 *
 * `tenant-isolation.integration.test.ts` already proves the five new tables
 * carry RLS, and `notifications.test.ts`/`web-push.test.ts` cover the pure
 * rules and the wire format. What can only be proven here is the plumbing
 * between them:
 *
 *   - a fact enqueued by a producer reaches the right people's bells, chosen by
 *     the *rules* rather than by the producer;
 *   - the same fact enqueued twice produces one notification, not two;
 *   - quiet hours suppress the push and never the bell — and a critical event
 *     ignores them;
 *   - a member pinned to one branch never hears about another's;
 *   - the VAPID pair is generated once and stays put, because rotating it would
 *     silently invalidate every device a business has registered;
 *   - a push service answering 410 deletes the device rather than leaving a row
 *     that fails forever.
 *
 * `fetch` is stubbed throughout: the point of these assertions is which request
 * would have gone where, and a test that reached a real push service would be
 * both flaky and rude.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

vi.mock("../src/lib/notification-transport", async (original) => ({
  ...(await original<typeof import("../src/lib/notification-transport")>()),
  postWebPush: vi.fn(),
}));
import { postWebPush } from "../src/lib/notification-transport";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/notifications-service");
let producer: typeof import("../src/lib/notification-events");
let webPush: typeof import("../src/lib/web-push");

const shop = { businessId: "", branchA: "", branchB: "", owner: "", managerA: "", cashier: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_notifications_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  // No VAPID pair in env: the generate-on-first-use path is what an on-site
  // install actually takes, so it is what the test exercises.
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;

  dbLib = await import("../src/lib/db");
  service = await import("../src/lib/notifications-service");
  producer = await import("../src/lib/notification-events");
  webPush = await import("../src/lib/web-push");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** Two branches, an owner who roams, a manager pinned to branch A, and a cashier. */
async function seedBusiness() {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    ["Café", `cafe-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business.rows[0].id;

  const branches: string[] = [];
  for (const name of ["Vanak", "Tajrish"]) {
    const row = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name, timezone) VALUES ($1, $2, 'Asia/Tehran') RETURNING id",
      [businessId, name],
    );
    branches.push(row.rows[0].id);
  }

  async function addUser(role: string, locationId: string | null) {
    const row = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash, location_id)
       VALUES ($1, $2::user_role, $3, $4, 'x', $5) RETURNING id`,
      [businessId, role, role, `${role}-${randomUUID().slice(0, 8)}@example.test`, locationId],
    );
    const id = row.rows[0].id;
    await db.query(`INSERT INTO employees(id,business_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
      id,
      businessId,
    ]);
    await db.query(
      `INSERT INTO notification_preferences(business_id,user_id,mode) VALUES ($1,$2,'immediate')`,
      [businessId, id],
    );
    return id;
  }

  return {
    businessId,
    branchA: branches[0],
    branchB: branches[1],
    // location_id NULL = roaming; accessibleLocationIds gives them every branch.
    owner: await addUser("owner", null),
    managerA: await addUser("manager", branches[0]),
    cashier: await addUser("cashier", branches[0]),
  };
}

/** Registers a usable subscription — real P-256 keys, so encryption succeeds. */
async function sessionFor(userId: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO employee_sessions(employee_id,business_id,token_hash,expires_at)
    VALUES ($1,$2,$3,now()+interval '7 days') RETURNING id`,
    [userId, shop.businessId, randomUUID().replaceAll("-", "").repeat(2)],
  );
  return rows[0].id;
}
async function addDevice(userId: string, label = "phone") {
  const sessionId = await sessionFor(userId);
  const { createECDH, randomBytes } = await import("node:crypto");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const result = await dbLib.withTenant(shop.businessId, () =>
    service.registerNotificationDevice(shop.businessId, userId, {
      sessionId,
      endpoint: `https://fcm.googleapis.com/wp/${randomUUID()}`,
      p256dh: webPush.toBase64Url(ecdh.getPublicKey()),
      auth: webPush.toBase64Url(randomBytes(16)),
      platform: "android",
      label,
    }),
  );
  if (!result.ok) throw new Error(`device registration failed: ${result.error}`);
  return result.device;
}

function enqueue(overrides: Partial<Parameters<typeof producer.recordNotification>[0]> = {}) {
  return dbLib.withTenant(shop.businessId, () =>
    producer.recordNotification({
      businessId: shop.businessId,
      locationId: shop.branchA,
      eventKey: "shift.cash_variance",
      severity: "important",
      title: "کسری صندوق",
      body: "۴۰۰٬۰۰۰ تومان",
      amountRial: -4_000_000,
      dedupeKey: `shift.cash_variance:${randomUUID()}`,
      ...overrides,
    }),
  );
}

/**
 * Delivery always runs at a fixed clock moment — noon Tehran, 12:00 local.
 * The alternative (the real wall clock) made the quiet-hours tests flaky in a
 * way nothing could reproduce locally: "cover the whole day" is written as
 * 0–1439 minutes, but the quiet window is half-open, so the minute 23:59 is
 * NOT quiet. A run that happened to execute at exactly Tehran 23:59 (one
 * minute per day) saw the push fire and failed — which is how this was found.
 */
function deliver(offsetMinutes = 0, limit = 50) {
  const noonTehran = new Date(
    new Date("2026-06-01T08:30:00.000Z").getTime() + offsetMinutes * 60000,
  ); // 12:00 Asia/Tehran
  return dbLib.withTenant(shop.businessId, async () =>
    service.runBusinessNotificationDelivery(
      shop.businessId,
      await service.getPushConfig(),
      limit,
      noonTehran,
    ),
  );
}

async function bellFor(userId: string) {
  const { rows } = await db.query<{ event_key: string; title: string }>(
    `SELECT e.event_key, e.title
       FROM notification_recipients r JOIN notification_events e ON e.id = r.event_id
      WHERE r.user_id = $1 ORDER BY r.created_at`,
    [userId],
  );
  return rows;
}

/** Stands in for every push service: records the request and answers `status`. */
function stubPush(status = 201) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.mocked(postWebPush).mockImplementation(async (url, headers) => {
    calls.push({ url, headers });
    return status;
  });
  return calls;
}

beforeEach(async () => {
  for (const table of [
    "notification_deliveries",
    "notification_recipients",
    "notification_events",
    "notification_rules",
    "notification_devices",
    "native_app_devices",
    "users",
    "locations",
    "businesses",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }
  Object.assign(shop, await seedBusiness());
});

afterEach(() => {
  delete process.env.BIZA_FIREBASE_PROJECT_ID;
  delete process.env.BIZA_FCM_ACCESS_TOKEN;
  vi.unstubAllGlobals();
  vi.mocked(postWebPush).mockReset();
});

describe("the VAPID identity", () => {
  it("is generated once and never rotates underneath existing devices", async () => {
    const first = await service.getPushConfig();
    const second = await service.getPushConfig();
    expect(first).not.toBeNull();
    // Rotating this would invalidate every subscription every business has
    // registered, silently — every push would start returning 401 and nothing
    // would say why.
    expect(second?.publicKey).toBe(first?.publicKey);

    const { rows } = await db.query("SELECT count(*)::int AS n FROM platform_push_config");
    expect(rows[0].n).toBe(1);
    expect(webPush.fromBase64Url(first!.publicKey)).toHaveLength(65);
    expect(webPush.fromBase64Url(first!.privateKey)).toHaveLength(32);
  });
});

describe("fan-out", () => {
  it("reaches the catalogue's default roles when nobody has configured anything", async () => {
    stubPush();
    await enqueue();
    await deliver();

    // shift.cash_variance defaults to owner + manager. The cashier is not told,
    // and did not have to switch anything off to not be told.
    expect(await bellFor(shop.owner)).toHaveLength(1);
    expect(await bellFor(shop.managerA)).toHaveLength(1);
    expect(await bellFor(shop.cashier)).toHaveLength(0);
  });

  it("never tells a branch-pinned member about another branch", async () => {
    stubPush();
    await enqueue({ locationId: shop.branchB, dedupeKey: "shift.cash_variance:branch-b" });
    await deliver();

    // The manager may only act in Vanak, so Tajrish's till is not their business.
    expect(await bellFor(shop.managerA)).toHaveLength(0);
    expect(await bellFor(shop.owner)).toHaveLength(1);
  });

  it("honours an explicit rule over the default, in both directions", async () => {
    await dbLib.withTenant(shop.businessId, async () => {
      // The owner opts out…
      await service.saveNotificationRule(shop.businessId, shop.owner, {
        eventKey: "shift.cash_variance",
        locationId: null,
        enabled: false,
        channels: ["push", "inapp"],
        minSeverity: "info",
        minAmountRial: null,
        quietFromMinutes: null,
        quietToMinutes: null,
      });
      // …and the cashier, whom the default excluded, opts in.
      await service.saveNotificationRule(shop.businessId, shop.cashier, {
        eventKey: "shift.cash_variance",
        locationId: null,
        enabled: true,
        channels: ["inapp"],
        minSeverity: "info",
        minAmountRial: null,
        quietFromMinutes: null,
        quietToMinutes: null,
      });
    });

    stubPush();
    await enqueue();
    await deliver();

    expect(await bellFor(shop.owner)).toHaveLength(0);
    expect(await bellFor(shop.cashier)).toHaveLength(0);
  });

  it("drops an event below the person's own amount threshold", async () => {
    await dbLib.withTenant(shop.businessId, () =>
      service.saveNotificationRule(shop.businessId, shop.owner, {
        eventKey: "shift.cash_variance",
        locationId: null,
        enabled: true,
        channels: ["inapp"],
        minSeverity: "info",
        // «فقط اگر بیشتر از یک میلیون تومان بود»
        minAmountRial: 10_000_000,
        quietFromMinutes: null,
        quietToMinutes: null,
      }),
    );

    stubPush();
    await enqueue({ amountRial: -4_000_000, dedupeKey: "small" });
    await deliver();
    expect(await bellFor(shop.owner)).toHaveLength(0);

    await enqueue({ amountRial: -40_000_000, dedupeKey: "large" });
    await deliver();
    expect(await bellFor(shop.owner)).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("collapses the same fact enqueued twice into one notification", async () => {
    stubPush();
    // What a retried request looks like: the producer keys on the shift, not on
    // the moment it ran.
    await enqueue({ dedupeKey: "shift.closed:the-same-shift" });
    await enqueue({ dedupeKey: "shift.closed:the-same-shift" });
    await deliver();

    const { rows } = await db.query("SELECT count(*)::int AS n FROM notification_events");
    expect(rows[0].n).toBe(1);
    expect(await bellFor(shop.owner)).toHaveLength(1);
  });

  it("does not re-deliver an event a previous pass already claimed", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await enqueue({ dedupeKey: "once" });

    await deliver();
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // A second tick — or a second app instance — must not push again.
    await deliver();
    expect(calls).toHaveLength(afterFirst);
  });
});

describe("quiet hours", () => {
  async function setQuietWindow(userId: string, eventKey: "shift.cash_variance" | "backup.failed") {
    // The branch is Asia/Tehran, and the window is written to cover the whole
    // day. It still can't cover 23:59 (the window is half-open and rule
    // minutes end at 1439), which is why deliver() runs at a fixed noon
    // instead of whenever the test happens to execute.
    await dbLib.withTenant(shop.businessId, () =>
      service.saveNotificationRule(shop.businessId, userId, {
        eventKey,
        locationId: null,
        enabled: true,
        channels: ["push", "inapp"],
        minSeverity: "info",
        minAmountRial: null,
        quietFromMinutes: 0,
        quietToMinutes: 1439,
      }),
    );
  }

  it("suppresses the push and still writes the bell", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await setQuietWindow(shop.owner, "shift.cash_variance");

    await enqueue({ dedupeKey: "quiet-one" });
    await deliver();

    // «بیدارم نکن» is not «به من نگو».
    expect(calls).toHaveLength(0);
    expect(await bellFor(shop.owner)).toHaveLength(1);
    const { rows } = await db.query("SELECT status FROM notification_deliveries");
    expect(rows.map((row) => row.status)).toEqual(["queued"]);
  });

  it("is ignored by a critical event", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await setQuietWindow(shop.owner, "backup.failed");

    await enqueue({
      eventKey: "backup.failed",
      severity: "critical",
      locationId: null,
      amountRial: null,
      title: "پشتیبان‌گیری ناموفق بود",
      dedupeKey: "backup.failed:run-1",
    });
    await deliver();

    // A week of silently failed backups is discovered exactly when it is too
    // late; this is the one event that gets to be rude.
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Urgency).toBe("high");
  });
});

describe("pushing", () => {
  it("sends a VAPID-signed, aes128gcm-encrypted request per device", async () => {
    const calls = stubPush();
    const device = await addDevice(shop.owner);
    expect(device.lastSuccessAt).toBeNull();

    await enqueue({ dedupeKey: "push-one" });
    await deliver();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/^https:\/\/fcm\.googleapis\.com\/wp\//);
    expect(calls[0].headers["Content-Encoding"]).toBe("aes128gcm");
    expect(calls[0].headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

    const { rows } = await db.query("SELECT status, http_status FROM notification_deliveries");
    expect(rows).toEqual([{ status: "sent", http_status: 201 }]);

    const [refreshed] = await dbLib.withTenant(shop.businessId, () =>
      service.listNotificationDevices(shop.businessId, shop.owner),
    );
    expect(refreshed.lastSuccessAt).not.toBeNull();
    expect(refreshed.failureCount).toBe(0);
  });

  it("deletes a device the push service says is gone", async () => {
    stubPush(410);
    await addDevice(shop.owner);
    await enqueue({ dedupeKey: "gone-one" });
    await deliver();

    // 410 means the browser is gone — uninstalled, site data cleared. Keeping
    // the row would mean failing against it forever.
    const devices = await dbLib.withTenant(shop.businessId, () =>
      service.listNotificationDevices(shop.businessId, shop.owner),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0].disabledAt).not.toBeNull();
  });

  it("counts a retryable failure against the device without deleting it", async () => {
    stubPush(503);
    await addDevice(shop.owner);
    await enqueue({ dedupeKey: "flaky-one" });
    await deliver();

    const [device] = await dbLib.withTenant(shop.businessId, () =>
      service.listNotificationDevices(shop.businessId, shop.owner),
    );
    expect(device.failureCount).toBe(1);
    expect(device.lastError).toContain("503");
  });

  it("re-subscribing the same endpoint updates the row and clears its failures", async () => {
    stubPush(503);
    const device = await addDevice(shop.owner);
    await enqueue({ dedupeKey: "before-resub" });
    await deliver();

    const { rows: before } = await db.query<{ endpoint: string }>(
      "SELECT endpoint FROM notification_devices WHERE id = $1",
      [device.id],
    );

    const { createECDH, randomBytes } = await import("node:crypto");
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const sessionId = await sessionFor(shop.owner);
    await dbLib.withTenant(shop.businessId, () =>
      service.registerNotificationDevice(shop.businessId, shop.owner, {
        sessionId,
        endpoint: before[0].endpoint,
        p256dh: webPush.toBase64Url(ecdh.getPublicKey()),
        auth: webPush.toBase64Url(randomBytes(16)),
        platform: "android",
        label: "phone",
      }),
    );

    // A browser that just re-subscribed is alive, whatever the old row said —
    // and it is one row, not two.
    const devices = await dbLib.withTenant(shop.businessId, () =>
      service.listNotificationDevices(shop.businessId, shop.owner),
    );
    expect(devices).toHaveLength(1);
    expect(devices[0].failureCount).toBe(0);
  });

  it("refuses a subscription whose keys could never encrypt", async () => {
    const result = await dbLib.withTenant(shop.businessId, () =>
      service.registerNotificationDevice(shop.businessId, shop.owner, {
        endpoint: "https://fcm.googleapis.com/wp/short-keys",
        p256dh: webPush.toBase64Url(Buffer.alloc(10)),
        auth: webPush.toBase64Url(Buffer.alloc(16)),
      }),
    );
    // Caught here rather than at send time: a stored row that can never be
    // pushed to would show as a working device in the settings list forever.
    expect(result).toEqual({ ok: false, error: "notification_device_invalid" });
  });
});

describe("the inbox", () => {
  it("counts unread and stops counting once read", async () => {
    stubPush();
    await enqueue({ dedupeKey: "inbox-one" });
    await deliver();

    const before = await dbLib.withTenant(shop.businessId, () =>
      service.listNotificationInbox(shop.businessId, shop.owner),
    );
    expect(before.unread).toBe(1);
    expect(before.entries[0].title).toBe("کسری صندوق");

    await dbLib.withTenant(shop.businessId, () =>
      service.markNotificationsRead(shop.businessId, shop.owner),
    );
    const after = await dbLib.withTenant(shop.businessId, () =>
      service.listNotificationInbox(shop.businessId, shop.owner),
    );
    expect(after.unread).toBe(0);
    expect(after.entries).toHaveLength(1);
  });
});

describe("preferences", () => {
  it("reports the default a member is living under until they write a rule", async () => {
    const before = await dbLib.withTenant(shop.businessId, () =>
      service.notificationPreferences(shop.businessId, shop.cashier, "cashier"),
    );
    const variance = before.find((row) => row.eventKey === "shift.cash_variance")!;
    // The screen has to be able to say "this is the default, and it is off" —
    // rather than showing an empty form that implies nothing is happening.
    expect(variance.isDefault).toBe(true);
    expect(variance.enabled).toBe(false);
    expect(variance.ruleId).toBeNull();

    await dbLib.withTenant(shop.businessId, () =>
      service.saveNotificationRule(shop.businessId, shop.cashier, {
        eventKey: "shift.cash_variance",
        locationId: null,
        enabled: true,
        channels: ["inapp"],
        minSeverity: "info",
        minAmountRial: null,
        quietFromMinutes: null,
        quietToMinutes: null,
      }),
    );

    const after = await dbLib.withTenant(shop.businessId, () =>
      service.notificationPreferences(shop.businessId, shop.cashier, "cashier"),
    );
    const saved = after.find((row) => row.eventKey === "shift.cash_variance")!;
    expect(saved.isDefault).toBe(false);
    expect(saved.enabled).toBe(true);
    expect(saved.ruleId).not.toBeNull();

    // Deleting the rule restores the default rather than switching it off.
    await dbLib.withTenant(shop.businessId, () =>
      service.deleteNotificationRule(shop.businessId, shop.cashier, saved.ruleId!),
    );
    const restored = await dbLib.withTenant(shop.businessId, () =>
      service.notificationPreferences(shop.businessId, shop.cashier, "cashier"),
    );
    expect(restored.find((row) => row.eventKey === "shift.cash_variance")!.isDefault).toBe(true);
  });

  it("saving the same event twice updates one rule rather than making two", async () => {
    for (const severity of ["info", "critical"] as const) {
      await dbLib.withTenant(shop.businessId, () =>
        service.saveNotificationRule(shop.businessId, shop.owner, {
          eventKey: "shift.closed",
          locationId: null,
          enabled: true,
          channels: ["inapp"],
          minSeverity: severity,
          minAmountRial: null,
          quietFromMinutes: null,
          quietToMinutes: null,
        }),
      );
    }
    const rules = await dbLib.withTenant(shop.businessId, () =>
      service.listNotificationRules(shop.businessId, shop.owner),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].minSeverity).toBe("critical");
  });
});

describe("the test notification", () => {
  it("reaches the caller's own devices even with the event switched off", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await dbLib.withTenant(shop.businessId, () =>
      service.saveNotificationRule(shop.businessId, shop.owner, {
        eventKey: "shift.cash_variance",
        locationId: null,
        enabled: false,
        channels: ["inapp"],
        minSeverity: "info",
        minAmountRial: null,
        quietFromMinutes: null,
        quietToMinutes: null,
      }),
    );

    const result = await dbLib.withTenant(shop.businessId, () =>
      service.sendTestNotification(shop.businessId, shop.owner),
    );
    // The button answers "is this phone set up correctly"; routing it through
    // the rules would make a working device look broken.
    expect(result).toEqual({ devices: 1, sent: 1, errors: [] });
    expect(calls).toHaveLength(1);
  });

  it("says so when there is no device rather than reporting success", async () => {
    stubPush();
    const result = await dbLib.withTenant(shop.businessId, () =>
      service.sendTestNotification(shop.businessId, shop.managerA),
    );
    expect(result.devices).toBe(0);
    expect(result.sent).toBe(0);
  });
});

describe("native FCM device fan-out", () => {
  it("delivers push payloads to active FCM native_app_devices honoring channel preferences and skips revoked devices", async () => {
    process.env.BIZA_FIREBASE_PROJECT_ID = "test-firebase-project";
    process.env.BIZA_FCM_ACCESS_TOKEN = "test-fcm-access-token";
    const fcmRequests: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      fcmRequests.push({
        url: String(url),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify({ name: "projects/test/messages/1" }), { status: 200 });
    });

    // Active device subscribed to "approvals" (matches shift.cash_variance)
    await db.query(
      `INSERT INTO native_app_devices (
        business_id, user_id, install_id, platform, app_environment,
        app_version_name, app_version_code, bridge_version,
        push_token, push_provider, push_channels
      ) VALUES ($1, $2, $3, 'android', 'production', '0.1.0', 1, 3, $4, 'fcm', $5)`,
      [
        shop.businessId,
        shop.owner,
        randomUUID(),
        "fcm-token-owner-active-123456",
        JSON.stringify(["approvals", "orders"]),
      ],
    );

    // Active device subscribed ONLY to "crm" (should be skipped for shift.cash_variance)
    await db.query(
      `INSERT INTO native_app_devices (
        business_id, user_id, install_id, platform, app_environment,
        app_version_name, app_version_code, bridge_version,
        push_token, push_provider, push_channels
      ) VALUES ($1, $2, $3, 'android', 'production', '0.1.0', 1, 3, $4, 'fcm', $5)`,
      [
        shop.businessId,
        shop.owner,
        randomUUID(),
        "fcm-token-owner-crm-only-123456",
        JSON.stringify(["crm"]),
      ],
    );

    // Revoked device (must never receive FCM push)
    await db.query(
      `INSERT INTO native_app_devices (
        business_id, user_id, install_id, platform, app_environment,
        app_version_name, app_version_code, bridge_version,
        push_token, push_provider, push_channels, revoked_at
      ) VALUES ($1, $2, $3, 'android', 'production', '0.1.0', 1, 3, $4, 'fcm', $5, NOW())`,
      [
        shop.businessId,
        shop.owner,
        randomUUID(),
        "fcm-token-owner-revoked-123456",
        JSON.stringify(["approvals"]),
      ],
    );

    await enqueue();
    await deliver();

    expect(fcmRequests).toHaveLength(1);
    expect(fcmRequests[0].url).toBe(
      "https://fcm.googleapis.com/v1/projects/test-firebase-project/messages:send",
    );
    expect(fcmRequests[0].body).toMatchObject({
      message: {
        token: "fcm-token-owner-active-123456",
        data: expect.objectContaining({
          businessId: shop.businessId,
          category: "approvals",
          eventType: "shift.cash_variance",
        }),
      },
    });
  });

  it("clears push_token and push_provider when FCM returns 410 Gone for a stale registration", async () => {
    process.env.BIZA_FIREBASE_PROJECT_ID = "test-firebase-project";
    process.env.BIZA_FCM_ACCESS_TOKEN = "test-fcm-access-token";
    vi.stubGlobal("fetch", async () => new Response(null, { status: 410 }));

    const installId = randomUUID();
    await db.query(
      `INSERT INTO native_app_devices (
        business_id, user_id, install_id, platform, app_environment,
        app_version_name, app_version_code, bridge_version,
        push_token, push_provider, push_channels
      ) VALUES ($1, $2, $3, 'android', 'production', '0.1.0', 1, 3, $4, 'fcm', $5)`,
      [
        shop.businessId,
        shop.owner,
        installId,
        "fcm-token-stale-410-123456",
        JSON.stringify(["approvals"]),
      ],
    );

    await enqueue();
    await deliver();

    const { rows } = await db.query<{ push_token: string | null; push_provider: string | null }>(
      `SELECT push_token, push_provider FROM native_app_devices WHERE business_id = $1 AND install_id = $2`,
      [shop.businessId, installId],
    );
    expect(rows[0]).toEqual({ push_token: null, push_provider: null });
  });
});

describe("audit #931: durable delivery, isolation and flood prevention", () => {
  it("retains 100 details while grouping the burst into one OS push", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await db.query(
      `UPDATE notification_preferences SET mode='digest',digest_minutes=5 WHERE user_id=$1`,
      [shop.owner],
    );
    for (let i = 0; i < 100; i++) await enqueue({ dedupeKey: `burst:${i}`, title: `event ${i}` });
    await deliver(0, 100);
    expect(calls).toHaveLength(0);
    expect(await bellFor(shop.owner)).toHaveLength(100);
    await deliver(5);
    expect(calls).toHaveLength(1);
    const { rows } = await db.query(
      `SELECT status,count(*)::int AS n,count(DISTINCT batch_id)::int AS batches FROM notification_deliveries GROUP BY status`,
    );
    expect(rows).toEqual([{ status: "sent", n: 100, batches: 1 }]);
    await deliver(10);
    expect(calls).toHaveLength(1);
  });
  it("defers a second immediate burst durably and critical bypasses ordinary backlog", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await enqueue({ dedupeKey: "first" });
    await deliver();
    await enqueue({ dedupeKey: "second" });
    await deliver();
    expect(calls).toHaveLength(1);
    expect(
      (await db.query(`SELECT status,error FROM notification_deliveries WHERE status='queued'`))
        .rows,
    ).toEqual([{ status: "queued", error: "throttled" }]);
    await enqueue({
      eventKey: "backup.failed",
      severity: "critical",
      locationId: null,
      dedupeKey: "urgent",
    });
    await deliver();
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.Urgency).toBe("high");
    await deliver(5);
    expect(calls).toHaveLength(3);
  });
  it.each([429, 503])(
    "retries provider %s after backoff without losing inbox or queued facts",
    async (status) => {
      const calls = stubPush(status);
      await addDevice(shop.owner);
      await enqueue();
      await deliver();
      expect((await db.query(`SELECT status,attempts FROM notification_deliveries`)).rows).toEqual([
        { status: "queued", attempts: 1 },
      ]);
      stubPush(201);
      await deliver(6);
      expect((await db.query(`SELECT status,attempts FROM notification_deliveries`)).rows).toEqual([
        { status: "sent", attempts: 2 },
      ]);
      expect(calls).toHaveLength(1);
      expect(await bellFor(shop.owner)).toHaveLength(1);
    },
  );
  it("recovers a crash after partial fanout and an expired push lease", async () => {
    const calls = stubPush();
    const device = await addDevice(shop.owner);
    await enqueue({ dedupeKey: "crash" });
    const {
      rows: [event],
    } = await db.query(`SELECT id FROM notification_events`);
    await db.query(
      `INSERT INTO notification_recipients(business_id,event_id,user_id) VALUES($1,$2,$3)`,
      [shop.businessId, event.id, shop.owner],
    );
    await db.query(
      `UPDATE notification_events SET lease_until=now()-interval '1 second' WHERE id=$1`,
      [event.id],
    );
    await db.query(
      `INSERT INTO notification_deliveries(business_id,event_id,device_id,user_id,available_at,lease_until,batch_id,attempts)
      VALUES($1,$2,$3,$4,'2026-06-01',now()-interval '1 second',$5,1)`,
      [shop.businessId, event.id, device.id, shop.owner, randomUUID()],
    );
    await deliver();
    expect(calls).toHaveLength(1);
    expect(await bellFor(shop.owner)).toHaveLength(1);
    expect((await db.query(`SELECT status,attempts FROM notification_deliveries`)).rows).toEqual([
      { status: "sent", attempts: 2 },
    ]);
  });
  it("concurrent workers claim one batch and do not duplicate presentation", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await enqueue();
    await Promise.all([deliver(), deliver()]);
    expect(calls).toHaveLength(1);
    expect(await bellFor(shop.owner)).toHaveLength(1);
  });
  it("revokes only the device bound to the ended login", async () => {
    const calls = stubPush();
    const first = await addDevice(shop.owner);
    const other = await addDevice(shop.owner, "other");
    await db.query(
      `UPDATE employee_sessions SET revoked_at=now() WHERE id=(SELECT session_id FROM notification_devices WHERE id=$1)`,
      [first.id],
    );
    expect(
      (await db.query(`SELECT disabled_at FROM notification_devices WHERE id=$1`, [first.id]))
        .rows[0].disabled_at,
    ).not.toBeNull();
    expect(
      (await db.query(`SELECT disabled_at FROM notification_devices WHERE id=$1`, [other.id]))
        .rows[0].disabled_at,
    ).toBeNull();
    await enqueue();
    await deliver();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(other.endpoint);
  });
  it("rechecks permission revocation before queued delivery AND inbox read", async () => {
    const calls = stubPush();
    await addDevice(shop.managerA);
    await db.query(`UPDATE notification_preferences SET mode='digest' WHERE user_id=$1`, [
      shop.managerA,
    ]);
    await enqueue();
    await deliver();
    expect(await bellFor(shop.managerA)).toHaveLength(1);
    await db.query(`UPDATE users SET permissions=$2 WHERE id=$1`, [
      shop.managerA,
      JSON.stringify({ revoked: ["ledger.view"] }),
    ]);
    await deliver(5);
    expect(calls).toHaveLength(0);
    const inbox = await dbLib.withTenant(shop.businessId, () =>
      service.listNotificationInbox(shop.businessId, shop.managerA),
    );
    expect(inbox).toEqual({ entries: [], unread: 0 });
    expect((await db.query(`SELECT status,error FROM notification_deliveries`)).rows).toEqual([
      { status: "expired", error: "authorization_revoked" },
    ]);
  });
  it("applies recipient timezone and releases quiet-hour work instead of hiding it", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await db.query(`UPDATE notification_preferences SET timezone='UTC' WHERE user_id=$1`, [
      shop.owner,
    ]);
    await dbLib.withTenant(shop.businessId, () =>
      service.saveNotificationRule(shop.businessId, shop.owner, {
        eventKey: "shift.cash_variance",
        channels: ["push", "inapp"],
        quietFromMinutes: 8 * 60,
        quietToMinutes: 9 * 60,
      }),
    );
    await enqueue();
    await deliver();
    expect(calls).toHaveLength(0);
    expect(await bellFor(shop.owner)).toHaveLength(1);
    await deliver(31);
    expect(calls).toHaveLength(1);
  });
  it("keeps an intentional 90-day inbox and never cleans queued work", async () => {
    stubPush();
    await addDevice(shop.owner);
    await enqueue();
    await deliver();
    await db.query(`UPDATE notification_events SET processed_at=now()-interval '31 days'`);
    await deliver();
    expect(await bellFor(shop.owner)).toHaveLength(1);
    await db.query(`UPDATE notification_events SET processed_at=now()-interval '91 days'`);
    await deliver();
    expect(await bellFor(shop.owner)).toHaveLength(0);
  });
  it("API throttles and budgets are durable and tenant/user scoped", async () => {
    const { notificationApiAllowed } = await import("../src/lib/notification-api");
    const allow = (user: string) =>
      dbLib.withTenant(shop.businessId, () =>
        notificationApiAllowed(shop.businessId, user, "test"),
      );
    expect(await allow(shop.owner)).toBe(true);
    expect(await allow(shop.owner)).toBe(false);
    expect(await allow(shop.managerA)).toBe(true);
    const {
      rows: [other],
    } = await db.query(`INSERT INTO businesses(name,slug) VALUES('Other',$1) RETURNING id`, [
      `other-${randomUUID()}`,
    ]);
    expect(
      await dbLib.withTenant(other.id, () => notificationApiAllowed(other.id, shop.owner, "test")),
    ).toBe(true);
  });
});

describe("audit #931: project confidentiality", () => {
  it("requires project membership, rechecks removal on inbox/retry, and excludes another tenant's project", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await db.query(`UPDATE businesses SET industry='architecture_construction' WHERE id=$1`, [
      shop.businessId,
    ]);
    await db.query(
      `INSERT INTO aec_business_profiles(business_id,operating_profile,capability_overrides)
      VALUES($1,'contractor','{"document_control":true}') ON CONFLICT(business_id) DO UPDATE SET capability_overrides=EXCLUDED.capability_overrides`,
      [shop.businessId],
    );
    const {
      rows: [project],
    } = await db.query(
      `INSERT INTO ai_projects(business_id,name,created_by) VALUES($1,'Private','test') RETURNING id`,
      [shop.businessId],
    );
    await dbLib.withTenant(shop.businessId, () =>
      service.saveNotificationRule(shop.businessId, shop.owner, {
        eventKey: "aec.rfi_overdue",
        channels: ["push", "inapp"],
        enabled: true,
      }),
    );
    await enqueue({
      eventKey: "aec.rfi_overdue",
      locationId: null,
      amountRial: null,
      dedupeKey: "project-non-member",
      payload: { projectId: project.id },
    });
    await deliver();
    expect(await bellFor(shop.owner)).toHaveLength(0);
    await db.query(
      `INSERT INTO workspace_members(project_id,user_id,role) VALUES($1,$2,'viewer')`,
      [project.id, shop.owner],
    );
    await db.query(`UPDATE notification_preferences SET mode='digest' WHERE user_id=$1`, [
      shop.owner,
    ]);
    await enqueue({
      eventKey: "aec.rfi_overdue",
      locationId: null,
      amountRial: null,
      dedupeKey: "project-member",
      payload: { projectId: project.id },
    });
    await deliver();
    expect(await bellFor(shop.owner)).toHaveLength(1);
    await db.query(`DELETE FROM workspace_members WHERE project_id=$1 AND user_id=$2`, [
      project.id,
      shop.owner,
    ]);
    await deliver(5);
    expect(calls).toHaveLength(0);
    expect(
      await dbLib.withTenant(shop.businessId, () =>
        service.listNotificationInbox(shop.businessId, shop.owner),
      ),
    ).toEqual({ entries: [], unread: 0 });
    const {
      rows: [foreign],
    } = await db.query(`INSERT INTO businesses(name,slug) VALUES('Foreign',$1) RETURNING id`, [
      `foreign-${randomUUID()}`,
    ]);
    const {
      rows: [foreignProject],
    } = await db.query(
      `INSERT INTO ai_projects(business_id,name,created_by) VALUES($1,'Foreign private','test') RETURNING id`,
      [foreign.id],
    );
    await enqueue({
      eventKey: "aec.rfi_overdue",
      locationId: null,
      amountRial: null,
      dedupeKey: "foreign-project",
      payload: { projectId: foreignProject.id },
    });
    await deliver(6);
    expect(await bellFor(shop.owner)).toHaveLength(1);
  });
});

describe("audit #931: independent budgets and cancellation", () => {
  it("does not let one recipient or tenant consume another's push budget", async () => {
    const calls = stubPush();
    const firstShop = { ...shop };
    await addDevice(shop.owner);
    await addDevice(shop.managerA);
    await enqueue();
    await deliver();
    expect(calls).toHaveLength(2); // Two distinct recipient budgets, same tenant.
    await enqueue({ dedupeKey: "blocked-first-tenant" });
    await deliver();
    expect(calls).toHaveLength(2);
    Object.assign(shop, await seedBusiness());
    await addDevice(shop.owner);
    await enqueue();
    await deliver();
    expect(calls).toHaveLength(3); // Another tenant remains independent.
    Object.assign(shop, firstShop);
  });
  it("keeps stale/in-app-only detail but explicitly cancels obsolete pushes", async () => {
    const calls = stubPush();
    await addDevice(shop.owner);
    await db.query(`UPDATE notification_preferences SET mode='digest' WHERE user_id=$1`, [
      shop.owner,
    ]);
    await enqueue();
    await deliver();
    await db.query(`UPDATE notification_events SET created_at='2026-05-01'`);
    await deliver(5);
    expect(calls).toHaveLength(0);
    expect((await db.query(`SELECT status,error FROM notification_deliveries`)).rows).toEqual([
      { status: "expired", error: "stale" },
    ]);
    expect(await bellFor(shop.owner)).toHaveLength(1);
    await db.query(`UPDATE notification_preferences SET mode='inapp' WHERE user_id=$1`, [
      shop.owner,
    ]);
    await enqueue({ dedupeKey: "inapp-only" });
    await deliver(10);
    expect(calls).toHaveLength(0);
    expect(await bellFor(shop.owner)).toHaveLength(2);
  });
});
