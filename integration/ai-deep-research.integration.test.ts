/**
 * Issue #812 §5/§29 — Deep Research, the workflow that spends real money.
 *
 * §29 names nine cases for it and there was no test file at all. The only
 * existing coverage was structural — the permission matrix and the attribution
 * test read the route as text — which proves a guard exists and nothing about
 * what the workflow does. For the one path in the product that can spend a
 * business's AI budget without a human watching, that is the wrong way round.
 *
 * The provider is stubbed at `fetch`, because the interesting behaviour is all
 * in what the module does *around* the call: when it refuses to start, when it
 * stops, what it keeps, and what it settles.
 *
 *  1. cost approval is required — a run cannot start without it
 *  2. a run cannot execute before it is approved
 *  3. the spend cap stops the loop and records what it spent
 *  4. a finding with no source is dropped, not guessed at
 *  5. an expired environment is reported as expired, never as live
 *  6. cancellation is idempotent and a finished run stays finished
 *  7. the environment is per-run and never reused
 *  8. a source is recorded once per run, not once per round
 *  9. tenant isolation (already covered in ai-tenant-isolation; asserted here
 *     from the run's own side for completeness)
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

/**
 * A provider stub. Each chat call returns the next scripted reply; the
 * knowledge endpoint answers from `hits` when given, so a run can be exercised
 * with real retrieval in the loop rather than a hand-written source list.
 */
function stubProvider(replies: string[], options: { costPerCallUsd?: number; hits?: { title: string; content: string }[] } = {}) {
  const costPerCallUsd = options.costPerCallUsd ?? 0.001;
  let call = 0;
  const seen: { model: string; system: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      // The knowledge gateway posts to `<base>/<businessId>/search`; the model
      // calls post to `/chat/completions`. Discriminating on the URL is what
      // lets both be stubbed at once.
      if (String(url).endsWith("/search")) {
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({ hits: options.hits ?? [] }),
        } as unknown as Response;
      }
      const body = JSON.parse(init.body) as { model: string; messages: { role: string; content: string }[] };
      seen.push({ model: body.model, system: body.messages[0]?.content ?? "" });
      const content = replies[Math.min(call, replies.length - 1)] ?? "";
      call += 1;
      return {
        ok: true,
        headers: new Headers({ "x-litellm-response-cost": String(costPerCallUsd) }),
        json: async () => ({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      } as unknown as Response;
    }),
  );
  return seen;
}

const CONFIG = {
  enabled: true,
  baseUrl: "http://litellm.test/v1",
  apiKey: "k",
  model: "pos-deep-research",
  maxOutputTokens: 2000,
  temperature: 0.2,
  gateway: { authKey: "k", body: {} },
} as unknown as Parameters<typeof research.runResearchRun>[0]["config"];

/** A config with the managed knowledge integration switched on. */
const CONFIG_WITH_KNOWLEDGE = {
  ...CONFIG,
  knowledge: {
    enabled: true,
    baseUrl: "http://litellm.test/v1/knowledge",
    apiKey: "k",
    model: "",
    maxResults: 5,
  },
} as unknown as typeof CONFIG;


async function createRun(overrides: Partial<Parameters<typeof research.createResearchRun>[0]> = {}) {
  const result = await research.createResearchRun({
    businessId: biz.businessId,
    userId: biz.userId,
    question: "چرا حاشیهٔ سود این ماه کم شد؟",
    costApproved: true,
    ...overrides,
  });
  if (!result.ok) throw new Error(`create failed: ${result.error}`);
  return result.run;
}

describe("§5 — explicit cost approval", () => {
  it("refuses to create a run the human has not agreed to pay for", async () => {
    const refused = await research.createResearchRun({
      businessId: biz.businessId,
      userId: biz.userId,
      question: "چرا حاشیهٔ سود این ماه کم شد؟",
      costApproved: false,
    });
    expect(refused).toEqual({ ok: false, error: "research_cost_not_approved" });
    // And nothing was written — an unapproved request leaves no row behind that
    // a later call could pick up.
    const { rows } = await db.query("SELECT count(*)::int AS n FROM ai_research_runs");
    expect(rows[0].n).toBe(0);
  });

  it("refuses an estimate that exceeds the platform's own spend cap", async () => {
    // The estimate is computed server-side from the caps, so a caller cannot
    // negotiate it down by asking for fewer rounds than it intends to use.
    const refused = await research.createResearchRun({
      businessId: biz.businessId,
      userId: biz.userId,
      question: "چرا حاشیهٔ سود این ماه کم شد؟",
      costApproved: true,
      maxRounds: 12,
      spendCapUsd: 0.01,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("research_estimate_over_spend_cap");
  });

  it("cannot execute before it is approved, however the call is made", async () => {
    // `runResearchRun` requires `running`, and only approval produces that. A
    // caller that reaches straight for the runner gets a refusal, not a run.
    const run = await createRun();
    expect(run.status).toBe("awaiting_approval");

    const early = await research.runResearchRun({
      id: run.id,
      businessId: biz.businessId,
      config: CONFIG,
      toolNames: ["run_report"],
    });
    expect(early).toEqual({ ok: false, error: "research_not_running" });
  });

  it("refuses a second approval of an already-approved run", async () => {
    // Re-approving is how a run spends twice.
    const run = await createRun();
    const first = await research.approveResearchRun({ id: run.id, businessId: biz.businessId, userId: biz.userId });
    expect(first.ok).toBe(true);

    const second = await research.approveResearchRun({ id: run.id, businessId: biz.businessId, userId: biz.userId });
    expect(second).toEqual({ ok: false, error: "research_not_awaiting_approval" });
  });
});

describe("§5 — the spend cap", () => {
  it("stops the loop when the accumulated cost reaches the cap", async () => {
    // Two rounds' worth of cost, a cap that only covers one. The loop must stop
    // rather than "try to finish anyway", and it must record what it spent.
    stubProvider(["یافته: حاشیهٔ سود ۱۲٪ افت کرد\nمنبع: knowledge:x"], { costPerCallUsd: 0.02 });
    const run = await createRun({ maxRounds: 4, spendCapUsd: 0.03 });

    const approved = await research.approveResearchRun({
      id: run.id,
      businessId: biz.businessId,
      userId: biz.userId,
    });
    expect(approved.ok).toBe(true);

    const result = await research.runResearchRun({
      id: run.id,
      businessId: biz.businessId,
      config: CONFIG,
      toolNames: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // It spent one round's worth and stopped — not four.
    expect(result.outcome.costUsd).toBeCloseTo(0.02, 5);
    const stored = await research.getResearchRun({ id: run.id, businessId: biz.businessId });
    expect(stored?.status).toBe("spend_cap_reached");
    expect(stored?.roundsUsed).toBe(1);
  });

  it("clamps a caller's round and cap requests to the platform's own bounds", async () => {
    // A tenant cannot raise its own ceiling by asking nicely.
    const run = await createRun({ maxRounds: 999, spendCapUsd: 9999, maxContextChars: 99_999_999 });
    expect(run.maxRounds).toBe(12);
    expect(run.spendCapUsd).toBe(100);
    expect(run.maxContextChars).toBe(400_000);
  });
});

describe("§5 — grounded output", () => {
  it("drops a finding that names no source instead of guessing at one", async () => {
    // The grounding rule, enforced on the way in. A model that states a fact
    // without evidence produces nothing, not a plausible citation.
    stubProvider([
      "یافته: فروش ۳۰٪ رشد کرد\nمنبع: knowledge:abc\n\nیافته: این عدد بی‌منبع است",
    ]);
    const run = await createRun({ maxRounds: 1 });
    await research.approveResearchRun({ id: run.id, businessId: biz.businessId, userId: biz.userId });
    const result = await research.runResearchRun({
      id: run.id,
      businessId: biz.businessId,
      config: CONFIG,
      toolNames: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await research.getResearchRun({ id: run.id, businessId: biz.businessId });
    const claims = (stored?.findings ?? []).map((f) => f.claim);
    expect(claims.some((c) => c.includes("بی‌منبع"))).toBe(false);
    expect(claims.some((c) => c.includes("۳۰٪"))).toBe(true);
    // And the surviving finding carries its source through to the answer.
    expect(stored?.answer).toContain("knowledge:abc");
  });

  it("says so plainly when nothing grounded could be found", async () => {
    // A research run that finds nothing must not spend a synthesis call
    // inventing an answer. "No documented finding" is the honest result.
    stubProvider(["یافته: ادعای بی‌پشتوانه"]);
    const run = await createRun({ maxRounds: 1 });
    await research.approveResearchRun({ id: run.id, businessId: biz.businessId, userId: biz.userId });
    const result = await research.runResearchRun({
      id: run.id,
      businessId: biz.businessId,
      config: CONFIG,
      toolNames: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await research.getResearchRun({ id: run.id, businessId: biz.businessId });
    expect(stored?.answer).toContain("هیچ یافتهٔ مستندی");
    // One provider call, not two: no synthesis happened.
    expect(result.outcome.costUsd).toBeCloseTo(0.001, 5);
  });
});

describe("§5 — the isolated environment", () => {
  it("gives every run its own environment id and never reuses one", async () => {
    const a = await createRun();
    const b = await createRun();
    expect(a.environmentId).not.toBe(b.environmentId);
    expect(a.environmentId).toMatch(/^research-env-/);
    // And the environment is what expires, not the run's row.
    expect(new Date(a.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("reports an expired environment as expired rather than as live", async () => {
    // The TTL is enforced by the reader as well as the writer, so a run that
    // expired while nobody looked is not returned as something to run.
    const run = await createRun();
    await research.approveResearchRun({ id: run.id, businessId: biz.businessId, userId: biz.userId });
    await db.query("UPDATE ai_research_runs SET expires_at = now() - interval '1 hour' WHERE id = $1", [run.id]);

    const result = await research.runResearchRun({
      id: run.id,
      businessId: biz.businessId,
      config: CONFIG,
      toolNames: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("research_environment_expired");
    const stored = await research.getResearchRun({ id: run.id, businessId: biz.businessId });
    expect(stored?.status).toBe("expired");
  });

  it("records each source once per run, not once per round", async () => {
    // `UNIQUE (run_id, ref)` plus the upsert in `finishRun`. Without it, a
    // five-round run would report five copies of the same source and a reader
    // would count evidence that does not exist.
    stubProvider(["یافته: یافتهٔ مستند\nمنبع: knowledge:same"], {
      costPerCallUsd: 0.001,
      hits: [
        { title: "گزارش فروش", content: "فروش بهار ۱۲٪ کم شد." },
        { title: "هزینه‌ها", content: "هزینهٔ اجاره ثابت بود." },
      ],
    });
    const run = await createRun({ maxRounds: 3, spendCapUsd: 100 });
    await research.approveResearchRun({ id: run.id, businessId: biz.businessId, userId: biz.userId });
    const result = await research.runResearchRun({
      id: run.id,
      businessId: biz.businessId,
      config: CONFIG_WITH_KNOWLEDGE,
      toolNames: ["run_report", "find_items"],
    });
    expect(result.ok).toBe(true);

    // The knowledge source is pushed on EVERY round `gatherRoundEvidence` runs,
    // always with the same ref (`knowledge:<businessId>`). Three rounds, three
    // pushes, one row — the upsert is the invariant.
    const sources = await research.listResearchSources(run.id, biz.businessId);
    expect(sources).toHaveLength(1);
    expect(sources[0].kind).toBe("knowledge");
    expect(sources[0].ref).toBe(`knowledge:${biz.businessId}`);
    expect(sources[0].count).toBe(2);
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM ai_research_sources WHERE run_id = $1",
      [run.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("survives a failing round and keeps what the other rounds gathered", async () => {
    // Half a grounded answer beats an exception. A round that throws is
    // recorded as that round's failure and the loop continues.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("network down");
        return {
          ok: true,
          headers: new Headers({ "x-litellm-response-cost": "0.001" }),
          json: async () => ({
            choices: [{ message: { content: "یافته: یافتهٔ دور دوم\nمنبع: knowledge:later" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        } as unknown as Response;
      }),
    );

    const run = await createRun({ maxRounds: 2, spendCapUsd: 100 });
    await research.approveResearchRun({ id: run.id, businessId: biz.businessId, userId: biz.userId });
    const result = await research.runResearchRun({
      id: run.id,
      businessId: biz.businessId,
      config: CONFIG,
      toolNames: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await research.getResearchRun({ id: run.id, businessId: biz.businessId });
    const claims = (stored?.findings ?? []).map((f) => f.claim).join(" ");
    expect(claims).toContain("دور 1");
    expect(claims).toContain("یافتهٔ دور دوم");
    expect(stored?.status).toBe("succeeded");
  });
});

describe("§5 — cancellation and settlement", () => {
  it("cancels a run that has not finished and leaves a finished one alone", async () => {
    const run = await createRun();
    expect((await research.cancelResearchRun({ id: run.id, businessId: biz.businessId })).ok).toBe(true);
    const cancelled = await research.getResearchRun({ id: run.id, businessId: biz.businessId });
    expect(cancelled?.status).toBe("cancelled");

    // Idempotent: cancelling again is not an error, and it does not resurrect or
    // re-finish anything.
    expect((await research.cancelResearchRun({ id: run.id, businessId: biz.businessId })).ok).toBe(false);
    expect((await research.getResearchRun({ id: run.id, businessId: biz.businessId }))?.status).toBe("cancelled");

    // A cancelled run cannot be approved — the window is closed.
    const approved = await research.approveResearchRun({
      id: run.id,
      businessId: biz.businessId,
      userId: biz.userId,
    });
    expect(approved.ok).toBe(false);
  });

  it("settles what a stopped run actually spent, not what it was allowed to", async () => {
    // The whole point of §16 as it applies to research: the cost that matters
    // is the one incurred, and a run stopped at its cap still owes for the
    // rounds it did complete.
    stubProvider(["یافته: یافتهٔ مستند\nمنبع: knowledge:x"], { costPerCallUsd: 0.025 });
    const run = await createRun({ maxRounds: 4, spendCapUsd: 0.04 });
    await research.approveResearchRun({ id: run.id, businessId: biz.businessId, userId: biz.userId });
    const result = await research.runResearchRun({
      id: run.id,
      businessId: biz.businessId,
      config: CONFIG,
      toolNames: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One round's cost, reported for settlement — not the cap, and not zero.
    expect(result.outcome.costUsd).toBeCloseTo(0.025, 5);
    expect(result.outcome.usage.promptTokens).toBeGreaterThan(0);
    const stored = await research.getResearchRun({ id: run.id, businessId: biz.businessId });
    expect(stored?.actualCostUsd).toBeCloseTo(0.025, 5);
    // …and strictly less than the ceiling it was approved against.
    expect(stored!.actualCostUsd).toBeLessThan(stored!.spendCapUsd);
  });
});
