import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let wallet: typeof import("../src/lib/wallet-service");
let billing: typeof import("../src/lib/billing-service");
let plans: typeof import("../src/lib/billing-plans-service");
let subs: typeof import("../src/lib/subscription-service");
let ent: typeof import("../src/lib/entitlement-service");
let runtime: typeof import("../src/lib/billing/runtime");
let aiAllowance: typeof import("../src/lib/ai-plan-allowance");
let aiBilling: typeof import("../src/lib/ai-wallet-billing");
let aiGatewayService: typeof import("../src/lib/ai-gateway-service");
let msgBilling: typeof import("../src/lib/messaging-billing");
let gatewayLib: typeof import("../src/lib/payment-gateway");
let dbLib: typeof import("../src/lib/db");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createBusiness(slug: string, plan = "free"): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan, ownership_kind)
     VALUES ($1, $2, $3, $4, 'customer')`,
    [id, `کسب‌وکار ${slug}`, slug, plan],
  );
  return id;
}

beforeAll(async () => {
  databaseName = `pos_billing_audit_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  wallet = await import("../src/lib/wallet-service");
  billing = await import("../src/lib/billing-service");
  plans = await import("../src/lib/billing-plans-service");
  subs = await import("../src/lib/subscription-service");
  ent = await import("../src/lib/entitlement-service");
  runtime = await import("../src/lib/billing/runtime");
  aiAllowance = await import("../src/lib/ai-plan-allowance");
  aiBilling = await import("../src/lib/ai-wallet-billing");
  aiGatewayService = await import("../src/lib/ai-gateway-service");
  msgBilling = await import("../src/lib/messaging-billing");
  gatewayLib = await import("../src/lib/payment-gateway");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  for (const [key, name] of [
    ["ai_agent", "دستیار هوشمند"],
    ["crm", "مدیریت مشتریان"],
    ["insights", "داشبورد تحلیل"],
    ["messaging", "ارسال پیامک و ایمیل"],
  ]) {
    await db.query(
      `INSERT INTO feature_flags (key, name, default_enabled)
       VALUES ($1, $2, true)
       ON CONFLICT (key) DO NOTHING`,
      [key, name],
    );
  }
}, 120_000);

afterAll(async () => {
  await dbLib?.getPool?.().end().catch(() => {});
  await db?.end();
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
});

describe("Superadmin billing & credit audit (#791)", () => {
  it("P0 #1: enforces Zarinpal authority binding, gateway/status preconditions, unique gateway_ref, code 101 idempotency, and stale callback protection", async () => {
    const bizA = await createBusiness("p0-biz-a");
    const bizB = await createBusiness("p0-biz-b");

    await dbLib.withoutTenantScope("platform", async () => {
      await wallet.savePaymentConfig({
        gateway: "zarinpal",
        merchantId: "00000000-0000-0000-0000-000000000001",
        sandbox: true,
        callbackUrl: "https://pos.example.test/api/billing/payments/verify",
        currency: "IRR",
      });
    });

    // Manual payment cannot be verified through Zarinpal verifyPayment
    const manualPay = await dbLib.withTenant(bizA, () =>
      wallet.createPayment({
        businessId: bizA,
        gateway: "manual",
        purpose: "top_up",
        amountRial: 200_000,
        creditRial: 200_000,
        description: "شارژ دستی",
      }),
    );
    await expect(
      dbLib.withoutTenantScope("platform", () =>
        wallet.verifyPayment({ paymentId: manualPay.id, authority: "A0001", statusParam: "OK" }),
      ),
    ).rejects.toThrow("invalid_payment_gateway");

    // Zarinpal payment still in 'pending' (before startPayment redirect) cannot be verified
    const unstartedZarinpal = await dbLib.withTenant(bizA, () =>
      wallet.createPayment({
        businessId: bizA,
        gateway: "zarinpal",
        purpose: "top_up",
        amountRial: 300_000,
        creditRial: 300_000,
        description: "شارژ درگاه",
      }),
    );
    await expect(
      dbLib.withoutTenantScope("platform", () =>
        wallet.verifyPayment({ paymentId: unstartedZarinpal.id, authority: "A0002", statusParam: "OK" }),
      ),
    ).rejects.toThrow("payment_not_pending");

    // Set payment into redirect state with bound authority
    await db.query(
      `UPDATE billing_payments SET status = 'redirect', authority = 'AUTH-BOUND-1', sandbox = true WHERE id = $1`,
      [unstartedZarinpal.id],
    );

    // Cross-business verification is rejected
    await expect(
      dbLib.withoutTenantScope("platform", () =>
        wallet.verifyPayment({
          paymentId: unstartedZarinpal.id,
          businessId: bizB,
          authority: "AUTH-BOUND-1",
          statusParam: "OK",
        }),
      ),
    ).rejects.toThrow("forbidden_business");

    // Authority mismatch is rejected before calling Zarinpal
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      dbLib.withoutTenantScope("platform", () =>
        wallet.verifyPayment({
          paymentId: unstartedZarinpal.id,
          businessId: bizA,
          authority: "AUTH-WRONG",
          statusParam: "OK",
        }),
      ),
    ).rejects.toThrow("authority_mismatch");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Valid Zarinpal verification (code 100) settles and binds gateway_ref
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { code: 100, ref_id: 777888999, card_pan: "6037****1234" }, errors: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const verified1 = await dbLib.withoutTenantScope("platform", () =>
      wallet.verifyPayment({
        paymentId: unstartedZarinpal.id,
        businessId: bizA,
        authority: "AUTH-BOUND-1",
        statusParam: "OK",
      }),
    );
    expect(verified1.status).toBe("verified");
    expect(verified1.gatewayRef).toBe("777888999");

    // Stale NOK callback after verification does NOT overwrite verified status
    const staleCallback = await dbLib.withoutTenantScope("platform", () =>
      wallet.verifyPayment({
        paymentId: unstartedZarinpal.id,
        businessId: bizA,
        authority: "AUTH-BOUND-1",
        statusParam: "NOK",
      }),
    );
    expect(staleCallback.status).toBe("verified");

    // Code 101 retry on already verified payment is idempotent and does not double-credit
    const walletAfterFirst = await dbLib.withTenant(bizA, () => wallet.getWallet(bizA));
    expect(walletAfterFirst.balanceRial).toBe(300_000);

    const retry101 = await dbLib.withoutTenantScope("platform", () =>
      wallet.verifyPayment({
        paymentId: unstartedZarinpal.id,
        businessId: bizA,
        authority: "AUTH-BOUND-1",
        statusParam: "OK",
      }),
    );
    expect(retry101.status).toBe("verified");
    const walletAfterRetry = await dbLib.withTenant(bizA, () => wallet.getWallet(bizA));
    expect(walletAfterRetry.balanceRial).toBe(300_000);

    // Unique gateway_ref per (gateway, sandbox): a second payment cannot reuse ref_id 777888999
    const secondPay = await dbLib.withTenant(bizA, () =>
      wallet.createPayment({
        businessId: bizA,
        gateway: "zarinpal",
        purpose: "top_up",
        amountRial: 300_000,
        creditRial: 300_000,
        description: "شارژ دوم",
      }),
    );
    await db.query(
      `UPDATE billing_payments SET status = 'redirect', authority = 'AUTH-BOUND-2', sandbox = true WHERE id = $1`,
      [secondPay.id],
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { code: 100, ref_id: 777888999 }, errors: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      dbLib.withoutTenantScope("platform", () =>
        wallet.verifyPayment({
          paymentId: secondPay.id,
          businessId: bizA,
          authority: "AUTH-BOUND-2",
          statusParam: "OK",
        }),
      ),
    ).rejects.toThrow("duplicate_gateway_ref");

    fetchSpy.mockRestore();
  });

  it("P1 #2: serializes invoice payments and voids with FOR UPDATE, idempotency keys, and overpayment/void guards", async () => {
    const bizId = await createBusiness("p1-invoice-biz");

    // Create an open invoice for 1,000,000 Rial
    const { rows: invRows } = await db.query<{ id: string }>(
      `INSERT INTO billing_invoices
         (business_id, invoice_number, status, currency, subtotal_rial, discount_rial, tax_rial, total_rial, paid_rial, reference)
       VALUES ($1, 'INV-AUDIT-001', 'open', 'IRR', 1000000, 0, 0, 1000000, 0, 'audit-ref-001')
       RETURNING id`,
      [bizId],
    );
    const invoiceId = invRows[0].id;

    // Apply partial payment with idempotencyKey
    const p1 = await dbLib.withoutTenantScope("platform", () =>
      subs.applyInvoicePayment(invoiceId, 400_000, {
        idempotencyKey: "manual-pay-1",
        note: "قسط اول",
      }),
    );
    expect(p1.status).toBe("partially_paid");
    expect(p1.paidRial).toBe(400_000);

    // Duplicate idempotencyKey is a no-op
    const p1Dup = await dbLib.withoutTenantScope("platform", () =>
      subs.applyInvoicePayment(invoiceId, 400_000, {
        idempotencyKey: "manual-pay-1",
        note: "تکرار قسط اول",
      }),
    );
    expect(p1Dup.paidRial).toBe(400_000);

    // Overpayment (> remaining 600,000) is rejected
    await expect(
      dbLib.withoutTenantScope("platform", () =>
        subs.applyInvoicePayment(invoiceId, 700_000, { idempotencyKey: "overpay-attempt" }),
      ),
    ).rejects.toThrow("overpayment");

    // Cannot void an invoice that already has partial payments
    await expect(
      dbLib.withoutTenantScope("platform", () => subs.voidBillingInvoice(invoiceId)),
    ).rejects.toThrow("payment_applied");

    // Concurrent partial payments of 300,000 + 300,000 serialize cleanly to 1,000,000 (paid)
    const [p2, p3] = await Promise.all([
      dbLib.withoutTenantScope("platform", () =>
        subs.applyInvoicePayment(invoiceId, 300_000, { idempotencyKey: "manual-pay-2" }),
      ),
      dbLib.withoutTenantScope("platform", () =>
        subs.applyInvoicePayment(invoiceId, 300_000, { idempotencyKey: "manual-pay-3" }),
      ),
    ]);
    const finalPaid = Math.max(p2.paidRial, p3.paidRial);
    expect(finalPaid).toBe(1_000_000);

    const paymentsList = await dbLib.withoutTenantScope("platform", () =>
      subs.listInvoicePayments(invoiceId),
    );
    expect(paymentsList).toHaveLength(3);

    // Create a second invoice, void it, and verify payment against void invoice is rejected
    const { rows: inv2Rows } = await db.query<{ id: string }>(
      `INSERT INTO billing_invoices
         (business_id, invoice_number, status, currency, subtotal_rial, discount_rial, tax_rial, total_rial, paid_rial, reference)
       VALUES ($1, 'INV-AUDIT-002', 'open', 'IRR', 500000, 0, 0, 500000, 0, 'audit-ref-002')
       RETURNING id`,
      [bizId],
    );
    const voided = await dbLib.withoutTenantScope("platform", () =>
      subs.voidBillingInvoice(inv2Rows[0].id),
    );
    expect(voided.status).toBe("void");

    await expect(
      dbLib.withoutTenantScope("platform", () =>
        subs.applyInvoicePayment(inv2Rows[0].id, 100_000, { idempotencyKey: "pay-voided" }),
      ),
    ).rejects.toThrow("invoice_void");
  });

  it("P1 #3: unifies effective AI plan allowance across getPlanAllowance, affordability gating, and consumePlanAllowanceTx", async () => {
    const planKey = `ai-plan-${randomUUID().slice(0, 8)}`;
    await dbLib.withoutTenantScope("platform", async () => {
      await plans.saveBillingPlan({
        key: planKey,
        name: "پلن هوش مصنوعی",
        monthlyPriceRial: 1_000_000,
        monthlyAiCreditRial: 500_000,
        status: "active",
        sortOrder: 1,
        limits: {
          branches: { unlimited: true, value: null },
          members: { unlimited: true, value: null },
          monthlyOrders: { unlimited: true, value: null },
        },
      });
    });

    const bizId = await createBusiness("p1-ai-allowance", planKey);
    await dbLib.withoutTenantScope("platform", () =>
      subs.changeBusinessPlan({ businessId: bizId, planKey, source: "admin" }),
    );

    // 1. Before any consumption, configured and effective allowance are 500,000
    const initial = await dbLib.withTenant(bizId, () => aiAllowance.getPlanAllowance(bizId));
    expect(initial.configuredCreditRial).toBe(500_000);
    expect(initial.effectiveCreditRial).toBe(500_000);
    expect(initial.remainingRial).toBe(500_000);

    // 2. First AI turn consumes 200,000 from allowance
    const s1 = await dbLib.withTenant(bizId, () =>
      wallet.settleAiWalletCharge({
        businessId: bizId,
        requestId: randomUUID(),
        chargedRial: 200_000,
      }),
    );
    expect(s1.allowanceAppliedRial).toBe(200_000);
    expect(s1.debitedRial).toBe(0);

    // 3. Superadmin increases plan AI allowance mid-month from 500,000 to 800,000
    await dbLib.withoutTenantScope("platform", async () => {
      await plans.saveBillingPlan({
        key: planKey,
        name: "پلن هوش مصنوعی",
        monthlyPriceRial: 1_000_000,
        monthlyAiCreditRial: 800_000,
        status: "active",
        sortOrder: 1,
      });
    });

    const afterIncrease = await dbLib.withTenant(bizId, () => aiAllowance.getPlanAllowance(bizId));
    expect(afterIncrease.configuredCreditRial).toBe(800_000);
    expect(afterIncrease.effectiveCreditRial).toBe(800_000);
    expect(afterIncrease.usedRial).toBe(200_000);
    expect(afterIncrease.remainingRial).toBe(600_000);

    // Affordability check sees the exact same 600,000 remaining allowance
    const affordIncrease = await dbLib.withTenant(bizId, () =>
      wallet.checkAiAffordability(bizId, 550_000),
    );
    expect(affordIncrease.affordable).toBe(true);
    expect(affordIncrease.allowanceRemainingRial).toBe(600_000);

    // Consuming 450,000 succeeds from the increased allowance (total used = 650,000)
    const s2 = await dbLib.withTenant(bizId, () =>
      wallet.settleAiWalletCharge({
        businessId: bizId,
        requestId: randomUUID(),
        chargedRial: 450_000,
      }),
    );
    expect(s2.allowanceAppliedRial).toBe(450_000);
    expect(s2.debitedRial).toBe(0);

    // 4. Superadmin decreases plan AI allowance mid-month to 300,000 — both getPlanAllowance and consumePlanAllowanceTx agree on the new effective cap (300,000) and remaining = 0
    await dbLib.withoutTenantScope("platform", async () => {
      await plans.saveBillingPlan({
        key: planKey,
        name: "پلن هوش مصنوعی",
        monthlyPriceRial: 1_000_000,
        monthlyAiCreditRial: 300_000,
        status: "active",
        sortOrder: 1,
      });
    });

    const afterDecrease = await dbLib.withTenant(bizId, () => aiAllowance.getPlanAllowance(bizId));
    expect(afterDecrease.configuredCreditRial).toBe(300_000);
    expect(afterDecrease.effectiveCreditRial).toBe(300_000);
    expect(afterDecrease.usedRial).toBe(650_000);
    expect(afterDecrease.remainingRial).toBe(0);

    const affordDecrease = await dbLib.withTenant(bizId, () =>
      wallet.checkAiAffordability(bizId, 50_000),
    );
    expect(affordDecrease.allowanceRemainingRial).toBe(0);
    expect(affordDecrease.affordable).toBe(false);
  });

  it("P1 #4 & #5: enforces maxRialPerRequest pre-request gate without discarding post-turn costs, and preserves valid zero-cost gateway responses", async () => {
    const bizId = await createBusiness("p1-ai-ceiling-zero");

    // Configure AI gateway costing via saveAiCostingConfig
    await dbLib.withoutTenantScope("platform", async () => {
      await aiGatewayService.saveAiCostingConfig({
        maxTurnRial: 50_000,
        inputCostRialPerMillion: 1_000_000,
        outputCostRialPerMillion: 2_000_000,
        revenueMarginPercent: 0,
        gatewayCostingEnabled: true,
        usdRialRate: 600_000,
      });
    });

    const turnConfig = {
      maxTurnRial: 50_000,
      inputTokenRialPerMillion: 1_000_000,
      outputTokenRialPerMillion: 2_000_000,
      revenueMarginPercent: 0,
    };

    // Wallet has 40,000 (< 50,000 required ceiling) → gateAiTurn blocks
    await dbLib.withoutTenantScope("platform", () =>
      wallet.grantCredits({ businessId: bizId, amountRial: 40_000, note: "شارژ اولیه" }),
    );
    await expect(
      dbLib.withTenant(bizId, () => aiBilling.gateAiTurn(bizId, turnConfig)),
    ).rejects.toThrow("ai_wallet_insufficient");

    // Top up another 20,000 (wallet = 60,000 >= 50,000) → gateAiTurn allows
    await dbLib.withoutTenantScope("platform", () =>
      wallet.grantCredits({ businessId: bizId, amountRial: 20_000, note: "شارژ تکمیلی" }),
    );
    await expect(
      dbLib.withTenant(bizId, () => aiBilling.gateAiTurn(bizId, turnConfig)),
    ).resolves.toBeUndefined();

    // Valid 0 USD cost from gateway (e.g., cached/free response) with non-zero tokens must charge 0 Rial ("free"), NOT fall back to token_rate!
    const zeroReqId = randomUUID();
    const zeroTurn = await dbLib.withTenant(bizId, () =>
      aiBilling.settleAiTurn({
        businessId: bizId,
        requestId: zeroReqId,
        config: turnConfig,
        usage: { inputTokens: 5_000, outputTokens: 2_000 },
        cacheHit: true,
        costUsd: 0,
      }),
    );
    expect(zeroTurn.chargedRial).toBe(0);
    expect(zeroTurn.debitedRial).toBe(0);

    const { rows: zeroSettleRows } = await db.query<{ priced_by: string }>(
      `SELECT priced_by FROM ai_wallet_settlements WHERE business_id = $1 AND request_id = $2`,
      [bizId, zeroReqId],
    );
    expect(zeroSettleRows[0]?.priced_by).toBe("free");

    // Turn whose actual provider cost (90,000 Rial) exceeds both maxTurnRial (50,000) and wallet balance (60,000):
    // full 90,000 is settled (60,000 debited from wallet + 30,000 recorded as AI debt), with ceilingExceeded = true
    const highReqId = randomUUID();
    const highTurn = await dbLib.withTenant(bizId, () =>
      aiBilling.settleAiTurn({
        businessId: bizId,
        requestId: highReqId,
        config: turnConfig,
        usage: { inputTokens: 50_000, outputTokens: 20_000 },
        costUsd: null, // falls back to token_rate: 50k/1M * 1M + 20k/1M * 2M = 90,000 Rial
      }),
    );
    expect(highTurn.chargedRial).toBe(90_000);
    expect(highTurn.debitedRial).toBe(60_000);
    expect(highTurn.debtAddedRial).toBe(30_000);
    expect(highTurn.debtRial).toBe(30_000);
    expect(highTurn.configuredMaxTurnRial).toBe(50_000);
    expect(highTurn.ceilingExceeded).toBe(true);

    const { rows: settlementRows } = await db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM ai_wallet_settlements WHERE business_id = $1 AND request_id = $2`,
      [bizId, highReqId],
    );
    expect(settlementRows[0]?.metadata?.configuredMaxTurnRial).toBe(50_000);
    expect(settlementRows[0]?.metadata?.ceilingExceeded).toBe(true);
  });

  it("P1 #6: tracks durable fulfilment state, retries failed post-settlement activation without double-crediting, and guards manual review actions", async () => {
    const draftPlanKey = `draft-plan-${randomUUID().slice(0, 8)}`;
    await dbLib.withoutTenantScope("platform", async () => {
      await plans.saveBillingPlan({
        key: draftPlanKey,
        name: "پلن پیش‌نویس",
        monthlyPriceRial: 400_000,
        status: "draft",
        sortOrder: 1,
        limits: {
          branches: { unlimited: true, value: null },
          members: { unlimited: true, value: null },
          monthlyOrders: { unlimited: true, value: null },
        },
      });
    });

    const bizId = await createBusiness("p1-fulfilment-biz");
    const pay = await dbLib.withTenant(bizId, () =>
      wallet.createPayment({
        businessId: bizId,
        gateway: "manual",
        purpose: "plan_purchase",
        planKey: draftPlanKey,
        amountRial: 400_000,
        creditRial: 400_000,
        description: "خرید پلن",
      }),
    );

    // Invalid action is rejected
    await expect(
      dbLib.withoutTenantScope("platform", () =>
        billing.reviewManualPayment({
          paymentId: pay.id,
          action: "invalid_action" as unknown as "approve",
          platformAdminId: randomUUID(),
        }),
      ),
    ).rejects.toThrow("invalid_review_action");

    // Approving while target plan is still 'draft' settles wallet credit ONCE, but fulfilment fails and records 'failed'
    await expect(
      dbLib.withoutTenantScope("platform", () =>
        billing.reviewManualPayment({
          paymentId: pay.id,
          action: "approve",
          platformAdminId: null as unknown as string,
        }),
      ),
    ).rejects.toThrow("plan_not_active");

    const afterFailedFulfil = await dbLib.withoutTenantScope("platform", () =>
      wallet.getPaymentById(pay.id),
    );
    expect(afterFailedFulfil?.status).toBe("verified");
    expect(afterFailedFulfil?.fulfilmentStatus).toBe("failed");
    expect(afterFailedFulfil?.fulfilmentError).toContain("plan_not_active");

    const walletAfterSettle = await dbLib.withTenant(bizId, () => wallet.getWallet(bizId));
    expect(walletAfterSettle.balanceRial).toBe(400_000);

    // Rejecting an already-verified payment does NOT clobber verified status
    const rejectStatus = await dbLib.withoutTenantScope("platform", () =>
      billing.reviewManualPayment({
        paymentId: pay.id,
        action: "reject",
        platformAdminId: null as unknown as string,
      }),
    );
    expect(rejectStatus).toBe("verified");

    // Activate the plan and retry reviewManualPayment('approve') -> fulfilment succeeds, wallet is NOT credited a second time!
    await dbLib.withoutTenantScope("platform", () => plans.activatePlan(draftPlanKey));
    const retriedStatus = await dbLib.withoutTenantScope("platform", () =>
      billing.reviewManualPayment({
        paymentId: pay.id,
        action: "approve",
        platformAdminId: null as unknown as string,
      }),
    );
    expect(retriedStatus).toBe("verified");

    const retriedPayment = await dbLib.withoutTenantScope("platform", () =>
      wallet.getPaymentById(pay.id),
    );
    expect(retriedPayment?.fulfilmentStatus).toBe("succeeded");
    expect(retriedPayment?.fulfilledAt).toBeTruthy();

    const walletAfterRetry = await dbLib.withTenant(bizId, () => wallet.getWallet(bizId));
    expect(walletAfterRetry.balanceRial).toBe(400_000);

    const sub = await dbLib.withTenant(bizId, () => subs.getBusinessSubscription(bizId));
    expect(sub?.planKey).toBe(draftPlanKey);
    expect(sub?.status).toBe("active");
  });

  it("P1 #7: processes period-end cancellations and non-renewing expirations in runSubscriptionRenewalTick and unifies plan-carrying rules", async () => {
    const planKey = `sub-lifecycle-${randomUUID().slice(0, 8)}`;
    await dbLib.withoutTenantScope("platform", async () => {
      await plans.saveBillingPlan({
        key: planKey,
        name: "پلن چرخه اشتراک",
        monthlyPriceRial: 250_000,
        status: "active",
        sortOrder: 1,
        limits: {
          branches: { unlimited: true, value: null },
          members: { unlimited: true, value: null },
          monthlyOrders: { unlimited: true, value: null },
        },
      });
      await plans.savePlanFeature({
        planKey,
        featureKey: "crm",
        pricingModel: "included",
        priceRial: 0,
        freeUntil: null,
        freeLimit: null,
        sortOrder: 1,
      });
    });

    const bizCancelEnd = await createBusiness("p1-sub-cancel-end", planKey);
    const bizNoAutoRenew = await createBusiness("p1-sub-no-autorenew", planKey);

    await dbLib.withoutTenantScope("platform", async () => {
      await subs.changeBusinessPlan({
        businessId: bizCancelEnd,
        planKey,
        source: "purchase",
      });
      await subs.cancelBusinessSubscription(bizCancelEnd, { atPeriodEnd: true });

      await subs.changeBusinessPlan({
        businessId: bizNoAutoRenew,
        planKey,
        source: "admin", // autoRenew = false
      });
    });

    // Move both subscriptions' current_period_end into the past
    await db.query(
      `UPDATE business_subscriptions
          SET current_period_end = now() - interval '1 hour'
        WHERE business_id IN ($1, $2)`,
      [bizCancelEnd, bizNoAutoRenew],
    );

    // Before tick runs, both isSubscriptionCarryingPlan and resolveBusinessCapability agree the lapsed subscriptions no longer carry the plan
    const capBeforeTick = await dbLib.withTenant(bizNoAutoRenew, () =>
      ent.resolveBusinessCapability(bizNoAutoRenew, "crm"),
    );
    expect(capBeforeTick.allowed).toBe(false);
    expect(capBeforeTick.reason).toBe("subscription_expired");

    // Run renewal tick: period-end cancellation -> 'cancelled', non-renewing active -> 'expired'
    const tick = await dbLib.withoutTenantScope("platform", () =>
      subs.runSubscriptionRenewalTick(),
    );
    expect(tick.cancelled).toBeGreaterThanOrEqual(1);
    expect(tick.expired).toBeGreaterThanOrEqual(1);

    const subCancelEnd = await dbLib.withTenant(bizCancelEnd, () =>
      subs.getBusinessSubscription(bizCancelEnd),
    );
    expect(subCancelEnd?.status).toBe("cancelled");

    const subNoAutoRenew = await dbLib.withTenant(bizNoAutoRenew, () =>
      subs.getBusinessSubscription(bizNoAutoRenew),
    );
    expect(subNoAutoRenew?.status).toBe("expired");
  });

  it("P1 #8 & P2 #11: unifies spend display and enforcement (including reservations, refunds, allowance, debt, excluding admin_adjust) and enforces warn_only / throttle_noncritical / block_noncritical", async () => {
    const planKey = `spend-plan-${randomUUID().slice(0, 8)}`;
    await dbLib.withoutTenantScope("platform", async () => {
      await plans.saveBillingPlan({
        key: planKey,
        name: "پلن بودجه",
        monthlyPriceRial: 0,
        monthlyAiCreditRial: 50_000,
        status: "active",
        sortOrder: 1,
        limits: {
          branches: { unlimited: true, value: null },
          members: { unlimited: true, value: null },
          monthlyOrders: { unlimited: true, value: null },
        },
      });
      await plans.savePlanFeature({
        planKey,
        featureKey: "crm",
        pricingModel: "included",
        priceRial: 0,
        freeUntil: null,
        freeLimit: null,
        sortOrder: 1,
      });
    });

    const bizId = await createBusiness("p1-spend-policy", planKey);
    await dbLib.withoutTenantScope("platform", async () => {
      await subs.changeBusinessPlan({ businessId: bizId, planKey, source: "admin" });
      await wallet.grantCredits({ businessId: bizId, amountRial: 500_000, note: "شارژ بودجه" });
    });

    // 1. Admin deduction (100,000) must NOT count as usage spend
    await dbLib.withoutTenantScope("platform", () =>
      wallet.deductCredits({ businessId: bizId, amountRial: 100_000, note: "اصلاح مدیریتی" }),
    );
    const spendAfterAdminAdjust = await dbLib.withTenant(bizId, () =>
      runtime.computeBusinessMonthlySpend(bizId),
    );
    expect(spendAfterAdminAdjust.totalSpendRial).toBe(0);

    // 2. Reserve a message send (80,000) -> counts in activeReservationsRial and totalSpendRial
    const reservation = await dbLib.withTenant(bizId, () =>
      msgBilling.reserveMessageSend({ businessId: bizId, reservedRial: 80_000 }),
    );
    const spendDuringReserve = await dbLib.withTenant(bizId, () =>
      runtime.computeBusinessMonthlySpend(bizId),
    );
    expect(spendDuringReserve.activeReservationsRial).toBe(80_000);
    expect(spendDuringReserve.totalSpendRial).toBe(80_000);

    // 3. Settle message send at actualCost = 30,000 (refunds 50,000) -> net spend is 30,000
    await dbLib.withTenant(bizId, () =>
      msgBilling.settleMessageSend({
        businessId: bizId,
        reservation,
        actualCostRial: 30_000,
      }),
    );
    const spendAfterSettle = await dbLib.withTenant(bizId, () =>
      runtime.computeBusinessMonthlySpend(bizId),
    );
    expect(spendAfterSettle.activeReservationsRial).toBe(0);
    expect(spendAfterSettle.walletUsageDebitsRial).toBe(80_000);
    expect(spendAfterSettle.spendRefundsRial).toBe(50_000);
    expect(spendAfterSettle.totalSpendRial).toBe(30_000);

    // 4. Consume 50,000 of AI plan allowance + 20,000 wallet debit = totalSpendRial becomes 100,000
    await dbLib.withTenant(bizId, () =>
      wallet.settleAiWalletCharge({
        businessId: bizId,
        requestId: randomUUID(),
        chargedRial: 70_000,
      }),
    );
    const spendAfterAi = await dbLib.withTenant(bizId, () =>
      runtime.computeBusinessMonthlySpend(bizId),
    );
    expect(spendAfterAi.allowanceUsedRial).toBe(50_000);
    expect(spendAfterAi.totalSpendRial).toBe(100_000);

    // 5. Configure spend policy at budget = 100,000 with warn_only -> emits warning, does not block
    await dbLib.withoutTenantScope("platform", () =>
      runtime.saveSpendPolicy({
        businessId: bizId,
        monthlyBudgetRial: 100_000,
        thresholds: [50, 80, 100],
        actionAtLimit: "warn_only",
      }),
    );
    const warnCap = await dbLib.withTenant(bizId, () =>
      ent.resolveBusinessCapability(bizId, "crm"),
    );
    expect(warnCap.allowed).toBe(true);
    expect(warnCap.warned).toBe(true);
    expect(warnCap.crossedThresholds).toEqual([50, 80, 100]);

    const savedPolicyAfterWarn = await dbLib.withoutTenantScope("platform", () =>
      runtime.getSpendPolicy(bizId),
    );
    expect(savedPolicyAfterWarn?.lastWarningThreshold).toBe(100);
    expect(savedPolicyAfterWarn?.lastWarningAt).toBeTruthy();

    // 6. Switch policy to throttle_noncritical -> allows non-critical capability with throttled=true & throttleDelayMs > 0
    await dbLib.withoutTenantScope("platform", () =>
      runtime.saveSpendPolicy({
        businessId: bizId,
        monthlyBudgetRial: 100_000,
        thresholds: [50, 80, 100],
        actionAtLimit: "throttle_noncritical",
      }),
    );
    const throttleCap = await dbLib.withTenant(bizId, () =>
      ent.resolveBusinessCapability(bizId, "crm"),
    );
    expect(throttleCap.allowed).toBe(true);
    expect(throttleCap.throttled).toBe(true);
    expect(throttleCap.throttleDelayMs).toBeGreaterThan(0);

    // 7. Switch policy to block_noncritical -> denies non-critical capability with spend_limit_reached, matching customerUsageSummary
    await dbLib.withoutTenantScope("platform", () =>
      runtime.saveSpendPolicy({
        businessId: bizId,
        monthlyBudgetRial: 100_000,
        thresholds: [50, 80, 100],
        actionAtLimit: "block_noncritical",
      }),
    );
    const summary = await dbLib.withTenant(bizId, () => runtime.customerUsageSummary(bizId));
    expect(summary.spend.spentRial).toBe(100_000);
    expect(summary.spend.blocked).toBe(true);

    const blockCap = await dbLib.withTenant(bizId, () =>
      ent.resolveBusinessCapability(bizId, "crm"),
    );
    expect(blockCap.allowed).toBe(false);
    expect(blockCap.reason).toBe("spend_limit_reached");
  });

  it("P1/P2 #10, #12, #13: enforces commercial settings (tax, rounding, minimumTopUpRial), reconciles AI debt on top-up, and previews quotes accurately", async () => {
    const planKey = `comm-plan-${randomUUID().slice(0, 8)}`;
    await dbLib.withoutTenantScope("platform", async () => {
      await runtime.saveCommercialSettings({
        taxRateBps: 1000, // 10%
        rounding: "ceil",
        minimumTopUpRial: 100_000,
      });

      await plans.saveBillingPlan({
        key: planKey,
        name: "پلن تجاری",
        monthlyPriceRial: 1_000_000,
        status: "active",
        sortOrder: 1,
        limits: {
          branches: { unlimited: true, value: null },
          members: { unlimited: true, value: null },
          monthlyOrders: { unlimited: true, value: null },
        },
      });
      await plans.savePlanFeature({
        planKey,
        featureKey: "insights",
        pricingModel: "monthly",
        priceRial: 200_000,
        freeUntil: null,
        freeLimit: null,
        sortOrder: 1,
      });
    });

    const bizId = await createBusiness("p2-commercial-biz", planKey);
    await dbLib.withoutTenantScope("platform", () =>
      subs.changeBusinessPlan({ businessId: bizId, planKey, source: "purchase" }),
    );

    // 1. Custom top-up below minimumTopUpRial (100,000) is rejected
    await expect(
      dbLib.withTenant(bizId, () =>
        wallet.createPayment({
          businessId: bizId,
          gateway: "manual",
          purpose: "top_up",
          amountRial: 50_000,
          creditRial: 50_000,
          description: "زیر حداقل شارژ",
        }),
      ),
    ).rejects.toThrow("below_minimum_top_up");

    // 2. Quote preview for plan_subscription includes base (1,000,000) + recurring addon (200,000) + 10% tax (120,000) = 1,320,000
    const quote = await dbLib.withoutTenantScope("platform", () =>
      runtime.previewCommercialQuote({
        kind: "plan_subscription",
        planKey,
        includeRecurringAddons: true,
      }),
    );
    expect(quote.subtotalRial).toBe(1_200_000);
    expect(quote.taxRial).toBe(120_000);
    expect(quote.totalRial).toBe(1_320_000);

    // 3. calculateSubscriptionTotal matches the quote preview
    const subTotal = await dbLib.withTenant(bizId, () => subs.calculateSubscriptionTotal(bizId));
    expect(subTotal.subtotalRial).toBe(1_200_000);
    expect(subTotal.taxRial).toBe(120_000);
    expect(subTotal.totalRial).toBe(1_320_000);

    // 4. AI debt reconciliation on credit grant / top-up
    await dbLib.withTenant(bizId, () =>
      wallet.settleAiWalletCharge({
        businessId: bizId,
        requestId: randomUUID(),
        chargedRial: 150_000,
      }),
    );
    const walletWithDebt = await dbLib.withTenant(bizId, () => wallet.getWallet(bizId));
    expect(walletWithDebt.balanceRial).toBe(0);
    expect(walletWithDebt.aiDebtRial).toBe(150_000);
    expect(walletWithDebt.netBalanceRial).toBe(-150_000);

    // Granting 400,000 Rial automatically pays down 150,000 AI debt, leaving 250,000 usable balance and 0 debt
    const grantRes = await dbLib.withoutTenantScope("platform", () =>
      wallet.grantCredits({ businessId: bizId, amountRial: 400_000, note: "شارژ تسویه بدهی" }),
    );
    expect(grantRes.debtPaidRial).toBe(150_000);
    expect(grantRes.debtRial).toBe(0);
    expect(grantRes.balanceRial).toBe(250_000);

    const walletAfterReconcile = await dbLib.withTenant(bizId, () => wallet.getWallet(bizId));
    expect(walletAfterReconcile.balanceRial).toBe(250_000);
    expect(walletAfterReconcile.aiDebtRial).toBe(0);
    expect(walletAfterReconcile.netBalanceRial).toBe(250_000);

    // Reset commercial settings back to defaults so subsequent tests see 0 tax/minTopUp
    await dbLib.withoutTenantScope("platform", async () => {
      await runtime.saveCommercialSettings({
        taxRateBps: 0,
        rounding: "ceil",
        minimumTopUpRial: 0,
      });
    });
  });

  it("P1/P2 #9 & #10: rates usage events from active price versions, decrements feature_usage on messaging refunds, and computes Tehran month windows", async () => {
    const planKey = `overview-plan-${randomUUID().slice(0, 8)}`;
    await dbLib.withoutTenantScope("platform", async () => {
      await plans.saveBillingPlan({
        key: planKey,
        name: "پلن گزارش مالی",
        monthlyPriceRial: 500_000,
        monthlyAiCreditRial: 250_000,
        status: "active",
        sortOrder: 1,
        limits: {
          branches: { unlimited: true, value: null },
          members: { unlimited: true, value: null },
          monthlyOrders: { unlimited: true, value: null },
        },
      });
    });

    const bizId = await createBusiness("p2-overview-metrics", planKey);
    await dbLib.withoutTenantScope("platform", async () => {
      await subs.changeBusinessPlan({ businessId: bizId, planKey, source: "purchase" });
      await wallet.grantCredits({ businessId: bizId, amountRial: 300_000, note: "شارژ پیامک" });
    });

    // 1. Publish a meter price version and append a usage event without ratedAmountRial -> auto-rated in billing_usage_ratings!
    const meterKey = "ai.request";
    await dbLib.withoutTenantScope("platform", () =>
      runtime.publishPriceVersion({
        targetType: "meter",
        targetKey: meterKey,
        unit: "request",
        unitAmountRial: 2_500,
      }),
    );
    const activePrice = await dbLib.withoutTenantScope("platform", () =>
      runtime.priceAt("meter", meterKey, new Date().toISOString()),
    );
    expect(activePrice?.unitAmountRial).toBe(2_500);

    const usageRes = await dbLib.withTenant(bizId, () =>
      runtime.appendUsageEvent({
        businessId: bizId,
        source: "platform",
        eventId: `usage-${randomUUID()}`,
        meterKey,
        quantity: 4,
        unit: "request",
      }),
    );
    expect(usageRes.status).toBe("accepted");
    if (usageRes.status !== "accepted") {
      throw new Error("expected usage event to be accepted");
    }
    const ratingRow = await db.query<{
      price_version_id: string | null;
      rated_amount_rial: string;
      overage_quantity: string;
    }>(
      `SELECT price_version_id, rated_amount_rial::text, overage_quantity::text
         FROM billing_usage_ratings
        WHERE usage_event_id = $1`,
      [usageRes.id],
    );
    expect(ratingRow.rows[0]?.price_version_id).toBe(activePrice?.id);
    expect(Number(ratingRow.rows[0]?.rated_amount_rial ?? 0)).toBe(10_000);
    expect(Number(ratingRow.rows[0]?.overage_quantity ?? 0)).toBe(4);

    // 2. Reserve 90,000 for messaging, then settle at 40,000 -> feature_usage.total_charged_rial reflects net 40,000 (decremented by 50,000 refund)
    const reservation = await dbLib.withTenant(bizId, () =>
      msgBilling.reserveMessageSend({ businessId: bizId, reservedRial: 90_000 }),
    );
    await dbLib.withTenant(bizId, () =>
      msgBilling.settleMessageSend({
        businessId: bizId,
        reservation,
        actualCostRial: 40_000,
      }),
    );
    const fuRes = await db.query<{ spent_rial: string; charged_count: number }>(
      `SELECT spent_rial::text, charged_count
         FROM feature_usage
        WHERE business_id = $1 AND feature_key = 'messaging'`,
      [bizId],
    );
    expect(Number(fuRes.rows[0]?.spent_rial ?? 0)).toBe(40_000);
    expect(Number(fuRes.rows[0]?.charged_count ?? 0)).toBe(1);

    // 3. Verify Tehran month window boundaries (Asia/Tehran is UTC+03:30)
    // 2026-04-30T21:00:00Z is 2026-05-01T00:30:00+03:30 in Tehran -> periodMonth is '2026-05'
    const tehranMayStart = new Date("2026-04-30T21:00:00.000Z");
    const win = aiAllowance.tehranMonthWindow(tehranMayStart);
    expect(win.periodMonth).toBe("2026-05");
    expect(win.startUtc.toISOString()).toBe("2026-04-30T20:30:00.000Z");
    expect(win.nextStartUtc.toISOString()).toBe("2026-05-31T20:30:00.000Z");
  });
});
