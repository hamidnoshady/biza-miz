#!/usr/bin/env node
/**
 * CRM «امروز» attention queues → Customer 360 browser regression (#1065).
 *
 * Creates two isolated temporary customers in the seeded owner business: an
 * at-risk customer and a customer with an overdue follow-up. It opens the
 * actual «امروز» item in the CRM sidebar, follows both queue links, and checks
 * the customer-file API and document response at desktop and phone sizes.
 * No seeded party is edited; temporary fixtures are deleted in finally (and
 * stale fixtures from an interrupted prior run are cleaned before setup).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { chromium } from "playwright";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const DATABASE_URL = process.env.DATABASE_URL;
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const BUSINESS_SLUG = process.env.SEED_BUSINESS_SLUG ?? "cafe-nemoone";
const EXECUTABLE = process.env.VISUAL_CHROMIUM_PATH || undefined;
const RUN_ID = Date.now();
const FIXTURE_PREFIX = "CRM E2E #1065:";
const AT_RISK_CUSTOMER_ID = "00000000-0000-4000-8000-000000000001";
const FOLLOW_UP_CUSTOMER_ID = randomUUID();
const AT_RISK_NAME = `${FIXTURE_PREFIX} at-risk ${RUN_ID}`;
const FOLLOW_UP_NAME = `${FIXTURE_PREFIX} follow-up ${RUN_ID}`;
const FOLLOW_UP_SUBJECT = `${FIXTURE_PREFIX} overdue call ${RUN_ID}`;
const AT_RISK_STAGES = ["at_risk", "cant_lose", "needs_attention"];

if (!DATABASE_URL) throw new Error("DATABASE_URL is required for the CRM queue E2E test.");

const db = new Client({ connectionString: DATABASE_URL });
let browser;
let businessId;
let activityId;
const createdCustomerIds = [];

async function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function deleteTemporaryFixtures(customerIds) {
  if (!businessId || customerIds.length === 0) return;
  await db.query(
    `DELETE FROM crm_activities
      WHERE business_id = $1 AND (id = $2 OR customer_id = ANY($3::uuid[]))`,
    [businessId, activityId, customerIds],
  ).catch(() => {});
  await db.query(
    `DELETE FROM parties
      WHERE business_id = $1 AND id = ANY($2::uuid[])
        AND name LIKE 'CRM E2E #1065:%'`,
    [businessId, customerIds],
  ).catch(() => {});
}

async function removeStaleFixtures() {
  const stale = await db.query(
    `SELECT id FROM parties
      WHERE business_id = $1 AND name LIKE 'CRM E2E #1065:%'`,
    [businessId],
  );
  const ids = stale.rows.map((row) => row.id);
  await deleteTemporaryFixtures(ids);
}

async function navigateToToday(page, isMobile) {
  if (isMobile) {
    // The mobile trigger's accessible label changes with state and viewport;
    // target the stable controlled sidebar and open it only when collapsed.
    const menuToggle = page.locator('button[aria-controls="dashboard-sidebar"]:visible').first();
    await menuToggle.waitFor({ state: "visible", timeout: 15_000 });
    if (await menuToggle.getAttribute("aria-expanded") !== "true") await menuToggle.click();
  }

  // The app shell is hydrated after `domcontentloaded`, so the sidebar does not
  // exist yet at the first paint. Wait for the navigation region itself before
  // asking whether one item is inside it: a link that is missing from a rendered
  // menu and a menu that has not rendered are different failures, and only the
  // first one is about the product. 45s, not 15s, because this runs on a shared
  // runner next to the whole database suite — the assertion has not changed.
  const crmNavigation = page.getByRole("navigation", { name: "بخش‌های ارتباط با مشتری" });
  await crmNavigation.waitFor({ state: "visible", timeout: 45_000 });
  const todayLink = crmNavigation.getByRole("link", { name: /^امروز/ });
  await todayLink.waitFor({ state: "visible", timeout: 45_000 });
  const todayHref = await todayLink.getAttribute("href");
  await assert(Boolean(todayHref?.startsWith("/crm/")), "CRM «امروز» navigation link has no CRM route");
  await todayLink.click();
  const todayPath = new URL(todayHref ?? "", BASE_URL).pathname;
  await page.waitForURL((url) => url.pathname === todayPath, { timeout: 20_000 });
  // The mobile sheet closes as soon as its nav link is selected, so the link
  // is no longer mounted/accessible for an aria-current check in that viewport.
  if (!isMobile) await assert(await todayLink.getAttribute("aria-current") === "page", "CRM «امروز» tab did not become active");
  await page.locator("#crm-queue-at_risk_customers").waitFor({ state: "visible", timeout: 30_000 });
}

async function followCustomerQueueLink(page, queueKey, customerId, customerName, viewportName, routeFailures) {
  const href = `/crm/persons/${customerId}`;
  const queue = page.locator(`#crm-queue-${queueKey}`);
  const link = queue.locator(`a[href="${href}"]`).filter({ hasText: customerName });
  await link.waitFor({ state: "visible", timeout: 20_000 });
  await assert(await link.getAttribute("href") === href, `${viewportName}: ${queueKey} customer href is not canonical`);

  await link.click();
  await page.waitForURL((url) => url.pathname === href, {
    timeout: 20_000,
    // Queue links use Next's client navigation; do not wait for a document-load
    // event that a soft navigation does not emit.
    waitUntil: "domcontentloaded",
  });

  // Fetch in the authenticated browser after the queue link changes the URL.
  // This avoids racing the profile component's effect while still asserting the
  // same tenant-scoped endpoint and exact customer payload.
  const fileResult = await page.evaluate(async (id) => {
    const response = await fetch(`/api/crm/customers/${id}/file`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    return { status: response.status, payload: await response.json() };
  }, customerId);
  await assert(fileResult.status === 200, `${viewportName}: customer-file API returned ${fileResult.status}`);
  await assert(fileResult.payload.file?.name === customerName, `${viewportName}: API did not return the intended customer`);

  // Also exercise a full browser document request with the same session, not
  // just the client-side route transition and explicit file API fetch.
  const documentResponse = await page.reload({ waitUntil: "domcontentloaded" });
  await assert(documentResponse?.status() === 200, `${viewportName}: profile document returned ${documentResponse?.status() ?? "no response"}`);
  await assert(
    !(await page.locator("body").innerText()).includes("This page could not be found"),
    `${viewportName}: Next.js 404 content was rendered`,
  );
  await page.locator("main").getByText(customerName, { exact: true }).waitFor({ timeout: 30_000 });
  await assert(routeFailures.length === 0, `${viewportName}: profile route returned an error: ${routeFailures.join(", ")}`);
  console.log(`  ✓ ${viewportName}: ${queueKey} link opened ${href} without a 404`);
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
      if (url.pathname.startsWith("/crm/persons/") && response.status() >= 400) {
        routeFailures.push(`${response.status()} ${url.pathname}`);
      }
    });

    // Start on a different CRM section and choose the real Today navigation
    // item. This exercises the product route instead of opening overview by URL.
    await page.goto(`${BASE_URL}/crm/directory`, { waitUntil: "domcontentloaded" });
    await navigateToToday(page, Boolean(options.isMobile));

    await followCustomerQueueLink(
      page,
      "at_risk_customers",
      AT_RISK_CUSTOMER_ID,
      AT_RISK_NAME,
      name,
      routeFailures,
    );

    await navigateToToday(page, Boolean(options.isMobile));
    await followCustomerQueueLink(
      page,
      "overdue_follow_ups",
      FOLLOW_UP_CUSTOMER_ID,
      FOLLOW_UP_NAME,
      name,
      routeFailures,
    );

    if (options.isMobile) {
      const noHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      await assert(noHorizontalOverflow, "mobile: customer profile has horizontal page overflow");
    }
  } finally {
    await context.close();
  }
}

async function main() {
  await db.connect();
  const business = await db.query("SELECT id FROM businesses WHERE slug = $1", [BUSINESS_SLUG]);
  if (!business.rows[0]) throw new Error(`Seed business ${BUSINESS_SLUG} was not found.`);
  businessId = business.rows[0].id;

  // A prior process kill can skip finally; clean only this test's namespaced
  // rows, never mutate lifecycle stages or any pre-existing seeded party.
  await removeStaleFixtures();

  await db.query(
    `INSERT INTO parties
       (id, business_id, name, roles, role, lifecycle_stage, last_interaction_at)
     VALUES ($1, $2, $3, ARRAY['customer']::text[], 'customer', 'at_risk', NULL)`,
    [AT_RISK_CUSTOMER_ID, businessId, AT_RISK_NAME],
  );
  createdCustomerIds.push(AT_RISK_CUSTOMER_ID);

  await db.query(
    `INSERT INTO parties (id, business_id, name, roles, role)
     VALUES ($1, $2, $3, ARRAY['customer']::text[], 'customer')`,
    [FOLLOW_UP_CUSTOMER_ID, businessId, FOLLOW_UP_NAME],
  );
  createdCustomerIds.push(FOLLOW_UP_CUSTOMER_ID);

  const activity = await db.query(
    `INSERT INTO crm_activities
       (business_id, customer_id, kind, subject, due_at, completed_at, assigned_to)
     VALUES ($1, $2, 'call', $3, '2000-01-01T00:00:00Z', NULL, '')
     RETURNING id`,
    [businessId, FOLLOW_UP_CUSTOMER_ID, FOLLOW_UP_SUBJECT],
  );
  activityId = activity.rows[0].id;

  // The queue orders NULL last-interaction timestamps before older contacts;
  // the low, test-only UUID ensures the new customer ranks inside its preview.
  const atRiskPreview = await db.query(
    `SELECT id FROM parties
      WHERE business_id = $1 AND merged_into_id IS NULL AND is_active
        AND lifecycle_stage = ANY($2::text[])
      ORDER BY last_interaction_at NULLS FIRST, id
      LIMIT 4`,
    [businessId, AT_RISK_STAGES],
  );
  await assert(
    atRiskPreview.rows.some((row) => row.id === AT_RISK_CUSTOMER_ID),
    "temporary at-risk customer did not rank inside the queue preview",
  );

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
} catch (error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  console.error(`::error title=CRM queue-link E2E failed::${detail.replaceAll("\n", " | ")}`);
  throw error;
} finally {
  await deleteTemporaryFixtures(createdCustomerIds);
  await db.end().catch(() => {});
}
