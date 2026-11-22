/**
 * Issue #812 §5/§29 — Deep Research, the workflow that spends real money.
 * Issue #1367 — the workflow is retired; this file is now the database-level
 * proof of that retirement and of the history it must not destroy.
 *
 * The provider is stubbed at `fetch` for the same reason as before: the
 * interesting behaviour is what the module does *around* the call. After
 * retirement the answer is "nothing at all":
 *
 *  1. a new run cannot be created through the service, and no row is written
 *  2. a historical `awaiting_approval` run cannot be approved
 *  3. a historical `running` run cannot execute or reach a provider
 *  4. historical runs, findings, sources and answers remain readable
 *  5. the reader still reports an expired environment as expired
 *  6. list reads stay scoped to the business and to the member's own runs
 *  7. cancellation remains a safe, idempotent, non-spending operation
 *  8. the documented reconciliation touches only pending and expired rows
 *
 * Rows are inserted directly with SQL because creation is deliberately closed:
 * that is the only honest way to simulate history written before the rollout.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let research: typeof import("../src/lib/ai-research");
let reconcile: typeof import("../src/lib/ai-research-reconcile");

const biz = { businessId: "", userId: "" };

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
  databaseName = `pos_ai_research_${randomUUID().replaceAll("-", "")}`;

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
  research = await import("../src/lib/ai-research");
  reconcile = await import("../src/lib/ai-research-reconcile");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  vi.restoreAllMocks();

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  // This file writes history directly (creation is retired). The raw client is
  // a maintenance session, so it stands down FORCE RLS the same way the
  // reconciliation script does; the application reads below are still scoped by
  // their own SQL parameters.
  await db.query("SELECT set_config('app.rls_bypass', 'on', false)");
  await db.query("DELETE FROM businesses");
  const created = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Alpha', $1, 'food_service') RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  biz.businessId = created.rows[0].id;
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [biz.businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  biz.userId = user.rows[0].id;
});

/** The config a retired run would have used, so a provider call would be visible. */
const CONFIG = {
  enabled: true,
  model: "research-model",
  baseUrl: "http://litellm.test/v1",
  apiKey: "k",
  maxOutputTokens: 1_000,
  temperature: 0.2,
  gateway: { authKey: "k", body: {} },
} as unknown as Parameters<typeof research.runResearchRun>[0]["config"];

/** Insert a run exactly as the pre-retirement workflow would have left it. */
async function insertHistoricalRun(
  overrides: {
    status?: string;
    userId?: string | null;
    businessId?: string;
    expiresInHours?: number;
    answer?: string | null;
    findings?: unknown[];
    sources?: unknown[];
    actualCostUsd?: number;
  } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_research_runs
       (business_id, user_id, question, status, environment_id, answer, findings, sources,
        actual_cost_usd, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9, now() + ($10 || ' hours')::interval)
     RETURNING id`,
    [
      overrides.businessId ?? biz.businessId,
      overrides.userId === undefined ? biz.userId : overrides.userId,
      "چرا حاشیهٔ سود این ماه کم شد؟",
      overrides.status ?? "awaiting_approval",
      `research-env-${randomUUID()}`,
      overrides.answer ?? null,
      JSON.stringify(overrides.findings ?? []),
      JSON.stringify(overrides.sources ?? []),
      overrides.actualCostUsd ?? 0,
      String(overrides.expiresInHours ?? 24),
    ],
  );
  return rows[0].id;
}

describe("issue #1367 — no new Deep Research execution", () => {
  it("refuses to create a run and writes no row", async () => {
    const refused = await research.createResearchRun({
      businessId: biz.businessId,
      userId: biz.userId,
      question: "چرا حاشیهٔ سود این ماه کم شد؟",
      costApproved: true,
    });
    expect(refused).toEqual({ ok: false, error: "research_retired" });

    // The certain proof: an accepted request used to INSERT here.
    const { rows } = await db.query("SELECT count(*)::int AS n FROM ai_research_runs");
    expect(rows[0].n).toBe(0);
  });

  it("refuses to approve a historical pending run and leaves the row as history", async () => {
    const id = await insertHistoricalRun();
    const refused = await research.approveResearchRun({
      id,
      businessId: biz.businessId,
      userId: biz.userId,
    });
    expect(refused).toEqual({ ok: false, error: "research_retired" });

    const stored = await research.getResearchRun({ id, businessId: biz.businessId });
    expect(stored?.status).toBe("awaiting_approval");
  });

  it("cannot reach a provider from a historical running run", async () => {
    // The safety property that matters most: retirement must not spend. A run
    // approved just before the rollout is `running` in the table, and the runner
    // refuses before it reads the run or calls LiteLLM.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const id = await insertHistoricalRun({ status: "running" });

    const refused = await research.runResearchRun({
      id,
      businessId: biz.businessId,
      config: CONFIG,
      toolNames: ["run_report"],
    });
    expect(refused).toEqual({ ok: false, error: "research_retired" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (await research.getResearchRun({ id, businessId: biz.businessId }))?.actualCostUsd,
    ).toBe(0);
  });
});

describe("issue #1367 — historical results stay readable", () => {
  it("returns the stored answer, findings and sources unchanged", async () => {
    const findings = [{ claim: "فروش ۳۰٪ رشد کرد", sourceRefs: ["knowledge:abc"] }];
    const id = await insertHistoricalRun({
      status: "succeeded",
      answer: "فروش ۳۰٪ رشد کرد (منبع: knowledge:abc)",
      findings,
      sources: [{ kind: "knowledge", ref: "knowledge:abc", title: "دانش کسب‌وکار", count: 2 }],
      actualCostUsd: 0.031,
    });
    await db.query(
      `INSERT INTO ai_research_sources (run_id, business_id, kind, ref, title, record_count)
       VALUES ($1,$2,'knowledge','knowledge:abc','دانش کسب‌وکار',2)`,
      [id, biz.businessId],
    );

    const stored = await research.getResearchRun({ id, businessId: biz.businessId });
    expect(stored?.status).toBe("succeeded");
    expect(stored?.answer).toContain("knowledge:abc");
    expect(stored?.findings).toEqual(findings);
    expect(stored?.actualCostUsd).toBeCloseTo(0.031, 5);

    const sources = await research.listResearchSources(id, biz.businessId);
    expect(sources).toEqual([
      { kind: "knowledge", ref: "knowledge:abc", title: "دانش کسب‌وکار", count: 2 },
    ]);
  });

  it("still reports an expired environment as expired rather than live", async () => {
    const id = await insertHistoricalRun({ status: "awaiting_approval", expiresInHours: -1 });
    expect((await research.getResearchRun({ id, businessId: biz.businessId }))?.status).toBe("expired");
  });

  it("scopes the history list to the business and to the member's own runs", async () => {
    const otherUser = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', 'Other', $2, 'x') RETURNING id`,
      [biz.businessId, `other-${randomUUID().slice(0, 8)}@example.test`],
    );
    const mine = await insertHistoricalRun({ status: "succeeded" });
    await insertHistoricalRun({ status: "succeeded", userId: otherUser.rows[0].id });

    const own = await research.listResearchRuns({
      businessId: biz.businessId,
      userId: biz.userId,
    });
    expect(own.map((run) => run.id)).toEqual([mine]);

    // Another business cannot read this run even knowing its id.
    const otherBusiness = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Beta', $1, 'food_service') RETURNING id",
      [`beta-${randomUUID().slice(0, 8)}`],
    );
    expect(
      await research.getResearchRun({
        id: mine,
        businessId: otherBusiness.rows[0].id,
      }),
    ).toBeNull();
  });

  it("keeps cancellation available and idempotent for a pending run", async () => {
    const id = await insertHistoricalRun();
    expect((await research.cancelResearchRun({ id, businessId: biz.businessId })).ok).toBe(true);
    expect((await research.getResearchRun({ id, businessId: biz.businessId }))?.status).toBe("cancelled");
    expect((await research.cancelResearchRun({ id, businessId: biz.businessId })).ok).toBe(false);
  });
});

describe("issue #1367 — the documented reconciliation policy", () => {
  it("cancels pending runs and fails only expired running runs, leaving a live run alone", async () => {
    const pending = await insertHistoricalRun({ status: "awaiting_approval" });
    const expired = await insertHistoricalRun({ status: "running", expiresInHours: -1 });
    const live = await insertHistoricalRun({ status: "running" });

    // The report is read-only.
    const before = await reconcile.readOpenResearchRuns(db, biz.businessId);
    expect(before).toEqual({ pending: 1, runningLive: 1, runningExpired: 1, running: 2 });

    const outcome = await reconcile.reconcileResearchRetirement(db, {
      businessId: biz.businessId,
      apply: true,
    });
    expect(outcome.applied).toEqual({ cancelled: 1, failed: 1 });
    expect(outcome.after).toEqual({ pending: 0, runningLive: 1, runningExpired: 0, running: 1 });

    expect((await research.getResearchRun({ id: pending, businessId: biz.businessId }))?.status).toBe("cancelled");
    expect((await research.getResearchRun({ id: expired, businessId: biz.businessId }))?.status).toBe("failed");
    expect((await research.getResearchRun({ id: live, businessId: biz.businessId }))?.status).toBe("running");
  });
});
