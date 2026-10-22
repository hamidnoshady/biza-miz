#!/usr/bin/env node
/**
 * CRM Today attention queue → Customer 360 browser regression (#1065).
 *
 * Runs against the seeded production server used by the E2E workflow. It adds
 * one temporary at-risk customer, isolates that queue while preserving its
 * previous stage values, then follows the rendered link on desktop and phone.
 * Both client navigation and a direct document request must open the intended
 * profile (never Next's 404 page).
 */
import { Client } from "pg";
import { chromium } from "playwright";

// The CI production server binds to IPv4 loopback only; avoid localhost resolving
// to ::1 first on runners where no IPv6 listener is present.
const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const DATABASE_URL = process.env.DATABASE_URL;
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const BUSINESS_SLUG = process.env.SEED_BUSINESS_SLUG ?? "cafe-nemoone";
const EXECUTABLE = process.env.VISUAL_CHROMIUM_PATH || undefined;
const CUSTOMER_NAME = `مشتری آزمون صف ${Date.now()}`;
const AT_RISK_STAGES = ["at_risk", "cant_lose", "needs_attention"];

if (!DATABASE_URL) throw new Error("DATABASE_URL is required for the CRM queue E2E test.");

const db = new Client({ connectionString: DATABASE_URL });
let browser;
let customerId;
let previousStages = [];
let businessId;

async function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function testViewport(name, options) {
  const context = await browser.newContext(options);
  try {
    const login = await context.request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    await assert(login.ok(), `${name}: owner login failed (${login.status()})`);

    const page = await context.newPage();
    const routeFailures = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === `/crm/persons/${customerId}` && response.status() >= 400) {
        routeFailures.push(`${response.status()} ${url.pathname}`);
      }
    });

    await page.goto(`${BASE_URL}/crm/overview`, { waitUntil: "domcontentloaded" });
    await page.getByText("مشتریان در معرض ریزش", { exact: true }).waitFor({ timeout: 30_000 });

    const href = `/crm/persons/${customerId}`;
    // Scope to the at-risk queue; the same customer also appears in the
    // overview's directory links, so a page-wide href selector is ambiguous.
    const atRiskQueue = page.locator("#crm-queue-at_risk_customers");
    const link = atRiskQueue.locator(`a[href="${href}"]`).filter({ hasText: CUSTOMER_NAME });
    await link.waitFor({ state: "visible", timeout: 15_000 });
    await assert(await link.getAttribute("href") === href, `${name}: queue rendered a non-canonical customer URL`);
    const fileApiResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/crm/customers/${customerId}/file`;
    }, { timeout: 20_000 });
    await link.click();
    await page.waitForURL((url) => url.pathname === href, { timeout: 15_000 });
    await page.locator("main").getByText(CUSTOMER_NAME, { exact: true }).waitFor({ timeout: 20_000 });

    const fileApiResponse = await fileApiResponsePromise;
    const filePayload = await fileApiResponse.json();
    await assert(fileApiResponse.status() === 200, `${name}: customer-file API returned ${fileApiResponse.status()}`);
    await assert(filePayload.file?.name === CUSTOMER_NAME, `${name}: API did not return the intended customer`);

    // Use the browser for the document request: Playwright's separate API
    // request context does not send Secure session cookies over loopback HTTP.
    const documentResponse = await page.reload({ waitUntil: "domcontentloaded" });
    await assert(documentResponse?.status() === 200, `${name}: customer page returned ${documentResponse?.status() ?? "no response"}`);
    await assert(!(await page.locator("body").innerText()).includes("This page could not be found"), `${name}: Next.js 404 content was rendered`);
    await page.locator("main").getByText(CUSTOMER_NAME, { exact: true }).waitFor({ timeout: 20_000 });
    await assert(routeFailures.length === 0, `${name}: profile navigation returned an error: ${routeFailures.join(", ")}`);

    if (options.isMobile) {
      const noHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      await assert(noHorizontalOverflow, "mobile: customer profile has horizontal page overflow");
    }
    console.log(`  ✓ ${name}: Today queue link opened the canonical Customer 360 profile`);
  } finally {
    await context.close();
  }
}

async function main() {
  await db.connect();
  const business = await db.query("SELECT id FROM businesses WHERE slug = $1", [BUSINESS_SLUG]);
  if (!business.rows[0]) throw new Error(`Seed business ${BUSINESS_SLUG} was not found.`);
  businessId = business.rows[0].id;

  const oldRows = await db.query(
    `SELECT id, lifecycle_stage FROM parties
      WHERE business_id = $1 AND lifecycle_stage = ANY($2::text[])`,
    [businessId, AT_RISK_STAGES],
  );
  previousStages = oldRows.rows;
  // Isolate the preview without leaving changes to the shared seeded dataset.
  await db.query(
    `UPDATE parties SET lifecycle_stage = NULL
      WHERE business_id = $1 AND lifecycle_stage = ANY($2::text[])`,
    [businessId, AT_RISK_STAGES],
  );
  const inserted = await db.query(
    `INSERT INTO parties (business_id, name, roles, role, lifecycle_stage)
     VALUES ($1, $2, ARRAY['customer']::text[], 'customer', 'at_risk')
     RETURNING id`,
    [businessId, CUSTOMER_NAME],
  );
  customerId = inserted.rows[0].id;

  browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: EXECUTABLE ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [],
  });
  try {
    await testViewport("desktop (1360×900)", {
      viewport: { width: 1360, height: 900 },
      locale: "fa-IR",
      timezoneId: "Asia/Tehran",
      reducedMotion: "reduce",
    });
    await testViewport("mobile (390×844)", {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: "fa-IR",
      timezoneId: "Asia/Tehran",
      reducedMotion: "reduce",
    });
  } finally {
    await browser.close();
  }
}

try {
  await main();
} finally {
  if (businessId) {
    if (customerId) await db.query("DELETE FROM parties WHERE business_id = $1 AND id = $2", [businessId, customerId]).catch(() => {});
    for (const row of previousStages) {
      await db.query("UPDATE parties SET lifecycle_stage = $2 WHERE business_id = $1 AND id = $3", [businessId, row.lifecycle_stage, row.id]).catch(() => {});
    }
  }
  await db.end().catch(() => {});
}
