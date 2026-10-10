/**
 * Phase C — the messaging read tools answer from real data.
 *
 * `runReadTool` is the same executor the dashboard assistant uses. The two new
 * tools (`list_message_templates`, `list_message_campaigns`) are exercised here
 * against real rows written through the campaign service, and shown to be
 * scoped to the calling business — a second business's template or campaign
 * never appears in the first's list.
 *
 * The four new *write* actions are not exercised here: they carry no server-side
 * executor and are applied only from the browser through the already-tested,
 * role-guarded routes (`/api/parties`, `/api/messaging`, `/api/ledger/ar/receipts`).
 * Their catalogue wiring is pinned in `src/lib/ai.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let aiTools: typeof import("../src/lib/ai-tools");
let campaigns: typeof import("../src/lib/message-campaigns-service");

const alpha = { businessId: "" };
const beta = { businessId: "" };

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
  databaseName = `pos_ai_phase_c_${randomUUID().replaceAll("-", "")}`;

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
  aiTools = await import("../src/lib/ai-tools");
  campaigns = await import("../src/lib/message-campaigns-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const a = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('Alpha Cafe', $1, 'food_service') RETURNING id`,
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = a.rows[0].id;
  const b = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('Beta Cafe', $1, 'food_service') RETURNING id`,
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  beta.businessId = b.rows[0].id;
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

describe("Phase C read tools", () => {
  it("list_message_templates returns the business's templates and filters by channel", async () => {
    await dbLib.withTenant(alpha.businessId, () =>
      campaigns.saveMessageTemplate(alpha.businessId, {
        channel: "sms",
        name: "یادآوری",
        body: "سلام {{نام}}",
      }),
    );
    await dbLib.withTenant(alpha.businessId, () =>
      campaigns.saveMessageTemplate(alpha.businessId, {
        channel: "email",
        name: "خبرنامه",
        subject: "خبر تازه",
        body: "سلام {{نام}}",
      }),
    );

    const all = await dbLib.withTenant(alpha.businessId, () =>
      aiTools.runReadTool("list_message_templates", {}, alpha.businessId),
    );
    expect(all.ok).toBe(true);
    const allData = all.data as {
      scopeNote: string;
      templates: Array<{ templateId: string; channel: string; name: string }>;
    };
    const allRows = allData.templates;
    expect(allData.scopeNote).toContain("کل کسب‌وکار");
    expect(allRows.length).toBe(2);
    expect(allRows.every((r) => typeof r.templateId === "string")).toBe(true);

    const sms = await dbLib.withTenant(alpha.businessId, () =>
      aiTools.runReadTool("list_message_templates", { channel: "sms" }, alpha.businessId),
    );
    const smsRows = (sms.data as { templates: Array<{ channel: string }> }).templates;
    expect(smsRows.length).toBe(1);
    expect(smsRows[0].channel).toBe("sms");
  });

  it("list_message_campaigns returns campaigns scoped to the business", async () => {
    const template = await dbLib.withTenant(alpha.businessId, () =>
      campaigns.saveMessageTemplate(alpha.businessId, {
        channel: "sms",
        name: "کمپین قالب",
        body: "سلام {{نام}}",
      }),
    );
    const created = await dbLib.withTenant(alpha.businessId, () =>
      campaigns.createMessageCampaign(alpha.businessId, {
        channel: "sms",
        name: "کمپین تست",
        templateId: template.id,
        segmentId: null,
      }),
    );

    const alphaList = await dbLib.withTenant(alpha.businessId, () =>
      aiTools.runReadTool("list_message_campaigns", {}, alpha.businessId),
    );
    expect(alphaList.ok).toBe(true);
    const alphaData = alphaList.data as {
      scopeNote: string;
      campaigns: Array<{ campaignId: string; name: string; status: string }>;
    };
    const alphaRows = alphaData.campaigns;
    expect(alphaData.scopeNote).toContain("کل کسب‌وکار");
    expect(alphaRows.some((r) => r.campaignId === created.id)).toBe(true);
    expect(alphaRows.find((r) => r.campaignId === created.id)?.status).toBe("draft");

    // Beta has no campaigns — the tool never leaks Alpha's rows.
    const betaList = await dbLib.withTenant(beta.businessId, () =>
      aiTools.runReadTool("list_message_campaigns", {}, beta.businessId),
    );
    const betaRows = (betaList.data as { campaigns: Array<{ campaignId: string }> }).campaigns;
    expect(betaRows.some((r) => r.campaignId === created.id)).toBe(false);
  });
});
