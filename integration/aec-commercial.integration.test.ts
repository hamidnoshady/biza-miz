/**
 * Issue #799 Wave 8 (§15, §16, §17 and §20) — the commercial controls, against
 * a real PostgreSQL.
 *
 * `src/lib/aec-commercial.test.ts` proves the pure half: the two status chains,
 * the certificate arithmetic, the approval split and what "revised contractual
 * value" means. What can only be proven here, with the schema and the triggers
 * in the way, is:
 *
 *   * §15's chain is walked end to end — a change order numbered `VO-001`, its
 *     estimate before its price, its submitted amount before it is sent, one
 *     `workspace_approvals` row filed at submit and decided through the service
 *     — and the moves the chain does not have are refused with a code;
 *   * **an approved change moves the contract's revised value and never the
 *     contract**: `workspace_contracts.value_rial` is byte-for-byte the same
 *     after an approval, the approved BOQ revision and its lines are untouched,
 *     and `aec_contract_commercials.revised_value_rial` is recomputed by the
 *     database even when a raw writer sets it by hand;
 *   * a submitted change order and a certified claim are **frozen in the
 *     database, not only in the service**: a raw `UPDATE` of a submitted order's
 *     description is refused with 23514 and a raw `DELETE` likewise, a certified
 *     claim cannot be changed at all, and the only way to correct either is the
 *     chain's own reopening (a rejected order is re-priced, a claim returns to
 *     draft) — which is what §33's "immutable history" means in practice;
 *   * §16's arithmetic is the database's too: the net is `gross − advance −
 *     retention − other − tax`, the measured lines must add up to the gross
 *     before a claim may leave draft (a raw status flip that skips the service is
 *     refused by the trigger), "previous certified" is derived on read rather
 *     than stored, and a certifier may approve less than the net but never more;
 *   * the advance is recovered once: a claim that would recover more than the
 *     contract's advance still holds is refused, and the outstanding figure the
 *     cockpit prints is the contract's advance minus what has been certified;
 *   * **Accounting keeps the money that moved.** No table in this wave stores a
 *     paid or received balance: the cockpit's actual cost is the ledger's
 *     (`journal_lines` through `journal_entries.project_id`, via `projectReport`)
 *     and is `null` for an actor without `ledger.view`, and the figures only the
 *     books own are *named* rather than recomputed;
 *   * the queues the widgets, the scan and the assistant read
 *     (`pendingVariations`, `pendingCertificates`, `expiringSecurities`,
 *     `certifiedClaimsAwaitingPayment`) select the same rows the screen shows,
 *     a decided approval is not decided twice, a certified claim older than the
 *     grace period becomes a notification through the hourly scan, and a
 *     restaurant is answered with a no-op;
 *   * each domain is gated on **its own** capability — an architecture office
 *     that never raises change orders still has §20's cockpit — and another
 *     business's contract, project or party is out of reach at the predicate, the
 *     service *and* the trigger;
 *   * a party merge re-points the responsible party of a change order **that is
 *     still being prepared** and leaves a submitted one naming the party it was
 *     raised against, which is what migration 0200's freeze and the merge
 *     registry's filter agree on.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { AecError } from "../src/lib/aec-service";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let aec: typeof import("../src/lib/aec-service");
let boq: typeof import("../src/lib/aec-boq-service");
let commercial: typeof import("../src/lib/aec-commercial-service");
let commercialPure: typeof import("../src/lib/aec-commercial");
let workspaceShared: typeof import("../src/lib/workspace-shared");
let crm: typeof import("../src/lib/crm-service");
let scans: typeof import("../src/lib/notification-scans");

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
  databaseName = `pos_aec_commercial_${randomUUID().replaceAll("-", "")}`;

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
  aec = await import("../src/lib/aec-service");
  boq = await import("../src/lib/aec-boq-service");
  commercial = await import("../src/lib/aec-commercial-service");
  commercialPure = await import("../src/lib/aec-commercial");
  workspaceShared = await import("../src/lib/workspace-shared");
  crm = await import("../src/lib/crm-service");
  scans = await import("../src/lib/notification-scans");

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

let seq = 0;

type Owner = { businessId: string; actorUserId: string; actorName: string };

/**
 * A contractor by default: §15, §16 and §20 are a builder's commercial controls,
 * and the preset carries `variations`, `progress_claims` and `financials` — the
 * three switches this wave added. `profile` selects the design preset instead,
 * which is how the capability test proves the three are independent (an office
 * that draws keeps §20's cockpit with neither register).
 */
async function provisionBusiness(
  industry: "architecture_construction" | "food_service" = "architecture_construction",
  profile: "contractor" | "design" = "contractor",
): Promise<{ businessId: string; owner: Owner }> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کسب‌وکار تجاری ${seq}`,
    ownerName: "مالک",
    email: `owner-commercial-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `commercial${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  const owner = { businessId: result.businessId, actorUserId: result.userId, actorName: "مالک" };
  if (industry === "architecture_construction" && profile === "contractor") {
    await dbLib.withTenant(result.businessId, () =>
      aec.saveBusinessAecProfile(owner, { operatingProfile: "contractor" }),
    );
  }
  return { businessId: result.businessId, owner };
}

/** `dbLib.withTenant`, captured so the helpers below can run before the suite. */
function withTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

async function createProject(businessId: string, ownerUserId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
     VALUES ($1, $2, $3::text, $3::uuid) RETURNING id`,
    [businessId, name, ownerUserId],
  );
  return rows[0].id;
}

async function createParty(businessId: string, name: string, roles: string[] = ["supplier"]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles)
     VALUES ($1, $2, $3, $4::text[]) RETURNING id`,
    [businessId, name, roles[0], roles],
  );
  return rows[0].id;
}

async function createContract(
  businessId: string,
  projectId: string,
  title: string,
  valueRial: number,
  createdBy: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workspace_contracts
       (business_id, project_id, title, contract_type, value_rial, start_date, end_date, status, created_by)
     VALUES ($1, $2, $3, 'contractor', $4, '2026-01-01', '2026-12-31', 'active', $5)
     RETURNING id`,
    [businessId, projectId, title, valueRial, createdBy],
  );
  return rows[0].id;
}

async function addMediaAsset(businessId: string, ownerUserId: string, fileName: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets
       (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256, created_by)
     VALUES ($1, 'image', $2, 'application/pdf', 2048, $3, repeat(md5($4), 2), $5::uuid)
     RETURNING id`,
    [businessId, fileName, `commercial/${randomUUID()}.pdf`, randomUUID(), ownerUserId],
  );
  return rows[0].id;
}

/** One posted cost against a project — what Accounting's ledger holds (§20). */
async function postProjectCost(
  businessId: string,
  projectId: string,
  amountRial: number,
  memo = "هزینهٔ اجرای پروژه",
): Promise<void> {
  await dbLib.withTenant(businessId, async () => {
    const { rows: accounts } = await dbLib.query<{ id: string }>(
      `SELECT id FROM accounts WHERE business_id = $1 ORDER BY code LIMIT 1`,
      [businessId],
    );
    const { rows: entries } = await dbLib.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, project_id)
       VALUES ($1, '2026-05-01', $2, 'manual', $3) RETURNING id`,
      [businessId, memo, projectId],
    );
    await dbLib.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
      [entries[0].id, accounts[0].id, amountRial],
    );
  });
}

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).name).toBe("AecError");
  expect((error as AecError).code).toBe(code);
}

/** A project with one contract, ready for a change order or a claim. */
async function seedContract(
  owner: Owner,
  projectName: string,
  valueRial = 5_000_000_000,
): Promise<{ projectId: string; contractId: string }> {
  const projectId = await createProject(owner.businessId, owner.actorUserId, projectName);
  const contractId = await createContract(
    owner.businessId,
    projectId,
    `پیمان ${projectName}`,
    valueRial,
    owner.actorUserId,
  );
  await withTenant(owner.businessId, () =>
    commercial.saveContractCommercial(owner, contractId, { contractNumber: `${projectName}-01` }),
  );
  return { projectId, contractId };
}

/** An approved estimate revision with one line — the BOQ an approval must not touch. */
async function seedApprovedBoq(owner: Owner, projectId: string): Promise<{ versionId: string; itemId: string }> {
  return withTenant(owner.businessId, async () => {
    const estimate = await boq.createEstimate(owner, projectId, { title: "برآورد اصلی" });
    const versionId = estimate.versions[0].id;
    await boq.saveDraftVersion(owner, versionId, {
      sections: [{ code: "01", title: "عملیات خاکی" }],
      items: [
        {
          sectionIndex: 0,
          itemCode: "01-10",
          description: "خاک‌برداری با ماشین",
          unit: "m3",
          quantity: "1000",
          materialRateRial: 0,
          laborRateRial: 180_000,
          equipmentRateRial: 20_000,
          subcontractRateRial: 0,
          wastePercent: "0",
          overheadPercent: "0",
          markupPercent: "0",
        },
      ],
    });
    await boq.submitEstimateVersion(owner, versionId, {});
    await boq.approveEstimateVersion(owner, versionId, "");
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM aec_boq_items WHERE business_id = $1 AND version_id = $2 LIMIT 1`,
      [owner.businessId, versionId],
    );
    return { versionId, itemId: rows[0].id };
  });
}

/** A priced change order with a submitted amount, ready to be sent. */
async function seedPricedVariation(
  owner: Owner,
  projectId: string,
  contractId: string | null,
  description: string,
  estimatedRial: number,
  submittedRial: number,
): Promise<string> {
  return withTenant(owner.businessId, async () => {
    const variation = await commercial.createVariation(owner, projectId, {
      contractId,
      source: "client_instruction",
      description,
      estimatedAmountRial: estimatedRial,
      submittedAmountRial: submittedRial,
    });
    await commercial.applyVariationAction(owner, variation.id, "price");
    return variation.id;
  });
}

/** A certified claim for `netRial`, through the real chain. */
async function seedCertifiedClaim(
  owner: Owner,
  projectId: string,
  contractId: string,
  period: { start: string; end: string },
  amounts: { grossRial: number; retentionRial?: number; advanceRecoveryRial?: number; taxRial?: number },
  kind: "application" | "certificate" = "application",
): Promise<{ id: string; approvedRial: number }> {
  return withTenant(owner.businessId, async () => {
    const certificate = await commercial.createCertificate(owner, projectId, {
      contractId,
      kind,
      periodStart: period.start,
      periodEnd: period.end,
      ...amounts,
    });
    await commercial.applyCertificateAction(owner, certificate.id, "submit");
    await commercial.applyCertificateAction(owner, certificate.id, "review");
    const certified = await commercial.applyCertificateAction(owner, certificate.id, "certify");
    return { id: certificate.id, approvedRial: certified.approvedAmountRial ?? certified.netRial };
  });
}

describe("the change-order register (issue #799 §15)", () => {
  it("numbers per project, walks the chain, and refuses the moves it does not have", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ تغییرات");

    const first = await withTenant(businessId, () =>
      commercial.createVariation(owner, projectId, {
        contractId,
        source: "client_instruction",
        reason: "دستور کارفرما",
        description: "افزایش دیوار حائل ضلع شمالی",
        estimatedAmountRial: 800_000_000,
        costImpactRial: 620_000_000,
        scheduleImpactDays: 5,
      }),
    );
    expect(first.variationNumber).toBe("VO-001");
    expect(first.status).toBe("draft");
    expect(first.estimatedAmountRial).toBe(800_000_000);
    expect(first.costImpactRial).toBe(620_000_000);
    expect(first.scheduleImpactDays).toBe(5);

    // One number per project, however many people raise changes.
    const second = await withTenant(businessId, () =>
      commercial.createVariation(owner, projectId, { description: "تغییر دوم" }),
    );
    expect(second.variationNumber).toBe("VO-002");

    // Draft → Approved is not a move the chain has.
    await withTenant(businessId, async () => {
      await expect(commercial.applyVariationAction(owner, first.id, "approve")).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "invalid_variation_transition");
          return true;
        },
      );
      // …and pricing without an estimate is refused by the service *and* by
      // 0200's `status <> 'priced' OR estimated_amount_rial IS NOT NULL`.
      await expect(commercial.applyVariationAction(owner, second.id, "price")).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "variation_estimate_required");
          return true;
        },
      );
      await expect(
        db.query(`UPDATE aec_variations SET status = 'priced' WHERE id = $1`, [second.id]),
      ).rejects.toMatchObject({ code: "23514" });
      await commercial.updateVariation(owner, second.id, { estimatedAmountRial: 100_000_000 });
      const priced = await commercial.applyVariationAction(owner, second.id, "price");
      expect(priced.status).toBe("priced");
      expect(priced.isEditable).toBe(true);
    });

    // Sending it needs the amount the client will be asked for — and the chain
    // says a draft is priced first, so the amount check is reachable only from
    // `priced` (which is the point of the two being separate refusals).
    await withTenant(businessId, async () => {
      await commercial.applyVariationAction(owner, first.id, "price");
      await expect(commercial.applyVariationAction(owner, first.id, "submit")).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "variation_submitted_amount_required");
          return true;
        },
      );
      await commercial.updateVariation(owner, first.id, { submittedAmountRial: 750_000_000 });
      const submitted = await commercial.applyVariationAction(owner, first.id, "submit");
      expect(submitted.status).toBe("submitted");
      expect(submitted.submittedDate).not.toBeNull();
      expect(submitted.isEditable).toBe(false);
      expect(submitted.approvalId).not.toBeNull();
      expect(submitted.approvalStatus).toBe("pending");

      // §15's "approvals" is the workspace's own queue: one row, the AEC subject
      // the approvals route resolves, pointing at this change order.
      const { rows } = await db.query<{ subject_type: string; status: string; project_id: string }>(
        `SELECT subject_type, status, project_id FROM workspace_approvals
          WHERE business_id = $1 AND subject_id = $2`,
        [businessId, first.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ subject_type: "variation", status: "pending", project_id: projectId });

      const reviewed = await commercial.applyVariationAction(owner, first.id, "review");
      expect(reviewed.status).toBe("under_review");

      // The approver may agree a different figure from the one submitted; the
      // order stays approvable because the amount is visible next to its estimate.
      const approved = await commercial.applyVariationAction(owner, first.id, "approve", {
        approvedAmountRial: 700_000_000,
        note: "با تعدیل",
      });
      expect(approved.status).toBe("approved");
      expect(approved.approvedAmountRial).toBe(700_000_000);
      expect(approved.approvedDate).not.toBeNull();

      const implemented = await commercial.applyVariationAction(owner, first.id, "implement");
      expect(implemented.status).toBe("implemented");
    });

    // §33's trail: one append-only event per step, and the register shows them.
    const { rows: events } = await db.query<{ action: string; summary: string }>(
      `SELECT action, summary FROM aec_commercial_events WHERE business_id = $1 AND variation_id = $2
        ORDER BY created_at, id`,
      [businessId, first.id],
    );
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(events[0].action).toBe("created");
    expect(events.some((event) => event.summary.includes("VO-001"))).toBe(true);
    expect(new Set(events.map((event) => event.action)).size).toBe(events.length);
  });

  it("freezes a submitted change order in the database, and reopens it only through the chain", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ انجماد");
    const draft = await withTenant(businessId, () =>
      commercial.createVariation(owner, projectId, { description: "تغییر پیش‌نویس" }),
    );
    const submitted = await seedPricedVariation(
      owner,
      projectId,
      contractId,
      "تغییر ارسال‌شده",
      500_000_000,
      480_000_000,
    );
    await withTenant(businessId, () => commercial.applyVariationAction(owner, submitted, "submit"));

    // What the client received cannot change underneath them.
    await expect(
      db.query(`UPDATE aec_variations SET description = 'چیز دیگری' WHERE id = $1`, [submitted]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(db.query(`DELETE FROM aec_variations WHERE id = $1`, [submitted])).rejects.toMatchObject({
      code: "23514",
    });
    // …and the same is true of the service, with a code the API can map.
    await withTenant(businessId, async () => {
      await expect(
        commercial.updateVariation(owner, submitted, { description: "ویرایش بی‌جا" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "variation_not_editable");
        return true;
      });
      await expect(commercial.deleteVariation(owner, submitted)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "variation_not_editable");
          return true;
        },
      );
    });

    // The only correction is the chain's own reopening: rejected, then re-priced.
    await withTenant(businessId, async () => {
      await commercial.applyVariationAction(owner, submitted, "review");
      const rejected = await commercial.applyVariationAction(owner, submitted, "reject", {
        note: "مبلغ پذیرفته نشد",
      });
      expect(rejected.status).toBe("rejected");
      // A rejected order carries no agreement — the next round must not inherit
      // the number nobody honoured.
      expect(rejected.approvedAmountRial).toBeNull();

      const repriced = await commercial.applyVariationAction(owner, submitted, "reopen");
      expect(repriced.status).toBe("priced");
      expect(repriced.isEditable).toBe(true);
      const edited = await commercial.updateVariation(owner, submitted, {
        description: "تغییر ارسال‌شده — دور دوم",
        estimatedAmountRial: 520_000_000,
      });
      expect(edited.description).toBe("تغییر ارسال‌شده — دور دوم");
    });

    // A rejected order is history too: only a draft can be deleted.
    await withTenant(businessId, async () => {
      await commercial.deleteVariation(owner, draft.id);
      await expect(commercial.deleteVariation(owner, submitted)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "variation_not_editable");
          return true;
        },
      );
    });
  });

  it("moves the revised contract value, and never the contract or the approved BOQ", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ ارزش اصلاح‌شده", 5_000_000_000);
    const { versionId, itemId } = await seedApprovedBoq(owner, projectId);
    const { rows: boqBefore } = await db.query<{ status: string; total_rial: string }>(
      `SELECT status, total_rial FROM aec_estimate_versions WHERE id = $1`,
      [versionId],
    );
    const { rows: itemBefore } = await db.query<{ total_rial: string }>(
      `SELECT total_rial FROM aec_boq_items WHERE id = $1`,
      [itemId],
    );

    // Two more change orders: one merely rejected, one approved and built.
    const rejected = await seedPricedVariation(
      owner,
      projectId,
      contractId,
      "تغییری که پذیرفته نشد",
      900_000_000,
      900_000_000,
    );
    const built = await seedPricedVariation(
      owner,
      projectId,
      contractId,
      "تغییری که اجرا شد",
      600_000_000,
      750_000_000,
    );
    await withTenant(businessId, async () => {
      await commercial.applyVariationAction(owner, rejected, "submit");
      await commercial.applyVariationAction(owner, rejected, "review");
      await commercial.applyVariationAction(owner, rejected, "reject");
      await commercial.applyVariationAction(owner, built, "submit");
      await commercial.applyVariationAction(owner, built, "review");
      await commercial.applyVariationAction(owner, built, "approve", { approvedAmountRial: 750_000_000 });
      await commercial.applyVariationAction(owner, built, "implement");
    });

    const commercialBlock = await withTenant(businessId, () =>
      commercial.loadContractCommercial(businessId, contractId),
    );
    // The revised value is the original plus the *approved* changes — a rejected
    // one contributes nothing.
    expect(commercialBlock.revisedValueRial).toBe(5_750_000_000);
    expect(commercialBlock.approvedVariationsRial).toBe(750_000_000);

    // The original contract amount is untouched, byte for byte, and so is the
    // approved BOQ revision the contract was priced from.
    const { rows: contractRows } = await db.query<{ value_rial: string }>(
      `SELECT value_rial FROM workspace_contracts WHERE id = $1`,
      [contractId],
    );
    expect(Number(contractRows[0].value_rial)).toBe(5_000_000_000);
    const { rows: boqAfter } = await db.query<{ status: string; total_rial: string }>(
      `SELECT status, total_rial FROM aec_estimate_versions WHERE id = $1`,
      [versionId],
    );
    const { rows: itemAfter } = await db.query<{ total_rial: string }>(
      `SELECT total_rial FROM aec_boq_items WHERE id = $1`,
      [itemId],
    );
    expect(boqAfter[0]).toEqual(boqBefore[0]);
    expect(itemAfter[0].total_rial).toBe(itemBefore[0].total_rial);

    // The rearranged figure is the database's: a raw writer cannot type it.
    await expect(
      db.query(`UPDATE aec_contract_commercials SET revised_value_rial = 1 WHERE contract_id = $1`, [
        contractId,
      ]),
    ).resolves.toBeTruthy();
    const { rows: recomputed } = await db.query<{ revised_value_rial: string }>(
      `SELECT revised_value_rial FROM aec_contract_commercials WHERE contract_id = $1`,
      [contractId],
    );
    expect(Number(recomputed[0].revised_value_rial)).toBe(5_750_000_000);

    // An approval with no agreed amount is not an approval (0200's CHECK).
    await expect(
      db.query(
        `UPDATE aec_variations SET status = 'approved', approved_date = current_date WHERE id = $1`,
        [rejected],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("progress measurement and payment certificates (issue #799 §16)", () => {
  it("computes the net the way the database does, and refuses lines that disagree with it", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ صورت‌وضعیت");
    const { itemId } = await seedApprovedBoq(owner, projectId);
    // §17's advance is what §16's recovery is measured against: a claim cannot
    // recover an advance the contract never paid.
    await withTenant(businessId, () =>
      commercial.saveContractCommercial(owner, contractId, { advanceAmountRial: 500_000_000 }),
    );

    const amounts = {
      grossRial: 1_000_000_000,
      advanceRecoveryRial: 50_000_000,
      retentionRial: 100_000_000,
      taxRial: 90_000_000,
    };
    const { netRial } = commercialPure.certificateTotals({ ...amounts, otherDeductionsRial: 0 });

    const certificate = await withTenant(businessId, () =>
      commercial.createCertificate(owner, projectId, {
        contractId,
        kind: "application",
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        progressPercent: 25,
        ...amounts,
      }),
    );
    expect(certificate.certificateNumber).toBe("PC-001");
    expect(certificate.netRial).toBe(netRial);
    expect(certificate.netRial).toBe(760_000_000);
    // "Current certified" is this claim's own figure; nothing has been certified
    // before it, so §16's "previous certified" is zero — derived, not stored.
    expect(certificate.currentCertifiedRial).toBe(0);
    expect(certificate.previousCertifiedRial).toBe(0);
    expect(certificate.contractRevisedValueRial).toBe(5_000_000_000);
    // Nothing is certified *by this claim* yet, so the whole revised value is
    // still outstanding against the contract — derived on read, like the row
    // above it, rather than summed into a column that could go stale.
    expect(certificate.contractOutstandingRial).toBe(5_000_000_000);

    // A claim measured against a BOQ item of another project is refused.
    const other = await seedContract(owner, "پروژهٔ دیگر");
    const { itemId: foreignItem } = await seedApprovedBoq(owner, other.projectId);
    await withTenant(businessId, async () => {
      await expect(
        commercial.updateCertificate(owner, certificate.id, {
          lines: [{ boqItemId: foreignItem, label: "قلم پروژهٔ دیگر", amountRial: 1_000_000_000 }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "boq_item_project_mismatch");
        return true;
      });

      // §16's measurement: when there are lines, they are the claim.
      await commercial.updateCertificate(owner, certificate.id, {
        lines: [
          { boqItemId: itemId, label: "خاک‌برداری", amountRial: 600_000_000, progressPercent: 30 },
          { label: "کارهای روزمزدی", amountRial: 400_000_000 },
        ],
      });
      // A draft is allowed to disagree with itself — that is what drafting is —
      // but it cannot be *sent* that way: the service refuses it with a code and
      // the trigger refuses the same status flip made with raw SQL.
      await commercial.updateCertificate(owner, certificate.id, { grossRial: 1_100_000_000 });
      await expect(
        commercial.applyCertificateAction(owner, certificate.id, "submit"),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "certificate_lines_mismatch");
        return true;
      });
      await expect(
        db.query(`UPDATE aec_payment_certificates SET status = 'submitted' WHERE id = $1`, [
          certificate.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });

      // Re-measured to agree, it goes — and from then on the arithmetic is
      // history: the net is not a field somebody may type over.
      await commercial.updateCertificate(owner, certificate.id, { grossRial: 1_000_000_000 });
      const sent = await commercial.applyCertificateAction(owner, certificate.id, "submit");
      expect(sent.status).toBe("submitted");
      expect(sent.grossRial).toBe(1_000_000_000);
      await expect(
        db.query(`UPDATE aec_payment_certificates SET net_rial = 999 WHERE id = $1`, [certificate.id]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("certifies at or below the net, never above, and freezes the certified record", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ گواهی");

    const certificate = await withTenant(businessId, () =>
      commercial.createCertificate(owner, projectId, {
        contractId,
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
        grossRial: 400_000_000,
        retentionRial: 40_000_000,
      }),
    );
    await withTenant(businessId, async () => {
      const submitted = await commercial.applyCertificateAction(owner, certificate.id, "submit");
      expect(submitted.status).toBe("submitted");
      expect(submitted.approvalStatus).toBe("pending");
      expect(submitted.submittedDate).not.toBeNull();

      // §16's "client/consultant approval" is the same queue as everything else.
      const { rows } = await db.query<{ subject_type: string }>(
        `SELECT subject_type FROM workspace_approvals WHERE business_id = $1 AND subject_id = $2`,
        [businessId, certificate.id],
      );
      expect(rows[0].subject_type).toBe("payment_certificate");

      await commercial.applyCertificateAction(owner, certificate.id, "review");
      await expect(
        commercial.applyCertificateAction(owner, certificate.id, "certify", {
          approvedAmountRial: certificate.netRial + 1,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "approved_amount_exceeds_net");
        return true;
      });

      // A certifier may approve less than the claim — and the approved figure is
      // what is owed, not the claimed one.
      const certified = await commercial.applyCertificateAction(owner, certificate.id, "certify", {
        approvedAmountRial: 300_000_000,
      });
      expect(certified.status).toBe("certified");
      expect(certified.approvedAmountRial).toBe(300_000_000);
      expect(certified.currentCertifiedRial).toBe(300_000_000);
      expect(certified.certifiedDate).not.toBeNull();
      // Certified is not collected: nothing in this schema says it was paid.
      expect(certified.isCertified).toBe(true);
      expect(certified.isEditable).toBe(false);
    });

    // A certified claim is a record: no raw UPDATE, no DELETE, no reopening.
    await expect(
      db.query(`UPDATE aec_payment_certificates SET progress_percent = 99 WHERE id = $1`, [
        certificate.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(`DELETE FROM aec_payment_certificates WHERE id = $1`, [certificate.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await withTenant(businessId, async () => {
      await expect(commercial.deleteCertificate(owner, certificate.id)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "certificate_not_editable");
          return true;
        },
      );
      await expect(
        commercial.applyCertificateAction(owner, certificate.id, "reopen"),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_certificate_transition");
        return true;
      });
    });

    // The correction path that *does* exist is the one §16 has: a rejected claim
    // returns to draft and is re-measured.
    const second = await withTenant(businessId, () =>
      commercial.createCertificate(owner, projectId, {
        contractId,
        periodStart: "2026-05-01",
        periodEnd: "2026-05-31",
        grossRial: 200_000_000,
      }),
    );
    await withTenant(businessId, async () => {
      await commercial.applyCertificateAction(owner, second.id, "submit");
      await commercial.applyCertificateAction(owner, second.id, "review");
      const rejected = await commercial.applyCertificateAction(owner, second.id, "reject", {
        note: "اندازه‌گیری بازبینی شود",
      });
      expect(rejected.status).toBe("rejected");
      const draft = await commercial.applyCertificateAction(owner, second.id, "reopen");
      expect(draft.status).toBe("draft");
      expect(draft.approvedAmountRial).toBeNull();
      const remeasured = await commercial.updateCertificate(owner, second.id, {
        grossRial: 250_000_000,
        lines: [{ label: "اندازه‌گیری اصلاح‌شده", amountRial: 250_000_000 }],
      });
      expect(remeasured.grossRial).toBe(250_000_000);
      await commercial.deleteCertificate(owner, second.id);
    });
  });

  it("recovers the advance once, and derives the running totals on read", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ پیش‌پرداخت", 4_000_000_000);
    await withTenant(businessId, () =>
      commercial.saveContractCommercial(owner, contractId, {
        advancePercent: 25,
        advanceAmountRial: 1_000_000_000,
        retentionPercent: 10,
      }),
    );

    // First claim recovers 400m of the 1,000m advance.
    const first = await seedCertifiedClaim(owner, projectId, contractId, { start: "2026-01-01", end: "2026-01-31" }, {
      grossRial: 900_000_000,
      advanceRecoveryRial: 400_000_000,
      retentionRial: 90_000_000,
    });
    // 900m − 400m of advance − 90m of retention.
    expect(first.approvedRial).toBe(410_000_000);

    // The second may not recover more than the 600m still outstanding.
    await withTenant(businessId, async () => {
      await expect(
        commercial.createCertificate(owner, projectId, {
          contractId,
          periodStart: "2026-02-01",
          periodEnd: "2026-02-28",
          grossRial: 800_000_000,
          advanceRecoveryRial: 700_000_000,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "advance_over_recovery");
        return true;
      });
    });

    const second = await seedCertifiedClaim(owner, projectId, contractId, { start: "2026-02-01", end: "2026-02-28" }, {
      grossRial: 800_000_000,
      advanceRecoveryRial: 600_000_000,
      retentionRial: 80_000_000,
    });
    // §16's "previous certified" and the contract's outstanding balance are
    // derived when the row is read — two places holding one running total is how
    // one of them goes stale.
    const loaded = await withTenant(businessId, () => commercial.loadCertificate(businessId, second.id));
    expect(loaded.previousCertifiedRial).toBe(first.approvedRial);
    expect(loaded.currentCertifiedRial).toBe(second.approvedRial);
    expect(loaded.contractRevisedValueRial).toBe(4_000_000_000);
    expect(loaded.contractOutstandingRial).toBe(
      4_000_000_000 - first.approvedRial - second.approvedRial,
    );

    // And the cockpit adds the same rows up, with the advance split in two.
    const summary = await withTenant(businessId, () =>
      commercial.getProjectCommercialSummary(owner, projectId),
    );
    expect(summary.advanceRial).toBe(1_000_000_000);
    expect(summary.advanceRecoveredRial).toBe(1_000_000_000);
    expect(summary.outstandingAdvanceRial).toBe(0);
    expect(summary.certifiedRial).toBe(first.approvedRial + second.approvedRial);
    expect(summary.retentionReceivableRial).toBe(170_000_000);
    expect(summary.retentionPayableRial).toBe(0);
    expect(summary.remainingCommitmentRial).toBe(4_000_000_000 - summary.certifiedRial);
  });

  it("reads §17's block only for an actor who may see the project's money", async () => {
    // The certificate register is a project capability (§24's "commercial/
    // payment certificate manage"); the *cockpit* is §24's "project financial
    // view", and an actor without it reads the register without the ledger's
    // half of the picture.
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ مرز حسابداری");
    await postProjectCost(businessId, projectId, 1_500_000_000);
    await seedCertifiedClaim(owner, projectId, contractId, { start: "2026-03-01", end: "2026-03-31" }, {
      grossRial: 500_000_000,
    });

    const withoutLedger = await withTenant(businessId, () =>
      commercial.getProjectCommercialSummary(owner, projectId),
    );
    // No `ledger.view`, no actual cost — `null`, never a fabricated zero.
    expect(withoutLedger.actualCostRial).toBeNull();
    expect(withoutLedger.budgetVarianceRial).toBeNull();
    // The figures the books own are named, not computed here.
    expect(withoutLedger.readInAccounting.length).toBe(3);
    expect(withoutLedger.readInAccounting.join(" ")).toContain("دریافتنی");
    // Wave 9 emptied the "not built yet" list — §18's commitments now answer
    // the three figures §20 was waiting on — so the cockpit carries none.
    expect(withoutLedger.awaitingWaves).toEqual([]);
    expect(withoutLedger.committedRial).toBe(0);

    const withLedger = await withTenant(businessId, () =>
      commercial.getProjectCommercialSummary(
        { ...owner, access: workspaceShared.workspaceAccessFlags(new Set(["ledger.view"])) },
        projectId,
      ),
    );
    expect(withLedger.actualCostRial).toBe(1_500_000_000);
    expect(withLedger.certifiedRial).toBe(500_000_000);
    expect(withLedger.remainingCommitmentRial).toBe(4_500_000_000);
    // With the ledger readable and no approved estimate on this fixture, §20's
    // forecast is still `null` rather than a number built on half the facts.
    expect(withLedger.costToCompleteRial).toBeNull();
    expect(withLedger.forecastBasis.trim().length).toBeGreaterThan(0);
  });
});

describe("the queues the widgets, the scan and the assistant read", () => {
  it("lists what is pending, decides once, and names the securities about to expire", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ صف‌ها", 3_000_000_000);
    const variation = await seedPricedVariation(
      owner,
      projectId,
      contractId,
      "تغییر در انتظار تصمیم",
      400_000_000,
      420_000_000,
    );
    await withTenant(businessId, () => commercial.applyVariationAction(owner, variation, "submit"));

    const certificate = await withTenant(businessId, () =>
      commercial.createCertificate(owner, projectId, {
        contractId,
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        grossRial: 300_000_000,
      }),
    );
    await withTenant(businessId, () =>
      commercial.applyCertificateAction(owner, certificate.id, "submit"),
    );

    const queues = await withTenant(businessId, async () => ({
      variations: await commercial.pendingVariations(businessId, { projectId }),
      certificates: await commercial.pendingCertificates(businessId, { projectId }),
    }));
    expect(queues.variations.map((row) => row.id)).toEqual([variation]);
    expect(queues.variations[0].submittedAmountRial).toBe(420_000_000);
    expect(queues.certificates.map((row) => row.id)).toEqual([certificate.id]);
    expect(queues.certificates[0].netRial).toBe(300_000_000);
    expect(queues.certificates[0].contractTitle).toBe("پیمان پروژهٔ صف‌ها");

    // §15's approval, decided through the queue half of the same service.
    const { rows: approvalRows } = await db.query<{ id: string }>(
      `SELECT id FROM workspace_approvals
        WHERE business_id = $1 AND subject_type = 'variation' AND subject_id = $2`,
      [businessId, variation],
    );
    const approvalId = approvalRows[0].id;
    const decided = await withTenant(businessId, () =>
      commercial.decideVariationApproval(owner, approvalId, "approved", "تأیید شد"),
    );
    expect(decided).toMatchObject({ variationId: variation, applied: true });
    const loadedVariation = await withTenant(businessId, () =>
      commercial.loadVariation(businessId, variation),
    );
    // The queue's approval agrees the submitted figure — what the approver saw.
    expect(loadedVariation.status).toBe("approved");
    expect(loadedVariation.approvedAmountRial).toBe(420_000_000);
    expect(loadedVariation.approvalStatus).toBe("approved");

    // A second decision on a decided approval changes nothing at all.
    const again = await withTenant(businessId, () =>
      commercial.decideVariationApproval(owner, approvalId, "rejected"),
    );
    expect(again.applied).toBe(false);
    const after = await withTenant(businessId, () =>
      commercial.loadVariation(businessId, variation),
    );
    expect(after.status).toBe("approved");

    // The two subjects are separate registers: a decision cannot be filed
    // against the wrong one.
    await withTenant(businessId, async () => {
      await expect(
        commercial.decideCertificateApproval(owner, approvalId, "approved"),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "approval_not_found");
        return true;
      });
    });

    // The claim's own queue decides it the same way — straight off the
    // submission, which is what the approvals screen offers.
    const { rows: certificateApprovals } = await db.query<{ id: string }>(
      `SELECT id FROM workspace_approvals
        WHERE business_id = $1 AND subject_type = 'payment_certificate' AND subject_id = $2`,
      [businessId, certificate.id],
    );
    const decidedClaim = await withTenant(businessId, () =>
      commercial.decideCertificateApproval(owner, certificateApprovals[0].id, "approved", "تأیید"),
    );
    expect(decidedClaim).toMatchObject({ certificateId: certificate.id, applied: true });
    const certifiedClaim = await withTenant(businessId, () =>
      commercial.loadCertificate(businessId, certificate.id),
    );
    expect(certifiedClaim.status).toBe("certified");
    // The queue's approver certifies the claim as measured — and certifying is
    // still not collecting: no receipt is recorded anywhere in this schema.
    expect(certifiedClaim.approvedAmountRial).toBe(300_000_000);
    expect(certifiedClaim.certifiedDate).not.toBeNull();

    // §22's "Financial Exposure" queue: the guarantees and insurances whose
    // dates are inside the window, read through the same block §17 stored.
    await withTenant(businessId, () =>
      commercial.saveContractCommercial(owner, contractId, {
        guaranteeType: "performance",
        guaranteeReference: "BG-1405-71",
        guaranteeAmountRial: 250_000_000,
        guaranteeExpiry: "2026-11-01",
        insuranceReference: "INS-7781",
        insuranceExpiry: "2027-06-01",
      }),
    );
    const expiring = await withTenant(businessId, () =>
      commercial.expiringSecurities(businessId, { withinDays: 60, projectId }),
    );
    const guarantee = expiring.find((row) => row.kind === "guarantee");
    expect(guarantee).toBeTruthy();
    expect(guarantee?.reference).toBe("BG-1405-71");
    expect(guarantee?.guaranteeExpiry).toBe("2026-11-01");
    // The insurance is a year out: inside the register, outside the window.
    expect(expiring.some((row) => row.kind === "insurance")).toBe(false);
  });

  it("turns a certified-but-unpaid claim into a reminder through the hourly scan", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ یادآوری");

    // A claim certified long enough ago to be overdue. The service cannot write
    // this: a certified claim is frozen (which is the point of the previous
    // test), and a real register legitimately holds history from before this
    // scan existed — so the fixture is a raw row.
    const { rows: seeded } = await db.query<{ id: string }>(
      `INSERT INTO aec_payment_certificates
         (business_id, project_id, contract_id, certificate_number, kind, period_start, period_end,
          gross_rial, retention_rial, net_rial, approved_amount_rial, status, submitted_date,
          certified_date, created_by, created_by_name)
       VALUES ($1, $2, $3, 'PC-900', 'application', '2026-01-01', '2026-01-31',
               500000000, 0, 500000000, 500000000, 'certified', '2026-02-02', '2026-02-05', $4, 'مالک')
       RETURNING id`,
      [businessId, projectId, contractId, owner.actorUserId],
    );
    expect(seeded[0].id).toBeTruthy();

    const queue = await withTenant(businessId, () =>
      commercial.certifiedClaimsAwaitingPayment(businessId, { afterDays: 30, projectId }),
    );
    expect(queue.map((row) => row.id)).toEqual([seeded[0].id]);
    expect(queue[0].certifiedRial).toBe(500_000_000);
    expect(queue[0].daysSinceCertified).toBeGreaterThan(30);

    // The scan is the same read, wearing §29's hat: it queues the reminder and
    // never touches the register.
    const scanned = await withTenant(businessId, () => scans.scanOverdueAecRegisters(businessId));
    expect(scanned).toBeGreaterThan(0);
    const { rows: events } = await db.query<{ event_key: string }>(
      `SELECT event_key FROM notification_events
        WHERE business_id = $1 AND payload->>'certificateId' = $2`,
      [businessId, seeded[0].id],
    );
    expect(events.map((row) => row.event_key)).toContain("aec.client_payment_overdue");

    // The scan is idempotent within the day: the second sweep re-counts what it
    // looked at, but `recordNotification`'s dedupe key keeps exactly one row —
    // which is what stops an hourly tick from being an hourly notification.
    const again = await withTenant(businessId, () => scans.scanOverdueAecRegisters(businessId));
    expect(again).toBeGreaterThan(0);
    const { rows: afterSecondSweep } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification_events
        WHERE business_id = $1 AND event_key = 'aec.client_payment_overdue'`,
      [businessId],
    );
    expect(afterSecondSweep[0].n).toBe(1);

    // A restaurant is answered with a no-op, not an exception.
    const restaurant = await provisionBusiness("food_service");
    const swept = await withTenant(restaurant.businessId, () =>
      scans.scanOverdueAecRegisters(restaurant.businessId),
    );
    expect(swept).toBe(0);
  });
});

describe("gates and tenancy", () => {
  it("gates each register on its own capability while the cockpit rides `financials`", async () => {
    // The design preset has `financials` and neither of the two registers — an
    // office that draws can see a project's money without ever raising a change
    // order. Three switches, three answers, on one fixture.
    const { businessId, owner } = await provisionBusiness("architecture_construction", "design");
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ دفتر طراحی");

    const summary = await withTenant(businessId, () =>
      commercial.getProjectCommercialSummary(owner, projectId),
    );
    expect(summary.revisedContractRial).toBe(0);

    await withTenant(businessId, async () => {
      await expect(
        commercial.createVariation(owner, projectId, { description: "تغییر در دفتر طراحی" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      await expect(
        commercial.createCertificate(owner, projectId, {
          periodStart: "2026-01-01",
          periodEnd: "2026-01-31",
          grossRial: 1_000_000,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      await expect(commercial.pendingVariations(businessId)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
    });

    // A café is refused at the industry, not at a capability.
    const restaurant = await provisionBusiness("food_service");
    const cafeProject = await createProject(
      restaurant.businessId,
      restaurant.owner.actorUserId,
      "پروژهٔ کافه",
    );
    await withTenant(restaurant.businessId, async () => {
      await expect(
        commercial.getProjectCommercialSummary(restaurant.owner, cafeProject),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "industry_mismatch");
        return true;
      });
    });
  });

  it("keeps another business's contract, project and party out of reach", async () => {
    const alpha = await provisionBusiness();
    const beta = await provisionBusiness();
    const { projectId: alphaProject, contractId: alphaContract } = await seedContract(
      alpha.owner,
      "پروژهٔ آلفا",
    );
    const { projectId: betaProject, contractId: betaContract } = await seedContract(
      beta.owner,
      "پروژهٔ بتا",
    );
    const betaParty = await createParty(beta.businessId, "پیمانکار بتا");

    // The predicate: β's contract is not β's to α, and α's project is not β's.
    await withTenant(alpha.businessId, async () => {
      await expect(
        commercial.loadContractCommercial(alpha.businessId, betaContract),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "contract_not_found");
        return true;
      });
      await expect(
        commercial.createVariation(alpha.owner, betaProject, { description: "تغییر روی پروژهٔ دیگری" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "project_not_found");
        return true;
      });
      await expect(
        commercial.createVariation(alpha.owner, alphaProject, {
          contractId: betaContract,
          description: "تغییر با قرارداد دیگری",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "contract_not_found");
        return true;
      });
      await expect(
        commercial.createVariation(alpha.owner, alphaProject, {
          responsiblePartyId: betaParty,
          description: "تغییر با طرف دیگر",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "party_not_found");
        return true;
      });
    });

    // …and the trigger refuses the same write made with raw SQL, so tenancy does
    // not depend on the service being the only writer.
    await expect(
      db.query(
        `INSERT INTO aec_variations
           (business_id, project_id, contract_id, variation_number, description, created_by_name)
         VALUES ($1, $2, $3, 'VO-777', 'تلاش میان‌مستأجری', 'مهاجم')`,
        [alpha.businessId, alphaProject, betaContract],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(
        `INSERT INTO aec_payment_certificates
           (business_id, project_id, contract_id, certificate_number, period_start, period_end,
            gross_rial, net_rial, created_by_name)
         VALUES ($1, $2, $3, 'PC-777', '2026-01-01', '2026-01-31', 1000, 1000, 'مهاجم')`,
        [alpha.businessId, betaProject, alphaContract],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^235(03|14)$/) });
  });

  it("links real Media Library files to both registers and refuses a foreign project's file", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ پیوست‌ها");
    const asset = await addMediaAsset(businessId, owner.actorUserId, "variation-backup.pdf");

    const variation = await withTenant(businessId, () =>
      commercial.createVariation(owner, projectId, {
        contractId,
        description: "تغییر دارای پیوست",
        attachments: [{ mediaAssetId: asset, title: "مستندات تغییر" }],
      }),
    );
    expect(variation.attachments).toHaveLength(1);
    expect(variation.attachments[0].title).toBe("مستندات تغییر");
    expect(variation.attachmentCount).toBe(1);

    const certificate = await withTenant(businessId, () =>
      commercial.createCertificate(owner, projectId, {
        contractId,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        grossRial: 100_000_000,
        attachments: [{ mediaAssetId: asset, title: "صورت‌وضعیت امضاشده" }],
      }),
    );
    expect(certificate.attachmentCount).toBe(1);

    const { rows } = await db.query<{ variation_id: string | null; payment_certificate_id: string | null; project_id: string }>(
      `SELECT variation_id, payment_certificate_id, project_id FROM workspace_documents
        WHERE business_id = $1 AND (variation_id = $2 OR payment_certificate_id = $3)`,
      [businessId, variation.id, certificate.id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.project_id).toBe(projectId);

    // Cross-project attachment is refused by the trigger, not only by the
    // service: the document's owner is compared with the register row's.
    const other = await seedContract(owner, "پروژهٔ دیگر");
    const foreign = await withTenant(businessId, () =>
      commercial.createVariation(owner, other.projectId, { description: "تغییر پروژهٔ دیگر" }),
    );
    const { rows: documentRows } = await db.query<{ id: string }>(
      `SELECT id FROM workspace_documents WHERE business_id = $1 AND variation_id = $2`,
      [businessId, variation.id],
    );
    await expect(
      db.query(`UPDATE workspace_documents SET variation_id = $2 WHERE id = $1`, [
        documentRows[0].id,
        foreign.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("moves the responsible party of a change still being prepared, and leaves a submitted one alone", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, contractId } = await seedContract(owner, "پروژهٔ ادغام تجاری");
    const loser = await createParty(businessId, "پیمانکار ادغام‌شدنی", ["customer"]);
    const survivor = await createParty(businessId, "پیمانکار بازمانده", ["customer"]);

    const draft = await withTenant(businessId, () =>
      commercial.createVariation(owner, projectId, {
        contractId,
        description: "تغییر در حال تنظیم",
        responsiblePartyId: loser,
      }),
    );
    const sent = await seedPricedVariation(
      owner,
      projectId,
      contractId,
      "تغییر ارسال‌شده",
      200_000_000,
      200_000_000,
    );
    // A priced order is still being prepared, so the party may be set on it.
    await db.query(`UPDATE aec_variations SET responsible_party_id = $2 WHERE id = $1`, [sent, loser]);
    await withTenant(businessId, () => commercial.applyVariationAction(owner, sent, "submit"));

    const merged = await withTenant(businessId, () =>
      crm.mergeCustomers(businessId, survivor, loser, { mergedByUserId: owner.actorUserId }),
    );
    expect(merged).not.toBeNull();

    const { rows } = await db.query<{ id: string; responsible_party_id: string | null }>(
      `SELECT id, responsible_party_id FROM aec_variations
        WHERE business_id = $1 AND id IN ($2, $3)`,
      [businessId, draft.id, sent],
    );
    const byId = new Map(rows.map((row) => [row.id, row.responsible_party_id]));
    // The order still being prepared follows the surviving party — a live
    // register must not name a party the merge removed.
    expect(byId.get(draft.id)).toBe(survivor);
    // The order the client received keeps the party it was raised against: the
    // registry's filter and 0200's freeze agree on that.
    expect(byId.get(sent)).toBe(loser);

    const loaded = await withTenant(businessId, () => commercial.loadVariation(businessId, draft.id));
    expect(loaded.responsiblePartyName).toBe("پیمانکار بازمانده");
  });
});
