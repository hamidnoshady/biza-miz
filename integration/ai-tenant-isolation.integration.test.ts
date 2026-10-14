/**
 * Issue #812 §10/§13 — no cross-tenant knowledge or memory leak is possible,
 * proven against a real database.
 *
 * `tenant-isolation.integration.test.ts` proves `ai_memory`,
 * `ai_research_runs` and `ai_research_sources` carry RLS like every other tenant
 * table. That is the structural half. This file proves the behavioural half,
 * which is the one a leak would actually take:
 *
 *   - a business's memory is invisible to a sibling, at every layer, even when
 *     the sibling names the same scope and the same project id;
 *   - a Deep Research run's id, found by reading the other tenant's row, is
 *     still not readable — the run's business id is re-checked on read, so a
 *     leaked id is a dead id rather than an open one;
 *   - a forgotten memory entry stops influencing future turns immediately;
 *   - a memory entry holding credential-shaped content is refused, because a
 *     stored token is a token you now have to rotate.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let memory: typeof import("../src/lib/ai-memory");
let research: typeof import("../src/lib/ai-research");

const alpha = { businessId: "", userId: "", projectId: "" };
const beta = { businessId: "", userId: "", projectId: "" };

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
  databaseName = `pos_ai_isolation_${randomUUID().replaceAll("-", "")}`;

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
  memory = await import("../src/lib/ai-memory");
  research = await import("../src/lib/ai-research");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
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

async function seedBusiness(name: string, slug: string, projectName: string) {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = biz.rows[0].id;
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [businessId, `owner-${slug}@example.test`],
  );
  const userId = user.rows[0].id;
  // A project per business. Deliberately created with the SAME name on both
  // sides: a leak that keys on a project name rather than its id would pass a
  // test that only used distinct names.
  const project = await db.query<{ id: string }>(
    `INSERT INTO ai_projects (business_id, name, instructions, created_by)
     VALUES ($1, $2, '', $3) RETURNING id`,
    [businessId, projectName, userId],
  );
  return { businessId, userId, projectId: project.rows[0].id };
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  Object.assign(
    alpha,
    await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`, "کمپین مشترک"),
  );
  Object.assign(
    beta,
    await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`, "کمپین مشترک"),
  );
});

describe("tenant memory cannot cross the boundary", () => {
  it("shows each business only its own rows, at every layer", async () => {
    await dbLib.withTenant(alpha.businessId, () =>
      memory.createMemoryEntry({
        businessId: alpha.businessId,
        scope: "tenant",
        content: "راز آلفا",
        createdBy: alpha.userId,
      }),
    );
    await dbLib.withTenant(alpha.businessId, () =>
      memory.createMemoryEntry({
        businessId: alpha.businessId,
        scope: "project",
        projectId: alpha.projectId,
        content: "یادداشت پروژهٔ آلفا",
        createdBy: alpha.userId,
      }),
    );
    await dbLib.withTenant(beta.businessId, () =>
      memory.createMemoryEntry({
        businessId: beta.businessId,
        scope: "tenant",
        content: "راز بتا",
        createdBy: beta.userId,
      }),
    );

    const alphaTenant = await dbLib.withTenant(alpha.businessId, () =>
      memory.listMemory({ businessId: alpha.businessId, scope: "tenant" }),
    );
    const betaTenant = await dbLib.withTenant(beta.businessId, () =>
      memory.listMemory({ businessId: beta.businessId, scope: "tenant" }),
    );

    expect(alphaTenant.map((entry) => entry.content)).toEqual(["راز آلفا"]);
    expect(betaTenant.map((entry) => entry.content)).toEqual(["راز بتا"]);
  });

  it("keeps a project layer private even when the sibling names the same project id", async () => {
    // The project-scope read takes the project id from the caller. Beta passing
    // ALPHA's project id must still return nothing: the query is scoped by
    // `business_id` as well, and RLS refuses the row outright underneath it.
    await dbLib.withTenant(alpha.businessId, () =>
      memory.createMemoryEntry({
        businessId: alpha.businessId,
        scope: "project",
        projectId: alpha.projectId,
        content: "یادداشت پروژهٔ آلفا",
        createdBy: alpha.userId,
      }),
    );

    const betaReadingAlphaProject = await dbLib.withTenant(beta.businessId, () =>
      memory.listMemory({ businessId: beta.businessId, scope: "project", projectId: alpha.projectId }),
    );
    expect(betaReadingAlphaProject).toEqual([]);

    // The RLS half is asserted structurally by `tenant-isolation.integration.test.ts`
    // (`ai_memory` carries FORCE ROW LEVEL SECURITY and a `business_id` column,
    // so it cannot be in `EXEMPT_TABLES`). What this file adds is the
    // behavioural half above: the read is scoped by the caller's own business,
    // so a wrong project id returns nothing rather than something filtered.
  });

  it("stops a forgotten entry from influencing future turns immediately", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      memory.createMemoryEntry({
        businessId: alpha.businessId,
        scope: "tenant",
        content: "این را فراموش کن",
        createdBy: alpha.userId,
      }),
    );
    expect(
      (await dbLib.withTenant(alpha.businessId, () =>
        memory.listMemory({ businessId: alpha.businessId, scope: "tenant" }),
      )).length,
    ).toBe(1);

    await dbLib.withTenant(alpha.businessId, () =>
      memory.deleteMemoryEntry({ businessId: alpha.businessId, id: created.id, scope: "tenant" }),
    );

    const after = await dbLib.withTenant(alpha.businessId, () =>
      memory.listMemory({ businessId: alpha.businessId, scope: "tenant" }),
    );
    expect(after).toEqual([]);

    // …and the render that actually reaches the model is empty, not stale.
    const layers = await dbLib.withTenant(alpha.businessId, () =>
      memory.memoryLayersForTurn({ businessId: alpha.businessId }),
    );
    // The layer object itself is empty, so the render that reaches the model is
    // too — a forgotten entry is not merely hidden from a list.
    expect(layers.tenant).toEqual([]);
    expect(memory.renderMemoryForPrompt(layers)).toBe("");
  });

  it("refuses credential-shaped content rather than storing a token to rotate", async () => {
    const secrets = [
      "کلید دسترسی sk-live-abcdef123456",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc",
      "pk_test_9f8e7d6c5b4a",
      // The prefix set the first revision of this check missed: a bare
      // `bearer eyJ…` with no label, and the provider prefixes with a hyphenated
      // body. `sk-live-…` is the single most likely thing a member would paste,
      // and an earlier regex that demanded 16+ bare alphanumerics let it
      // straight through.
      "bearer eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxIn0",
      "sk-proj-AbCdEf123456",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_1234567890abcdefghij",
      "xoxb-1234567890-abcdefghij",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
    ];
    for (const content of secrets) {
      const result = memory.validateMemoryInput({
        businessId: alpha.businessId,
        scope: "tenant",
        content,
      });
      expect(result.ok, content).toBe(false);
    }
  });
});

describe("a Deep Research run's id is not an open door", () => {
  it("re-checks the run's business on read, so a leaked id is a dead id", async () => {
    // Beta is handed ALPHA's run id — the shape a leaked id would take, whether
    // it came from a log line, a URL or a mistake in a report. The read must
    // refuse it rather than trusting the id.
    const created = await dbLib.withTenant(alpha.businessId, () =>
      research.createResearchRun({
        businessId: alpha.businessId,
        userId: alpha.userId,
        question: "چرا حاشیهٔ سود کم شد؟",
        costApproved: true,
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const betaReading = await dbLib.withTenant(beta.businessId, () =>
      research.getResearchRun({ id: created.run.id, businessId: beta.businessId }),
    );
    expect(betaReading).toBeNull();

    // And the run's sources are equally unreachable.
    const betaSources = await dbLib.withTenant(beta.businessId, () =>
      research.listResearchSources(created.run.id, beta.businessId),
    );
    expect(betaSources).toEqual([]);

    // Alpha can still read its own run — the boundary is a boundary, not a lock.
    const alphaReading = await dbLib.withTenant(alpha.businessId, () =>
      research.getResearchRun({ id: created.run.id, businessId: alpha.businessId }),
    );
    expect(alphaReading?.id).toBe(created.run.id);
  });

  it("lists only the caller's own runs", async () => {
    for (const [biz, user] of [
      [alpha, alpha.userId],
      [beta, beta.userId],
    ] as const) {
      await dbLib.withTenant(biz.businessId, () =>
        research.createResearchRun({
          businessId: biz.businessId,
          userId: user,
          question: "پرسش دربارهٔ فروش این کسب‌وکار",
          costApproved: true,
        }),
      );
    }

    const alphaRuns = await dbLib.withTenant(alpha.businessId, () =>
      research.listResearchRuns({ businessId: alpha.businessId, userId: alpha.userId }),
    );
    const betaRuns = await dbLib.withTenant(beta.businessId, () =>
      research.listResearchRuns({ businessId: beta.businessId, userId: beta.userId }),
    );

    expect(alphaRuns).toHaveLength(1);
    expect(betaRuns).toHaveLength(1);
    expect(alphaRuns[0].id).not.toBe(betaRuns[0].id);
  });
});
