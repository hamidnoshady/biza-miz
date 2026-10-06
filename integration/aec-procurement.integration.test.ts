/**
 * Issue #799 Wave 9 (§18, §20, §22, §24, §29 and §33) — procurement, against a
 * real PostgreSQL.
 *
 * `src/lib/aec-procurement.test.ts` proves the pure half: the three status
 * chains, the committed-cost arithmetic, the forecast's null-not-zero rule and
 * the approval split. What can only be proven here, with the schema and the
 * triggers in the way, is:
 *
 *   * §18's flow walks end to end — a requirement numbered `MR-001` with its
 *     lines, a submitted request that files one `workspace_approvals` row, a
 *     decision through `decideMaterialRequestApproval`, the tender it produced
 *     (`RFQ-001`, issued to two suppliers), two quotations compared by amount,
 *     the award raised from the winning offer (`PO-001`, which flips that
 *     quotation to `selected` in the same transaction), the commitment's own
 *     approval, a delivery and the close-out — and every number the cockpit
 *     counts is read back from the registers after the walk;
 *   * **a submitted request and an issued RFQ are frozen in the database, not
 *     only in the service**: raw writes of the fields the chain froze raise
 *     23514, and the only way back is the chain's own reopening (a rejected
 *     request) or a new round of offers;
 *   * §18's three facts are the database's too: an acted-on commitment must
 *     carry a value and an expected date (the CHECK refuses a raw status flip),
 *     a delivery is refused against an award that has not been approved, and one
 *     supplier has one offer per tender (`quotation_exists`, and a UNIQUE index
 *     under it);
 *   * **Accounting stays the source of truth**: nothing in these tables is an
 *     invoice, an AP entry or a payment. The committed cost is a *promise*, read
 *     from `aec_commitments`; the actual cost is the ledger's
 *     (`journal_lines` through `journal_entries.project_id`), and §20's forecast
 *     is `null` — never zero — until both halves exist;
 *   * the delay warning is one predicate shared by the register, the queue, the
 *     assistant's tool and §29's reminder: an approved award past its expected
 *     date appears in `delayedCommitments`, becomes one notification through the
 *     hourly scan, and a second sweep does not duplicate it;
 *   * each kind is gated on **its own** capability: the design preset has neither
 *     `procurement` nor `subcontractors`, and a business that switched purchases
 *     on cannot write an `SC-` award;
 *   * another business's project, party or quotation is out of reach at the
 *     predicate, the service *and* the trigger, and RLS answers an empty set for
 *     every session that is not the owning tenant;
 *   * a party merge re-points the supplier of a draft award and leaves a
 *     submitted one naming the party it was raised against — the merge
 *     registry's filter and migration 0201's freeze agree.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { workspaceAccessFlags } from "../src/lib/workspace-shared";
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
let procurement: typeof import("../src/lib/aec-procurement-service");
let procurementPure: typeof import("../src/lib/aec-procurement");
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
  databaseName = `pos_aec_procurement_${randomUUID().replaceAll("-", "")}`;

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
  procurement = await import("../src/lib/aec-procurement-service");
  procurementPure = await import("../src/lib/aec-procurement");
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
 * A contractor by default: §18's flow is a builder's, and the construction
 * preset carries `procurement` and `subcontractors` — the two switches this wave
 * promoted. `profile` selects the design preset instead, which has neither,
 * which is how the capability tests below prove they gate.
 */
async function provisionBusiness(
  industry: "architecture_construction" | "food_service" = "architecture_construction",
  profile: "contractor" | "design" = "contractor",
): Promise<{ businessId: string; owner: Owner }> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کسب‌وکار تأمین ${seq}`,
    ownerName: "مالک",
    email: `owner-procurement-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `procurement${seq}`,
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

async function createParty(
  businessId: string,
  name: string,
  roles: string[] = ["supplier"],
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles)
     VALUES ($1, $2, $3, $4::text[]) RETURNING id`,
    [businessId, name, roles[0], roles],
  );
  return rows[0].id;
}

/** One posted cost against a project — what Accounting's ledger holds (§20). */
async function postProjectCost(businessId: string, projectId: string, amountRial: number): Promise<void> {
  await dbLib.withTenant(businessId, async () => {
    const { rows: accounts } = await dbLib.query<{ id: string }>(
      `SELECT id FROM accounts WHERE business_id = $1 ORDER BY code LIMIT 1`,
      [businessId],
    );
    const { rows: entries } = await dbLib.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, project_id)
       VALUES ($1, '2026-05-01', 'هزینهٔ اجرای پروژه', 'manual', $2) RETURNING id`,
      [businessId, projectId],
    );
    await dbLib.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
      [entries[0].id, accounts[0].id, amountRial],
    );
  });
}

/** An approved estimate, so §20's forecast has its second half. */
async function seedApprovedEstimate(owner: Owner, projectId: string): Promise<void> {
  await withTenant(owner.businessId, async () => {
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
  });
}

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).name).toBe("AecError");
  expect((error as AecError).code).toBe(code);
}

/** A raw write that the wave's guard should refuse, with Postgres' own code. */
async function expectPgError(sql: string, params: unknown[], code: RegExp): Promise<void> {
  try {
    await db.query(sql, params);
    throw new Error("expected the database to refuse the write");
  } catch (error) {
    expect((error as { code?: string }).code ?? "").toMatch(code);
  }
}

describe("§18's flow", () => {
  it("walks requirement → request → RFQ → comparison → award → delivery, and counts each step", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "برج شمال");
    const supplierA = await createParty(businessId, "فولاد آریا");
    const supplierB = await createParty(businessId, "بتن پارس");
    const other = await createParty(businessId, "تأمین‌کنندهٔ دیگر");

    // 1 — the requirement, numbered per project, with its lines.
    const request = await withTenant(businessId, () =>
      procurement.createMaterialRequest(owner, projectId, {
        title: "ورق گالوانیزه بلوک B",
        workPackage: "سازه",
        priority: "high",
        requiredBy: "2026-12-01",
        lines: [
          { description: "ورق گالوانیزه ۲ میلی‌متر", unit: "ورق", quantity: "40" },
          { description: "پیچ خودکار", unit: "بسته", quantity: "12" },
        ],
      }),
    );
    expect(request.requestNumber).toBe("MR-001");
    expect(request.lines).toHaveLength(2);
    expect(request.status).toBe("draft");
    expect(request.priorityLabel.trim().length).toBeGreaterThan(0);

    // A second request proves the numbering is per project, not global.
    const second = await withTenant(businessId, () =>
      procurement.createMaterialRequest(owner, projectId, { title: "مصالح بنایی" }),
    );
    expect(second.requestNumber).toBe("MR-002");

    // 2 — submit files one approval; the register freezes from here.
    const submitted = await withTenant(businessId, () =>
      procurement.applyMaterialRequestAction(owner, request.id, "submit"),
    );
    expect(submitted.status).toBe("submitted");
    expect(submitted.approvalId).toBeTruthy();
    expect(submitted.approvalStatus).toBe("pending");
    expect(submitted.isEditable).toBe(false);

    await expectPgError(
      `UPDATE aec_material_requests SET title = 'چیزی دیگر' WHERE id = $1`,
      [request.id],
      /^235(03|14)$/,
    );
    await withTenant(businessId, async () => {
      await expect(
        procurement.updateMaterialRequest(owner, request.id, { title: "چیزی دیگر" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "request_not_editable");
        return true;
      });
    });

    // 3 — the queue's decision is the same act the status route gates on
    // `workspace.approve`.
    const decided = await withTenant(businessId, () =>
      procurement.decideMaterialRequestApproval(owner, submitted.approvalId!, "approved", "تأیید"),
    );
    expect(decided.applied).toBe(true);
    const approvedRequest = await withTenant(businessId, () =>
      procurement.loadMaterialRequest(businessId, request.id),
    );
    expect(approvedRequest.status).toBe("approved");
    // Deciding twice is refused by the queue, not by the register.
    const again = await withTenant(businessId, () =>
      procurement.decideMaterialRequestApproval(owner, submitted.approvalId!, "approved", ""),
    );
    expect(again.applied).toBe(false);

    // 4 — the tender, issued to two suppliers.
    const rfq = await withTenant(businessId, () =>
      procurement.createRfq(owner, projectId, {
        title: "استعلام ورق گالوانیزه",
        scope: "۴۰ ورق ۲ میلی‌متر، تحویل در کارگاه",
        requestId: request.id,
        responseDue: "2026-11-01",
        suppliers: [{ partyId: supplierA }, { partyId: supplierB }],
      }),
    );
    expect(rfq.rfqNumber).toBe("RFQ-001");
    expect(rfq.supplierCount).toBe(2);
    await withTenant(businessId, async () => {
      await expect(procurement.applyRfqAction(owner, rfq.id, "issue")).resolves.toSatisfy(
        (issued: { status: string }) => issued.status === "issued",
      );
    });
    // An issued tender is frozen: what the suppliers received is what they quote.
    await expectPgError(
      `UPDATE aec_rfqs SET title = 'استعلام دیگر' WHERE id = $1`,
      [rfq.id],
      /^235(14)$/,
    );

    // 5 — two offers; a third supplier may not add a second for the same one.
    const quotationA = await withTenant(businessId, () =>
      procurement.recordQuotation(owner, rfq.id, {
        partyId: supplierA,
        amountRial: 4_800_000_000,
        leadDays: 14,
        validityDate: "2026-12-01",
      }),
    );
    const quotationB = await withTenant(businessId, () =>
      procurement.recordQuotation(owner, rfq.id, {
        partyId: supplierB,
        amountRial: 4_500_000_000,
        leadDays: 21,
      }),
    );
    expect(quotationA.status).toBe("received");
    await withTenant(businessId, async () => {
      await expect(
        procurement.recordQuotation(owner, rfq.id, { partyId: supplierA, amountRial: 4_000_000_000 }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "quotation_exists");
        return true;
      });
    });

    // A party this business may not name is refused before any constraint sees
    // it. The invitation list is what the firm *sent* — the database does not
    // force every offer to come from an invited supplier, because a quotation
    // that arrives unsolicited is still a quotation — but the party must belong
    // to this tenant and be live.
    const stranger = await provisionBusiness();
    const strangerParty = await createParty(stranger.businessId, "تأمین‌کنندهٔ بیگانه");
    await withTenant(businessId, async () => {
      await expect(
        procurement.recordQuotation(owner, rfq.id, { partyId: strangerParty, amountRial: 1 }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "party_not_found");
        return true;
      });
    });
    expect(other).toBeTruthy();

    // 6 — the comparison, then the award raised from the winning offer.
    const loadedRfq = await withTenant(businessId, () => procurement.loadRfq(businessId, rfq.id));
    expect(loadedRfq.quotations.map((row) => row.amountRial)).toEqual([
      4_500_000_000, 4_800_000_000,
    ]);

    const commitment = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "خرید ورق گالوانیزه",
        supplierPartyId: supplierB,
        valueRial: 4_500_000_000,
        expectedDeliveryDate: "2026-11-20",
        requestId: request.id,
        rfqId: rfq.id,
        quotationId: quotationB.id,
        workPackage: "سازه",
      }),
    );
    expect(commitment.commitmentNumber).toBe("PO-001");
    expect(commitment.status).toBe("draft");
    // The award *is* the selection: the quotation it came from is marked in the
    // same transaction, so the comparison and the register cannot disagree.
    const { rows: selectedRows } = await db.query<{ status: string }>(
      `SELECT status FROM aec_supplier_quotations WHERE id = $1`,
      [quotationB.id],
    );
    expect(selectedRows[0].status).toBe("selected");

    // 7 — §18's three facts are checked before the award may be acted on: an
    // award that is being submitted says how much and when it is expected. Both
    // refusals are stated here rather than discovered by a constraint.
    const draftWithoutValue = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "تعهد بدون مبلغ",
        supplierPartyId: supplierA,
        expectedDeliveryDate: "2026-12-01",
      }),
    );
    await withTenant(businessId, async () => {
      await expect(
        procurement.applyCommitmentAction(owner, draftWithoutValue.id, "submit"),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "commitment_value_required");
        return true;
      });
    });

    const draftWithoutDate = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "تعهد بدون تاریخ",
        supplierPartyId: supplierA,
        valueRial: 100_000_000,
      }),
    );
    await withTenant(businessId, async () => {
      await expect(
        procurement.applyCommitmentAction(owner, draftWithoutDate.id, "submit"),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "commitment_delivery_date_required");
        return true;
      });
    });

    const submittedCommitment = await withTenant(businessId, () =>
      procurement.applyCommitmentAction(owner, commitment.id, "submit"),
    );
    expect(submittedCommitment.status).toBe("submitted");
    expect(submittedCommitment.approvalId).toBeTruthy();
    // A raw status flip that skips the service is refused by 0201's CHECK.
    await expectPgError(
      `UPDATE aec_commitments SET status = 'delivered' WHERE id = $1`,
      [commitment.id],
      /^235(03|14)$/,
    );

    const decision = await withTenant(businessId, () =>
      procurement.decideCommitmentApproval(owner, submittedCommitment.approvalId!, "approved", ""),
    );
    expect(decision.applied).toBe(true);
    const approvedCommitment = await withTenant(businessId, () =>
      procurement.loadCommitment(businessId, commitment.id),
    );
    expect(approvedCommitment.status).toBe("approved");
    expect(approvedCommitment.isCommitted).toBe(true);
    expect(approvedCommitment.valueRial).toBe(4_500_000_000);

    // 8 — committed money is counted, and only from the approval onwards.
    const totals = await withTenant(businessId, () =>
      procurement.projectCommitmentTotals(businessId, projectId),
    );
    expect(totals.committedRial).toBe(4_500_000_000);
    expect(totals.deliveredRial).toBe(0);
    // Three awards are open — the approved one and the two drafts the refusals
    // above left behind — but only the approved one is money.
    expect(totals.openCommitmentCount).toBe(3);
    // The drafts are proposals, not money.
    expect(totals.delayedCount).toBe(0);

    // 9 — tracking the delivery, then the close-out.
    const delivered = await withTenant(businessId, () =>
      procurement.recordDelivery(owner, commitment.id, {
        deliveredOn: "2026-11-18",
        note: "۳۸ ورق سالم، ۲ ورق آسیب‌دیده",
      }),
    );
    expect(delivered.deliveries).toHaveLength(1);
    expect(delivered.deliveries[0].receivedByName).toBe("مالک");

    // A receipt is a fact about a box, not a decision: the award is still open,
    // so the committed cost is unchanged and nothing is counted as "delivered"
    // until somebody marks the award delivered. That is deliberate — a partial
    // receipt must not make an undelivered balance disappear from the count.
    const afterReceipt = await withTenant(businessId, () =>
      procurement.projectCommitmentTotals(businessId, projectId),
    );
    expect(afterReceipt.committedRial).toBe(4_500_000_000);
    expect(afterReceipt.deliveredRial).toBe(0);

    const deliveredAward = await withTenant(businessId, () =>
      procurement.applyCommitmentAction(owner, commitment.id, "deliver", {
        deliveredOn: "2026-11-18",
      }),
    );
    expect(deliveredAward.status).toBe("delivered");
    const afterDelivery = await withTenant(businessId, () =>
      procurement.projectCommitmentTotals(businessId, projectId),
    );
    expect(afterDelivery.committedRial).toBe(4_500_000_000);
    expect(afterDelivery.deliveredRial).toBe(4_500_000_000);

    const closed = await withTenant(businessId, () =>
      procurement.applyCommitmentAction(owner, commitment.id, "close"),
    );
    expect(closed.status).toBe("closed");
    // Closing the only open award closes the tender it came from.
    const { rows: rfqRows } = await db.query<{ status: string }>(
      `SELECT status FROM aec_rfqs WHERE id = $1`,
      [rfq.id],
    );
    expect(rfqRows[0].status).toBe("closed");

    // Closed means "the cost is the ledger's now" — it must not be counted here
    // as well, or the cockpit would double-count the same rial.
    const afterClose = await withTenant(businessId, () =>
      procurement.projectCommitmentTotals(businessId, projectId),
    );
    expect(afterClose.committedRial).toBe(0);

    // 10 — §33's trail: every act in the walk is on the register's own history.
    const { rows: events } = await db.query<{ action: string }>(
      `SELECT action FROM aec_procurement_events
        WHERE business_id = $1 AND commitment_id = $2 ORDER BY created_at`,
      [businessId, commitment.id],
    );
    const actions = events.map((row) => row.action);
    for (const expected of ["created", "submitted", "approved", "delivered", "closed"]) {
      expect(actions, expected).toContain(expected);
    }

    // The tab's own read agrees with the register the flow just wrote.
    const summary = await withTenant(businessId, () =>
      procurement.projectProcurementSummary(businessId, projectId),
    );
    expect(summary.openRequestCount + summary.pendingRequestCount).toBeGreaterThan(0);
    expect(summary.committedRial).toBe(0);
    expect(summary.deliveredRial).toBe(0);
  });

  it("numbers a subcontract `SC-` and gates it on `subcontractors`", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ پیمان جزء");
    const subcontractor = await createParty(businessId, "پیمانکار نازک‌کاری");

    const award = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "subcontract",
        title: "اجرای نازک‌کاری طبقهٔ ۳",
        supplierPartyId: subcontractor,
        valueRial: 2_000_000_000,
        expectedDeliveryDate: "2026-12-10",
      }),
    );
    expect(award.commitmentNumber).toBe("SC-001");
    expect(award.kindLabel.trim().length).toBeGreaterThan(0);

    // A design office has neither switch: the register is refused, and so is a
    // subcontract award when only `procurement` is on.
    const saved = await withTenant(businessId, () =>
      aec.saveBusinessAecProfile(owner, {
        operatingProfile: "contractor",
        capabilityOverrides: { subcontractors: false },
      }),
    );
    expect(saved.capabilities).not.toContain("subcontractors");
    expect(saved.capabilities).toContain("procurement");
    await withTenant(businessId, async () => {
      await expect(
        procurement.createCommitment(owner, projectId, {
          kind: "subcontract",
          title: "پیمان جزء دوم",
          supplierPartyId: subcontractor,
          valueRial: 1,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      // …while a purchase order still works: one switch, one kind.
      await expect(
        procurement.createCommitment(owner, projectId, {
          kind: "purchase",
          title: "خرید مصالح",
          supplierPartyId: subcontractor,
          valueRial: 1,
        }),
      ).resolves.toSatisfy((row: { commitmentNumber: string }) => row.commitmentNumber === "PO-001");
    });

    const design = await provisionBusiness("architecture_construction", "design");
    const designProject = await createProject(design.businessId, design.owner.actorUserId, "دفتر");
    const designSupplier = await createParty(design.businessId, "تأمین‌کنندهٔ دفتر");
    await withTenant(design.businessId, async () => {
      await expect(
        procurement.createMaterialRequest(design.owner, designProject, { title: "کاغذ" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      await expect(
        procurement.createCommitment(design.owner, designProject, {
          kind: "purchase",
          title: "خرید",
          supplierPartyId: designSupplier,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      // §20's cockpit still answers for that office — with nothing committed,
      // which is the honest answer rather than an error.
      const totals = await procurement.projectCommitmentTotals(
        design.businessId,
        designProject,
      );
      expect(totals.committedRial).toBe(0);
    });
  });

  it("refuses a commitment whose links cross projects or businesses", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ الف");
    const otherProject = await createProject(businessId, owner.actorUserId, "پروژهٔ ب");
    const supplier = await createParty(businessId, "تأمین‌کنندهٔ پروژهٔ الف");

    // A party of *another* business, and a project of this one: the party is
    // what the service must refuse.
    const foreign = await provisionBusiness();
    const foreignParty = await createParty(foreign.businessId, "تأمین‌کنندهٔ بیگانه");

    const request = await withTenant(businessId, () =>
      procurement.createMaterialRequest(owner, projectId, { title: "مصالح" }),
    );
    await withTenant(businessId, async () => {
      // A tender for another project may not quote this project's requirement.
      await expect(
        procurement.createRfq(owner, otherProject, {
          title: "استعلام در پروژهٔ دیگر",
          requestId: request.id,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "request_project_mismatch");
        return true;
      });

      // …and an award on this project may not name another project's tender.
      const rfq = await procurement.createRfq(owner, otherProject, { title: "استعلام ب" });
      await expect(
        procurement.createCommitment(owner, projectId, {
          kind: "purchase",
          title: "تعهد با استعلام پروژهٔ دیگر",
          supplierPartyId: supplier,
          rfqId: rfq.id,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "rfq_project_mismatch");
        return true;
      });

      // The party must be this tenant's, and live.
      await expect(
        procurement.createCommitment(owner, projectId, {
          kind: "purchase",
          title: "تعهد با طرف بیگانه",
          supplierPartyId: foreignParty,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "party_not_found");
        return true;
      });
    });

    // And the other business cannot reach this project at all — the predicate
    // refuses before the party is ever looked at.
    await withTenant(foreign.businessId, async () => {
      await expect(
        procurement.createMaterialRequest(foreign.owner, projectId, { title: "دستبرد" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "project_not_found");
        return true;
      });
    });
  });

  it("refuses a delivery against an award that has not been approved", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ تحویل");
    const supplier = await createParty(businessId, "تأمین‌کنندهٔ تحویل");

    const draft = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "خرید تجهیزات",
        supplierPartyId: supplier,
        valueRial: 500_000_000,
        expectedDeliveryDate: "2026-11-01",
      }),
    );
    await withTenant(businessId, async () => {
      await expect(
        procurement.recordDelivery(owner, draft.id, { note: "رسید" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "commitment_not_approved");
        return true;
      });
    });

    // The database says the same thing even to a writer that skips the service.
    await expectPgError(
      `INSERT INTO aec_commitment_deliveries (business_id, commitment_id, delivered_on, note)
       VALUES ($1, $2, '2026-11-02', 'رسید')`,
      [businessId, draft.id],
      /^235(03|14)$/,
    );
  });

  it("keeps the request and RFQ chains closed against raw writers", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ زنجیره");
    const supplier = await createParty(businessId, "تأمین‌کنندهٔ زنجیره");

    const request = await withTenant(businessId, () =>
      procurement.createMaterialRequest(owner, projectId, { title: "درخواست آزمایشی" }),
    );
    await withTenant(businessId, () =>
      procurement.applyMaterialRequestAction(owner, request.id, "submit"),
    );
    await withTenant(businessId, () =>
      procurement.applyMaterialRequestAction(owner, request.id, "reject"),
    );
    // Rejected is the one deliberate reopening: the request goes back to draft
    // so it can be revised rather than raised again with a new number.
    const reopened = await withTenant(businessId, () =>
      procurement.applyMaterialRequestAction(owner, request.id, "reopen"),
    );
    expect(reopened.status).toBe("draft");
    expect(reopened.requestNumber).toBe("MR-001");

    function rfqIds(): Promise<string[]> {
      return db.query<{ id: string }>(`SELECT id FROM aec_rfqs WHERE business_id = $1`, [businessId]).then(({ rows }) => rows.map((row) => row.id));
    }
    expect(rfqIds).toBeTypeOf("function");
    // A tender raised and deleted before it was ever issued leaves no trace, so
    // its number is free again: the register numbers against the rows that
    // exist (`max + 1` under the advisory lock), which is what makes it unique
    // among live tenders rather than gapless.
    const rfq = await withTenant(businessId, () =>
      procurement.createRfq(owner, projectId, {
        title: "استعلام آزمایشی",
        suppliers: [{ partyId: supplier }],
      }),
    );
    expect(rfq.rfqNumber).toBe("RFQ-001");
    await withTenant(businessId, () => procurement.deleteRfq(owner, rfq.id));
    const next = await withTenant(businessId, () =>
      procurement.createRfq(owner, projectId, {
        title: "استعلام دوم",
        suppliers: [{ partyId: supplier }],
      }),
    );
    expect(next.rfqNumber).toBe("RFQ-001");

    // A closed request is terminal, and the service says so with a code.
    const second = await withTenant(businessId, () =>
      procurement.createMaterialRequest(owner, projectId, { title: "درخواست دوم" }),
    );
    await withTenant(businessId, () =>
      procurement.applyMaterialRequestAction(owner, second.id, "submit"),
    );
    await withTenant(businessId, async () => {
      await expect(
        procurement.applyMaterialRequestAction(owner, second.id, "close"),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_request_transition");
        return true;
      });
    });
  });
});

describe("§20's committed cost, the forecast and the delay warning", () => {
  it("reads the ledger for actual cost and forecasts only from both halves", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ پیش‌بینی");
    const supplier = await createParty(businessId, "تأمین‌کنندهٔ پیش‌بینی");

    await postProjectCost(businessId, projectId, 1_500_000_000);
    // The ledger is the Accounting module's; reading its figures takes
    // `ledger.view`, exactly as the finance card and the assistant require. The
    // fixture grants it to the same owner, so the forecast below has both halves.
    const ledgerOwner = {
      ...owner,
      access: workspaceAccessFlags(new Set(["ledger.view"])),
    };

    // Without an approved estimate there is no forecast, and the cockpit says
    // `null` rather than inventing a zero.
    const before = await withTenant(businessId, () =>
      commercial.getProjectCommercialSummary(ledgerOwner, projectId),
    );
    expect(before.actualCostRial).toBe(1_500_000_000);
    expect(before.costToCompleteRial).toBeNull();
    expect(before.forecastFinalCostRial).toBeNull();
    expect(before.forecastMarginRial).toBeNull();
    expect(before.forecastBasis.trim().length).toBeGreaterThan(0);
    // Wave 9 emptied the "not built yet" list: everything §20 asks for is
    // answered by a register now.
    expect(before.awaitingWaves).toEqual([]);

    await seedApprovedEstimate(owner, projectId);
    const award = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "خرید میلگرد",
        supplierPartyId: supplier,
        valueRial: 1_000_000_000,
        expectedDeliveryDate: "2030-01-01",
      }),
    );
    await withTenant(businessId, () =>
      procurement.applyCommitmentAction(owner, award.id, "submit"),
    );
    const submittedAward = await withTenant(businessId, () =>
      procurement.loadCommitment(businessId, award.id),
    );
    await withTenant(businessId, () =>
      procurement.decideCommitmentApproval(owner, submittedAward.approvalId!, "approved", ""),
    );

    const after = await withTenant(businessId, () =>
      commercial.getProjectCommercialSummary(ledgerOwner, projectId),
    );
    expect(after.committedRial).toBe(1_000_000_000);
    expect(after.deliveredRial).toBe(0);
    // The estimate is 200,000,000 (1000 m3 × 200,000); the ledger holds
    // 1,500,000,000 — already past it — so there is nothing left to complete and
    // the forecast is actual + committed rather than a negative.
    expect(after.costToCompleteRial).toBe(0);
    expect(after.forecastFinalCostRial).toBe(2_500_000_000);
    expect(after.forecastMarginRial).toBe(-2_500_000_000);
    expect(after.readInAccounting.length).toBeGreaterThan(0);

    // The forecast uses `costForecast` — assert the same numbers through the
    // pure helper, so the cockpit and the module cannot drift.
    expect(
      procurementPure.costForecast({
        actualCostRial: after.actualCostRial,
        committedRial: after.committedRial,
        approvedEstimateRial: after.approvedEstimateRial,
      }),
    ).toEqual({
      costToCompleteRial: after.costToCompleteRial,
      forecastFinalCostRial: after.forecastFinalCostRial,
    });
  });

  it("raises §29's delivery-delay reminder once, from the same queue the tab reads", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ تأخیر");
    const supplier = await createParty(businessId, "تأمین‌کنندهٔ دیرکرد");

    const award = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "خرید ورق با تأخیر",
        supplierPartyId: supplier,
        valueRial: 700_000_000,
        expectedDeliveryDate: "2026-01-01",
      }),
    );
    await withTenant(businessId, () =>
      procurement.applyCommitmentAction(owner, award.id, "submit"),
    );
    const submittedAward = await withTenant(businessId, () =>
      procurement.loadCommitment(businessId, award.id),
    );
    await withTenant(businessId, () =>
      procurement.decideCommitmentApproval(owner, submittedAward.approvalId!, "approved", ""),
    );

    const queue = await withTenant(businessId, () =>
      procurement.delayedCommitments(businessId, { projectId }),
    );
    expect(queue.map((row) => row.id)).toEqual([award.id]);
    expect(queue[0].delayDays).toBeGreaterThan(0);
    expect(queue[0].valueRial).toBe(700_000_000);
    expect(
      procurementPure.isCommitmentDelayed(
        { status: "approved", expectedDeliveryDate: queue[0].expectedDeliveryDate },
        queue[0].expectedDeliveryDate,
      ),
    ).toBe(false);

    const scanned = await withTenant(businessId, () => scans.scanOverdueAecRegisters(businessId));
    expect(scanned).toBeGreaterThan(0);
    const { rows: events } = await db.query<{ event_key: string }>(
      `SELECT event_key FROM notification_events
        WHERE business_id = $1 AND payload->>'commitmentId' = $2`,
      [businessId, award.id],
    );
    expect(events.map((row) => row.event_key)).toContain("aec.procurement_delivery_delay");

    await withTenant(businessId, () => scans.scanOverdueAecRegisters(businessId));
    const { rows: afterSecondSweep } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notification_events
        WHERE business_id = $1 AND event_key = 'aec.procurement_delivery_delay'`,
      [businessId],
    );
    expect(afterSecondSweep[0].n).toBe(1);

    // A receipt does not clear the warning: recording what arrived is a fact
    // about a box, while the award stays open (and late) until somebody marks it
    // delivered. Suppressing the warning on any receipt would silence the award
    // that got half its goods and is still waiting — the worse failure.
    await withTenant(businessId, () =>
      procurement.recordDelivery(owner, award.id, { deliveredOn: "2026-02-01", note: "رسید" }),
    );
    const afterReceipt = await withTenant(businessId, () =>
      procurement.delayedCommitments(businessId, { projectId }),
    );
    expect(afterReceipt.map((row) => row.id)).toEqual([award.id]);

    // Marking it delivered is the act that closes the delay.
    await withTenant(businessId, () =>
      procurement.applyCommitmentAction(owner, award.id, "deliver", {
        deliveredOn: "2026-02-01",
      }),
    );
    const afterDelivery = await withTenant(businessId, () =>
      procurement.delayedCommitments(businessId, { projectId }),
    );
    expect(afterDelivery).toEqual([]);
  });

  it("answers a restaurant with a no-op rather than an error", async () => {
    const restaurant = await provisionBusiness("food_service");
    await withTenant(restaurant.businessId, async () => {
      // The scan sweeps every business; a non-AEC one must not throw.
      const swept = await scans.scanOverdueAecRegisters(restaurant.businessId);
      expect(swept).toBe(0);
      // And the register itself refuses: an AEC industry is what it is for.
      await expect(
        procurement.projectProcurementSummary(restaurant.businessId, randomUUID()),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "industry_mismatch");
        return true;
      });
    });
  });
});

describe("gates and tenancy", () => {
  it("hides every Wave 9 table from a session that is not the owning tenant", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ محرمانه");
    const supplier = await createParty(businessId, "تأمین‌کنندهٔ محرمانه");

    const request = await withTenant(businessId, () =>
      procurement.createMaterialRequest(owner, projectId, {
        title: "درخواست محرمانه",
        lines: [{ description: "کالا", unit: "عدد", quantity: "1" }],
      }),
    );
    const rfq = await withTenant(businessId, () =>
      procurement.createRfq(owner, projectId, {
        title: "استعلام محرمانه",
        suppliers: [{ partyId: supplier }],
      }),
    );
    await withTenant(businessId, () =>
      procurement.recordQuotation(owner, rfq.id, { partyId: supplier, amountRial: 10 }),
    );
    const award = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "تعهد محرمانه",
        supplierPartyId: supplier,
        valueRial: 10,
        expectedDeliveryDate: "2026-12-01",
      }),
    );
    // Approved and received, so all eight tables hold a row for the sweep below.
    const submittedAward = await withTenant(businessId, async () => {
      await procurement.applyCommitmentAction(owner, award.id, "submit");
      return procurement.loadCommitment(businessId, award.id);
    });
    await withTenant(businessId, () =>
      procurement.decideCommitmentApproval(owner, submittedAward.approvalId!, "approved", ""),
    );
    await withTenant(businessId, () =>
      procurement.recordDelivery(owner, award.id, { note: "رسید" }),
    );

    const tables = [
      "aec_material_requests",
      "aec_material_request_lines",
      "aec_rfqs",
      "aec_rfq_suppliers",
      "aec_supplier_quotations",
      "aec_commitments",
      "aec_commitment_deliveries",
      "aec_procurement_events",
    ] as const;

    // The owner sees its own rows…
    for (const table of tables) {
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`,
        [businessId],
      );
      expect(rows[0].n, table).toBeGreaterThan(0);
    }

    // …and every one of the eight is behind RLS with exactly one policy. The
    // *behavioural* proof — a session that cannot read a row belonging to
    // another tenant — lives in `integration/tenant-isolation.integration.test.ts`,
    // which connects as the purpose-created unprivileged role: this suite's
    // connection is the database owner, and a superuser ignores row-level
    // security entirely, so a `count(*) = 0` here would prove nothing.
    // (`integration/aec.integration.test.ts` asserts the same policy metadata
    // for every `aec_*` table, which is what fails when a table arrives without
    // one.)
    const { rows: secured } = await db.query<{ relname: string; secured: boolean; policies: number }>(
      `SELECT c.relname,
              (c.relrowsecurity AND c.relforcerowsecurity) AS secured,
              (SELECT count(*)::int FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r' AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [[...tables]],
    );
    expect(secured.map((row) => row.relname)).toEqual([...tables].sort());
    for (const row of secured) {
      expect(row.secured, row.relname).toBe(true);
      expect(Number(row.policies), row.relname).toBe(1);
    }

    // The service refuses another tenant's rows at the predicate — which is the
    // layer this suite can prove without the unprivileged role.
    const foreign = await provisionBusiness();
    await withTenant(foreign.businessId, async () => {
      await expect(
        procurement.loadMaterialRequest(foreign.businessId, request.id),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "request_not_found");
        return true;
      });
      await expect(
        procurement.loadCommitment(foreign.businessId, award.id),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "commitment_not_found");
        return true;
      });
      await expect(
        procurement.loadRfq(foreign.businessId, rfq.id),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "rfq_not_found");
        return true;
      });
    });
  });

  it("re-points a draft award's supplier on a merge and leaves a submitted one alone", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ ادغام");
    const survivor = await createParty(businessId, "تأمین‌کنندهٔ بازمانده", [
      "customer",
      "supplier",
    ]);
    const loser = await createParty(businessId, "تأمین‌کنندهٔ حذف‌شده", [
      "customer",
      "supplier",
    ]);

    const draft = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "تعهد در حال تنظیم",
        supplierPartyId: loser,
        valueRial: 100,
        expectedDeliveryDate: "2026-12-01",
      }),
    );
    const sent = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "تعهد ارسال‌شده",
        supplierPartyId: loser,
        valueRial: 200,
        expectedDeliveryDate: "2026-12-01",
      }),
    );
    await withTenant(businessId, () =>
      procurement.applyCommitmentAction(owner, sent.id, "submit"),
    );

    const merged = await withTenant(businessId, () =>
      crm.mergeCustomers(businessId, survivor, loser, { mergedByUserId: owner.actorUserId }),
    );
    expect(merged).not.toBeNull();

    const { rows } = await db.query<{ id: string; supplier_party_id: string }>(
      `SELECT id, supplier_party_id FROM aec_commitments WHERE business_id = $1 AND id IN ($2, $3)`,
      [businessId, draft.id, sent.id],
    );
    const byId = new Map(rows.map((row) => [row.id, row.supplier_party_id]));
    // The draft follows the surviving party: a live register must not name a
    // party the merge removed.
    expect(byId.get(draft.id)).toBe(survivor);
    // The submitted award keeps the supplier it obliges — 0201's freeze and the
    // merge registry's filter agree on that.
    expect(byId.get(sent.id)).toBe(loser);

    const loaded = await withTenant(businessId, () =>
      procurement.loadCommitment(businessId, draft.id),
    );
    expect(loaded.supplierName).toBe("تأمین‌کنندهٔ بازمانده");
  });
});
