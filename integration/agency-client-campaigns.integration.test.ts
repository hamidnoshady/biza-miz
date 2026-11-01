/**
 * The campaign as it ran, against a real database (issue #1128 §A + §C).
 *
 * `agency-campaign.test.ts` pins the vocabulary and the arithmetic; 0278's
 * constraints are pinned by 66 raw-SQL assertions. What only a database can show
 * is whether the service and the schema agree — the class of bug that produced
 * 0276's fix, where a migration refused to withdraw a line-less draft while the
 * service allowed it and each was self-consistent:
 *
 *   * that a patch carrying one field does not clear the others, which is the
 *     `undefined`-versus-empty distinction the normalisers exist for;
 *   * that a status change the service permits is one the triggers permit, in both
 *     directions, including the window a status implies;
 *   * that a closed campaign is refused by the *database* when a race gets past the
 *     service's read, which is why the service takes no row lock;
 *   * that §A's rule holds here too — «مهر فود»'s campaign cannot carry
 *     «مهر کیمیا»'s brief or proposal, and the refusal arrives as the trigger's
 *     SQLSTATE rather than as a service error class;
 *   * that the per-brand count the customer file's organisation card was missing in
 *     wave 8 now exists and agrees with the rows behind it.
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
let provisioning: typeof import("../src/lib/business-provisioning");
let campaigns: typeof import("../src/lib/agency-campaign-service");
let briefs: typeof import("../src/lib/agency-brief-service");
let proposals: typeof import("../src/lib/agency-proposal-service");

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
  databaseName = `agency_campaign_${randomUUID().replaceAll("-", "")}`;

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
  campaigns = await import("../src/lib/agency-campaign-service");
  briefs = await import("../src/lib/agency-brief-service");
  proposals = await import("../src/lib/agency-proposal-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

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

/* ------------------------------------------------------------------ fixtures */

let seq = 0;
const ACTOR = { userId: randomUUID(), name: "مالک" };
const TODAY = "2026-05-15";

async function provisionAgency(): Promise<string> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس کمپین ${seq}`,
    ownerName: "مالک",
    email: `agency-camp-${seq}@example.test`,
    password: "correct-horse",
    subdomain: `agcamp${seq}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  return result.businessId;
}

async function seedParty(businessId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO parties (id, business_id, name) VALUES ($1,$2,$3)`, [
    id,
    businessId,
    name,
  ]);
  return id;
}

/** A group with two brands, so the §A "multiple brands" case is the fixture. */
async function agencyWithBrands() {
  const businessId = await provisionAgency();
  const group = await seedParty(businessId, "گروه صنعتی مهر");
  const food = await seedParty(businessId, "مهر فود");
  const kimia = await seedParty(businessId, "مهر کیمیا");
  await db.query(
    `INSERT INTO crm_party_relationships (business_id, from_party_id, to_party_id, kind)
     VALUES ($1,$2,$3,'parent_organization'), ($1,$4,$2,'parent_organization')`,
    [businessId, group, food, kimia],
  );
  return { businessId, group, food, kimia };
}

const codeOf = (error: unknown): string => {
  if (error instanceof campaigns.AgencyCampaignError) return error.code;
  // A refusal from 0278 arrives as a Postgres error, and its SQLSTATE is the answer
  // worth asserting: the service did not invent a code for a rule the database owns.
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : String(error);
};

/* --------------------------------------------------------------------- tests */

describe("the client campaign against a real database (issue #1128 §A + §C)", () => {
  it("creates a campaign, numbers it in its own series, and defaults what was not said", async () => {
    const { businessId, food } = await agencyWithBrands();
    const created = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین بهارهٔ فود",
    });

    expect(created.campaignNumber).toBe("CA-001");
    expect(created.status).toBe("planned");
    expect(created.clientName).toBe("مهر فود");
    expect(created.channels).toEqual([]);
    expect(created.spendRial).toBe(0);
    expect(created.budgetRial).toBeNull();
    expect(created.revenueRial).toBeNull();
    expect(created.metricsSource).toBe("manual");
    expect(created.createdByName).toBe("مالک");
    expect(created.editable).toBe(true);
    expect(created.deletable).toBe(true);
    expect(created.actions).toEqual(["start", "cancel"]);

    const second = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین دوم",
    });
    expect(second.campaignNumber).toBe("CA-002");
  });

  it("refuses what a member can get wrong, in words rather than as a database error", async () => {
    const { businessId, food } = await agencyWithBrands();
    const attempt = async (input: Parameters<typeof campaigns.createAgencyCampaign>[2]) =>
      campaigns.createAgencyCampaign(businessId, ACTOR, { partyId: food, title: "x", ...input }).then(
        () => null,
        (error: unknown) => codeOf(error),
      );

    expect(await attempt({ title: "   " })).toBe("title_required");
    // A party id that is not a uuid never reaches the database, so the service
    // answers. One that *is* a uuid but is nobody's is the reference trigger's
    // answer, and arrives as its SQLSTATE — see the cross-tenant test below.
    expect(await attempt({ partyId: "not-a-uuid" })).toBe("client_required");
    expect(await attempt({ partyId: randomUUID() })).toBe("23514");
    expect(await attempt({ channels: ["billboard"] })).toBe("invalid_channel");
    expect(await attempt({ startDate: "1406-03-01" })).toBe("invalid_date");
    expect(await attempt({ startDate: "2026-02-31" })).toBe("invalid_date");
    expect(await attempt({ startDate: "2026-05-10", endDate: "2026-05-01" })).toBe("window_reversed");
    expect(await attempt({ impressions: 10, clicks: 11 })).toBe("clicks_exceed_impressions");
    expect(await attempt({ budgetRial: 0 })).toBe("invalid_metric");
    expect(await attempt({ spendRial: -5 })).toBe("invalid_metric");
    expect(await attempt({ metricsSource: "platform" })).toBe("invalid_metrics_source");
    expect(await attempt({ briefId: "not-a-uuid" })).toBe("invalid_reference");
    expect(await attempt({ title: "ا".repeat(201) })).toBe("text_too_long");
  });

  it("records an overspend rather than refusing it, and reports the overrun as a state", async () => {
    const { businessId, food } = await agencyWithBrands();
    const created = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین پرهزینه",
      startDate: "2026-03-01",
      budgetRial: 500_000,
      spendRial: 900_000,
    });

    // 0278 deliberately does not CHECK spend against budget: the true figure has to
    // be storable, or it ends up in a note no report can read.
    expect(created.spendRial).toBe(900_000);
    expect(created.budget).toEqual({ state: "over", differenceRial: 400_000, percentOfBudget: 180 });
  });

  it("derives the four ratios from stored figures, and leaves a ratio with no denominator null", async () => {
    const { businessId, food } = await agencyWithBrands();
    const full = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین با آمار",
      spendRial: 400_000,
      impressions: 1_000,
      clicks: 40,
      leadsGenerated: 12,
      conversions: 3,
      revenueRial: 1_200_000,
    });
    expect(full.metrics).toEqual({ ctrPct: 4, cplRial: 33_333, cpaRial: 133_333, roas: 3 });

    // The rule that matters: no leads means no CPL, not a CPL of zero. §C's word for
    // a zero here is "fake".
    const noLeads = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین بدون سرنخ",
      spendRial: 400_000,
      impressions: 1_000,
      clicks: 40,
    });
    expect(noLeads.metrics).toEqual({ ctrPct: 4, cplRial: null, cpaRial: null, roas: null });

    // "We do not know the revenue yet" and "the revenue was zero" are both null
    // ROAS, because neither supports the claim a ROAS makes.
    const zeroRevenue = await campaigns.updateAgencyCampaign(businessId, noLeads.id, ACTOR, {
      revenueRial: 0,
    });
    expect(zeroRevenue.revenueRial).toBe(0);
    expect(zeroRevenue.metrics.roas).toBeNull();
  });

  it("a list row carries the same figures as the record opened from it", async () => {
    const { businessId, food } = await agencyWithBrands();
    const created = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین فهرست",
      spendRial: 300_000,
      impressions: 600,
      clicks: 30,
      leadsGenerated: 6,
      budgetRial: 200_000,
    });

    const list = await campaigns.listAgencyCampaigns(businessId, { q: "فهرست" }, { todayIso: TODAY });
    expect(list).toHaveLength(1);
    const row = list[0];
    // The lesson 0276's list taught: a list must not print a figure it did not read.
    // These are computed from columns the list actually selects.
    expect(row.metrics).toEqual(created.metrics);
    expect(row.budget).toEqual(created.budget);
    expect(row.spendRial).toBe(300_000);
    expect(row.budget.state).toBe("over");
    expect(row.clientName).toBe("مهر فود");
  });

  it("filters by status, by client, and by whether it is on air today", async () => {
    const { businessId, food, kimia } = await agencyWithBrands();
    await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "جاری فود",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    const running = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "جاری فود",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
    });
    await campaigns.applyAgencyCampaignAction(businessId, running.id, ACTOR, "start");
    await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: kimia,
      title: "کیمیا آینده",
      startDate: "2026-08-01",
      endDate: "2026-09-01",
    });

    const byClient = await campaigns.listAgencyCampaigns(businessId, { partyId: kimia }, { todayIso: TODAY });
    expect(byClient).toHaveLength(1);
    expect(byClient[0].clientName).toBe("مهر کیمیا");

    const current = await campaigns.listAgencyCampaigns(businessId, { currentOnly: true }, { todayIso: TODAY });
    expect(current.map((c) => c.title)).toEqual(["جاری فود"]);
    expect(current[0].current).toBe(true);

    const open = await campaigns.listAgencyCampaigns(businessId, { openOnly: true }, { todayIso: TODAY });
    expect(open).toHaveLength(3);
    expect(open.every((c) => !c.closed)).toBe(true);

    // An unknown status filters nothing rather than matching nothing, so a stale
    // bookmark shows the list instead of an empty screen that looks like data loss.
    const unknown = await campaigns.listAgencyCampaigns(businessId, { status: "nonsense" }, { todayIso: TODAY });
    expect(unknown.length).toBeGreaterThanOrEqual(3);
  });

  it("a patch carrying one field leaves every other field alone", async () => {
    const { businessId, food } = await agencyWithBrands();
    const created = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین اولیه",
      objective: "افزایش آگاهی",
      startDate: "2026-05-01",
      endDate: "2026-06-01",
      budgetRial: 1_000_000,
      spendRial: 250_000,
      impressions: 500,
      clicks: 25,
      leadsGenerated: 5,
      channels: ["social"],
      note: "یادداشت اول",
    });

    const renamed = await campaigns.updateAgencyCampaign(businessId, created.id, ACTOR, {
      title: "کمپین اصلاح‌شده",
    });
    expect(renamed.title).toBe("کمپین اصلاح‌شده");
    expect(renamed.objective).toBe("افزایش آگاهی");
    expect(renamed.startDate).toBe("2026-05-01");
    expect(renamed.endDate).toBe("2026-06-01");
    expect(renamed.budgetRial).toBe(1_000_000);
    expect(renamed.spendRial).toBe(250_000);
    expect(renamed.impressions).toBe(500);
    expect(renamed.clicks).toBe(25);
    expect(renamed.leadsGenerated).toBe(5);
    expect(renamed.channels).toEqual(["social"]);
    expect(renamed.note).toBe("یادداشت اول");

    // And clearing is still possible when that is what was meant.
    const cleared = await campaigns.updateAgencyCampaign(businessId, created.id, ACTOR, {
      budgetRial: "",
      note: "",
      channels: [],
    });
    expect(cleared.budgetRial).toBeNull();
    expect(cleared.note).toBe("");
    expect(cleared.channels).toEqual([]);
    expect(cleared.spendRial).toBe(250_000);

    // An empty patch is "nothing to do", which is not "nothing there".
    const unchanged = await campaigns.updateAgencyCampaign(businessId, created.id, ACTOR, {});
    expect(unchanged.id).toBe(created.id);
  });

  it("checks a figure pair against the record, not against a default", async () => {
    const { businessId, food } = await agencyWithBrands();
    const created = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین آمار",
      impressions: 100,
      clicks: 50,
    });
    // Raising impressions alone would put clicks above them; the service sees the
    // pair as it will be stored, so this is refused rather than written.
    await expect(
      campaigns.updateAgencyCampaign(businessId, created.id, ACTOR, { impressions: 10 }),
    ).rejects.toMatchObject({ code: "clicks_exceed_impressions" });
    // Lowering both together is fine.
    const both = await campaigns.updateAgencyCampaign(businessId, created.id, ACTOR, {
      impressions: 10,
      clicks: 5,
    });
    expect(both.impressions).toBe(10);
    expect(both.clicks).toBe(5);
  });

  it("walks the lifecycle, and says in words what a status change needs first", async () => {
    const { businessId, food } = await agencyWithBrands();
    const created = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین چرخه",
    });

    // 0278 CHECKs this; the service refuses it first so the member is told what to
    // fill in rather than shown a database error.
    await expect(
      campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "start"),
    ).rejects.toMatchObject({ code: "start_date_required" });

    await campaigns.updateAgencyCampaign(businessId, created.id, ACTOR, {
      startDate: "2026-05-01",
      endDate: "2026-06-30",
    });

    const running = await campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "start");
    expect(running.status).toBe("running");
    expect(running.actions).toEqual(["pause", "complete", "cancel"]);

    const paused = await campaigns.applyAgencyCampaignAction(
      businessId,
      created.id,
      ACTOR,
      "pause",
      { todayIso: TODAY },
    );
    expect(paused.status).toBe("paused");
    // Paused is still in flight: the budget is committed and the channels are booked.
    // `todayIso` is pinned rather than read off the wall clock, so this holds
    // whenever the suite runs.
    expect(paused.current).toBe(true);

    const resumed = await campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "resume");
    expect(resumed.status).toBe("running");

    // An action the status does not offer is refused, not ignored.
    await expect(
      campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "resume"),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "approve"),
    ).rejects.toMatchObject({ code: "invalid_action" });

    await campaigns.updateAgencyCampaign(businessId, created.id, ACTOR, {
      spendRial: 800_000,
      impressions: 20_000,
      clicks: 900,
      leadsGenerated: 60,
      conversions: 15,
      revenueRial: 3_000_000,
      metricsSource: "imported",
      metricsNote: "از خروجی خود پلتفرم",
    });

    const ended = await campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "complete");
    expect(ended.status).toBe("completed");
    expect(ended.closed).toBe(true);
    expect(ended.actions).toEqual([]);
    expect(ended.metrics).toEqual({ ctrPct: 4.5, cplRial: 13_333, cpaRial: 53_333, roas: 3.75 });
    expect(ended.metricsSource).toBe("imported");
  });

  it("a completed campaign is closed to edits, and the database is the authority", async () => {
    const { businessId, food } = await agencyWithBrands();
    const created = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین بسته",
      startDate: "2026-01-01",
      endDate: "2026-02-01",
      spendRial: 100,
    });
    await campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "start");
    await campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "complete");

    await expect(
      campaigns.updateAgencyCampaign(businessId, created.id, ACTOR, { spendRial: 1 }),
    ).rejects.toMatchObject({ code: "campaign_closed" });
    await expect(
      campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "cancel"),
    ).rejects.toMatchObject({ code: "campaign_closed" });

    // The service's read is not what protects the record — 0278's trigger is, and it
    // runs inside the write. A raw UPDATE that skips the service is still refused,
    // which is why the service takes no row lock.
    const raw = await db.query(
      `UPDATE agency_client_campaigns SET spend_rial = 1 WHERE id = $1`,
      [created.id],
    ).then(
      () => "updated",
      (error: { code?: string }) => error.code ?? "?",
    );
    expect(raw).toBe("23514");
  });

  it("deletes only what never ran", async () => {
    const { businessId, food } = await agencyWithBrands();
    const planned = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "حذف‌شدنی",
    });
    expect(await campaigns.deleteAgencyCampaign(businessId, planned.id)).toBe(true);

    const ran = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "اجراشده",
      startDate: "2026-05-01",
    });
    await campaigns.applyAgencyCampaignAction(businessId, ran.id, ACTOR, "start");
    await expect(campaigns.deleteAgencyCampaign(businessId, ran.id)).rejects.toMatchObject({
      code: "campaign_not_deletable",
    });
    await expect(campaigns.deleteAgencyCampaign(businessId, randomUUID())).rejects.toMatchObject({
      code: "campaign_not_found",
    });
  });

  it("keeps one tenant's campaigns out of another's", async () => {
    const mine = await agencyWithBrands();
    const theirs = await agencyWithBrands();
    const created = await campaigns.createAgencyCampaign(mine.businessId, ACTOR, {
      partyId: mine.food,
      title: "کمپین من",
    });

    await expect(
      campaigns.loadAgencyCampaign(theirs.businessId, created.id),
    ).resolves.toBeNull();
    await expect(
      campaigns.listAgencyCampaigns(theirs.businessId, {}, { todayIso: TODAY }),
    ).resolves.toHaveLength(0);
    await expect(
      campaigns.updateAgencyCampaign(theirs.businessId, created.id, ACTOR, { title: "x" }),
    ).rejects.toMatchObject({ code: "campaign_not_found" });
    await expect(
      campaigns.deleteAgencyCampaign(theirs.businessId, created.id),
    ).rejects.toMatchObject({ code: "campaign_not_found" });

    // A foreign client cannot be used either: the reference trigger checks ownership
    // before the FK ever sees the id.
    await expect(
      campaigns.createAgencyCampaign(mine.businessId, ACTOR, {
        partyId: theirs.food,
        title: "کمپین با مشتری بیگانه",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("does not belong") });
  });

  it("refuses to let one brand's campaign carry another brand's documents", async () => {
    const { businessId, food, kimia } = await agencyWithBrands();
    const kimiaBrief = await briefs.createAgencyBrief(businessId, ACTOR, {
      partyId: kimia,
      title: "بریف کیمیا",
    });
    const kimiaProposal = await proposals.createAgencyProposal(businessId, ACTOR, {
      partyId: kimia,
      title: "پیشنهاد کیمیا",
      lines: [{ description: "کمپین", quantity: 1, unitPriceRial: 1000 }],
    });
    const foodBrief = await briefs.createAgencyBrief(businessId, ACTOR, {
      partyId: food,
      title: "بریف فود",
    });

    // §A's rule: without it, «مهر فود»'s campaign carries «مهر کیمیا»'s accepted
    // proposal and the two brands' figures merge in every report §C must keep apart.
    // The refusal is the trigger's, so it arrives as a SQLSTATE and not as a code
    // this service invented.
    for (const input of [
      { partyId: food, title: "x", briefId: kimiaBrief.id },
      { partyId: food, title: "x", proposalId: kimiaProposal.id },
    ]) {
      const error = await campaigns
        .createAgencyCampaign(businessId, ACTOR, input)
        .then(() => null, (e: unknown) => e as { code?: string });
      expect(error).not.toBeNull();
      expect(error!.code).toBe("23514");
    }

    const own = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "کمپین فود",
      briefId: foodBrief.id,
      proposalId: undefined,
    });
    expect(own.briefNumber).toBe(foodBrief.briefNumber);
    expect(own.briefTitle).toBe("بریف فود");
  });

  it("counts campaigns per brand, which is what wave 8 had to refuse", async () => {
    const { businessId, group, food, kimia } = await agencyWithBrands();
    for (const title of ["بهاره", "تابستانی"]) {
      const created = await campaigns.createAgencyCampaign(businessId, ACTOR, {
        partyId: food,
        title: `کمپین ${title} فود`,
        startDate: "2026-05-01",
        endDate: "2026-06-30",
      });
      await campaigns.applyAgencyCampaignAction(businessId, created.id, ACTOR, "start");
    }
    const paused = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "متوقف فود",
      startDate: "2026-05-01",
      endDate: "2026-06-30",
    });
    await campaigns.applyAgencyCampaignAction(businessId, paused.id, ACTOR, "start");
    await campaigns.applyAgencyCampaignAction(businessId, paused.id, ACTOR, "pause");
    await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "برنامه‌ریزی‌شدهٔ فود",
    });
    await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: kimia,
      title: "کمپین کیمیا",
    });

    const counts = await campaigns.countCampaignsByParty(businessId, [group, food, kimia]);
    // The group carries nothing itself: its brands do. Rolling the brands up would
    // double-count every figure on the organisation card.
    expect(counts.get(group)).toBeUndefined();
    expect(counts.get(food)).toEqual({ total: 4, inFlight: 3 });
    expect(counts.get(kimia)).toEqual({ total: 1, inFlight: 0 });
    expect(await campaigns.countCampaignsByParty(businessId, [])).toEqual(new Map());
  });

  it("holds two of one brand's campaigns in the same window — §A's concurrent campaigns", async () => {
    const { businessId, food } = await agencyWithBrands();
    const first = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "بهاره",
      startDate: "2026-03-01",
      endDate: "2026-05-30",
    });
    const second = await campaigns.createAgencyCampaign(businessId, ACTOR, {
      partyId: food,
      title: "رمضانی",
      startDate: "2026-04-01",
      endDate: "2026-06-30",
    });
    await campaigns.applyAgencyCampaignAction(businessId, first.id, ACTOR, "start");
    await campaigns.applyAgencyCampaignAction(businessId, second.id, ACTOR, "start");

    const current = await campaigns.listAgencyCampaigns(
      businessId,
      { partyId: food, currentOnly: true },
      { todayIso: TODAY },
    );
    expect(current.map((c) => c.title).sort()).toEqual(["بهاره", "رمضانی"]);
    expect(current.every((c) => c.current)).toBe(true);

    // And neither is current once the window has passed, which is the difference
    // between a calendar and a list of everything ever run.
    const later = await campaigns.listAgencyCampaigns(
      businessId,
      { partyId: food, currentOnly: true },
      { todayIso: "2026-09-01" },
    );
    expect(later).toHaveLength(0);
  });

  it("answers for a campaign that does not exist, and an id that is not one", async () => {
    const { businessId } = await agencyWithBrands();
    await expect(campaigns.loadAgencyCampaign(businessId, randomUUID())).resolves.toBeNull();
    await expect(campaigns.loadAgencyCampaign(businessId, "nope")).resolves.toBeNull();
    await expect(
      campaigns.updateAgencyCampaign(businessId, "nope", ACTOR, { title: "x" }),
    ).rejects.toMatchObject({ code: "campaign_not_found" });
    await expect(
      campaigns.applyAgencyCampaignAction(businessId, "nope", ACTOR, "start"),
    ).rejects.toMatchObject({ code: "campaign_not_found" });
  });
});
