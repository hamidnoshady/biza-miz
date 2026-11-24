#!/usr/bin/env node
/**
 * Browser acceptance for ticket-wide kitchen fulfillment (issue #1048).
 *
 * Runs against a migrated, seeded server and a real PostgreSQL database:
 *
 *   DATABASE_URL=… E2E_BASE_URL=http://127.0.0.1:3000 \
 *     npm run test:e2e:kitchen-batch
 *
 * DATABASE_URL must be the migration/owner connection (the script seeds and
 * asserts raw rows); the server under test should use its unprivileged app
 * role, as production does.
 *
 * It owns only its fixture orders (1048–1050) in the first business/location,
 * so it can be re-run against the same E2E database. It proves:
 *  1. owner login through the manager door and the real KDS page;
 *  2. Start all posts one server-side batch, updates every sent line, and the
 *     same request retried through the real API reports already-applied
 *     instead of advancing twice;
 *  3. a line changed by another worker (served) is reported per line and the
 *     remaining preparing lines still advance — no false all-success;
 *  4. Escape cancels the confirmation and sends nothing;
 *  5. a 390px viewport stays RTL and has no horizontal page scroll.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { Client } from "pg";

const BASE_URL = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").origin;
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required: this acceptance seeds and checks real kitchen lines.");
  process.exit(1);
}

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const fa = (value) => String(value).replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function firstVisible(page, locator, what) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  throw new Error(`${what} is not visible`);
}

const db = new Client({ connectionString: DATABASE_URL });
let browser;

async function resetOrders(locationId, specs) {
  for (const spec of specs) {
    const existing = await db.query(
      "SELECT id FROM orders WHERE location_id = $1 AND order_number = $2",
      [locationId, spec.number],
    );
    for (const order of existing.rows) {
      await db.query("UPDATE orders SET status = 'open' WHERE id = $1", [order.id]);
      await db.query("DELETE FROM order_items WHERE order_id = $1", [order.id]);
      await db.query("DELETE FROM orders WHERE id = $1", [order.id]);
    }
    const inserted = await db.query(
      "INSERT INTO orders (location_id, order_number, type, status, total) VALUES ($1, $2, $3, 'open', 0) RETURNING id",
      [locationId, spec.number, spec.type ?? "dine_in"],
    );
    const orderId = inserted.rows[0].id;
    for (const [index, status] of spec.statuses.entries()) {
      await db.query(
        `INSERT INTO order_items
           (location_id, order_id, name_snapshot, unit_price, quantity, status, sent_to_kitchen_at)
         VALUES ($1, $2, $3, 100000, 1, $4, now())`,
        [locationId, orderId, `${spec.name} ${index + 1}`, status],
      );
    }
    spec.orderId = orderId;
  }
}

async function statusesOf(orderId) {
  const { rows } = await db.query(
    "SELECT id, status::text FROM order_items WHERE order_id = $1",
    [orderId],
  );
  return rows;
}

async function main() {
  await db.connect();
  const business = await db.query("SELECT id FROM businesses ORDER BY created_at LIMIT 1");
  assert(business.rows[0], "No business found — run npm run db:seed first");
  const location = await db.query(
    "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1",
    [business.rows[0].id],
  );
  assert(location.rows[0], "No location found — run npm run db:seed first");
  const locationId = location.rows[0].id;

  const specs = [
    { number: 1048, name: "آشپزخانه ۱۰۴۸", statuses: ["sent", "sent", "sent"] },
    { number: 1049, name: "آشپزخانه ۱۰۴۹", statuses: ["preparing", "preparing", "preparing"], type: "takeaway" },
    { number: 1050, name: "آشپزخانه ۱۰۵۰", statuses: ["sent", "sent"] },
  ];
  await resetOrders(locationId, specs);

  browser = await chromium.launch({ headless: process.env.E2E_HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.setDefaultNavigationTimeout(120_000);

  await page.goto(`${BASE_URL}/admin`, { waitUntil: "domcontentloaded" });
  const identifier = page.getByLabel("ایمیل", { exact: true });
  const passwordInput = page.getByLabel("رمز عبور", { exact: true });
  await identifier.waitFor();
  // Let hydration attach before filling; an input event that lands first
  // leaves React's state empty and the submit button disabled.
  await page.waitForTimeout(1_200);
  await identifier.fill(EMAIL);
  await passwordInput.fill(PASSWORD);
  const loginButton = page.getByRole("button", { name: "ورود", exact: true });
  if (!(await loginButton.isEnabled())) {
    await identifier.click();
    await identifier.press("Control+A");
    await identifier.pressSequentially(EMAIL, { delay: 10 });
    await passwordInput.click();
    await passwordInput.press("Control+A");
    await passwordInput.pressSequentially(PASSWORD, { delay: 10 });
  }
  assert(await loginButton.isEnabled(), "The login form stayed disabled after typing the owner credentials");
  await loginButton.click();
  await page.waitForTimeout(3_000);
  // A fresh owner is offered the mandatory-MFA enrollment screen. This
  // acceptance is about kitchen fulfillment, not 2FA enrollment, so take the
  // documented "later" path and continue.
  const later = page.getByRole("button", { name: "بعداً", exact: true });
  if (await later.isVisible().catch(() => false)) {
    await later.click();
    await page.waitForTimeout(3_000);
  }
  const path = new URL(page.url()).pathname;
  if (path.startsWith("/admin") || path.startsWith("/login")) {
    const cookies = await context.cookies(BASE_URL);
    assert(
      cookies.some((cookie) => cookie.name === "pos_session" && cookie.value),
      `Login did not mint a session (still on ${page.url()})`,
    );
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  }
  assert(!page.url().includes("/setup"), `Login landed on ${page.url()} instead of the app`);

  await page.goto(`${BASE_URL}/accounting/kitchen`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "آشپزخانه", exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: new RegExp(`سفارش ${fa(1048)}`) }).first().click();

  const startAll = page.getByRole("button", { name: "شروع آماده‌سازی همهٔ اقلام جدید" });
  await (await firstVisible(page, startAll, "Start all")).click();
  await page.getByRole("dialog").waitFor();
  const startConfirm = page.getByRole("button", { name: new RegExp(`شروع آماده‌سازی \\(${fa(3)}\\)`) });
  await startConfirm.click();

  const firstResult = page.getByLabel("نتیجهٔ اقدام گروهی آشپزخانه");
  await firstResult.getByText(new RegExp(`${fa(3)} قلم ثبت شد`)).waitFor();
  assert(
    (await firstResult.textContent())?.includes(`${fa(3)} قلم ثبت شد`),
    "The first batch did not report three applied lines",
  );
  assert(
    (await statusesOf(specs[0].orderId)).every((line) => line.status === "preparing"),
    "Start all did not persist every sent line as preparing",
  );

  // A retry of the same intent must be a no-op, not a second transition.
  // Use the page's own fetch so the browser sends the same session cookie the
  // KDS used (a Playwright APIRequestContext does not share this site's
  // strict session cookie on plain-HTTP localhost).
  const retry = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "preparing" }),
    });
    return { status: response.status, body: await response.json() };
  }, `${BASE_URL}/api/kitchen/tickets/${specs[0].orderId}/batch`);
  assert(retry.status === 200, `Retried batch returned HTTP ${retry.status}`);
  const retryBody = retry.body;
  assert(retryBody.summary.applied === 0, "A retried batch applied transitions twice");
  assert(retryBody.summary.alreadyApplied === 3, "A retried batch did not report already-applied");
  assert(
    (await statusesOf(specs[0].orderId)).every((line) => line.status === "preparing"),
    "A retried batch moved lines past preparing",
  );

  // A concurrent worker serves one line after the operator's dialog snapshot.
  await db.query("UPDATE order_items SET status = 'preparing' WHERE order_id = $1", [specs[1].orderId]);
  await page.getByRole("button", { name: new RegExp(`سفارش ${fa(1049)}`) }).first().click();
  const readyAll = page.getByRole("button", {
    name: "علامت‌گذاری همهٔ اقلام در حال آماده‌سازی به‌عنوان آماده",
  });
  await (await firstVisible(page, readyAll, "Mark ready")).click();
  await page.getByRole("dialog").waitFor();
  const secondLines = await statusesOf(specs[1].orderId);
  await db.query("UPDATE order_items SET status = 'served' WHERE id = $1", [secondLines[0].id]);
  await page.getByRole("button", { name: new RegExp(`علامت‌گذاری به‌عنوان آماده \\(${fa(3)}\\)`) }).click();

  const partialResult = page.getByLabel("نتیجهٔ اقدام گروهی آشپزخانه");
  await partialResult
    .getByText(new RegExp(`${fa(1)} قلم سروشده/باطل/در انتظار قابل تغییر نبود`))
    .waitFor();
  const partialText = (await partialResult.textContent()) ?? "";
  assert(partialText.includes(`${fa(2)} قلم ثبت شد`), "Partial batch did not report its two applied lines");
  assert(
    partialText.includes(`${fa(1)} قلم سروشده/باطل/در انتظار قابل تغییر نبود`),
    "Partial batch did not report the served line as ineligible",
  );
  assert(!partialText.includes(`${fa(3)} قلم ثبت شد`), "Partial batch falsely claimed all three lines applied");
  const afterSecond = await statusesOf(specs[1].orderId);
  assert(
    afterSecond.filter((line) => line.status === "ready").length === 2 &&
      afterSecond.some((line) => line.status === "served"),
    "Partial batch persisted the wrong line states",
  );

  // Keyboard: Escape cancels the confirmation and sends nothing.
  await page.getByRole("button", { name: new RegExp(`سفارش ${fa(1050)}`) }).first().click();
  await (await firstVisible(page, startAll, "Start all for cancel")).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert(
    (await statusesOf(specs[2].orderId)).every((line) => line.status === "sent"),
    "Escape still sent a batch",
  );

  await (await firstVisible(page, startAll, "Start all after cancel")).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: new RegExp(`شروع آماده‌سازی \\(${fa(2)}\\)`) }).click();
  await page
    .getByLabel("نتیجهٔ اقدام گروهی آشپزخانه")
    .getByText(new RegExp(`سفارش ${fa(1050)}`))
    .waitFor();
  await page
    .getByLabel("نتیجهٔ اقدام گروهی آشپزخانه")
    .getByText(new RegExp(`${fa(2)} قلم ثبت شد`))
    .waitFor();
  assert(
    (await statusesOf(specs[2].orderId)).every((line) => line.status === "preparing"),
    "The keyboard-driven batch did not persist",
  );

  // Mobile/RTL: the operational surface must not create horizontal page scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: new RegExp(`سفارش ${fa(1048)}`) })
    .first()
    .waitFor({ timeout: 60_000 });
  const layout = await page.evaluate(() => ({
    direction: getComputedStyle(document.body).direction,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  assert(layout.direction === "rtl", `Mobile surface is not RTL (${layout.direction})`);
  assert(!layout.overflow, "Mobile kitchen page has horizontal overflow");

  console.log(
    JSON.stringify(
      {
        ok: true,
        firstBatch: "3 applied",
        retry: "already applied, no duplicate",
        partialBatch: "2 applied / 1 served reported separately",
        escapeCancel: "no write",
        mobile: "390px RTL with no horizontal overflow",
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  console.error("\nKitchen batch acceptance failed:", error instanceof Error ? error.message : error);
  if (browser) {
    try {
      const page = (await browser.contexts()[0]?.pages())?.[0];
      if (page) {
        mkdirSync("test-results", { recursive: true });
        await page.screenshot({ path: "test-results/kitchen-batch-failure.png", fullPage: true });
        console.error("Screenshot: test-results/kitchen-batch-failure.png");
        console.error("URL:", page.url());
      }
    } catch {
      // The failure path must not hide the original error.
    }
  }
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await db.end().catch(() => {});
}
