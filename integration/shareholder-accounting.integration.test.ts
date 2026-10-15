/**
 * Shareholder Accounting (#864), exercised against PostgreSQL.
 *
 * This is deliberately a consumer of the existing ledger and close: the
 * fixture supplies an already-closed year's closing entry, and assertions
 * prove that shareholder postings use its retained-earnings result rather than
 * adding a second close path or a parallel equity balance.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { jalaliToIsoDate, isoDateToJalali } from "../src/lib/jalali";
import { roleBasePermissions } from "../src/lib/permissions";
import { SYNC_EVENT_REGISTRY, siteSkipsPulledEvent, syncEventDefinition } from "../src/lib/sync-event-registry";
import type { ShareholderActor, OwnershipChangeInput } from "../src/lib/shareholder-service";
import type { Role } from "../src/lib/auth";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let businessDay: typeof import("../src/lib/business-day-service");
let shareholders: typeof import("../src/lib/shareholder-service");
let originalDeploymentRole: string | undefined;

interface Fixture {
  businessId: string;
  ownerId: string;
  accountantId: string;
  partyA: string;
  partyB: string;
  cashAccountId: string;
  closedFiscalYearId: string;
  openFiscalYearId: string;
  today: string;
  currentJalaliYear: number;
  priorJalaliYear: number;
  priorYearStart: string;
  priorYearEnd: string;
  currentYearStart: string;
  currentYearEnd: string;
  transferOn: string;
  snapshotOn: string;
  postSnapshotChangeOn: string;
}

let fixture: Fixture;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  return urlFor("postgres");
}

function isoDate(jalaliYear: number, month: number, day: number): string {
  return jalaliToIsoDate(jalaliYear, month, day);
}

function dayBefore(iso: string): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function actor(userId: string, role: "owner" | "accountant"): ShareholderActor {
  return {
    userId,
    role: role as Role,
    permissions: new Set(roleBasePermissions(role)),
  };
}

async function insertAccount(
  businessId: string,
  row: { code: string; name: string; type: string; level: string; parentCode?: string; isContra?: boolean },
  ids: Map<string, string>,
): Promise<void> {
  const parentId = row.parentCode ? ids.get(row.parentCode) : null;
  const result = await db.query<{ id: string }>(
    `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
     VALUES ($1, $2, $3, $4, $5::account_type, $6::account_level, $7)
     RETURNING id`,
    [businessId, parentId, row.code, row.name, row.type, row.level, row.isContra ?? false],
  );
  ids.set(row.code, result.rows[0].id);
}

async function createFixture(): Promise<Fixture> {
  const businessResult = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Shareholder ${randomUUID().slice(0, 8)}`, `shareholder-${randomUUID().slice(0, 8)}`],
  );
  const businessId = businessResult.rows[0].id;
  await db.query(
    `INSERT INTO locations (business_id, name, timezone, is_active)
     VALUES ($1, 'Main', 'Asia/Tehran', true)`,
    [businessId],
  );
  const ownerResult = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'owner', 'Owner', 'test') RETURNING id`,
    [businessId],
  );
  const accountantResult = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'accountant', 'Accountant', 'test') RETURNING id`,
    [businessId],
  );
  const ownerId = ownerResult.rows[0].id;
  const accountantId = accountantResult.rows[0].id;

  const accountIds = new Map<string, string>();
  const accountRows = [
    { code: "1000", name: "Assets", type: "asset", level: "group" },
    { code: "2000", name: "Liabilities", type: "liability", level: "group" },
    { code: "3000", name: "Equity", type: "equity", level: "group" },
    { code: "4000", name: "Revenue", type: "revenue", level: "group" },
    { code: "1100", name: "Cash", type: "asset", level: "kol", parentCode: "1000" },
    { code: "2510", name: "Shareholder loans payable", type: "liability", level: "kol", parentCode: "2000" },
    { code: "2520", name: "Shareholder distributions payable", type: "liability", level: "kol", parentCode: "2000" },
    { code: "3100", name: "Share capital", type: "equity", level: "kol", parentCode: "3000" },
    { code: "3150", name: "Additional paid-in capital", type: "equity", level: "kol", parentCode: "3000" },
    { code: "3200", name: "Owner withdrawals", type: "equity", level: "kol", parentCode: "3000", isContra: true },
    { code: "3800", name: "Retained earnings", type: "equity", level: "kol", parentCode: "3000" },
    { code: "4300", name: "Sales revenue", type: "revenue", level: "kol", parentCode: "4000" },
  ];
  for (const row of accountRows) await insertAccount(businessId, row, accountIds);

  const partyResult = await db.query<{ id: string; name: string }>(
    `INSERT INTO parties (business_id, name, role)
     VALUES ($1, 'Shareholder A', 'customer'), ($1, 'Shareholder B', 'supplier')
     RETURNING id, name`,
    [businessId],
  );
  const partyA = partyResult.rows.find((row) => row.name === "Shareholder A")!.id;
  const partyB = partyResult.rows.find((row) => row.name === "Shareholder B")!.id;

  const today = await businessDay.businessToday(businessId);
  const todayParts = isoDateToJalali(today);
  if (!todayParts) throw new Error("test_business_day_outside_supported_jalali_range");
  const currentJalaliYear = todayParts.jy;
  const priorJalaliYear = currentJalaliYear - 1;
  const currentYearStart = isoDate(currentJalaliYear, 1, 1);
  const currentYearEnd = dayBefore(isoDate(currentJalaliYear + 1, 1, 1));
  const priorYearStart = isoDate(priorJalaliYear, 1, 1);
  const priorYearEnd = dayBefore(currentYearStart);

  const closedYearResult = await db.query<{ id: string }>(
    `INSERT INTO fiscal_years (business_id, label, starts_on, ends_on)
     VALUES ($1, $2, $3::date, $4::date) RETURNING id`,
    [businessId, String(priorJalaliYear).padStart(4, "0"), priorYearStart, priorYearEnd],
  );
  const closedFiscalYearId = closedYearResult.rows[0].id;
  const openYearResult = await db.query<{ id: string }>(
    `INSERT INTO fiscal_years (business_id, label, starts_on, ends_on)
     VALUES ($1, $2, $3::date, $4::date) RETURNING id`,
    [businessId, String(currentJalaliYear).padStart(4, "0"), currentYearStart, currentYearEnd],
  );
  const openFiscalYearId = openYearResult.rows[0].id;
  await db.query(
    `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on)
     VALUES ($1, $2, $3, $4::date, $5::date), ($1, $6, $7, $8::date, $9::date)`,
    [
      businessId,
      closedFiscalYearId,
      `${priorJalaliYear}-test-period`,
      priorYearStart,
      priorYearEnd,
      openFiscalYearId,
      `${currentJalaliYear}-test-period`,
      currentYearStart,
      currentYearEnd,
    ],
  );

  // An existing, balanced closing entry is the distribution's only profit
  // source. This fixture doesn't run or reproduce the fiscal-close workflow.
  const closeResult = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id, created_by)
     VALUES ($1, NULL, $2::date, 'Existing year-end close', 'closing', $3, $4)
     RETURNING id`,
    [businessId, priorYearEnd, closedFiscalYearId, ownerId],
  );
  const closingEntryId = closeResult.rows[0].id;
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     VALUES ($1, $2, 10000, 0), ($1, $3, 0, 10000)`,
    [closingEntryId, accountIds.get("4300"), accountIds.get("3800")],
  );
  await db.query(
    `UPDATE fiscal_years SET closed_at = now(), closed_by = $2 WHERE id = $1`,
    [closedFiscalYearId, ownerId],
  );

  return {
    businessId,
    ownerId,
    accountantId,
    partyA,
    partyB,
    cashAccountId: accountIds.get("1100")!,
    closedFiscalYearId,
    openFiscalYearId,
    today,
    currentJalaliYear,
    priorJalaliYear,
    priorYearStart,
    priorYearEnd,
    currentYearStart,
    currentYearEnd,
    transferOn: isoDate(priorJalaliYear, 7, 1),
    snapshotOn: isoDate(priorJalaliYear, 9, 1),
    postSnapshotChangeOn: isoDate(priorJalaliYear, 10, 1),
  };
}

async function addOwnershipHistory(f: Fixture): Promise<{ shareholderAId: string; shareholderBId: string; eventIds: string[] }> {
  const owner = actor(f.ownerId, "owner");
  const transferGroupId = randomUUID();
  const events: OwnershipChangeInput[] = [
    {
      partyId: f.partyA,
      eventType: "shareholder_added",
      effectiveOn: f.priorYearStart,
      ownershipPercent: "60",
      shareUnits: "60",
      reason: "Founding ownership register",
      sourceReference: "FOUNDING-1",
    },
    {
      partyId: f.partyB,
      eventType: "shareholder_added",
      effectiveOn: f.priorYearStart,
      ownershipPercent: "40",
      shareUnits: "40",
      reason: "Founding ownership register",
      sourceReference: "FOUNDING-1",
    },
    {
      partyId: f.partyA,
      eventType: "ownership_transfer_out",
      effectiveOn: f.transferOn,
      ownershipPercent: "50",
      transferPercent: "10",
      transferGroupId,
      reason: "Documented share transfer",
      sourceReference: "TRANSFER-1",
    },
    {
      partyId: f.partyB,
      eventType: "ownership_transfer_in",
      effectiveOn: f.transferOn,
      ownershipPercent: "50",
      transferPercent: "10",
      transferGroupId,
      reason: "Documented share transfer",
      sourceReference: "TRANSFER-1",
    },
  ];
  const result = await shareholders.recordOwnershipEvents(f.businessId, owner, events, "ownership-history-1");
  const rows = await db.query<{ id: string; party_id: string }>(
    `SELECT sa.id, sa.party_id FROM shareholder_accounts sa
      WHERE sa.business_id = $1 AND sa.party_id = ANY($2::uuid[])`,
    [f.businessId, [f.partyA, f.partyB]],
  );
  return {
    shareholderAId: rows.rows.find((row) => row.party_id === f.partyA)!.id,
    shareholderBId: rows.rows.find((row) => row.party_id === f.partyB)!.id,
    eventIds: result.eventIds,
  };
}

beforeAll(async () => {
  originalDeploymentRole = process.env.DEPLOYMENT_ROLE;
  process.env.DEPLOYMENT_ROLE = "central";
  databaseName = `pos_shareholders_${randomUUID().replaceAll("-", "")}`;
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
  businessDay = await import("../src/lib/business-day-service");
  shareholders = await import("../src/lib/shareholder-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

beforeEach(async () => {
  fixture = await createFixture();
}, 30_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (originalDeploymentRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = originalDeploymentRole;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("effective-dated shareholder ownership and audit", () => {
  it("requires retroactive permission, validates atomic transfers, and refuses edits to history", async () => {
    const accountant = actor(fixture.accountantId, "accountant");
    const pastEvent: OwnershipChangeInput = {
      partyId: fixture.partyA,
      eventType: "shareholder_added",
      effectiveOn: fixture.priorYearStart,
      ownershipPercent: "100",
      reason: "Backdated register",
    };
    await expect(
      shareholders.recordOwnershipEvents(fixture.businessId, accountant, [pastEvent], "retro-denied"),
    ).rejects.toMatchObject({ message: "retroactive_permission_required", status: 403 });

    const ownership = await addOwnershipHistory(fixture);
    const owner = actor(fixture.ownerId, "owner");
    const transferGroupId = (await db.query<{ transfer_group_id: string }>(
      "SELECT transfer_group_id FROM shareholder_events WHERE id = $1",
      [ownership.eventIds[2]],
    )).rows[0].transfer_group_id;
    const repeated = await shareholders.recordOwnershipEvents(
      fixture.businessId,
      owner,
      [
        {
          partyId: fixture.partyA,
          eventType: "shareholder_added",
          effectiveOn: fixture.priorYearStart,
          ownershipPercent: "60",
          shareUnits: "60",
          reason: "Founding ownership register",
          sourceReference: "FOUNDING-1",
        },
        {
          partyId: fixture.partyB,
          eventType: "shareholder_added",
          effectiveOn: fixture.priorYearStart,
          ownershipPercent: "40",
          shareUnits: "40",
          reason: "Founding ownership register",
          sourceReference: "FOUNDING-1",
        },
        {
          partyId: fixture.partyA,
          eventType: "ownership_transfer_out",
          effectiveOn: fixture.transferOn,
          ownershipPercent: "50",
          transferPercent: "10",
          transferGroupId,
          reason: "Documented share transfer",
          sourceReference: "TRANSFER-1",
        },
        {
          partyId: fixture.partyB,
          eventType: "ownership_transfer_in",
          effectiveOn: fixture.transferOn,
          ownershipPercent: "50",
          transferPercent: "10",
          transferGroupId,
          reason: "Documented share transfer",
          sourceReference: "TRANSFER-1",
        },
      ],
      "ownership-history-1",
    );
    expect(repeated).toMatchObject({ eventIds: ownership.eventIds, replayed: true });

    await shareholders.updateOwnershipTotalPolicy(fixture.businessId, owner, "exactly_100");
    await expect(
      shareholders.recordOwnershipEvents(
        fixture.businessId,
        owner,
        [{
          partyId: fixture.partyA,
          eventType: "ownership_changed",
          effectiveOn: fixture.priorYearStart,
          ownershipPercent: "60",
          reason: "Duplicate effective date",
        }],
      ),
    ).rejects.toMatchObject({ message: "duplicate_shareholder_event_date", status: 409 });

    const workspace = await shareholders.loadShareholderWorkspace(fixture.businessId, fixture.snapshotOn);
    expect(workspace.totalPolicy).toBe("exactly_100");
    expect(workspace.register.map((row) => [row.partyId, row.ownershipPercent]).sort()).toEqual(
      [[fixture.partyA, "50.000000"], [fixture.partyB, "50.000000"]].sort(),
    );
    expect(workspace.events.filter((row) => row.transferGroupId)).toHaveLength(2);
    expect(workspace.events.every((row) => row.reason && row.createdByName === "Owner")).toBe(true);

    await expect(
      db.query("UPDATE shareholder_events SET reason = 'rewritten history' WHERE id = $1", [ownership.eventIds[0]]),
    ).rejects.toMatchObject({ code: "55000" });

    // The unique index and deferred pairing constraint also protect callers
    // that bypass the service and issue SQL directly.
    await expect(db.query(
      `INSERT INTO shareholder_events (business_id, shareholder_id, event_type, effective_on,
          ownership_percent, reason, created_by)
       VALUES ($1, $2, 'ownership_changed', $3::date, 60, 'duplicate', $4)`,
      [fixture.businessId, ownership.shareholderAId, fixture.priorYearStart, fixture.ownerId],
    )).rejects.toMatchObject({ code: "23505" });

    const invalidGroup = randomUUID();
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO shareholder_events (business_id, shareholder_id, event_type, effective_on,
            ownership_percent, transfer_percent, transfer_group_id, reason, created_by)
         VALUES ($1, $2, 'ownership_transfer_out', $3::date, 40, 10, $4, 'unpaired transfer', $5)`,
        [fixture.businessId, ownership.shareholderAId, fixture.postSnapshotChangeOn, invalidGroup, fixture.ownerId],
      );
      await expect(db.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await db.query("ROLLBACK").catch(() => {});
    }

    const audits = await db.query<{ action: string; payload: { ownershipBefore?: string; ownershipAfter?: string } }>(
      `SELECT action, payload FROM audit_log
        WHERE business_id = $1 AND action = 'shareholder.ownership_event.recorded'`,
      [fixture.businessId],
    );
    expect(audits.rows).toHaveLength(4);
    expect(audits.rows.some((row) => row.payload.ownershipAfter === "60")).toBe(true);
  }, 30_000);
});

describe("capital, closed-year distribution and the shareholder subledger", () => {
  it("posts and reverses immutable GL facts, freezes distributions, and emits acknowledgement-only sync events", async () => {
    const owner = actor(fixture.ownerId, "owner");
    const accountant = actor(fixture.accountantId, "accountant");
    const ownership = await addOwnershipHistory(fixture);

    const contributionInput = {
      partyId: fixture.partyA,
      eventType: "capital_contribution" as const,
      capitalClass: "equity" as const,
      amountRial: "20,000",
      paymentAccountId: fixture.cashAccountId,
      effectiveOn: fixture.today,
      sourceReference: "CAPITAL-1",
      reason: "Initial capital contribution",
    };
    const contribution = await shareholders.recordCapitalMovement(
      fixture.businessId,
      accountant,
      contributionInput,
      "capital-idempotency-1",
    );
    const contributionReplay = await shareholders.recordCapitalMovement(
      fixture.businessId,
      accountant,
      contributionInput,
      "capital-idempotency-1",
    );
    expect(contributionReplay).toMatchObject({ ...contribution, replayed: true });

    const capitalLines = await db.query<{ code: string; debit: string; credit: string; party_id: string | null }>(
      `SELECT a.code, jl.debit::text, jl.credit::text, jl.party_id
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY a.code`,
      [contribution.journalEntryId],
    );
    expect(capitalLines.rows).toEqual([
      expect.objectContaining({ code: "1100", debit: "20000", credit: "0", party_id: null }),
      expect.objectContaining({ code: "3100", debit: "0", credit: "20000", party_id: fixture.partyA }),
    ]);

    const capitalReversal = await shareholders.reverseCapitalMovement(
      fixture.businessId,
      owner,
      contribution.eventId,
      "capital-reversal-1",
    );
    const reversedCapitalLines = await db.query<{ code: string; party_id: string | null }>(
      `SELECT a.code, jl.party_id FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1`,
      [capitalReversal.journalEntryId],
    );
    expect(reversedCapitalLines.rows.find((row) => row.code === "3100")?.party_id).toBe(fixture.partyA);

    const distributionInput = {
      fiscalYearId: fixture.closedFiscalYearId,
      snapshotOn: fixture.snapshotOn,
      taxAdjustmentRial: "0",
      reserveAdjustmentRial: "0",
      manualAdjustmentRial: "0",
    };
    await expect(
      shareholders.createShareholderDistribution(
        fixture.businessId,
        accountant,
        { ...distributionInput, fiscalYearId: fixture.openFiscalYearId, snapshotOn: fixture.today },
        "distribution-open-year",
      ),
    ).rejects.toMatchObject({ message: "fiscal_year_not_closed", status: 409 });
    await expect(
      shareholders.createShareholderDistribution(
        fixture.businessId,
        accountant,
        { ...distributionInput, taxAdjustmentRial: "1" },
        "distribution-missing-adjustment-reason",
      ),
    ).rejects.toMatchObject({ message: "adjustment_reason_required", status: 400 });

    const created = await shareholders.createShareholderDistribution(
      fixture.businessId,
      accountant,
      distributionInput,
      "distribution-idempotency-1",
    );
    expect(created).toMatchObject({ replayed: false, distribution: {
      status: "draft",
      sourceProfitRial: "10000",
      distributableRial: "10000",
      createdById: fixture.accountantId,
    } });
    const createdReplay = await shareholders.createShareholderDistribution(
      fixture.businessId,
      accountant,
      distributionInput,
      "distribution-idempotency-1",
    );
    expect(createdReplay).toMatchObject({ replayed: true, distribution: { id: created.distribution.id } });

    // This later effective change must not rewrite the already-frozen draft.
    await shareholders.recordOwnershipEvents(fixture.businessId, owner, [
      {
        partyId: fixture.partyA,
        eventType: "ownership_changed",
        effectiveOn: fixture.postSnapshotChangeOn,
        ownershipPercent: "60",
        reason: "Later ownership amendment",
      },
      {
        partyId: fixture.partyB,
        eventType: "ownership_changed",
        effectiveOn: fixture.postSnapshotChangeOn,
        ownershipPercent: "40",
        reason: "Later ownership amendment",
      },
    ]);
    const snapshotWorkspace = await shareholders.loadShareholderWorkspace(
      fixture.businessId,
      fixture.snapshotOn,
      created.distribution.id,
    );
    expect(snapshotWorkspace.register.map((row) => [row.partyId, row.ownershipPercent]).sort()).toEqual(
      [[fixture.partyA, "50.000000"], [fixture.partyB, "50.000000"]].sort(),
    );
    expect(snapshotWorkspace.distributionLines.map((row) => [row.partyId, row.ownershipPercent, row.allocatedRial]).sort()).toEqual(
      [[fixture.partyA, "50.000000", "5000"], [fixture.partyB, "50.000000", "5000"]].sort(),
    );

    await expect(
      shareholders.approveShareholderDistribution(fixture.businessId, accountant, created.distribution.id),
    ).rejects.toMatchObject({ message: "distribution_creator_cannot_approve", status: 403 });
    await shareholders.approveShareholderDistribution(fixture.businessId, owner, created.distribution.id);
    const posted = await shareholders.postShareholderDistribution(fixture.businessId, accountant, created.distribution.id);
    expect(posted.distribution.status).toBe("posted");

    const distributionGl = await db.query<{ code: string; debit: string; credit: string; party_id: string | null }>(
      `SELECT a.code, jl.debit::text, jl.credit::text, jl.party_id
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 AND a.code IN ('2520', '3800') ORDER BY a.code, jl.party_id`,
      [posted.journalEntryId],
    );
    expect(distributionGl.rows).toHaveLength(4);
    expect(distributionGl.rows.every((row) => row.party_id !== null)).toBe(true);
    expect(distributionGl.rows.filter((row) => row.code === "3800").reduce((sum, row) => sum + BigInt(row.debit), 0n)).toBe(10000n);
    expect(distributionGl.rows.filter((row) => row.code === "2520").reduce((sum, row) => sum + BigInt(row.credit), 0n)).toBe(10000n);

    const selected = snapshotWorkspace.distributionLines[0];
    const paymentInput = {
      shareholderId: selected.shareholderId,
      amountRial: "2500",
      paidOn: fixture.today,
      paymentAccountId: fixture.cashAccountId,
      note: "First partial distribution payment",
    };
    const payment = await shareholders.payShareholderDistribution(
      fixture.businessId,
      accountant,
      created.distribution.id,
      paymentInput,
      "payment-idempotency-1",
    );
    expect(await shareholders.payShareholderDistribution(
      fixture.businessId,
      accountant,
      created.distribution.id,
      paymentInput,
      "payment-idempotency-1",
    )).toMatchObject({ ...payment, replayed: true });
    await expect(
      shareholders.payShareholderDistribution(
        fixture.businessId,
        accountant,
        created.distribution.id,
        { ...paymentInput, amountRial: "6000" },
        "payment-over-allocation",
      ),
    ).rejects.toMatchObject({ message: "payment_exceeds_shareholder_outstanding", status: 409 });

    const partiallyPaid = await shareholders.loadShareholderWorkspace(
      fixture.businessId,
      fixture.today,
      created.distribution.id,
    );
    expect(partiallyPaid.distributionLines).toHaveLength(2);
    expect(partiallyPaid.payments).toHaveLength(1);
    expect(partiallyPaid.distributions.find((row) => row.id === created.distribution.id)?.status).toBe("partially_paid");

    const paymentReversal = await shareholders.reverseShareholderDistributionPayment(
      fixture.businessId,
      owner,
      payment.paymentId,
      "payment-reversal-1",
    );
    const distributionReversal = await shareholders.reverseShareholderDistribution(
      fixture.businessId,
      owner,
      created.distribution.id,
      "distribution-reversal-1",
    );
    expect(distributionReversal.distribution.status).toBe("reversed");
    expect(distributionReversal.distribution.reversalEntryId).toBe(distributionReversal.journalEntryId);

    const mirroredLines = await db.query<{ entry_id: string; code: string; debit: string; credit: string; party_id: string | null }>(
      `SELECT jl.entry_id, a.code, jl.debit::text, jl.credit::text, jl.party_id
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = ANY($1::uuid[]) AND a.code IN ('2520', '3800')`,
      [[paymentReversal.journalEntryId, distributionReversal.journalEntryId]],
    );
    expect(mirroredLines.rows).toHaveLength(5);
    expect(mirroredLines.rows.every((row) => row.party_id !== null)).toBe(true);

    const finalWorkspace = await shareholders.loadShareholderWorkspace(
      fixture.businessId,
      fixture.today,
      created.distribution.id,
    );
    expect(finalWorkspace.distributionLines).toHaveLength(2);
    expect(finalWorkspace.payments.map((row) => row.paymentType).sort()).toEqual(["payment", "reversal"]);
    expect(finalWorkspace.distributions.find((row) => row.id === created.distribution.id)).toMatchObject({
      status: "reversed",
      paidRial: "0",
      outstandingRial: "10000",
    });
    const payable = finalWorkspace.glReconciliation.find((row) => row.accountCode === "2520");
    expect(payable).toMatchObject({ ledgerBalanceRial: "0", attributedBalanceRial: "0", unattributedBalanceRial: "0" });

    const syncRows = await db.query<{ event_type: string; schema_version: number; actor_role: string; scope: string }>(
      `SELECT event_type, schema_version, actor_role, scope FROM sync_events
        WHERE business_id = $1 AND event_type LIKE 'shareholder.%' ORDER BY event_type`,
      [fixture.businessId],
    );
    expect(syncRows.rows.map((row) => row.event_type).sort()).toEqual([
      "shareholder.capital.recorded",
      "shareholder.capital.reversed",
      "shareholder.distribution.payment.recorded",
      "shareholder.distribution.payment.reversed",
      "shareholder.distribution.posted",
      "shareholder.distribution.reversed",
    ]);
    for (const row of syncRows.rows) {
      expect(row.scope).toBe("business");
      expect(row.actor_role).toMatch(/^(owner|accountant)$/);
      const definition = syncEventDefinition(row.event_type, row.schema_version);
      expect(definition).toBeDefined();
      expect(siteSkipsPulledEvent(definition!)).toBe(true);
    }
    expect(SYNC_EVENT_REGISTRY.filter((entry) => entry.effectClass === "shareholder_accounting")).toHaveLength(6);

    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE business_id = $1 AND action LIKE 'shareholder.%'`,
      [fixture.businessId],
    );
    expect(Number(audit.rows[0].count)).toBeGreaterThanOrEqual(12);
  }, 30_000);
});
