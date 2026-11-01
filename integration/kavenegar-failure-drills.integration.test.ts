/**
 * Issue #902 §9 item 7 — the drill that matters most (DoD #9 × DoD #11).
 *
 * DoD #9 says login must survive the business's commercial state:
 *
 *   *"Auth OTP still works if Growth is disabled, tenant marketing credit is
 *   exhausted, campaign sends are paused, or an individual child's account is
 *   suspended."*
 *
 * Every one of those has been tested on its own — the drain leaves rows queued
 * when a child is not active, `resolveBusinessSmsSender` refuses a suspended
 * child, the reservation fails closed on an empty wallet. What no test proved is
 * the *combination*: that with a business in each of those states, **a member of
 * that business can still log in**. The two paths share a database, a module and
 * a supplier, and the thing that keeps them apart is a decision (the login code
 * rides the platform-auth transport, paid by the platform) rather than a
 * coincidence of code layout.
 *
 * So this file drives the real drain and the real OTP dispatch against a real
 * database, with one scripted `fetch` at the edge:
 *
 *   - the drain must attempt **nothing** and leave every row queued;
 *   - the wallet must not move by a single rial;
 *   - `getSmsProvider()` must still produce a working sender, and the code must
 *     leave on the **platform's** key — never the child's;
 *   - and the reverse: a carrier that refuses the login code must fail honestly
 *     (a Persian error the screen shows, challenge consumed) rather than logging
 *     the code and pretending success.
 *
 * No network call is made: `fetch` is replaced for the duration of the file.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { MessageProvider } from "../src/lib/messaging/provider";
import type { KavenegarError as KavenegarErrorType } from "../src/lib/sms-kavenegar";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

/** The platform-auth key: what a login code rides on, and nothing else does. */
const PLATFORM_KEY = "PLATFORMKEY0000000000000000000001";
/** The business's own child key. A login code must never be sent with this. */
const CHILD_KEY = "CHILDKEY1234567890ABCDEFGHIJ";

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let outbox: typeof import("../src/lib/message-outbox-service");
let billing: typeof import("../src/lib/messaging-billing");
let credentials: typeof import("../src/lib/kavenegar/credentials");
let smsConfig: typeof import("../src/lib/sms-config");
let smsKavenegar: typeof import("../src/lib/sms-kavenegar");

const alpha = { businessId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function seedBusiness(name: string): Promise<{ businessId: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id };
}

async function fundWallet(businessId: string, rial: number): Promise<void> {
  await db.query(
    `INSERT INTO business_wallets (business_id, balance_rial, total_topped_up_rial, total_spent_rial)
     VALUES ($1, $2, $2, 0)`,
    [businessId, rial],
  );
  await db.query(
    `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, note)
     VALUES ($1, 'top_up', 'credit', $2, $2, 'seed top-up')`,
    [businessId, rial],
  );
}

async function balanceRial(businessId: string): Promise<number> {
  const { rows } = await db.query<{ balance_rial: string }>(
    `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
    [businessId],
  );
  return Number(rows[0]!.balance_rial);
}

/** A child account in the given state, with a key unless it is inactive. */
async function childAccount(businessId: string, state: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO kavenegar_business_accounts
       (business_id, localid, username, provision_state, provider_status, sender_lines)
     VALUES ($1, $2, $3, $4, 'approved', '{10004346}')
     RETURNING id`,
    [businessId, businessId, `bm${randomUUID().replaceAll("-", "").slice(0, 8)}`, state],
  );
  if (state === "active") await credentials.writeAccountApiKey(rows[0]!.id, CHILD_KEY);
}

/** Queued sends for one campaign, in the state the drain claims. */
async function queueSends(businessId: string, addresses: string[], campaignStatus = "sending"): Promise<void> {
  const { rows: campaignRows } = await db.query<{ id: string }>(
    `INSERT INTO message_campaigns (business_id, channel, name, status)
     VALUES ($1, 'sms', 'Drill', $2) RETURNING id`,
    [businessId, campaignStatus],
  );
  for (const address of addresses) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO message_recipients (business_id, campaign_id, channel, address, body)
       VALUES ($1, $2, 'sms', $3, 'کد ورود شما: ۱۲۳۴') RETURNING id`,
      [businessId, campaignRows[0]!.id, address],
    );
    await db.query(
      `INSERT INTO message_outbox (business_id, recipient_id, campaign_id, status)
       VALUES ($1, $2, $3, 'queued')`,
      [businessId, rows[0]!.id, campaignRows[0]!.id],
    );
  }
}

/** Outbox states, as the queue itself sees them. */
async function outboxStatuses(businessId: string): Promise<string[]> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM message_outbox WHERE business_id = $1 ORDER BY created_at`,
    [businessId],
  );
  return rows.map((row) => row.status);
}

/** A marketing transport that always refuses — the provider-outage drill. */
function refusingProvider(): MessageProvider {
  return {
    key: "scripted-outage",
    channel: "sms",
    async send() {
      return { ok: false, retryable: true, code: "kavenegar_451", message: "rate limited" };
    },
  };
}

/** Every URL the OTP transport asked for, and every body it read. */
let otpRequests: string[] = [];

/** Answer the login-code call the way the carrier does. */
function stubCarrier(answer: { status: number; body?: unknown } | "throw-timeout") {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    otpRequests.push(url);
    if (answer === "throw-timeout") {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    const body = JSON.stringify(answer.body ?? { return: { status: answer.status } });
    // Both readers, because the two transports parse differently: the login
    // transport reads `json()`, the marketing adapter reads `text()` and parses
    // it itself. A stub that served only one would fail a drill for a reason
    // that has nothing to do with the drill.
    return {
      ok: answer.status === 200,
      status: answer.status,
      json: async () => JSON.parse(body),
      text: async () => body,
    };
  });
}

/** Send a login code exactly as the auth path does. */
async function sendLoginCode(phone: string, code: string): Promise<void> {
  const provider = await smsConfig.getSmsProvider();
  await provider.sendOtp(phone, code);
}

/**
 * The drain, with or without an injected transport.
 *
 * Without injection it runs the **production** path — `buildProviders` over the
 * sender the managed-account resolver chose — which is the only way to prove the
 * fail-closed decision for a suspended child. With injection it is the seam the
 * other database suites use to script a provider's answer.
 */
async function drain(providers?: { sms: MessageProvider | null; email: MessageProvider | null }) {
  const config = await billing.resolveMessageConfig();
  return dbLib.withTenant(alpha.businessId, () =>
    outbox.runBusinessMessageDrain(alpha.businessId, config, providers),
  );
}

/**
 * Point the platform's marketing adapter at the carrier, so a provider *would* be
 * built for a business with no managed account. A suspended child must still get
 * none — that is the whole drill.
 */
async function platformMarketingAdapter(provider: "noop" | "kavenegar"): Promise<void> {
  await db.query(`UPDATE platform_message_config SET sms_provider = $1 WHERE id = true`, [provider]);
}

beforeAll(async () => {
  databaseName = `pos_kavenegar_drills_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  outbox = await import("../src/lib/message-outbox-service");
  billing = await import("../src/lib/messaging-billing");
  credentials = await import("../src/lib/kavenegar/credentials");
  smsConfig = await import("../src/lib/sms-config");
  smsKavenegar = await import("../src/lib/sms-kavenegar");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // The platform's own send configuration. `noop` for the marketing adapter keeps
  // `buildProviders` from constructing one we do not use, while `getSmsProvider`
  // is answered by KAVENEGAR_API_KEY above — the same resolution order production
  // uses (stored console key, then environment).
  await db.query(
    `INSERT INTO platform_message_config (id, enabled, sms_provider, email_provider, sms_rial_per_segment)
     VALUES (true, true, 'noop', 'noop', 1200)
     ON CONFLICT (id) DO UPDATE
       SET enabled = true, sms_provider = 'noop', email_provider = 'noop', sms_rial_per_segment = 1200`,
  );
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.KAVENEGAR_API_KEY;
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  otpRequests = [];
  // The deployment-wide login-code credential. Present in every drill: the point
  // is that nothing about a *business* can take it away.
  process.env.KAVENEGAR_API_KEY = PLATFORM_KEY;
  delete process.env.KAVENEGAR_OTP_TEMPLATE;

  await db.query("DELETE FROM message_outbox");
  await db.query("DELETE FROM message_recipients");
  await db.query("DELETE FROM message_campaigns");
  await db.query("DELETE FROM billing_vendor_cost_events");
  await db.query("DELETE FROM billing_usage_ratings");
  await db.query("DELETE FROM billing_usage_events");
  await db.query("DELETE FROM wallet_ledger");
  await db.query("DELETE FROM business_wallets");
  await db.query("DELETE FROM kavenegar_account_credentials");
  await db.query("DELETE FROM kavenegar_business_accounts");
  await db.query("DELETE FROM businesses");

  Object.assign(alpha, await seedBusiness("Alpha"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login survives every way a business's marketing can be broken", () => {
  it("suspended child: nothing is attempted, nothing is charged, the code still goes out", async () => {
    await childAccount(alpha.businessId, "suspended");
    await fundWallet(alpha.businessId, 500_000);
    await queueSends(alpha.businessId, ["+989120000001", "+989120000002"]);
    const before = await balanceRial(alpha.businessId);
    // The platform adapter is live: without the managed-sender rule this would
    // happily build a provider and bill the *platform* account for a tenant whose
    // managed service is suspended.
    await platformMarketingAdapter("kavenegar");

    const result = await drain();

    // `attempted` is the number of rows the drain *claimed*; the proof that no
    // dispatch happened is on the rows themselves — no attempt counted, no
    // attempt timestamped, still queued — and on the wallet, which did not move.
    expect(result).toMatchObject({ sent: 0, failed: 0 });
    expect(await outboxStatuses(alpha.businessId)).toEqual(["queued", "queued"]);
    const { rows: queue } = await db.query<{ attempts: number; last_attempt_at: Date | null }>(
      `SELECT attempts, last_attempt_at FROM message_outbox WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(queue.map((row) => row.attempts)).toEqual([0, 0]);
    expect(queue.map((row) => row.last_attempt_at)).toEqual([null, null]);
    expect(await balanceRial(alpha.businessId)).toBe(before);

    // And the member can still log in.
    stubCarrier({ status: 200 });
    await sendLoginCode("+989120000001", "482913");
    expect(otpRequests).toHaveLength(1);
    expect(otpRequests[0]).toContain(PLATFORM_KEY);
    expect(otpRequests[0]).not.toContain(CHILD_KEY);
    expect(otpRequests[0]).toContain("verify/lookup.json");
  });

  it("empty wallet: the drain refuses before it sends, and login does not care", async () => {
    await childAccount(alpha.businessId, "active");
    await queueSends(alpha.businessId, ["+989120000001"]);

    // A provider that would scream if it were called: an empty wallet must stop
    // the drain before the first dispatch, not after it.
    let called = 0;
    const sentinel: MessageProvider = {
      key: "sentinel",
      channel: "sms",
      async send() {
        called += 1;
        return { ok: true, providerMessageId: "never", segments: 1 };
      },
    };

    const result = await drain({ sms: sentinel, email: null });
    expect(result).toMatchObject({ attempted: 0, sent: 0, failed: 0 });
    expect(called).toBe(0);
    expect(await outboxStatuses(alpha.businessId)).toEqual(["queued"]);

    stubCarrier({ status: 200 });
    await sendLoginCode("+989120000001", "482913");
    expect(otpRequests).toHaveLength(1);
  });

  it("paused campaign: the queue is not claimed, and login still works", async () => {
    await childAccount(alpha.businessId, "active");
    await fundWallet(alpha.businessId, 500_000);
    await queueSends(alpha.businessId, ["+989120000001"], "paused");

    let called = 0;
    const sentinel: MessageProvider = {
      key: "sentinel",
      channel: "sms",
      async send() {
        called += 1;
        return { ok: true, providerMessageId: "never", segments: 1 };
      },
    };

    const result = await drain({ sms: sentinel, email: null });
    expect(result).toMatchObject({ attempted: 0, sent: 0, failed: 0 });
    expect(called).toBe(0);
    expect(await outboxStatuses(alpha.businessId)).toEqual(["queued"]);

    stubCarrier({ status: 200 });
    await sendLoginCode("+989120000001", "482913");
    expect(otpRequests).toHaveLength(1);
  });

  it("provider outage: the send is requeued, not failed, and login is unaffected", async () => {
    await childAccount(alpha.businessId, "active");
    await fundWallet(alpha.businessId, 500_000);
    await queueSends(alpha.businessId, ["+989120000001"]);
    const before = await balanceRial(alpha.businessId);

    const result = await drain({ sms: refusingProvider(), email: null });
    expect(result).toMatchObject({ attempted: 1, sent: 0, failed: 0 });

    // Still queued with a backoff: a rate limit is "later", not "never".
    expect(await outboxStatuses(alpha.businessId)).toEqual(["queued"]);
    const { rows } = await db.query<{ next_attempt_at: Date; attempts: number }>(
      `SELECT next_attempt_at, attempts FROM message_outbox WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(rows[0]!.attempts).toBe(1);
    expect(new Date(rows[0]!.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Nothing was charged for a message that never went out.
    expect(await balanceRial(alpha.businessId)).toBe(before);

    stubCarrier({ status: 200 });
    await sendLoginCode("+989120000001", "482913");
    expect(otpRequests).toHaveLength(1);
  });

  it("a business with no child at all: whole fleet is unaffected", async () => {
    // No account row: the legacy platform path. Still nothing to send with the
    // marketing adapter disabled, but the login transport resolves regardless —
    // which is the property DoD #9 is about.
    await queueSends(alpha.businessId, ["+989120000001"]);

    stubCarrier({ status: 200 });
    await sendLoginCode("+989120000001", "482913");
    expect(otpRequests).toHaveLength(1);
    expect(otpRequests[0]).toContain(PLATFORM_KEY);
  });
});

describe("the two transports use different credentials in the same run", () => {
  it("markets with the business's child key and logs in with the platform key", async () => {
    await childAccount(alpha.businessId, "active");
    await fundWallet(alpha.businessId, 500_000);
    await queueSends(alpha.businessId, ["+989120000001"]);
    await platformMarketingAdapter("kavenegar");

    // One stub answers both calls, so the assertion is about the two URLs that
    // were actually built — not about which module we believed was called.
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const body = JSON.stringify({
        return: { status: 200, message: "ok" },
        entries: [{ messageid: 1, status: 1, cost: 500 }],
      });
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
    });

    const result = await drain();
    expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0 });

    await sendLoginCode("+989120000002", "482913");

    const marketing = urls.filter((url) => url.includes("/sms/send.json"));
    const login = urls.filter((url) => url.includes("/verify/lookup.json"));
    expect(marketing).toHaveLength(1);
    expect(login).toHaveLength(1);

    // The separation, asserted on the wire: the marketing message carries the
    // business's own credential, the login code carries the platform's, and
    // neither URL contains the other's key.
    expect(marketing[0]).toContain(CHILD_KEY);
    expect(marketing[0]).not.toContain(PLATFORM_KEY);
    expect(login[0]).toContain(PLATFORM_KEY);
    expect(login[0]).not.toContain(CHILD_KEY);
  });
});

describe("when the login code itself cannot be delivered", () => {
  it("fails honestly on a carrier timeout, and says nothing that logs the code", async () => {
    stubCarrier("throw-timeout");

    const error = await sendLoginCode("+989120000001", "482913").then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    // A real failure the screen can render, not a silent success.
    expect(error).toBeInstanceOf(smsKavenegar.KavenegarError);
    expect(error!.message).toBe(smsKavenegar.OTP_TIMEOUT_MESSAGE);
    expect(error!.message).not.toContain("482913");
  });

  it("fails honestly when the carrier rejects the platform credential", async () => {
    stubCarrier({ status: 403, body: { return: { status: 403, message: "access denied" } } });

    const error = await sendLoginCode("+989120000001", "482913").then(
      () => null,
      (thrown: unknown) => thrown as KavenegarErrorType,
    );

    expect(error).toBeInstanceOf(smsKavenegar.KavenegarError);
    expect(error!.status).toBe(403);
    // Operator fault: this is ours to fix, and the person is not told their
    // number is wrong when the platform's key stopped working.
    expect(error!.operatorFault).toBe(true);
    expect(error!.message).toMatch(/[\u0600-\u06FF]/);
    expect(error!.message).not.toContain("482913");
  });

  it("refuses to log a code in production when no credential exists at all", async () => {
    // The DoD #9 fallback rule, exercised through the real resolver rather than
    // the unit: no key anywhere, and a deployment that is not a developer's box.
    delete process.env.KAVENEGAR_API_KEY;
    const previous = process.env.NODE_ENV;
    // `production` is what a deployed install reports; the fallback must throw
    // instead of printing a live code into a log file.
    vi.stubEnv("NODE_ENV", "production");
    try {
      const error = await sendLoginCode("+989120000001", "482913").then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      expect(error?.name).toBe("SmsNotConfiguredError");
      expect(otpRequests).toHaveLength(0);
    } finally {
      if (previous === undefined) vi.unstubAllEnvs();
      else vi.stubEnv("NODE_ENV", previous);
      process.env.KAVENEGAR_API_KEY = PLATFORM_KEY;
    }
  });
});
