/** #1128: read-only allocation previews over canonical posted expense lines. */
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
let provisioning: typeof import("../src/lib/business-provisioning");

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
  databaseName = `agency_alloc_preview_${randomUUID().replaceAll("-", "")}`;

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
  provisioning = await import("../src/lib/business-provisioning");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 240_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
});

async function fixture() {
  const id = randomUUID().slice(0, 8);
  const provisioned = await provisioning.provisionBusiness({
    businessName: "آژانس تخصیص",
    ownerName: "حسابدار",
    email: `allocation-${id}@example.test`,
    password: "correct-horse",
    subdomain: `alloc${id}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  const businessId = provisioned.businessId;
  const owner = {
    businessId,
    actorUserId: provisioned.userId,
    actorName: "حسابدار",
  };
  const partyId = (
    await db.query(
      `INSERT INTO parties(business_id,name,role,roles) VALUES($1,'کارفرما','customer',ARRAY['customer']) RETURNING id`,
      [businessId],
    )
  ).rows[0].id;
  const projectId = (
    await db.query(
      `INSERT INTO ai_projects(business_id,name,created_by,owner_user_id,party_id) VALUES($1,'پروژه',$2::text,$2::uuid,$3) RETURNING id`,
      [businessId, provisioned.userId, partyId],
    )
  ).rows[0].id;
  const campaignId = (
    await db.query(
      `INSERT INTO agency_client_campaigns(business_id,campaign_number,party_id,project_id,title) VALUES($1,'CA-1',$2,$3,'کمپین') RETURNING id`,
      [businessId, partyId, projectId],
    )
  ).rows[0].id;
  const ledger = await import("../src/lib/ledger-service");
  const exact = await import("../src/lib/inventory-exact");
  const accounts = (
    await db.query(
      `SELECT id,code FROM accounts WHERE business_id=$1 AND code IN ('5197','2140','1270','4100')`,
      [businessId],
    )
  ).rows;
  const account = (code: string) =>
    accounts.find((row) => row.code === code)?.id as string;
  const post = async (
    amount = "9007199254740993",
    code = "5197",
    project: string | null = projectId,
  ) => {
    const entryId = await dbLib.withTenantTransaction(businessId, (client) =>
      ledger.postExactJournalEntry(client, {
        businessId,
        locationId: provisioned.locationId,
        projectId: project,
        entryDate: "2026-10-20",
        memo: "تخصیص آزمایشی",
        sourceType: "manual",
        sourceId: null,
        createdBy: provisioned.userId,
        lines: [
          {
            accountId: account(code),
            debit: exact.rialText(amount),
            credit: exact.rialText("0"),
          },
          {
            accountId: account("2140"),
            debit: exact.rialText("0"),
            credit: exact.rialText(amount),
          },
        ],
      }),
    );
    const lineId = (
      await db.query(
        `SELECT id::text FROM journal_lines WHERE entry_id=$1 AND account_id=$2`,
        [entryId, account(code)],
      )
    ).rows[0].id;
    return { entryId, lineId };
  };
  const preview = async (
    lineId: string,
    targets = [{ campaignId, basisPoints: 2500 }],
    asOwner = owner,
  ) => {
    const service =
      await import("../src/lib/agency-campaign-allocation-service");
    return dbLib.withTenant(asOwner.businessId, () =>
      service.previewPostedCampaignAllocation(asOwner, projectId, {
        sourceLineId: lineId,
        targets,
        sourceAmountRial: "1",
      }),
    );
  };
  return { businessId, owner, partyId, projectId, campaignId, post, preview };
}

describe("posted campaign expense allocation preview", () => {
  it("reads exact posted facts and leaves the ledger and dimensions untouched", async () => {
    const f = await fixture();
    const source = await f.post();
    const before = (
      await db.query(
        `SELECT to_jsonb(l) AS facts FROM journal_lines l WHERE entry_id=$1 ORDER BY id`,
        [source.entryId],
      )
    ).rows;
    const result = await f.preview(source.lineId);
    expect(result.previewOnly).toBe(true);
    expect(result.sourceAmountRial).toBe("9007199254740993");
    expect(
      BigInt(result.allocations[0].amountRial) + BigInt(result.unassignedRial),
    ).toBe(9007199254740993n);
    expect(result.sourceEntryId).toBe(source.entryId);
    expect(
      (
        await db.query(
          `SELECT to_jsonb(l) AS facts FROM journal_lines l WHERE entry_id=$1 ORDER BY id`,
          [source.entryId],
        )
      ).rows,
    ).toEqual(before);
    expect(await f.preview(source.lineId)).toEqual(result);
  });
  it("does not turn pass-through assets or unscoped entries into campaign expense", async () => {
    const f = await fixture();
    for (const source of [
      await f.post("100", "1270"),
      await f.post("100", "5197", null),
    ]) {
      await expect(f.preview(source.lineId)).rejects.toThrow(
        "allocation_source_not_found",
      );
    }
  });
  it("rejects missing, different-tenant and same-tenant different-client campaigns generically", async () => {
    const f = await fixture();
    const other = await fixture();
    const source = await f.post("100");
    const otherParty = (
      await db.query(
        `INSERT INTO parties(business_id,name) VALUES($1,'مشتری دیگر') RETURNING id`,
        [f.businessId],
      )
    ).rows[0].id;
    const otherCampaign = (
      await db.query(
        `INSERT INTO agency_client_campaigns(business_id,campaign_number,party_id,project_id,title) VALUES($1,'CA-2',$2,$3,'دیگر') RETURNING id`,
        [f.businessId, otherParty, f.projectId],
      )
    ).rows[0].id;
    for (const campaignId of [randomUUID(), other.campaignId, otherCampaign]) {
      await expect(
        f.preview(source.lineId, [{ campaignId, basisPoints: 10000 }]),
      ).rejects.toThrow("allocation_campaign_not_found");
    }
    await expect(f.preview((await other.post("100")).lineId)).rejects.toThrow(
      "allocation_source_not_found",
    );
  });
  it("rejects same-client campaigns linked to a different project", async () => {
    const f = await fixture();
    const project = (
      await db.query(
        `INSERT INTO ai_projects(business_id,name,created_by,owner_user_id,party_id) VALUES($1,'دیگر',$2::text,$2::uuid,$3) RETURNING id`,
        [f.businessId, f.owner.actorUserId, f.partyId],
      )
    ).rows[0].id;
    const campaignId = (
      await db.query(
        `INSERT INTO agency_client_campaigns(business_id,campaign_number,party_id,project_id,title) VALUES($1,'CA-2',$2,$3,'دیگر') RETURNING id`,
        [f.businessId, f.partyId, project],
      )
    ).rows[0].id;
    await expect(
      f.preview((await f.post("100")).lineId, [
        { campaignId, basisPoints: 10000 },
      ]),
    ).rejects.toThrow("allocation_campaign_not_found");
  });
  it("protects project existence from nonmembers", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      f.preview((await f.post("100")).lineId, [], {
        ...f.owner,
        actorUserId: other.owner.actorUserId,
      }),
    ).rejects.toThrow("project_not_found");
  });
  it("rejects a reversed original rather than recalculate historical attribution", async () => {
    const f = await fixture();
    const source = await f.post("100");
    const ledger = await import("../src/lib/ledger-service");
    const reversalId = await dbLib.withTenantTransaction(
      f.businessId,
      (client) =>
        ledger.postExactMirrorEntry(client, {
          businessId: f.businessId,
          locationId: null,
          projectId: f.projectId,
          originalEntryId: source.entryId!,
          sourceType: "manual_reversal",
          sourceId: randomUUID(),
          postingKind: "reversal",
          memo: "برگشت",
          createdBy: f.owner.actorUserId,
          entryDate: "2026-10-20",
        }),
    );
    const reversalLine = (
      await db.query(
        `SELECT id::text FROM journal_lines WHERE entry_id=$1 ORDER BY id LIMIT 1`,
        [reversalId],
      )
    ).rows[0].id;
    await expect(f.preview(reversalLine)).rejects.toThrow(
      "allocation_source_not_found",
    );
    await expect(f.preview(source.lineId)).rejects.toThrow(
      "allocation_source_not_found",
    );
  });
  it("does not allocate the payable credit leg or treat an empty proposal as full attribution", async () => {
    const f = await fixture();
    const source = await f.post("100");
    const creditId = (
      await db.query(
        `SELECT id::text FROM journal_lines WHERE entry_id=$1 AND credit>0`,
        [source.entryId],
      )
    ).rows[0].id;
    await expect(f.preview(creditId)).rejects.toThrow(
      "allocation_source_not_found",
    );
    expect(await f.preview(source.lineId, [])).toMatchObject({
      allocations: [],
      unassignedRial: "100",
      unassignedBasisPoints: 10000,
    });
  });
  it("does not let a project viewer preview allocation decisions", async () => {
    const f = await fixture();
    const source = await f.post("100");
    await db.query(
      `UPDATE workspace_members SET role='viewer' WHERE project_id=$1 AND user_id=$2`,
      [f.projectId, f.owner.actorUserId],
    );
    await expect(f.preview(source.lineId)).rejects.toThrow(
      "insufficient_project_role",
    );
  });
});
