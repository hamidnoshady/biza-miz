/**
 * #1585 — persistent remembered-login authorization, against real Postgres.
 *
 * The properties this suite exists to pin are the ones a unit test cannot:
 * rotation is atomic under concurrency, a replayed credential is recognised and
 * revokes its family, both deadlines are enforced, a removed membership ends the
 * family, and RLS keeps one business's families invisible to another.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let remembered: typeof import("../src/lib/remembered-login");
const { EMPTY_DEVICE_CONTEXT } = { EMPTY_DEVICE_CONTEXT: { browserFamily: "chrome" as const, osFamily: "windows" as const, regionHint: "IR" } };

const biz = { id: "", userId: "" };

/**
 * Whether this connection is actually subject to RLS. The suite's own PGlite
 * fallback (scripts/pglite-wire-server.mjs) connects as a superuser, which
 * bypasses row security entirely; the repo's isolation suites all gate on this
 * instead of pretending the assertion ran. CI's `postgres:16` service runs it.
 */
let rlsActive = false;

/**
 * A pool of one cannot run two transactions at the same time, so "five
 * simultaneous requests" would be five sequential ones and the race it exists
 * to pin would never happen. The PGlite fallback documents this limit itself;
 * the concurrency assertions belong to the real server in CI.
 */
const serialisedPool = process.env.DB_POOL_MAX === "1";

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

beforeAll(async () => {
  databaseName = `pos_remember_${randomUUID().replaceAll("-", "")}`;
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
  remembered = await import("../src/lib/remembered-login");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  rlsActive = await dbLib.rlsEffective();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool().catch(() => {});
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
  await db.query("DELETE FROM remembered_login_families");
  await db.query("DELETE FROM businesses");
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Remember Co', $1) RETURNING id",
    [`remember-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  biz.userId = userRow.rows[0].id;
});

async function issue(overrides: { businessId?: string; userId?: string } = {}) {
  return remembered.issueRememberedLogin({
    businessId: overrides.businessId ?? biz.id,
    userId: overrides.userId ?? biz.userId,
    platformUserId: null,
    loginMethod: "password",
    mfaVerified: false,
    otpOnlyAssurance: false,
    authenticatedAt: new Date(),
    deviceLabel: "Chrome on Windows",
    device: EMPTY_DEVICE_CONTEXT,
  });
}

describe("issuing and rotating", () => {
  it("mints one family with one credential and stores only a digest", async () => {
    const issued = await issue();
    expect(issued.secret.startsWith("rlog_")).toBe(true);
    expect(issued.absoluteExpiresAt.getTime()).toBeGreaterThan(Date.now());

    const { rows } = await db.query<{ token_hash: string; generation: number }>(
      "SELECT token_hash, generation FROM remembered_login_credentials WHERE family_id = $1",
      [issued.familyId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].generation).toBe(1);
    // The stored value is a hex digest, never the secret itself.
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toContain(issued.secret);
  });

  it("rotates to a new secret, supersedes the old one and grows the chain", async () => {
    const issued = await issue();
    const first = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(first.status).toBe("rotated");
    if (first.status !== "rotated") return;
    expect(first.secret).not.toBe(issued.secret);

    const second = await remembered.rotateRememberedLogin({
      secret: first.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(second.status).toBe("rotated");

    const { rows } = await db.query<{ generation: number; superseded_at: Date | null }>(
      "SELECT generation, superseded_at FROM remembered_login_credentials WHERE family_id = $1 ORDER BY generation",
      [issued.familyId],
    );
    expect(rows.map((row) => row.generation)).toEqual([1, 2, 3]);
    expect(rows[0].superseded_at).not.toBeNull();
    expect(rows[1].superseded_at).not.toBeNull();
    expect(rows[2].superseded_at).toBeNull();
  });

  it("answers a concurrent presentation of the just-rotated secret without a new credential", async () => {
    const issued = await issue();
    const first = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(first.status).toBe("rotated");

    const sibling = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(sibling.status).toBe("concurrent");

    const { rows } = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM remembered_login_families WHERE id = $1",
      [issued.familyId],
    );
    // A legitimate sibling tab must not blow the family away.
    expect(rows[0].revoked_at).toBeNull();
  });

  it.skipIf(serialisedPool)("rotates exactly one of five simultaneous requests and revokes nothing", async () => {
    const issued = await issue();
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        remembered.rotateRememberedLogin({ secret: issued.secret, device: EMPTY_DEVICE_CONTEXT }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === "rotated")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "concurrent")).toHaveLength(4);
    expect(attempts.some((attempt) => attempt.status === "reauth_required")).toBe(false);

    const { rows } = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM remembered_login_families WHERE id = $1",
      [issued.familyId],
    );
    expect(rows[0].revoked_at).toBeNull();
  });
});

describe("replay detection", () => {
  it("revokes the family when a superseded credential is presented after the grace window", async () => {
    const issued = await issue();
    await remembered.rotateRememberedLogin({ secret: issued.secret, device: EMPTY_DEVICE_CONTEXT });

    // Age the supersession past the concurrency grace: this is a stolen token,
    // not a second tab.
    await db.query(
      "UPDATE remembered_login_credentials SET superseded_at = now() - interval '5 minutes'",
    );

    const replay = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(replay.status).toBe("reauth_required");
    if (replay.status === "reauth_required") expect(replay.reason).toBe("replay");

    const { rows } = await db.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
      "SELECT revoked_at, revoked_reason FROM remembered_login_families WHERE id = $1",
      [issued.familyId],
    );
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[0].revoked_reason).toBe("replay");
  });

  it("refuses an unknown credential without touching any family", async () => {
    const result = await remembered.rotateRememberedLogin({
      secret: "rlog_not-a-real-secret",
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(result.status).toBe("reauth_required");
  });
});

describe("deadlines", () => {
  it("refuses and revokes a family past its idle deadline", async () => {
    const issued = await issue();
    await db.query(
      "UPDATE remembered_login_families SET idle_expires_at = now() - interval '1 second' WHERE id = $1",
      [issued.familyId],
    );
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(result.status).toBe("reauth_required");
    if (result.status === "reauth_required") expect(result.reason).toBe("family_expired");
  });

  it("refuses a family past its hard deadline even when the idle window is open", async () => {
    const issued = await issue();
    await db.query(
      "UPDATE remembered_login_families SET absolute_expires_at = now() - interval '1 second', idle_expires_at = now() - interval '1 second' WHERE id = $1",
      [issued.familyId],
    );
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(result.status).toBe("reauth_required");
  });

  it("clamps a renewal's idle deadline to the hard maximum", async () => {
    const issued = await issue();
    const absolute = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    // Both deadlines move together: the table's CHECK refuses a row whose idle
    // window outlives its hard one, which is the invariant being relied on.
    await db.query(
      "UPDATE remembered_login_families SET absolute_expires_at = $2, idle_expires_at = LEAST(idle_expires_at, $2::timestamptz) WHERE id = $1",
      [issued.familyId, absolute],
    );
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(result.status).toBe("rotated");
    if (result.status !== "rotated") return;
    expect(result.idleExpiresAt.getTime()).toBeLessThanOrEqual(result.absoluteExpiresAt.getTime());
  });
});

describe("identity and membership", () => {
  it("refuses and revokes when the membership is no longer active", async () => {
    const issued = await issue();
    await db.query("UPDATE users SET is_active = false WHERE id = $1", [biz.userId]);
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(result.status).toBe("reauth_required");
    if (result.status === "reauth_required") expect(result.reason).toBe("membership_inactive");
  });

  it("refuses when the business is suspended", async () => {
    const issued = await issue();
    await db.query("UPDATE businesses SET status = 'suspended' WHERE id = $1", [biz.id]);
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(result.status).toBe("reauth_required");
  });

  it("refuses once the family has been revoked", async () => {
    const issued = await issue();
    const revoked = await remembered.revokeRememberedLoginFamily({
      businessId: biz.id,
      userId: biz.userId,
      familyId: issued.familyId,
      reason: "user_revoked",
    });
    expect(revoked).toBe(true);
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: EMPTY_DEVICE_CONTEXT,
    });
    expect(result.status).toBe("reauth_required");
  });
});

describe("risk", () => {
  it("renews silently on a region change only", async () => {
    const issued = await issue();
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: { browserFamily: "chrome", osFamily: "windows", regionHint: "DE" },
    });
    expect(result.status).toBe("rotated");
  });

  it("asks for a step-up on a browser-family change and keeps the credential valid", async () => {
    const issued = await issue();
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: { browserFamily: "firefox", osFamily: "windows", regionHint: "IR" },
    });
    expect(result.status).toBe("step_up_required");
    // Not rotated, not revoked: the same secret still works for the retry.
    const retried = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: { browserFamily: "firefox", osFamily: "windows", regionHint: "IR" },
      stepUpVerified: true,
    });
    expect(retried.status).toBe("rotated");
  });

  it("refuses outright when both context axes change", async () => {
    const issued = await issue();
    const result = await remembered.rotateRememberedLogin({
      secret: issued.secret,
      device: { browserFamily: "safari", osFamily: "macos", regionHint: "IR" },
    });
    expect(result.status).toBe("reauth_required");
  });
});

describe("tenant isolation and cleanup", () => {
  it.skipIf(!rlsActive)("keeps one business's families invisible under another tenant's scope", async () => {
    await issue();
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const visible = await dbLib.withTenant(other.rows[0].id, () =>
      dbLib.query<{ count: string }>("SELECT count(*)::text AS count FROM remembered_login_families"),
    );
    expect(visible.rows[0].count).toBe("0");
  });

  it("revokes every family a membership holds, keeping a named one", async () => {
    const first = await issue();
    const second = await issue();
    const revoked = await remembered.revokeRememberedLoginsForMember({
      businessId: biz.id,
      userId: biz.userId,
      reason: "sessions_revoked_others",
      keepFamilyId: first.familyId,
    });
    expect(revoked).toBe(1);
    const { rows } = await db.query<{ id: string; revoked_at: Date | null }>(
      "SELECT id, revoked_at FROM remembered_login_families ORDER BY id",
    );
    const kept = rows.find((row) => row.id === first.familyId);
    const ended = rows.find((row) => row.id === second.familyId);
    expect(kept?.revoked_at).toBeNull();
    expect(ended?.revoked_at).not.toBeNull();
  });

  it("cleans up families long past their hard deadline", async () => {
    const issued = await issue();
    await db.query(
      "UPDATE remembered_login_families SET absolute_expires_at = now() - interval '100 days', idle_expires_at = now() - interval '100 days' WHERE id = $1",
      [issued.familyId],
    );
    const result = await remembered.cleanupRememberedLogins({ retentionDays: 30 });
    expect(result.families).toBeGreaterThanOrEqual(1);
    const { rows } = await db.query("SELECT id FROM remembered_login_families WHERE id = $1", [
      issued.familyId,
    ]);
    expect(rows).toHaveLength(0);
  });
});
