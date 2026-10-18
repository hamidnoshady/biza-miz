/**
 * Migration 0228 — the support companion's server foundation against a real
 * database (issue #984).
 *
 * The pure vocabulary, crypto verification and permission intersection are
 * unit-tested under src/lib/support-companion/*.test.ts; this proves the
 * database round trips the ticket workspace depends on:
 *
 * 1. **Installations** — enrollment binds a verified active site device;
 *    other-business or inactive devices are refused; revocation bumps the
 *    generation so outstanding authorizations fail closed.
 * 2. **Diagnostic requests/runs** — ticket+installation binding, idempotent
 *    create, terminal-state honesty, and redaction before persistence.
 * 3. **Access tokens** — scope intersection at issuance, atomic one-use
 *    online redeem, signed offline issue/redeem with challenge binding,
 *    generation/revocation failure, and hash-only storage (no plaintext).
 * 4. **Assistance** — request/consent narrowing, single live session,
 *    lease renewal/expiry, revoke, and no fake provider join.
 * 5. **Repairs** — seeded catalog is inactive, publish/propose pins hashes,
 *    drift blocks authorization, success requires postcheck verification.
 * 6. **Consent** — the operator cannot self-approve; customer Stop revokes.
 * 7. **Support AI** — ticket-scoped conversations, advanced-profile gating,
 *    deterministic investigation, tool-realm denials, spend ceiling.
 * 8. **RLS** — the new tables are RLS-enabled and forced, and an
 *    unprivileged role can neither read nor write another business's rows.
 *
 * Migration 0229 extends the same suite (issue #984, server completion):
 *
 * 9. **Enrollment** — owner begins, companion completes with a locally
 *    generated secret stored hash-only; wrong codes fail, claims are
 *    single-use, revocation cancels, and staged rotation overlaps safely.
 * 10. **Artifact uploads** — chunked upload with server-side reassembly and
 *    sha256 verification, idempotent chunk retry, integrity fail-closed,
 *    and the retention sweep purging expired bytes and spent claims.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_companion_rls_role";
const APP_PASSWORD = "rls-test-password";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let memberService: typeof import("../src/lib/support-service");
let installations: typeof import("../src/lib/support-companion/installations");
let diagnostics: typeof import("../src/lib/support-companion/diagnostics");
let tokens: typeof import("../src/lib/support-companion/access-tokens");
let assistance: typeof import("../src/lib/support-companion/assistance");
let repairs: typeof import("../src/lib/support-companion/repair-catalog");
let consent: typeof import("../src/lib/support-companion/consent");
let supportAi: typeof import("../src/lib/support-companion/support-ai");
let enrollment: typeof import("../src/lib/support-companion/device-credentials");
let artifacts: typeof import("../src/lib/support-companion/artifacts");
let keys: import("../src/lib/support-companion/access-tokens").SupportTokenKeys;
let offlineKeys: import("../src/lib/support-companion/access-tokens").OfflineTokenKeys;

const alpha = { id: "", locationId: "", ownerId: "", ticketId: "", deviceId: "", installationId: "" };
const beta = { id: "", locationId: "", ownerId: "", ticketId: "", deviceId: "" };
const admin = { id: "" };

const ENGINEER_CAPS = [
  "support.context.read",
  "support.reports.read",
  "support.diagnostics.request",
  "support.repair.propose",
  "support.assist.view",
  "support.assist.revoke",
  "support.token.issue",
  "support.ai.use",
] as const;

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_companion_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  memberService = await import("../src/lib/support-service");
  installations = await import("../src/lib/support-companion/installations");
  diagnostics = await import("../src/lib/support-companion/diagnostics");
  tokens = await import("../src/lib/support-companion/access-tokens");
  assistance = await import("../src/lib/support-companion/assistance");
  repairs = await import("../src/lib/support-companion/repair-catalog");
  consent = await import("../src/lib/support-companion/consent");
  supportAi = await import("../src/lib/support-companion/support-ai");
  enrollment = await import("../src/lib/support-companion/device-credentials");
  artifacts = await import("../src/lib/support-companion/artifacts");

  const pair = await tokens.generateSupportTokenKeys();
  keys = { kid: "test-k1", privateJwk: pair.privateJwk, publicJwks: [{ ...pair.publicJwk, kid: "test-k1" }] };
  const offlinePair = await tokens.generateOfflineTokenKeys();
  offlineKeys = {
    kid: "test-offline-k1",
    privateJwk: offlinePair.privateJwk,
    publicJwks: [{ ...offlinePair.publicJwk, kid: "test-offline-k1" }],
  };

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  async function seedBusiness(name: string, slug: string) {
    const biz = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id", [
      name,
      slug,
    ]);
    const loc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
      [biz.rows[0].id],
    );
    const user = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, location_id, role, full_name, pin_hash) VALUES ($1, $2, 'owner', $3, 'x') RETURNING id",
      [biz.rows[0].id, loc.rows[0].id, `${name} Owner`],
    );
    const device = await db.query<{ id: string }>(
      "INSERT INTO site_devices (business_id, location_id, display_name, status) VALUES ($1, $2, 'POS-1', 'active') RETURNING id",
      [biz.rows[0].id, loc.rows[0].id],
    );
    return {
      businessId: biz.rows[0].id,
      locationId: loc.rows[0].id,
      ownerId: user.rows[0].id,
      deviceId: device.rows[0].id,
    };
  }

  const alphaBiz = await seedBusiness("Alpha Café", `alpha-${randomUUID().slice(0, 8)}`);
  const betaBiz = await seedBusiness("Beta Café", `beta-${randomUUID().slice(0, 8)}`);
  Object.assign(alpha, {
    id: alphaBiz.businessId,
    locationId: alphaBiz.locationId,
    ownerId: alphaBiz.ownerId,
    deviceId: alphaBiz.deviceId,
  });
  Object.assign(beta, {
    id: betaBiz.businessId,
    locationId: betaBiz.locationId,
    ownerId: betaBiz.ownerId,
    deviceId: betaBiz.deviceId,
  });

  const adminRow = await db.query<{ id: string }>(
    "INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1, 'x', 'Companion Operator') RETURNING id",
    [`companion-op-${randomUUID().slice(0, 8)}@example.com`],
  );
  admin.id = adminRow.rows[0].id;

  async function seedTicket(businessId: string, locationId: string, userId: string) {
    return dbLib.withTenant(businessId, () =>
      memberService.createMemberTicket({
        businessId,
        locationId,
        userId,
        subject: "دسکتاپ بالا نمی‌آید",
        category: "technical",
        priority: "high",
        body: "شرح اولیه.",
        attachment: null,
      }),
    );
  }
  alpha.ticketId = (await seedTicket(alpha.id, alpha.locationId, alpha.ownerId)).id;
  beta.ticketId = (await seedTicket(beta.id, beta.locationId, beta.ownerId)).id;

  const enrolled = await dbLib.withoutTenantScope("platform", () =>
    installations.ensureInstallation(alpha.id, alpha.deviceId, { displayName: "POS-1" }),
  );
  if (!enrolled.ok) throw new Error("fixture installation failed");
  alpha.installationId = enrolled.installation.id;
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM support_ai_tool_events");
  await db.query("DELETE FROM support_ai_messages");
  await db.query("DELETE FROM support_ai_conversations");
  await db.query("DELETE FROM support_consent_events");
  await db.query("DELETE FROM support_token_redemptions");
  await db.query("DELETE FROM support_access_tokens");
  await db.query("DELETE FROM support_assistance_events");
  await db.query("DELETE FROM support_assistance_sessions");
  await db.query("DELETE FROM support_repair_runs");
  await db.query("DELETE FROM support_diagnostic_artifacts");
  await db.query("DELETE FROM support_diagnostic_runs");
  await db.query("DELETE FROM support_diagnostic_requests");
  await db.query("DELETE FROM support_repair_catalog WHERE publisher_admin_id IS NOT NULL");
});

function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withoutTenantScope("platform", fn);
}

describe("installations", () => {
  it("refuses other-business and inactive devices", async () => {
    await expect(
      asPlatform(() => installations.ensureInstallation(alpha.id, beta.deviceId)),
    ).resolves.toMatchObject({ ok: false, error: "device_not_found" });

    await db.query("UPDATE site_devices SET status = 'disabled' WHERE id = $1", [beta.deviceId]);
    await expect(
      asPlatform(() => installations.ensureInstallation(beta.id, beta.deviceId)),
    ).resolves.toMatchObject({ ok: false, error: "device_not_active" });
    await db.query("UPDATE site_devices SET status = 'active' WHERE id = $1", [beta.deviceId]);
  });

  it("revocation bumps the generation so outstanding authorizations fail closed", async () => {
    const before = await asPlatform(() => installations.getInstallation(alpha.id, alpha.installationId));
    await expect(
      asPlatform(() => installations.revokeInstallation(alpha.id, alpha.installationId)),
    ).resolves.toMatchObject({ ok: true });
    const after = await asPlatform(() => installations.getInstallation(alpha.id, alpha.installationId));
    expect(after!.enrollmentState).toBe("revoked");
    expect(after!.generation).toBe(before!.generation + 1);
    await expect(
      asPlatform(() =>
        installations.installationGenerationValid(alpha.id, alpha.installationId, before!.generation),
      ),
    ).resolves.toBe(false);

    // Re-enroll for the rest of the suite (revocation is permanent; the
    // device itself is untouched, so a fresh enrollment row is impossible on
    // the same device — restore by hand for fixture continuity).
    await db.query(
      "UPDATE support_installations SET enrollment_state = 'active', revoked_at = NULL WHERE id = $1",
      [alpha.installationId],
    );
  });
});

describe("diagnostic requests and runs", () => {
  it("binds ticket and installation, and refuses cross-tenant bindings", async () => {
    const created = await asPlatform(() =>
      diagnostics.createDiagnosticRequest({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        initiatedBy: "operator",
        operatorAdminId: admin.id,
        modules: ["storage", "bogus_module"],
        reason: "بررسی خرابی راه‌اندازی",
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.request.modules).toEqual(["storage"]);
    expect(created.request.installationGeneration).toBeGreaterThanOrEqual(1);

    // Beta's ticket with alpha's installation: refused, not re-scoped.
    await expect(
      asPlatform(() =>
        diagnostics.createDiagnosticRequest({
          businessId: alpha.id,
          ticketId: beta.ticketId,
          installationId: alpha.installationId,
          initiatedBy: "operator",
          modules: ["storage"],
          reason: "x",
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "ticket_not_found" });
  });

  it("is idempotent on retry and freezes terminal states", async () => {
    const input = {
      businessId: alpha.id,
      ticketId: alpha.ticketId,
      installationId: alpha.installationId,
      initiatedBy: "operator" as const,
      operatorAdminId: admin.id,
      modules: ["storage"],
      reason: "تکرار",
      idempotencyKey: `idem-${randomUUID()}`,
    };
    const first = await asPlatform(() => diagnostics.createDiagnosticRequest(input));
    const second = await asPlatform(() => diagnostics.createDiagnosticRequest(input));
    expect(first.ok && !first.duplicate).toBe(true);
    expect(second.ok && second.duplicate).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.request.id).toBe(first.request.id);

    const cancelled = await asPlatform(() =>
      diagnostics.transitionDiagnosticRequest(alpha.id, first.request.id, "cancelled"),
    );
    expect(cancelled.ok).toBe(true);
    await expect(
      asPlatform(() => diagnostics.transitionDiagnosticRequest(alpha.id, first.request.id, "completed")),
    ).resolves.toMatchObject({ ok: false, error: "terminal_state" });
  });

  it("redacts findings before persistence and acknowledges receipt", async () => {
    const created = await asPlatform(() =>
      diagnostics.createDiagnosticRequest({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        initiatedBy: "operator",
        operatorAdminId: admin.id,
        modules: ["database"],
        reason: "بررسی دیتابیس",
      }),
    );
    if (!created.ok) throw new Error("request fixture failed");
    const recorded = await asPlatform(() =>
      diagnostics.recordDiagnosticRun({
        businessId: alpha.id,
        requestId: created.request.id,
        state: "partial",
        findings: [
          { code: "DB_DOWN", password: "hunter2", detail: "connect postgres://pos:s3cret@127.0.0.1/pos failed" },
        ],
        severityOverall: "failed",
        observedAt: new Date().toISOString(),
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.run.uploadState).toBe("received");
    expect(recorded.run.serverAckAt).not.toBeNull();
    const stored = recorded.run.findings[0] as Record<string, string>;
    expect(stored.password).toBe("[REDACTED]");
    expect(stored.detail).not.toContain("s3cret");
    expect(recorded.redaction.blockedFields).toBeGreaterThanOrEqual(1);

    const request = await asPlatform(() =>
      diagnostics.getDiagnosticRequest(alpha.id, created.request.id),
    );
    expect(request!.state).toBe("partial");

    // The ticket itself is untouched by report appends.
    const { rows } = await db.query<{ status: string }>(
      "SELECT status FROM support_tickets WHERE id = $1",
      [alpha.ticketId],
    );
    expect(rows[0].status).toBe("open");
  });

  it("refuses findings filed outside the caller's ticket/installation scope", async () => {
    const created = await asPlatform(() =>
      diagnostics.createDiagnosticRequest({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        initiatedBy: "operator",
        operatorAdminId: admin.id,
        modules: ["os"],
        reason: "scope check",
      }),
    );
    if (!created.ok) throw new Error("request fixture failed");
    // A session issued for another ticket in the same business cannot file here.
    await expect(
      asPlatform(() =>
        diagnostics.recordDiagnosticRun({
          businessId: alpha.id,
          requestId: created.request.id,
          state: "completed",
          expectTicketId: beta.ticketId,
          expectInstallationId: alpha.installationId,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "scope_mismatch" });
    await expect(
      asPlatform(() =>
        diagnostics.recordDiagnosticRun({
          businessId: alpha.id,
          requestId: created.request.id,
          state: "completed",
          expectTicketId: alpha.ticketId,
          expectInstallationId: randomUUID(),
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "scope_mismatch" });
    // The matching scope still records.
    const recorded = await asPlatform(() =>
      diagnostics.recordDiagnosticRun({
        businessId: alpha.id,
        requestId: created.request.id,
        state: "completed",
        expectTicketId: alpha.ticketId,
        expectInstallationId: alpha.installationId,
      }),
    );
    expect(recorded.ok).toBe(true);
  });
});

describe("access tokens", () => {
  it("intersects requested scope with the issuer's own authority", async () => {
    const issued = await asPlatform(() =>
      tokens.issueOnlineCode({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        issuerAdminId: admin.id,
        issuerCapabilities: [...ENGINEER_CAPS],
        requestedScope: ["diagnostics.run", "remote.control", "bogus.op"],
        reason: "حضور در محل",
      }),
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    // remote.control needs the owner-only cap; the engineer cannot mint it.
    expect(issued.record.scope).toEqual(["diagnostics.run"]);
    expect(issued.plaintext).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Nothing beyond the issuer's authority: an empty intersection is refused.
    await expect(
      asPlatform(() =>
        tokens.issueOnlineCode({
          businessId: alpha.id,
          ticketId: alpha.ticketId,
          installationId: alpha.installationId,
          issuerAdminId: admin.id,
          issuerCapabilities: ["support.manage"],
          requestedScope: ["remote.control"],
          reason: "x",
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "scope_empty" });
  });

  it("redeems an online code atomically once, then stores no plaintext", async () => {
    const issued = await asPlatform(() =>
      tokens.issueOnlineCode({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        issuerAdminId: admin.id,
        issuerCapabilities: [...ENGINEER_CAPS],
        requestedScope: ["diagnostics.run", "report.upload"],
        reason: "حضور در محل",
      }),
    );
    if (!issued.ok) throw new Error("issuance fixture failed");

    const first = await asPlatform(() => tokens.redeemOnlineCode({ code: issued.plaintext, keys }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.session.ticketId).toBe(alpha.ticketId);
    expect(first.session.scope).toEqual(["diagnostics.run", "report.upload"]);
    expect(first.session.sessionJwt.split(".")).toHaveLength(3);

    const second = await asPlatform(() => tokens.redeemOnlineCode({ code: issued.plaintext, keys }));
    expect(second).toMatchObject({ ok: false, error: "token_consumed" });

    // Hash-only storage: neither the code nor the session JWT appears.
    const { rows } = await db.query<{ fingerprint: string; online_code_hash: string }>(
      "SELECT fingerprint, online_code_hash FROM support_access_tokens WHERE id = $1",
      [issued.record.id],
    );
    expect(rows[0].fingerprint).not.toContain(issued.plaintext);
    expect(rows[0].online_code_hash).toMatch(/^[0-9a-f]{64}$/);
    const { rows: sessions } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM support_access_tokens WHERE scope::text LIKE '%session%'",
      [],
    );
    expect(sessions[0].count).toBe("0");
  });

  it("revokes a consumed issuance so its live session fails closed", async () => {
    const issued = await asPlatform(() =>
      tokens.issueOnlineCode({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        issuerAdminId: admin.id,
        issuerCapabilities: [...ENGINEER_CAPS],
        requestedScope: ["diagnostics.run", "report.upload"],
        reason: "x",
      }),
    );
    if (!issued.ok) throw new Error("issuance fixture failed");
    const redeemed = await asPlatform(() => tokens.redeemOnlineCode({ code: issued.plaintext, keys }));
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    // A consumed issuance backs a live session: revocation must still land.
    const revoked = await asPlatform(() => tokens.revokeAccessToken(alpha.id, issued.record.id));
    expect(revoked).toMatchObject({ ok: true, alreadyTerminal: false });
    await expect(asPlatform(() => tokens.verifyCompanionSession(redeemed.session.sessionJwt, keys))).resolves.toMatchObject({
      ok: false,
      error: "revoked",
    });
    // Second revoke is idempotent, not an error.
    const again = await asPlatform(() => tokens.revokeAccessToken(alpha.id, issued.record.id));
    expect(again).toMatchObject({ ok: true, alreadyTerminal: true });
  });

  it("rejects expired codes without leaking their existence shape", async () => {
    const issued = await asPlatform(() =>
      tokens.issueOnlineCode({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        issuerAdminId: admin.id,
        issuerCapabilities: [...ENGINEER_CAPS],
        requestedScope: ["diagnostics.run"],
        reason: "x",
        validityMinutes: 30,
      }),
    );
    if (!issued.ok) throw new Error("issuance fixture failed");
    await db.query("UPDATE support_access_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      issued.record.id,
    ]);
    await expect(
      asPlatform(() => tokens.redeemOnlineCode({ code: issued.plaintext, keys })),
    ).resolves.toMatchObject({ ok: false, error: "token_expired" });
    await expect(
      asPlatform(() => tokens.redeemOnlineCode({ code: "ZZZZ-ZZZZ", keys })),
    ).resolves.toMatchObject({ ok: false, error: "token_not_found" });
  });

  it("does not burn a code when signing is unavailable", async () => {
    const issued = await asPlatform(() =>
      tokens.issueOnlineCode({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        issuerAdminId: admin.id,
        issuerCapabilities: [...ENGINEER_CAPS],
        requestedScope: ["diagnostics.run"],
        reason: "x",
      }),
    );
    if (!issued.ok) throw new Error("issuance fixture failed");
    const saved = process.env.SUPPORT_TOKEN_SIGNING_KEY;
    delete process.env.SUPPORT_TOKEN_SIGNING_KEY;
    try {
      await expect(
        asPlatform(() => tokens.redeemOnlineCode({ code: issued.plaintext })),
      ).resolves.toMatchObject({ ok: false, error: "signing_unavailable" });
    } finally {
      if (saved !== undefined) process.env.SUPPORT_TOKEN_SIGNING_KEY = saved;
    }
    // Keys resolve before the consume, so the code survived for a retry.
    const redeemed = await asPlatform(() => tokens.redeemOnlineCode({ code: issued.plaintext, keys }));
    expect(redeemed.ok).toBe(true);
  });

  it("issues and redeems a signed offline token with challenge binding", async () => {
    const issued = await asPlatform(() =>
      tokens.issueOfflineToken({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        issuerAdminId: admin.id,
        issuerCapabilities: [...ENGINEER_CAPS],
        requestedScope: ["diagnostics.run", "report.upload"],
        reason: "حضور آفلاین",
        technicianBindingHash: "tech-device-fingerprint",
        challenge: "install-nonce-1",
        offlineKeys,
      }),
    );
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.plaintext.split(".")).toHaveLength(3);

    // Local verification works without the database (pure crypto).
    const verified = await tokens.verifyOfflineToken(issued.plaintext, offlineKeys);
    expect(verified.ok).toBe(true);

    // A copied token without the technician proof or the right challenge fails.
    await expect(
      asPlatform(() =>
        tokens.redeemOfflineToken({
          token: issued.plaintext,
          technicianBindingHash: "someone-else",
          challenge: "install-nonce-1",
          keys,
          offlineKeys,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "binding_mismatch" });

    const redeemed = await asPlatform(() =>
      tokens.redeemOfflineToken({
        token: issued.plaintext,
        technicianBindingHash: "tech-device-fingerprint",
        challenge: "install-nonce-1",
        keys,
        offlineKeys,
      }),
    );
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;
    expect(redeemed.session.installationId).toBe(alpha.installationId);

    // The companion session verifies, then dies on revocation.
    const live = await asPlatform(() => tokens.verifyCompanionSession(redeemed.session.sessionJwt, keys));
    expect(live.ok).toBe(true);
    await asPlatform(() => tokens.revokeAccessToken(alpha.id, issued.record.id));
    // Consumed rows are terminal: revoke reports already-terminal honestly.
    const again = await asPlatform(() => tokens.revokeAccessToken(alpha.id, issued.record.id));
    expect(again).toMatchObject({ ok: true, alreadyTerminal: true });
  });

  it("fails closed when the installation generation moved on", async () => {
    const issued = await asPlatform(() =>
      tokens.issueOnlineCode({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        issuerAdminId: admin.id,
        issuerCapabilities: [...ENGINEER_CAPS],
        requestedScope: ["diagnostics.run"],
        reason: "x",
      }),
    );
    if (!issued.ok) throw new Error("issuance fixture failed");
    await db.query("UPDATE support_installations SET generation = generation + 1 WHERE id = $1", [
      alpha.installationId,
    ]);
    await expect(
      asPlatform(() => tokens.redeemOnlineCode({ code: issued.plaintext, keys })),
    ).resolves.toMatchObject({ ok: false, error: "generation_mismatch" });
    await db.query("UPDATE support_installations SET generation = generation - 1 WHERE id = $1", [
      alpha.installationId,
    ]);
  });
});

describe("assistance sessions", () => {
  it("requests, narrows consent, and refuses parallel live sessions", async () => {
    const requested = await asPlatform(() =>
      assistance.requestAssistanceSession({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        requestedCaps: ["view", "control"],
        reason: "مشاهده خطا",
      }),
    );
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;

    await expect(
      asPlatform(() =>
        assistance.requestAssistanceSession({
          businessId: alpha.id,
          ticketId: alpha.ticketId,
          installationId: alpha.installationId,
          operatorAdminId: admin.id,
          requestedCaps: ["view"],
          reason: "دوم",
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "session_already_live" });

    // The customer narrows to view-only; they cannot widen to elevation.
    const consented = await asPlatform(() =>
      assistance.recordLocalConsent({
        businessId: alpha.id,
        sessionId: requested.session.id,
        approved: true,
        approvedCaps: ["view", "elevation", "bogus"],
      }),
    );
    expect(consented.ok).toBe(true);
    if (!consented.ok) return;
    expect(consented.session.approvedCaps).toEqual(["view"]);

    // No qualified provider yet: joining is refused honestly, not faked.
    await expect(
      asPlatform(() => assistance.operatorJoinSession(alpha.id, requested.session.id, admin.id)),
    ).resolves.toMatchObject({ ok: false, error: "provider_not_configured" });

    const events = await asPlatform(() => assistance.listAssistanceEvents(alpha.id, requested.session.id));
    expect(events.map((event) => event.kind)).toContain("consent_granted");
    expect(events.map((event) => event.seq)).toEqual([...events.map((event) => event.seq)].sort((a, b) => a - b));
  });

  it("denies locally, expires stale leases, and revokes immediately", async () => {
    const first = await asPlatform(() =>
      assistance.requestAssistanceSession({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        requestedCaps: ["view"],
        reason: "x",
      }),
    );
    if (!first.ok) throw new Error("session fixture failed");
    const denied = await asPlatform(() =>
      assistance.recordLocalConsent({ businessId: alpha.id, sessionId: first.session.id, approved: false }),
    );
    expect(denied.ok && denied.session.state).toBe("revoked");

    const second = await asPlatform(() =>
      assistance.requestAssistanceSession({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        requestedCaps: ["view"],
        reason: "x",
      }),
    );
    if (!second.ok) throw new Error("session fixture failed");
    // Drive it live by hand (the provider join is tested above as refused).
    await db.query(
      "UPDATE support_assistance_sessions SET state = 'active_view', approved_caps = '{view}', lease_expires_at = now() + interval '1 hour' WHERE id = $1",
      [second.session.id],
    );
    const renewed = await asPlatform(() => assistance.renewSessionLease(alpha.id, second.session.id));
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.session.leaseEpoch).toBe(1);

    await db.query("UPDATE support_assistance_sessions SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [
      second.session.id,
    ]);
    await expect(
      asPlatform(() => assistance.renewSessionLease(alpha.id, second.session.id)),
    ).resolves.toMatchObject({ ok: false, error: "lease_expired" });
    const terminal = await asPlatform(() => assistance.getAssistanceSession(alpha.id, second.session.id));
    expect(terminal!.state).toBe("expired");

    // The sweeper expires lapsed leases without any renewal attempt.
    const third = await asPlatform(() =>
      assistance.requestAssistanceSession({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        requestedCaps: ["view"],
        reason: "x",
      }),
    );
    if (!third.ok) throw new Error("session fixture failed");
    await db.query(
      "UPDATE support_assistance_sessions SET state = 'active_view', lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [third.session.id],
    );
    const swept = await asPlatform(() => assistance.expireStaleSessions());
    expect(swept).toBe(1);
    const sweptSession = await asPlatform(() => assistance.getAssistanceSession(alpha.id, third.session.id));
    expect(sweptSession!.state).toBe("expired");
    const sweepEvents = await asPlatform(() => assistance.listAssistanceEvents(alpha.id, third.session.id));
    expect(sweepEvents.map((event) => event.kind)).toContain("lease_expired");
  });

  it("binds a broker share on join and unbinds on revoke", async () => {
    await asPlatform(() =>
      installations.recordInstallationContact(alpha.id, alpha.installationId, {
        meshNodeId: "node//test-agent-1",
      }),
    );
    const requested = await asPlatform(() =>
      assistance.requestAssistanceSession({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        requestedCaps: ["view"],
        reason: "بایند موتور",
      }),
    );
    if (!requested.ok) throw new Error("session fixture failed");
    const consented = await asPlatform(() =>
      assistance.recordLocalConsent({
        businessId: alpha.id,
        sessionId: requested.session.id,
        approved: true,
        approvedCaps: ["view"],
      }),
    );
    if (!consented.ok) throw new Error("consent fixture failed");

    const seen: Record<string, unknown>[] = [];
    const overrides = {
      broker: {
        provider: "meshcentral" as const,
        controlUrl: "wss://mesh.example.com/control.ashx",
        username: "u",
        password: "p",
        allowSelfSignedTls: false,
      },
      transport: (async (_config: unknown, message: Record<string, unknown>) => {
        seen.push(message);
        if (message.action === "createDeviceShareLink") {
          return { action: "createDeviceShareLink", result: "OK", publicid: "share-9", url: "https://mesh.example.com/share/share-9" };
        }
        return { action: "removeDeviceShare", result: "OK" };
      }) as NonNullable<Parameters<typeof assistance.operatorJoinSession>[3]>["transport"],
    };
    const joined = await asPlatform(() =>
      assistance.operatorJoinSession(alpha.id, requested.session.id, admin.id, overrides),
    );
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.session.state).toBe("connecting");
    expect(joined.operatorUrl).toBe("https://mesh.example.com/share/share-9");
    expect(joined.session.engineBinding).toMatchObject({
      provider: "meshcentral",
      nodeId: "node//test-agent-1",
      shareId: "share-9",
      viewOnly: true,
    });
    // The guest URL is returned once — never stored on the row.
    expect(JSON.stringify(joined.session.engineBinding)).not.toContain("https://mesh.example.com/share/share-9");
    expect(seen[0]).toMatchObject({ action: "createDeviceShareLink", nodeid: "node//test-agent-1", viewOnly: true });

    const revoked = await asPlatform(() =>
      assistance.revokeAssistanceSession(alpha.id, requested.session.id, `operator:${admin.id}`, "done", overrides),
    );
    expect(revoked.ok).toBe(true);
    expect(seen[1]).toMatchObject({ action: "removeDeviceShare", publicid: "share-9" });
    const events = await asPlatform(() => assistance.listAssistanceEvents(alpha.id, requested.session.id));
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["operator_joined", "revoked", "engine_unbound"]),
    );
    const terminal = await asPlatform(() => assistance.getAssistanceSession(alpha.id, requested.session.id));
    expect(terminal!.engineBinding).toMatchObject({ revokedAt: expect.any(String) });
  });

  it("rejoins a live session with a fresh share, and refuses stale ones", async () => {
    await asPlatform(() =>
      installations.recordInstallationContact(alpha.id, alpha.installationId, {
        meshNodeId: "node//test-agent-9",
      }),
    );
    const requested = await asPlatform(() =>
      assistance.requestAssistanceSession({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        requestedCaps: ["view"],
        reason: "rejoin",
      }),
    );
    if (!requested.ok) throw new Error("session fixture failed");
    const consented = await asPlatform(() =>
      assistance.recordLocalConsent({
        businessId: alpha.id,
        sessionId: requested.session.id,
        approved: true,
        approvedCaps: ["view"],
      }),
    );
    if (!consented.ok) throw new Error("consent fixture failed");

    // Rejoin before first join is not a thing.
    const brokerOnly = {
      broker: {
        provider: "meshcentral" as const,
        controlUrl: "wss://mesh.example.com/control.ashx",
        username: "u",
        password: "p",
        allowSelfSignedTls: false,
      },
    };
    await expect(
      asPlatform(() => assistance.operatorRejoinSession(alpha.id, requested.session.id, admin.id, brokerOnly)),
    ).resolves.toMatchObject({ ok: false, error: "invalid_transition" });

    let shares = 0;
    const seen: Record<string, unknown>[] = [];
    const overrides = {
      ...brokerOnly,
      transport: (async (_config: unknown, message: Record<string, unknown>) => {
        seen.push(message);
        if (message.action === "createDeviceShareLink") {
          shares += 1;
          return {
            action: "createDeviceShareLink",
            result: "OK",
            publicid: `share-r${shares}`,
            url: `https://mesh.example.com/share/share-r${shares}`,
          };
        }
        return { action: "removeDeviceShare", result: "OK" };
      }) as NonNullable<Parameters<typeof assistance.operatorJoinSession>[3]>["transport"],
    };
    const joined = await asPlatform(() =>
      assistance.operatorJoinSession(alpha.id, requested.session.id, admin.id, overrides),
    );
    if (!joined.ok) throw new Error("join fixture failed");

    // Media confirmed live; the operator's tab then dies.
    await db.query(
      "UPDATE support_assistance_sessions SET state = 'active_view', lease_expires_at = now() + interval '1 hour' WHERE id = $1",
      [requested.session.id],
    );
    const rejoined = await asPlatform(() =>
      assistance.operatorRejoinSession(alpha.id, requested.session.id, admin.id, overrides),
    );
    expect(rejoined.ok).toBe(true);
    if (!rejoined.ok) return;
    expect(rejoined.session.state).toBe("connecting");
    expect(rejoined.operatorUrl).toBe("https://mesh.example.com/share/share-r2");
    expect(rejoined.session.engineBinding).toMatchObject({
      provider: "meshcentral",
      nodeId: "node//test-agent-9",
      shareId: "share-r2",
    });
    expect(rejoined.session.engineBinding).not.toHaveProperty("revokedAt");
    expect(JSON.stringify(rejoined.session.engineBinding)).not.toContain("https://mesh.example.com/share/share-r2");
    // Old share unbound first, then the fresh bind.
    expect(seen[1]).toMatchObject({ action: "removeDeviceShare", publicid: "share-r1" });
    expect(seen[2]).toMatchObject({ action: "createDeviceShareLink", nodeid: "node//test-agent-9" });
    const events = await asPlatform(() => assistance.listAssistanceEvents(alpha.id, requested.session.id));
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["operator_joined", "engine_unbound", "operator_rejoined"]),
    );
    const rejoinEvent = events.find((event) => event.kind === "operator_rejoined");
    expect(rejoinEvent!.payload).toMatchObject({ shareId: "share-r2", previousShareId: "share-r1" });

    // A different operator cannot steal the session via rejoin.
    await expect(
      asPlatform(() => assistance.operatorRejoinSession(alpha.id, requested.session.id, "00000000-0000-0000-0000-000000000000", overrides)),
    ).resolves.toMatchObject({ ok: false, error: "invalid_transition" });

    // A lapsed lease expires the session instead of resuming input.
    await db.query(
      "UPDATE support_assistance_sessions SET state = 'active_view', lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [requested.session.id],
    );
    await expect(
      asPlatform(() => assistance.operatorRejoinSession(alpha.id, requested.session.id, admin.id, overrides)),
    ).resolves.toMatchObject({ ok: false, error: "lease_expired" });
    const terminal = await asPlatform(() => assistance.getAssistanceSession(alpha.id, requested.session.id));
    expect(terminal!.state).toBe("expired");
  });

  it("refuses join without an agent link, and fails bind/revoke honestly", async () => {
    await db.query("UPDATE support_installations SET mesh_node_id = NULL WHERE id = $1", [alpha.installationId]);
    const requested = await asPlatform(() =>
      assistance.requestAssistanceSession({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        requestedCaps: ["view"],
        reason: "بدون لینک ایجنت",
      }),
    );
    if (!requested.ok) throw new Error("session fixture failed");
    const consented = await asPlatform(() =>
      assistance.recordLocalConsent({
        businessId: alpha.id,
        sessionId: requested.session.id,
        approved: true,
        approvedCaps: ["view"],
      }),
    );
    if (!consented.ok) throw new Error("consent fixture failed");

    const broker = {
      provider: "meshcentral" as const,
      controlUrl: "wss://mesh.example.com/control.ashx",
      username: "u",
      password: "p",
      allowSelfSignedTls: false,
    };
    const down = {
      broker,
      transport: (async () => {
        throw new Error("meshcentral_timeout");
      }) as NonNullable<Parameters<typeof assistance.operatorJoinSession>[3]>["transport"],
    };
    // No agent link: refused before any broker call.
    await expect(
      asPlatform(() => assistance.operatorJoinSession(alpha.id, requested.session.id, admin.id, down)),
    ).resolves.toMatchObject({ ok: false, error: "agent_not_linked" });

    await asPlatform(() =>
      installations.recordInstallationContact(alpha.id, alpha.installationId, { meshNodeId: "node//down" }),
    );
    // Broker down: the session stays approved (retryable), never fake-connected.
    await expect(
      asPlatform(() => assistance.operatorJoinSession(alpha.id, requested.session.id, admin.id, down)),
    ).resolves.toMatchObject({ ok: false, error: "provider_unreachable" });
    const still = await asPlatform(() => assistance.getAssistanceSession(alpha.id, requested.session.id));
    expect(still!.state).toBe("approved");

    // A bound share whose revoke call fails: termination still wins, and the
    // failure is journaled (the share's own expiry is the backstop).
    await db.query(
      "UPDATE support_assistance_sessions SET engine_binding = $2 WHERE id = $1",
      [requested.session.id, JSON.stringify({ provider: "meshcentral", nodeId: "node//down", shareId: "share-x" })],
    );
    const revoked = await asPlatform(() =>
      assistance.revokeAssistanceSession(alpha.id, requested.session.id, `operator:${admin.id}`, "stop", down),
    );
    expect(revoked.ok).toBe(true);
    const events = await asPlatform(() => assistance.listAssistanceEvents(alpha.id, requested.session.id));
    expect(events.map((event) => event.kind)).toContain("engine_revoke_failed");
    await db.query("UPDATE support_installations SET mesh_node_id = NULL WHERE id = $1", [alpha.installationId]);
  });
});

describe("repair catalog and runs", () => {
  it("seeds an inactive catalog; activation is explicit", async () => {
    const catalog = await asPlatform(() => repairs.listActiveCatalog());
    expect(catalog).toEqual([]);
    const seed = await asPlatform(() => repairs.getRecipe("companion.clean_temp", 1));
    expect(seed).not.toBeNull();
    expect(seed!.active).toBe(false);
    expect(seed!.recipeHash).toBe(repairs.recipeHashFor(seed!.recipe));
  });

  it("proposes pinned recipes and blocks drifted authorization", async () => {
    const published = await asPlatform(() =>
      repairs.publishRecipe({
        recipeId: "companion.clean_temp",
        title: "پاک‌سازی (آزمون)",
        risk: "low",
        recipe: { action: "companion.clean_temp", params: { maxAgeDays: 3, roots: ["companion_temp"] } },
        publisherAdminId: admin.id,
        active: true,
      }),
    );
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.recipe.version).toBe(2);

    // Unbounded recipes are refused at publish, not at execute.
    await expect(
      asPlatform(() =>
        repairs.publishRecipe({
          recipeId: "evil",
          title: "x",
          risk: "low",
          recipe: { action: "main.restart_backend", command: "rm -rf /" },
          publisherAdminId: admin.id,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid_recipe" });

    const proposed = await asPlatform(() =>
      repairs.proposeRepair({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        recipeId: "companion.clean_temp",
        actor: "operator",
        operatorAdminId: admin.id,
      }),
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.run.recipeVersion).toBe(2);
    expect(proposed.run.recipeHash).toBe(published.recipe.recipeHash);

    // Drift the catalog entry after approval: authorization blocks the run.
    await db.query(
      "UPDATE support_repair_catalog SET recipe_hash = '00', active = false WHERE recipe_id = $1 AND version = 2",
      ["companion.clean_temp"],
    );
    await expect(
      asPlatform(() => repairs.transitionRepairRun(alpha.id, proposed.run.id, "authorized")),
    ).resolves.toMatchObject({ ok: false, error: "recipe_drifted" });
    const blocked = await asPlatform(() => repairs.getRepairRun(alpha.id, proposed.run.id));
    expect(blocked!.state).toBe("blocked");
  });

  it("never calls a repair successful without postcheck verification", async () => {
    const published = await asPlatform(() =>
      repairs.publishRecipe({
        recipeId: "companion.rotate_logs",
        title: "چرخش لاگ (آزمون)",
        risk: "low",
        recipe: { action: "companion.rotate_logs", params: { keepFiles: 5 } },
        publisherAdminId: admin.id,
        active: true,
      }),
    );
    if (!published.ok) throw new Error("publish fixture failed");
    const proposed = await asPlatform(() =>
      repairs.proposeRepair({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        recipeId: "companion.rotate_logs",
        actor: "operator",
        operatorAdminId: admin.id,
      }),
    );
    if (!proposed.ok) throw new Error("propose fixture failed");

    // The state graph holds: a fresh proposal can move to execution or
    // success only through authorization — never by jumping the edge.
    await expect(
      asPlatform(() => repairs.transitionRepairRun(alpha.id, proposed.run.id, "executing")),
    ).resolves.toMatchObject({ ok: false, error: "illegal_transition" });
    await expect(
      asPlatform(() => repairs.transitionRepairRun(alpha.id, proposed.run.id, "succeeded")),
    ).resolves.toMatchObject({ ok: false, error: "illegal_transition" });

    const authorized = await asPlatform(() =>
      repairs.transitionRepairRun(alpha.id, proposed.run.id, "authorized"),
    );
    expect(authorized.ok).toBe(true);
    // Authorization alone is not execution: executing → verifying →
    // succeeded is the only road, and success needs real postchecks.
    await expect(
      asPlatform(() => repairs.transitionRepairRun(alpha.id, proposed.run.id, "succeeded")),
    ).resolves.toMatchObject({ ok: false, error: "illegal_transition" });
    const executing = await asPlatform(() =>
      repairs.transitionRepairRun(alpha.id, proposed.run.id, "executing"),
    );
    expect(executing.ok).toBe(true);
    await expect(
      asPlatform(() => repairs.transitionRepairRun(alpha.id, proposed.run.id, "succeeded")),
    ).resolves.toMatchObject({ ok: false, error: "illegal_transition" });
    const verifying = await asPlatform(() =>
      repairs.transitionRepairRun(alpha.id, proposed.run.id, "verifying"),
    );
    expect(verifying.ok).toBe(true);
    await expect(
      asPlatform(() => repairs.transitionRepairRun(alpha.id, proposed.run.id, "succeeded")),
    ).resolves.toMatchObject({ ok: false, error: "verification_required" });
    const succeeded = await asPlatform(() =>
      repairs.transitionRepairRun(alpha.id, proposed.run.id, "succeeded", {
        verification: { verified: true, postchecks: [{ check: "log_write_ok", ok: true }] },
      }),
    );
    expect(succeeded.ok).toBe(true);
    await expect(
      asPlatform(() => repairs.transitionRepairRun(alpha.id, proposed.run.id, "executing")),
    ).resolves.toMatchObject({ ok: false, error: "terminal_state" });
  });
});

describe("consent", () => {
  it("lets the customer grant and stop, but never lets the operator self-approve", async () => {
    await expect(
      asPlatform(() =>
        consent.recordConsentEvent({
          businessId: alpha.id,
          ticketId: alpha.ticketId,
          installationId: alpha.installationId,
          subject: "repair",
          decision: "granted",
          grantedBy: "operator",
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid_decision" });

    const granted = await asPlatform(() =>
      consent.recordConsentEvent({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        subject: "repair",
        decision: "granted",
        grantedBy: "customer",
        expiresInMinutes: 30,
      }),
    );
    expect(granted.ok).toBe(true);
    await expect(
      asPlatform(() => consent.consentAllows(alpha.id, alpha.installationId, "repair")),
    ).resolves.toBe(true);

    await asPlatform(() =>
      consent.recordConsentEvent({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        subject: "repair",
        decision: "revoked",
        grantedBy: "customer",
      }),
    );
    await expect(
      asPlatform(() => consent.consentAllows(alpha.id, alpha.installationId, "repair")),
    ).resolves.toBe(false);
  });
});

describe("support AI", () => {
  it("scopes conversations to the ticket and gates advanced profiles", async () => {
    const opened = await asPlatform(() =>
      supportAi.createSupportConversation({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        operatorCapabilities: [...ENGINEER_CAPS],
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.conversation.modelProfile).toBe("support-default");

    await expect(
      asPlatform(() =>
        supportAi.createSupportConversation({
          businessId: alpha.id,
          ticketId: alpha.ticketId,
          operatorAdminId: admin.id,
          operatorCapabilities: [...ENGINEER_CAPS],
          modelProfile: "support-advanced",
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "profile_not_permitted" });

    // Cross-ticket conversations are refused, not re-scoped.
    await expect(
      asPlatform(() =>
        supportAi.createSupportConversation({
          businessId: alpha.id,
          ticketId: beta.ticketId,
          operatorAdminId: admin.id,
          operatorCapabilities: [...ENGINEER_CAPS],
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "ticket_not_found" });
  });

  it("investigates deterministically and enforces the tool realm", async () => {
    const opened = await asPlatform(() =>
      supportAi.createSupportConversation({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        operatorAdminId: admin.id,
        operatorCapabilities: [...ENGINEER_CAPS],
      }),
    );
    if (!opened.ok) throw new Error("conversation fixture failed");

    const appended = await asPlatform(() =>
      supportAi.appendSupportMessage({
        businessId: alpha.id,
        conversationId: opened.conversation.id,
        role: "operator",
        content: "علت خرابی چیست؟ password: hunter2",
      }),
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.message.content).not.toContain("hunter2");

    const evidence = await asPlatform(() => supportAi.buildSupportEvidence(alpha.id, alpha.ticketId));
    expect(evidence.ticketId).toBe(alpha.ticketId);
    expect(supportAi.investigateDeterministic(evidence)).toContain("یافته‌های تیکت");

    // Without reports.read, even evidence reads are denied — and journaled.
    const denied = supportAi.supportToolExecutor({
      businessId: alpha.id,
      conversation: opened.conversation,
      operatorCaps: ["support.manage"],
    });
    const deniedResult = await asPlatform(() => denied("support.evidence.read", {}));
    expect(deniedResult.ok).toBe(false);

    const allowed = supportAi.supportToolExecutor({
      businessId: alpha.id,
      conversation: opened.conversation,
      operatorCaps: [...ENGINEER_CAPS],
    });
    const allowedResult = await asPlatform(() => allowed("support.evidence.read", {}));
    expect(allowedResult.ok).toBe(true);

    // A model-supplied installation outside the conversation scope is refused.
    const scoped = await asPlatform(() =>
      allowed("support.diagnostics.request", {
        installationId: "00000000-0000-0000-0000-000000000000",
        reason: "x",
      }),
    );
    expect(scoped.ok).toBe(false);

    const events = await asPlatform(() =>
      supportAi.listSupportToolEvents(alpha.id, opened.conversation.id),
    );
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].permission).toBeDefined();
  });

  it("treats the spend limit as a hard ceiling", async () => {
    const opened = await asPlatform(() =>
      supportAi.createSupportConversation({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        operatorAdminId: admin.id,
        operatorCapabilities: [...ENGINEER_CAPS],
        spendLimitRial: 100,
      }),
    );
    if (!opened.ok) throw new Error("conversation fixture failed");
    await expect(
      asPlatform(() =>
        supportAi.accrueSupportSpend({
          businessId: alpha.id,
          conversationId: opened.conversation.id,
          costUsd: 10,
          usdRialRate: 1000,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "spend_limit_exceeded" });
    const small = await asPlatform(() =>
      supportAi.accrueSupportSpend({
        businessId: alpha.id,
        conversationId: opened.conversation.id,
        costUsd: 0.00005,
        usdRialRate: 1000,
      }),
    );
    expect(small.ok).toBe(true);
  });
});

describe("enrollment and device credentials", () => {
  const newSecret = () => randomBytes(32).toString("base64url");

  it("enrolls a local-only installation and stores the secret hash-only", async () => {
    const begun = await asPlatform(() =>
      enrollment.beginEnrollment({ businessId: alpha.id, approvedBy: admin.id }),
    );
    expect(begun.claimCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const secret = newSecret();
    const completed = await enrollment.completeEnrollment({
      enrollmentId: begun.enrollmentId,
      claimCode: begun.claimCode,
      credential: secret,
      installation: { displayName: "POS-1", companionVersion: "1.0.0" },
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    const identity = await enrollment.verifySupportDeviceCredential(secret);
    expect(identity).toMatchObject({
      businessId: alpha.id,
      installationId: completed.installationId,
      credentialState: "active",
    });

    // Hash-only storage: the secret (or any recognizable fragment) appears nowhere.
    const { rows } = await db.query<{ credential_hash: string }>(
      "SELECT credential_hash FROM support_device_credentials WHERE installation_id = $1",
      [completed.installationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].credential_hash).toBe(createHash("sha256").update(secret, "utf8").digest("hex"));
    const { rows: claims } = await db.query<{ claim_code_hash: string }>(
      "SELECT claim_code_hash FROM support_enrollments WHERE id = $1",
      [begun.enrollmentId],
    );
    expect(claims[0].claim_code_hash).not.toContain(begun.claimCode);
  });

  it("rejects wrong codes, short secrets and double completion", async () => {
    const begun = await asPlatform(() =>
      enrollment.beginEnrollment({ businessId: alpha.id, approvedBy: admin.id }),
    );
    await expect(
      enrollment.completeEnrollment({
        enrollmentId: begun.enrollmentId,
        claimCode: "ZZZZ-ZZZZ",
        credential: newSecret(),
      }),
    ).resolves.toMatchObject({ ok: false, error: "claim_rejected" });
    await expect(
      enrollment.completeEnrollment({
        enrollmentId: begun.enrollmentId,
        claimCode: begun.claimCode,
        credential: "too-short",
      }),
    ).resolves.toMatchObject({ ok: false, error: "credential_rejected" });

    const completed = await enrollment.completeEnrollment({
      enrollmentId: begun.enrollmentId,
      claimCode: begun.claimCode,
      credential: newSecret(),
    });
    expect(completed.ok).toBe(true);

    // Claims are single-use: the second completion fails closed.
    await expect(
      enrollment.completeEnrollment({
        enrollmentId: begun.enrollmentId,
        claimCode: begun.claimCode,
        credential: newSecret(),
      }),
    ).resolves.toMatchObject({ ok: false, error: "enrollment_expired" });
  });

  it("lets the owner cancel a pending enrollment before it is claimed", async () => {
    const begun = await asPlatform(() =>
      enrollment.beginEnrollment({ businessId: alpha.id, approvedBy: admin.id }),
    );
    const pending = await asPlatform(() => enrollment.listPendingEnrollments(alpha.id));
    expect(pending.map((p) => p.id)).toContain(begun.enrollmentId);

    await expect(
      asPlatform(() => enrollment.revokeEnrollment(alpha.id, begun.enrollmentId)),
    ).resolves.toEqual({ ok: true });
    await expect(
      enrollment.completeEnrollment({
        enrollmentId: begun.enrollmentId,
        claimCode: begun.claimCode,
        credential: newSecret(),
      }),
    ).resolves.toMatchObject({ ok: false, error: "enrollment_not_found" });
  });

  it("rotates with a staged overlap and revokes the old credential on confirm", async () => {
    const begun = await asPlatform(() =>
      enrollment.beginEnrollment({ businessId: alpha.id, approvedBy: admin.id }),
    );
    const oldSecret = newSecret();
    const completed = await enrollment.completeEnrollment({
      enrollmentId: begun.enrollmentId,
      claimCode: begun.claimCode,
      credential: oldSecret,
    });
    if (!completed.ok) throw new Error("enrollment fixture failed");

    const fresh = newSecret();
    const rotated = await asPlatform(() =>
      enrollment.rotateSupportDeviceCredential({
        businessId: alpha.id,
        installationId: completed.installationId,
        currentBearer: oldSecret,
        newCredential: fresh,
      }),
    );
    expect(rotated).toEqual({ ok: true, staged: true });

    // Overlap: both verify while the rotation is unconfirmed.
    expect(await enrollment.verifySupportDeviceCredential(oldSecret)).toMatchObject({
      credentialState: "active",
    });
    expect(await enrollment.verifySupportDeviceCredential(fresh)).toMatchObject({
      credentialState: "staged",
    });

    const confirmed = await asPlatform(() =>
      enrollment.confirmSupportDeviceRotation({
        businessId: alpha.id,
        installationId: completed.installationId,
        newBearer: fresh,
      }),
    );
    expect(confirmed).toEqual({ ok: true });
    expect(await enrollment.verifySupportDeviceCredential(oldSecret)).toBeNull();
    expect(await enrollment.verifySupportDeviceCredential(fresh)).toMatchObject({
      credentialState: "active",
    });
  });

  it("revoking the installation kills its device credentials", async () => {
    const begun = await asPlatform(() =>
      enrollment.beginEnrollment({ businessId: alpha.id, approvedBy: admin.id }),
    );
    const secret = newSecret();
    const completed = await enrollment.completeEnrollment({
      enrollmentId: begun.enrollmentId,
      claimCode: begun.claimCode,
      credential: secret,
    });
    if (!completed.ok) throw new Error("enrollment fixture failed");
    expect(await enrollment.verifySupportDeviceCredential(secret)).not.toBeNull();

    await asPlatform(() => installations.revokeInstallation(alpha.id, completed.installationId));
    expect(await enrollment.verifySupportDeviceCredential(secret)).toBeNull();
  });
});

describe("artifact uploads", () => {
  async function requestAndRun() {
    const created = await asPlatform(() =>
      diagnostics.createDiagnosticRequest({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        installationId: alpha.installationId,
        initiatedBy: "operator",
        operatorAdminId: admin.id,
        modules: ["database"],
        reason: "مصنوع آپلود فیکسچر",
      }),
    );
    if (!created.ok) throw new Error("request fixture failed");
    const recorded = await asPlatform(() =>
      diagnostics.recordDiagnosticRun({
        businessId: alpha.id,
        requestId: created.request.id,
        state: "completed",
        findings: [{ code: "DB_OK" }],
        severityOverall: "ok",
      }),
    );
    if (!recorded.ok) throw new Error("run fixture failed");
    return recorded.run.id;
  }

  function splitBytes(payload: Buffer, chunkSize: number): Buffer[] {
    const out: Buffer[] = [];
    for (let i = 0; i < payload.length; i += chunkSize) out.push(payload.subarray(i, i + chunkSize));
    return out;
  }

  it("uploads in chunks, reassembles and verifies the sha256", async () => {
    const runId = await requestAndRun();
    // ~300 KB across two real 256 KiB-window chunks.
    const payload = Buffer.from(JSON.stringify({ journal: "x".repeat(300_000) }));
    const chunks = splitBytes(payload, artifacts.ARTIFACT_CHUNK_BYTES);
    expect(chunks).toHaveLength(2);
    const sha256 = createHash("sha256").update(payload).digest("hex");

    const begun = await asPlatform(() =>
      artifacts.beginArtifactUpload({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        runId,
        name: "sync-journal.json",
        mimeType: "application/json",
        sha256,
        sizeBytes: payload.length,
        chunkCount: chunks.length,
      }),
    );
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.artifact.uploadState).toBe("uploading");

    for (const [index, bytes] of chunks.entries()) {
      const uploaded = await asPlatform(() =>
        artifacts.uploadArtifactChunk({
          businessId: alpha.id,
          artifactId: begun.artifact.id,
          chunkIndex: index,
          bytes,
        }),
      );
      expect(uploaded.ok).toBe(true);
    }

    const completed = await asPlatform(() =>
      artifacts.completeArtifactUpload({ businessId: alpha.id, artifactId: begun.artifact.id }),
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.artifact.uploadState).toBe("available");

    const fetched = await asPlatform(() => artifacts.getArtifactPayload(alpha.id, begun.artifact.id));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(Buffer.from(fetched.payload).equals(payload)).toBe(true);
  });

  it("retries identical chunks idempotently but rejects conflicting bytes", async () => {
    const runId = await requestAndRun();
    const payload = Buffer.from("chunk-conflict-probe");
    const begun = await asPlatform(() =>
      artifacts.beginArtifactUpload({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        runId,
        name: "probe.bin",
        sha256: createHash("sha256").update(payload).digest("hex"),
        sizeBytes: payload.length,
        chunkCount: 1,
      }),
    );
    if (!begun.ok) throw new Error("begin fixture failed");

    const first = await asPlatform(() =>
      artifacts.uploadArtifactChunk({
        businessId: alpha.id,
        artifactId: begun.artifact.id,
        chunkIndex: 0,
        bytes: payload,
      }),
    );
    expect(first).toMatchObject({ ok: true, received: 1, expected: 1 });

    // Identical retry: no-op success, still one chunk staged.
    const retry = await asPlatform(() =>
      artifacts.uploadArtifactChunk({
        businessId: alpha.id,
        artifactId: begun.artifact.id,
        chunkIndex: 0,
        bytes: Buffer.from(payload),
      }),
    );
    expect(retry).toMatchObject({ ok: true, received: 1, expected: 1 });

    // Different bytes for the same index: rejected, never silently overwritten.
    await expect(
      asPlatform(() =>
        artifacts.uploadArtifactChunk({
          businessId: alpha.id,
          artifactId: begun.artifact.id,
          chunkIndex: 0,
          bytes: Buffer.from("tampered-bytes-here!"),
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "chunk_conflict" });
  });

  it("fails closed to rejected when the assembled bytes mismatch the declared hash", async () => {
    const runId = await requestAndRun();
    const payload = Buffer.from("these bytes do not match the manifest");
    const begun = await asPlatform(() =>
      artifacts.beginArtifactUpload({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        runId,
        name: "lying-manifest.bin",
        sha256: createHash("sha256").update("something else entirely").digest("hex"),
        sizeBytes: payload.length,
        chunkCount: 1,
      }),
    );
    if (!begun.ok) throw new Error("begin fixture failed");
    const uploaded = await asPlatform(() =>
      artifacts.uploadArtifactChunk({
        businessId: alpha.id,
        artifactId: begun.artifact.id,
        chunkIndex: 0,
        bytes: payload,
      }),
    );
    expect(uploaded.ok).toBe(true);

    await expect(
      asPlatform(() =>
        artifacts.completeArtifactUpload({ businessId: alpha.id, artifactId: begun.artifact.id }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "integrity_mismatch" });

    const meta = await asPlatform(() => artifacts.getArtifactMeta(alpha.id, begun.artifact.id));
    expect(meta?.uploadState).toBe("rejected");
    await expect(
      asPlatform(() => artifacts.getArtifactPayload(alpha.id, begun.artifact.id)),
    ).resolves.toMatchObject({ ok: false, error: "not_available" });
  });

  it("refuses to attach bytes to another ticket's run", async () => {
    const runId = await requestAndRun();
    const payload = Buffer.from("cross-ticket");
    await expect(
      asPlatform(() =>
        artifacts.beginArtifactUpload({
          businessId: alpha.id,
          ticketId: beta.ticketId,
          runId,
          name: "nope.bin",
          sha256: createHash("sha256").update(payload).digest("hex"),
          sizeBytes: payload.length,
          chunkCount: 1,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "run_not_found" });
  });

  it("sweeps expired bytes, stale uploads and spent enrollment claims", async () => {
    const runId = await requestAndRun();
    const payload = Buffer.from("retention-sweep-target");
    const begun = await asPlatform(() =>
      artifacts.beginArtifactUpload({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        runId,
        name: "expiring.bin",
        sha256: createHash("sha256").update(payload).digest("hex"),
        sizeBytes: payload.length,
        chunkCount: 1,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    if (!begun.ok) throw new Error("begin fixture failed");
    await asPlatform(() =>
      artifacts.uploadArtifactChunk({
        businessId: alpha.id,
        artifactId: begun.artifact.id,
        chunkIndex: 0,
        bytes: payload,
      }),
    );
    const completed = await asPlatform(() =>
      artifacts.completeArtifactUpload({ businessId: alpha.id, artifactId: begun.artifact.id }),
    );
    expect(completed.ok).toBe(true);

    // An abandoned upload, backdated past the stale window.
    const stale = await asPlatform(() =>
      artifacts.beginArtifactUpload({
        businessId: alpha.id,
        ticketId: alpha.ticketId,
        runId,
        name: "abandoned.bin",
        sha256: createHash("sha256").update(payload).digest("hex"),
        sizeBytes: payload.length,
        chunkCount: 1,
      }),
    );
    if (!stale.ok) throw new Error("stale fixture failed");
    await db.query(
      "UPDATE support_diagnostic_artifacts SET created_at = now() - interval '25 hours' WHERE id = $1",
      [stale.artifact.id],
    );

    const expiredClaim = await asPlatform(() =>
      enrollment.beginEnrollment({ businessId: alpha.id, approvedBy: admin.id }),
    );
    await db.query("UPDATE support_enrollments SET expires_at = now() - interval '1 hour' WHERE id = $1", [
      expiredClaim.enrollmentId,
    ]);

    const swept = await artifacts.runSupportRetentionSweep();
    expect(swept.expiredArtifactBytesPurged).toBeGreaterThanOrEqual(1);
    expect(swept.staleUploadsRejected).toBeGreaterThanOrEqual(1);
    expect(swept.expiredEnrollmentsDeleted).toBeGreaterThanOrEqual(1);

    // The metadata tombstone survives; the bytes do not.
    const meta = await asPlatform(() => artifacts.getArtifactMeta(alpha.id, begun.artifact.id));
    expect(meta?.deletedAt).not.toBeNull();
    await expect(
      asPlatform(() => artifacts.getArtifactPayload(alpha.id, begun.artifact.id)),
    ).resolves.toMatchObject({ ok: false, error: "deleted" });
    const staleMeta = await asPlatform(() => artifacts.getArtifactMeta(alpha.id, stale.artifact.id));
    expect(staleMeta?.uploadState).toBe("rejected");
  });
});

describe("tenant isolation", () => {
  const TABLES = [
    "support_installations",
    "support_diagnostic_requests",
    "support_diagnostic_runs",
    "support_diagnostic_artifacts",
    "support_repair_runs",
    "support_assistance_sessions",
    "support_assistance_events",
    "support_access_tokens",
    "support_token_redemptions",
    "support_consent_events",
    "support_ai_conversations",
    "support_ai_messages",
    "support_ai_tool_events",
    "support_device_credentials",
    "support_enrollments",
    "support_artifact_chunks",
  ];

  it("enables and forces RLS with a scoping policy on every new table", async () => {
    for (const table of TABLES) {
      const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1",
        [table],
      );
      expect(rows[0]?.relrowsecurity, table).toBe(true);
      expect(rows[0]?.relforcerowsecurity, table).toBe(true);
      const { rows: policies } = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_isolation'",
        [table],
      );
      expect(Number(policies[0].count), table).toBe(1);
    }
  });

  it("lets an unprivileged role touch only its own business's rows", async () => {
    const scoped = new Client({
      connectionString: urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD }),
    });
    await scoped.connect();
    try {
      // The role itself must be unprivileged, or every RLS assertion is vacuous.
      const { rows: priv } = await scoped.query<{ privileged: boolean }>(
        "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
      );
      expect(priv[0].privileged).toBe(false);

      // Scoped to Alpha: its enrolled installation is visible.
      await scoped.query("SELECT set_config('app.business_id', $1, false)", [alpha.id]);
      const { rows: mine } = await scoped.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM support_installations",
      );
      expect(Number(mine[0].count)).toBeGreaterThanOrEqual(1);

      // Scoped to Beta: Alpha's rows are invisible.
      await scoped.query("SELECT set_config('app.business_id', $1, false)", [beta.id]);
      const { rows: others } = await scoped.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM support_installations",
      );
      expect(Number(others[0].count)).toBe(0);

      // A cross-business UPDATE touches zero rows.
      const upd = await scoped.query(
        "UPDATE support_installations SET display_name = 'نفوذ' WHERE id = $1::uuid",
        [alpha.installationId],
      );
      expect(upd.rowCount).toBe(0);

      // A cross-business DELETE touches zero rows.
      const del = await scoped.query("DELETE FROM support_installations WHERE id = $1::uuid", [
        alpha.installationId,
      ]);
      expect(del.rowCount).toBe(0);

      // An INSERT naming another business is refused outright (WITH CHECK).
      // The ticket/installation FKs resolve — only the tenant policy fails.
      await expect(
        scoped.query(
          `INSERT INTO support_diagnostic_requests
             (business_id, ticket_id, installation_id, installation_generation,
              initiated_by, reason, expires_at, idempotency_key)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'operator', 'نفوذ',
                   now() + interval '1 hour', $4)`,
          [alpha.id, alpha.ticketId, alpha.installationId, `rls-${randomUUID()}`],
        ),
      ).rejects.toThrow("row-level security");
    } finally {
      await scoped.end();
    }
  });
});
