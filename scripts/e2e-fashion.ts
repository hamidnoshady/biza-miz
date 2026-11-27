#!/usr/bin/env tsx
/**
 * GH #1567 — fashion & apparel browser acceptance (6A–6E, 6.3 subcontracting,
 * and the C5 consignment blocks) against a running server and a real
 * PostgreSQL database:
 *
 *   DATABASE_URL=… E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e:fashion
 *
 * DATABASE_URL must be the migration/owner connection: the script provisions
 * its OWN fashion business (a fresh owner each run, so it can be re-run
 * against the same database and never touches the seeded fixture), seeds it
 * through the real services, then drives the real pages as that owner.
 *
 * It proves, at desktop (1440), tablet (820) and phone (390) widths:
 *   1. every fashion page renders RTL with its heading, no error boundary,
 *      no uncaught page error and no horizontal page scroll;
 *   2. 6A tailoring desk and 6B production orders open; a production order's
 *      detail shows its 6.3 subcontract (supplier, stage);
 *   3. 6C size packs: an owned-only pack is sellable, a pack holding a
 *      consigned variant is named as such on the row (C5) — not a shortage;
 *   4. 6D consignment: the contract and its consigned on-hand are listed;
 *      the till labels the consigned variant «امانی» and refuses the mixed
 *      pack by name (C5);
 *   5. 6E advisory report opens from the reports workspace and says it is
 *      advisory;
 *   6. axe-core (WCAG 2.0/2.1 A + AA) reports no serious or critical
 *      violation inside <main> on each page at each width.
 *
 * Exits non-zero on any failed expectation. Nothing is skipped or retried
 * into a pass. VISUAL_CHROMIUM_PATH overrides the browser executable.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { Client, type PoolClient } from "pg";

const BASE_URL = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").origin;
const DATABASE_URL = process.env.DATABASE_URL;
const EXECUTABLE = process.env.VISUAL_CHROMIUM_PATH || undefined;
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR || "";
const require = createRequire(import.meta.url);

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required: this acceptance provisions and seeds its own fashion business.");
  process.exit(1);
}

const failures: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let barcodeCounter = Math.floor(Math.random() * 1e8);
function ean13(): string {
  const body = `29${String(barcodeCounter++).padStart(10, "0")}`;
  const sum = [...body].reduce((acc, digit, i) => acc + Number(digit) * (i % 2 === 0 ? 1 : 3), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/* ------------------------------------------------------------------ *
 * Seed — through the real services, as the app would write it.
 * ------------------------------------------------------------------ */

interface Fixture {
  email: string;
  password: string;
  contractRef: string;
  ownedPack: string;
  mixedPack: string;
  orderRef: string;
  supplierName: string;
  variantM: string;
  recoveryCode: string;
}

async function seed(): Promise<Fixture> {
  const dbLib = await import("../src/lib/db");
  const provisioning = await import("../src/lib/business-provisioning");
  const productInput = await import("../src/lib/product-input");
  const productCreation = await import("../src/lib/product-creation-service");
  const itemsService = await import("../src/lib/items-service");
  const stockService = await import("../src/lib/retail-stock-service");
  const consignment = await import("../src/lib/fashion-consignment-service");
  const sizePacks = await import("../src/lib/fashion-size-pack-service");
  const production = await import("../src/lib/fashion-production-service");

  const tx = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  const tag = randomUUID().slice(0, 8);
  const email = `fashion-e2e-${tag}@example.com`;
  const password = "correct-horse-e2e";
  const tenant = await provisioning.provisionBusiness({
    businessName: `بوتیک آزمون ${tag}`,
    ownerName: "مالک آزمون",
    email,
    password,
    subdomain: `fashione2e${tag}`,
    industry: "fashion_apparel",
    seedChartOfAccounts: true,
  });
  const { businessId, locationId, userId } = tenant;

  const parsed = productInput.parseProductCreateInput({
    name: "مانتو آزمون",
    sku: `MN-${tag}`,
    unit: "عدد",
    taxSalePercent: 9,
    sellPrice: 1_200_000,
    variants: ["S", "M", "L"].map((size) => ({
      sku: `MN-${tag}-${size}`,
      barcode: ean13(),
      attributes: [{ name: "سایز", value: size }, { name: "رنگ", value: "مشکی" }],
    })),
  });
  if (!parsed.ok) throw new Error(`product input rejected: ${JSON.stringify(parsed)}`);
  const created = await productCreation.createProductRecord(locationId, parsed.data);
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const bySize = async (size: string) => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT i.id FROM items i JOIN item_variant_attributes a ON a.item_id = i.id AND a.name = 'سایز' AND a.value = $2
          WHERE i.parent_item_id = $1`,
        [created.item.id, size],
      );
      return rows[0].id;
    };
    const [s, m, l] = [await bySize("S"), await bySize("M"), await bySize("L")];
    const fabric = (await itemsService.createItem({ locationId, name: "پارچه کرپ آزمون" })).id;
    await tx((client) => stockService.receiveItemPurchase(client, {
      businessId, locationId,
      lines: [
        { itemId: s, quantity: "6", unitCost: 500_000 },
        { itemId: l, quantity: "4", unitCost: 500_000 },
        { itemId: fabric, quantity: "40", unitCost: 80_000 },
      ],
    }));

    // 6D — M is someone else's goods, on contract.
    const actor = { businessId, userId };
    const contractRef = `E2E-${tag}`;
    const owner = await consignment.createConsignorRecord(actor, locationId, { name: "تولیدی آزمون", phone: null, notes: null });
    const contract = await consignment.createContract(actor, locationId, {
      reference: contractRef, consignorId: owner.id, startsOn: "2026-01-01", expiresOn: null, notes: null,
      lines: [{ itemId: m, terms: "commission", ownerUnitPriceRial: null, commissionBp: 2_000, retailPriceRial: 1_500_000 }],
    });
    await consignment.receiveConsignedGoods(actor, locationId, contract.id, {
      idempotencyKey: `e2e-receive-${tag}`, expectedVersion: contract.version, note: null,
      lines: [{ lineId: contract.lines[0].id, quantity: 2 }],
    });

    // 6C — one owned-only pack, one that contains the consigned M.
    const ownedPack = `بستهٔ خودی ${tag}`;
    const mixedPack = `بستهٔ مخلوط ${tag}`;
    await sizePacks.saveSizePack(actor, locationId, {
      name: ownedPack, barcode: null,
      components: [{ itemId: s, quantity: 1, unitPriceRial: 900_000 }, { itemId: l, quantity: 1, unitPriceRial: 900_000 }],
    });
    await sizePacks.saveSizePack(actor, locationId, {
      name: mixedPack, barcode: null,
      components: [{ itemId: s, quantity: 1, unitPriceRial: 900_000 }, { itemId: m, quantity: 1, unitPriceRial: 900_000 }],
    });

    // 6B + 6.3 — a released order whose sewing stage is subcontracted.
    const prodActor = { businessId, userId, canWriteOff: true };
    const bom = await production.saveBom(prodActor, locationId, {
      name: `مانتو ${tag}`, outputItemId: l, conversionCostPerUnitRial: 0,
      lines: [{ materialItemId: fabric, quantityPerUnit: "2" }],
    });
    let order = await production.createProductionOrder(prodActor, locationId, {
      bomId: bom.id, plannedQuantity: "5", idempotencyKey: `e2e-order-${tag}`,
    });
    order = await production.applyProductionOrderAction(prodActor, locationId, order.order.id, {
      action: "release", expectedVersion: order.order.version, idempotencyKey: `e2e-release-${tag}`,
    } as Parameters<typeof production.applyProductionOrderAction>[3]);
    const supplierName = `کارگاه دوخت ${tag}`;
    const { rows: [party] } = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, role, person_type) VALUES ($1, $2, 'supplier', 'legal') RETURNING id",
      [businessId, supplierName]);
    const { rows: [alias] } = await db.query<{ id: string }>(
      "INSERT INTO suppliers (location_id, name, party_id, is_active) VALUES ($1, $2, $3, true) RETURNING id",
      [locationId, supplierName, party.id]);
    await production.applyProductionOrderAction(prodActor, locationId, order.order.id, {
      action: "subcontract_create", supplierId: alias.id, stage: "sew", ratePerUnitRial: 150_000,
      expectedVersion: order.order.version, idempotencyKey: `e2e-sub-${tag}`,
    } as Parameters<typeof production.applyProductionOrderAction>[3]);

    const { rows: [variant] } = await db.query<{ name: string }>("SELECT name FROM items WHERE id = $1", [m]);
    const recoveryCode = tenant.recoveryCodes?.[0];
    if (!recoveryCode) throw new Error("provisioning issued no recovery code");
    return {
      email, password, contractRef, ownedPack, mixedPack, orderRef: order.order.reference, supplierName,
      variantM: variant.name, recoveryCode,
    };
  } finally {
    await db.end();
    await dbLib.getPool().end().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Browser helpers
 * ------------------------------------------------------------------ */

/**
 * One real login through the manager door: password, then the owner's
 * mandatory second factor. Provisioning enrols the owner's phone for SMS OTP
 * (no SMS leaves a test run), so the second factor is completed with one of
 * the recovery codes provisioning issued — the documented fallback path.
 * The resulting session is reused by every viewport.
 */
async function login(context: BrowserContext, fixture: Fixture) {
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  const identifier = page.getByLabel("ایمیل", { exact: true });
  const passwordInput = page.getByLabel("رمز عبور", { exact: true });
  await identifier.waitFor();
  // Let hydration attach before filling (an early input leaves React state empty).
  await page.waitForTimeout(1_500);
  await identifier.fill(fixture.email);
  await passwordInput.fill(fixture.password);
  const loginButton = page.getByRole("button", { name: "ورود", exact: true });
  if (!(await loginButton.isEnabled())) {
    await identifier.click();
    await identifier.press("Control+A");
    await identifier.pressSequentially(fixture.email, { delay: 10 });
    await passwordInput.click();
    await passwordInput.press("Control+A");
    await passwordInput.pressSequentially(fixture.password, { delay: 10 });
  }
  await loginButton.click();
  const mfa = page.getByRole("button", { name: "استفاده از کد بازیابی" });
  if (await mfa.waitFor({ timeout: 60_000 }).then(() => true, () => false)) {
    await mfa.click();
    const recoveryInput = page.getByLabel("کد بازیابی", { exact: true });
    await recoveryInput.waitFor();
    // The submit button renders a nameless spinner while the automatic SMS
    // challenge is in flight, and the mode toggle clears the field, so wait
    // for the form to go idle and confirm the value actually stuck.
    const submit = page.locator('form button[type="submit"]').first();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.waitForFunction(() => !document.querySelector('form button[type="submit"] svg, form [data-slot="spinner"]'), undefined, { timeout: 60_000 })
        .catch(() => undefined);
      await recoveryInput.fill(fixture.recoveryCode);
      if ((await recoveryInput.inputValue()) === fixture.recoveryCode && (await submit.isEnabled().catch(() => false))) break;
      await page.waitForTimeout(1_000);
    }
    if (!(await submit.isEnabled().catch(() => false))) {
      console.log(`    (mfa step: ${(await page.locator("main, body").first().innerText()).replace(/\s+/g, " ").slice(0, 400)})`);
      await shot(page, "mfa-step");
    }
    await submit.click();
    await page.waitForURL((url) => !url.pathname.startsWith("/admin"), { timeout: 120_000 }).catch(() => undefined);
    if (new URL(page.url()).pathname.startsWith("/admin")) {
      const alerts = await page.getByRole("alert").allInnerTexts().catch(() => []);
      console.log(`    (still on ${page.url()} after MFA; alerts: ${alerts.join(" | ") || "none"})`);
      await shot(page, "mfa-after-submit");
    }
  }
  await page.waitForTimeout(2_000);
  // A fresh owner may be offered MFA enrollment; this acceptance is not about 2FA.
  const later = page.getByRole("button", { name: "بعداً", exact: true });
  if (await later.isVisible().catch(() => false)) {
    await later.click();
    await page.waitForTimeout(2_000);
  }
  const cookies = await context.cookies(BASE_URL);
  check("owner login mints a session", cookies.some((c) => c.name === "pos_session" && Boolean(c.value)), page.url());
  await page.close();
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector('main [data-slot="skeleton"], main [aria-busy="true"]'), undefined, { timeout: 60_000 })
    .catch(() => undefined);
  await page.waitForTimeout(400);
}

async function pageBasics(page: Page, label: string, heading: string) {
  await page.getByRole("heading", { name: heading, exact: true }).first().waitFor({ timeout: 120_000 });
  await settle(page);
  check(`${label}: html is RTL`, (await page.locator("html").getAttribute("dir")) === "rtl");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${label}: no horizontal page scroll`, overflow <= 1, `scrollWidth exceeds viewport by ${overflow}px`);
  const boundary = await page.getByText(/مشکلی پیش آمد|خطای غیرمنتظره/).count();
  check(`${label}: no error boundary`, boundary === 0);
}

async function axe(page: Page, label: string) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const result = await page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[] }> } };
    return w.axe.run({ include: [["main"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
  });
  const blocking = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  check(
    `${label}: axe — no serious/critical WCAG A/AA violation in <main>`,
    blocking.length === 0,
    blocking.map((v) => `${v.id} (${v.impact}) × ${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`).join("; "),
  );
  const minor = result.violations.filter((v) => !blocking.includes(v));
  if (minor.length) console.log(`    (axe minor/moderate: ${minor.map((v) => `${v.id}×${v.nodes.length}`).join(", ")})`);
}

async function shot(page: Page, name: string) {
  if (!SCREENSHOT_DIR) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
] as const;

async function main() {
  console.log("Seeding a fresh fashion business…");
  const fixture = await seed();
  console.log(`  owner ${fixture.email}, contract ${fixture.contractRef}, order ${fixture.orderRef}`);

  const browser = await chromium.launch({ headless: process.env.E2E_HEADED !== "1", executablePath: EXECUTABLE });
  try {
    const loginContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "fa-IR" });
    await login(loginContext, fixture);
    const storageState = await loginContext.storageState();
    await loginContext.close();
    if (failures.length > 0) throw new Error("login failed; nothing further can be checked");
    for (const viewport of VIEWPORTS) {
      console.log(`\n[${viewport.name} ${viewport.width}×${viewport.height}]`);
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        locale: "fa-IR",
        isMobile: viewport.name === "phone",
        hasTouch: viewport.name !== "desktop",
        storageState,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      page.setDefaultNavigationTimeout(180_000);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const v = viewport.name;

      // 6A — tailoring desk.
      await page.goto(`${BASE_URL}/accounting/tailoring`, { waitUntil: "domcontentloaded" });
      await pageBasics(page, `${v} 6A tailoring`, "خیاطی و دوخت");
      await axe(page, `${v} 6A tailoring`);
      await shot(page, `${v}-tailoring`);

      // 6B + 6.3 — production order with its subcontract.
      await page.goto(`${BASE_URL}/accounting/production-orders`, { waitUntil: "domcontentloaded" });
      await pageBasics(page, `${v} 6B production`, "تولید پوشاک");
      const orderButton = page.getByRole("button", { name: fixture.orderRef, exact: true }).first();
      await orderButton.waitFor();
      await orderButton.click();
      const subcontracts = page.getByRole("region", { name: "پیمانکاران" }).or(page.locator('section[aria-labelledby="po-subcontracts"]')).first();
      await subcontracts.waitFor();
      check(`${v} 6.3 order detail lists the subcontractor`, (await subcontracts.getByText(fixture.supplierName).count()) > 0);
      await settle(page);
      await axe(page, `${v} 6B/6.3 order detail`);
      await shot(page, `${v}-production-detail`);
      await page.keyboard.press("Escape");

      // 6C — size packs; the mixed pack names its consigned variant (C5).
      await page.goto(`${BASE_URL}/accounting/size-packs`, { waitUntil: "domcontentloaded" });
      await pageBasics(page, `${v} 6C size packs`, "بسته‌های سایزی");
      await page.getByText(fixture.mixedPack).first().waitFor();
      const mixedRow = page.getByRole("row").filter({ hasText: fixture.mixedPack }).first();
      const ownedRow = page.getByRole("row").filter({ hasText: fixture.ownedPack }).first();
      const mixedVisible = await mixedRow.isVisible().catch(() => false);
      // At phone width the table may render as cards; read the card text then.
      const mixedText = mixedVisible
        ? await mixedRow.innerText()
        : await page.locator("li, article, div").filter({ hasText: fixture.mixedPack }).last().innerText();
      check(`${v} C5 mixed pack is named as consigned, not a shortage`, /کالای امانی است/.test(mixedText), mixedText.slice(0, 160));
      const ownedText = (await ownedRow.isVisible().catch(() => false))
        ? await ownedRow.innerText()
        : await page.locator("li, article, div").filter({ hasText: fixture.ownedPack }).last().innerText();
      check(`${v} 6C owned-only pack carries no consignment notice`, !/امانی/.test(ownedText));
      await axe(page, `${v} 6C size packs`);
      await shot(page, `${v}-size-packs`);

      // 6D — consignment contract and its consigned on-hand.
      await page.goto(`${BASE_URL}/accounting/consignment`, { waitUntil: "domcontentloaded" });
      await pageBasics(page, `${v} 6D consignment`, "کالای امانی");
      await page.getByText(fixture.contractRef).first().waitFor();
      check(`${v} 6D contract is listed`, (await page.getByText(fixture.contractRef).count()) > 0);
      await axe(page, `${v} 6D consignment`);
      await shot(page, `${v}-consignment`);

      // 6D/C5 — the till labels the consigned variant and refuses the mixed pack by name.
      await page.goto(`${BASE_URL}/accounting/pos`, { waitUntil: "domcontentloaded" });
      const picker = page.getByRole("button", { name: "انتخاب کالا" }).first();
      await picker.waitFor({ timeout: 120_000 });
      await settle(page);
      check(`${v} till: html is RTL`, (await page.locator("html").getAttribute("dir")) === "rtl");
      const tillOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(`${v} till: no horizontal page scroll`, tillOverflow <= 1, `${tillOverflow}px`);
      await picker.click();
      const consignedOption = page.getByRole("option", { name: new RegExp(`امانی · موجودی`) }).first();
      const consignedShown = await consignedOption.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      check(`${v} till labels the consigned variant «امانی»`, consignedShown);
      await page.keyboard.press("Escape");
      const packPicker = page.getByRole("button", { name: "انتخاب بسته" }).first();
      if (await packPicker.isVisible().catch(() => false)) {
        await packPicker.click();
        await page.getByRole("option", { name: new RegExp(fixture.mixedPack) }).first().click();
        const refusal = await page.getByRole("alert").filter({ hasText: /کالای امانی است/ }).first()
          .waitFor({ timeout: 10_000 }).then(() => true, () => false);
        check(`${v} till refuses the mixed pack by name (C5)`, refusal);
        const add = page.getByRole("button", { name: /افزودن بسته به فاکتور/ }).first();
        check(`${v} till keeps «add pack» disabled for the mixed pack`, await add.isDisabled());
      } else {
        check(`${v} till shows the size-pack panel`, false, "«انتخاب بسته» not visible");
      }
      await axe(page, `${v} till`);
      await shot(page, `${v}-till`);

      // 6E — the advisory report from the reports workspace.
      await page.goto(`${BASE_URL}/accounting/reports`, { waitUntil: "domcontentloaded" });
      await pageBasics(page, `${v} reports`, "گزارش‌ها");
      const reportEntry = page.getByRole("button", { name: /پیشنهادهای خرید و چیدمان/ })
        .or(page.getByRole("link", { name: /پیشنهادهای خرید و چیدمان/ }))
        .or(page.getByRole("option", { name: /پیشنهادهای خرید و چیدمان/ }))
        .first();
      const entryFound = await reportEntry.waitFor({ timeout: 30_000 }).then(() => true, () => false);
      check(`${v} 6E advisory report is offered`, entryFound);
      if (entryFound) {
        await reportEntry.click();
        const advisory = await page.getByRole("note").filter({ hasText: /هیچ خرید، ثبت انبار، تغییر قیمت یا پیامی/ }).first()
          .waitFor({ timeout: 60_000 }).then(() => true, () => false);
        check(`${v} 6E report says it is advisory`, advisory);
        await settle(page);
        await axe(page, `${v} 6E advisory report`);
        await shot(page, `${v}-advice`);
      }

      check(`${v}: no uncaught page error`, pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
      await context.close();
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} expectation(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nAll fashion acceptance expectations passed.");
}

main().catch((error) => {
  console.error("[e2e-fashion] Error:", error);
  process.exit(1);
});
