/**
 * Authenticated end-to-end acceptance for guided tours (issue #972, Phase A).
 *
 * This is the suite that proves the *real* journey in a real browser against a
 * real server and database — not a mocked unit: sign in, open the existing
 * «آموزش» button, start a tour, walk it, reload mid-tour, cross a page
 * boundary, complete it, and confirm an ineligible member is refused.
 *
 * Deliberate scope (the rest is covered by unit / integration / RLS suites):
 *  1. owner login, Knowledge button, tour list, article half still present;
 *  2. start → steps → complete, and the server's own progress agrees;
 *  3. refresh mid-tour resumes at the same step;
 *  4. pause/resume from the modal;
 *  5. a cross-page tour navigates and keeps the same session;
 *  6. verified action evidence: 409 before the write, 200 after;
 *  7. a learning-path page step can be acknowledged; a tour step cannot;
 *  8. a cashier without `parties.manage` is refused the protected tour;
 *  9. a missing/blocked tour request leaves the article usable;
 * 10. desktop and 390×844 mobile/RTL, with no horizontal overflow.
 *
 * Requires: a migrated + seeded server (`npm run db:seed`), the same
 * `DATABASE_URL`, and `SEED_OWNER_*` (defaults match scripts/seed.ts).
 *
 * Usage: node scripts/e2e-guided-tours.mjs
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE_URL = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000").origin;
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const BUSINESS_SLUG = process.env.SEED_BUSINESS_SLUG ?? "cafe-nemoone";
const CASHIER_PIN = process.env.SEED_CASHIER_PIN ?? "1234";
const EXECUTABLE = process.env.VISUAL_CHROMIUM_PATH || undefined;
const ARTIFACTS = process.env.E2E_ARTIFACTS_DIR ?? ".cache/guided-tours";
const RUN_ID = Date.now().toString(36);

mkdirSync(ARTIFACTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: EXECUTABLE ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [],
});

const failures = [];
let shots = 0;

function log(step, message) {
  console.log(`[e2e-tours] ${step}: ${message}`);
}

async function shot(page, name) {
  shots += 1;
  await page.screenshot({ path: `${ARTIFACTS}/${String(shots).padStart(2, "0")}-${name}.png`, fullPage: false }).catch(() => {});
}

async function step(name, fn) {
  try {
    await fn();
    log("ok", name);
  } catch (error) {
    failures.push({ name, error });
    log("FAILED", `${name} — ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function settle(page) {
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll("main, [data-page-shell]").length > 0 &&
        document.querySelectorAll('[aria-busy="true"]').length === 0 &&
        document.querySelectorAll('[data-slot="skeleton"]').length === 0,
      null,
      { timeout: 45_000 },
    )
    .catch(() => {});
}

async function openPage(page, path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await settle(page);
}

// Use Chromium's cookie jar and Origin header for every request. The
// production session is Secure, including on the loopback CI origin.
async function browserApi(page, url, data) {
  const { status, text } = await page.evaluate(async ({ url, data }) => {
    const response = await fetch(url, {
      method: data === undefined ? "GET" : "POST",
      credentials: "same-origin",
      redirect: "error",
      ...(data === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    return { status: response.status, text: await response.text() };
  }, { url, data });
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body is reported by the caller through `body()` rather than
    // hiding the HTTP status behind a JSON parse error.
  }
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: () => payload,
    body: () => text,
  };
}

async function ownerLogin(page) {
  const url = `${BASE_URL}/api/auth/login`;
  const credentials = { email: EMAIL, password: PASSWORD };
  let login = await browserApi(page, url, credentials);
  assert(login.ok(), `owner login failed (${login.status()})`);
  const initial = login.json();
  if (initial.needsBusinessSelection) {
    const business = initial.businesses?.find(({ slug }) => slug === BUSINESS_SLUG);
    assert(business, "owner login did not offer the seeded business");
    login = await browserApi(page, url, { ...credentials, businessId: business.id });
  }

  assert(login.ok(), `owner tenant login failed (${login.status()})`);
  const result = login.json();
  assert(result.business?.slug === BUSINESS_SLUG && result.user?.role === "owner",
    "login did not establish an owner session for the seeded business");
  await assertSessionRole(page, "owner", result.business.id);
  return result.business.id;
}

async function assertSessionRole(page, role, businessId) {
  const session = await browserApi(page, `${BASE_URL}/api/auth/me`);
  assert(session.ok(), `${role} browser session failed (${session.status()})`);
  const { user } = session.json();
  assert(user?.role === role && user.businessId === businessId, `unexpected ${role} browser session`);
}

const overlay = (page) => page.locator("[data-tour-overlay]");
const overlayHeading = (page) => overlay(page).getByRole("heading", { level: 2 });

async function waitForOverlay(page) {
  await overlay(page).waitFor({ state: "visible", timeout: 120_000 });
  await overlayHeading(page).waitFor({ state: "visible", timeout: 30_000 });
}

async function startTourFromPage(page, label, optionText) {
  await page.getByRole("button", { name: `آموزش ${label}` }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("تور تعاملی صفحه").waitFor({ timeout: 60_000 });
  const button = optionText
    ? dialog.getByRole("button", { name: optionText })
    : dialog.getByRole("button", { name: /شروع تور|ادامهٔ تور|مرور دوباره/ }).first();
  await button.click();
  await waitForOverlay(page);
}

async function clickNext(page) {
  const button = overlay(page).getByRole("button", { name: /^(بعدی|پایان)$/ });
  await button.click({ timeout: 120_000 });
}

/** Press Next and wait until the visible step changed (or the tour closed). */
async function clickNextAndSettle(page) {
  const before = await overlayHeading(page).innerText().catch(() => "");
  await clickNext(page);
  await page.waitForFunction(
    (previous) => {
      const current = document.querySelector("[data-tour-overlay]");
      if (!current) return true;
      const heading = current.querySelector("h2");
      return Boolean(heading && heading.textContent && heading.textContent.trim() !== previous);
    },
    before,
    { timeout: 120_000 },
  );
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------
const desktop = await browser.newContext({
  viewport: { width: 1360, height: 900 },
  locale: "fa-IR",
  timezoneId: "Asia/Tehran",
  reducedMotion: "reduce",
});
const page = await desktop.newPage();
let desktopState = null;
let ownerBusinessId;

try {
  await page.goto(`${BASE_URL}/api/health`);
  ownerBusinessId = await ownerLogin(page);

  const reset = await browserApi(page,
    `${BASE_URL}/api/knowledge/tours/accounting.overview.ledger/progress`,
    { event: "reset" },
  );
  assert(reset.ok(), `initial progress reset failed (${reset.status()})`);

  await step("the Knowledge button offers a tour and the article half", async () => {
    await openPage(page, "/accounting/overview");
    assert((await page.locator("html").getAttribute("dir")) === "rtl", "page is not RTL");
    await page.getByRole("button", { name: "آموزش داشبورد حسابداری" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("تور تعاملی صفحه").waitFor({ timeout: 60_000 });
    await dialog.getByRole("button", { name: "شروع تور" }).click();
    await waitForOverlay(page);
    await shot(page, "started");
  });

  await step("steps advance and the tour completes with server progress", async () => {
    for (let i = 0; i < 7; i += 1) await clickNextAndSettle(page);
    await overlay(page).waitFor({ state: "detached", timeout: 120_000 });
    const playback = await browserApi(page,
      `${BASE_URL}/api/knowledge/tours/accounting.overview.ledger`,
    );
    assert(playback.ok(), `tour playback request failed (${playback.status()}): ${playback.body()}`);
    const payload = playback.json();
    assert(payload?.progress, `unexpected playback body: ${playback.body()}`);
    assert(payload.progress.status === "completed", `tour not completed: ${payload.progress.status}`);
  });

  await step("a refresh mid-tour resumes at the same step", async () => {
    await startTourFromPage(page, "داشبورد حسابداری", "مرور دوباره");
    const first = await overlayHeading(page).innerText();
    await clickNextAndSettle(page);
    const second = await overlayHeading(page).innerText();
    assert(first !== second, "the second step did not open");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
    await settle(page);
    await waitForOverlay(page);
    const resumed = await overlayHeading(page).innerText();
    assert(resumed === second, `resume showed "${resumed}", expected "${second}"`);
  });

  await step("closing pauses, and the modal offers Continue", async () => {
    await page.keyboard.press("Escape");
    await overlay(page).waitFor({ state: "detached", timeout: 10_000 });
    await page.getByRole("button", { name: "آموزش داشبورد حسابداری" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "ادامهٔ تور" }).waitFor({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "ادامهٔ تور" }).click();
    await waitForOverlay(page);
    await page.keyboard.press("Escape");
  });

  await step("a cross-page tour keeps the session across navigation", async () => {
    await openPage(page, "/accounting/orders");
    await startTourFromPage(page, "سفارش‌ها", "شروع تور");
    for (let i = 0; i < 3; i += 1) await clickNextAndSettle(page);
    const navigate = overlay(page).getByRole("button", { name: "رفتن به بخش بعدی" });
    await navigate.click();
    await page.waitForURL("**/accounting/pos", { timeout: 30_000 });
    await settle(page);
    await waitForOverlay(page);
    const heading = await overlayHeading(page).innerText();
    assert(heading.includes("سبد و پرداخت"), `destination step was "${heading}"`);
    await page.keyboard.press("Escape");
  });

  await step("verified action evidence is required, and a real write satisfies it", async () => {
    const tour = await browserApi(page,
      `${BASE_URL}/api/knowledge/tours/crm.directory.first-customer`,
    );
    assert(tour.ok(), "action tour playback failed");
    const before = await browserApi(page,
      `${BASE_URL}/api/knowledge/tours/crm.directory.first-customer/verify`,
      { stepId: "register" },
    );
    assert(before.status() === 409, `expected 409 before the write, got ${before.status()}`);

    const created = await browserApi(page, `${BASE_URL}/api/parties`, {
      displayName: `مشتری تور ${RUN_ID}`,
      role: "Customer",
      roles: ["Customer"],
    });
    assert(created.ok(), `party create failed (${created.status()})`);

    const after = await browserApi(page,
      `${BASE_URL}/api/knowledge/tours/crm.directory.first-customer/verify`,
      { stepId: "register" },
    );
    assert(after.ok(), `expected 200 after the write, got ${after.status()}`);
  });

  await step("a tour step cannot be claimed, a page step can be acknowledged", async () => {
    const refused = await browserApi(page,
      `${BASE_URL}/api/knowledge/learning-paths/cafe.first-day/progress`,
      { event: "step_completed", stepId: "register-customer" },
    );
    assert(refused.status() === 400, `tour step claim should be 400, got ${refused.status()}`);

    const acknowledged = await browserApi(page,
      `${BASE_URL}/api/knowledge/learning-paths/retail.first-sale/progress`,
      { event: "step_completed", stepId: "submit-invoice" },
    );
    assert(acknowledged.ok(), `page step acknowledgement failed (${acknowledged.status()})`);
    const detail = await browserApi(page,
      `${BASE_URL}/api/knowledge/learning-paths/retail.first-sale`,
    );
    assert(detail.ok(), "path detail failed");
    const payload = detail.json();
    assert(
      payload.steps.find((entry) => entry.id === "submit-invoice")?.completed === true,
      "acknowledged page step is not shown as completed",
    );
  });

  await step("a blocked tour request leaves the article half usable", async () => {
    await openPage(page, "/accounting/orders");
    await page.route("**/api/knowledge/tours?page=*", (route) => route.abort());
    await page.getByRole("button", { name: /^آموزش / }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 15_000 });
    await dialog.getByText(/هنوز صفحهٔ آموزشی|راهنمای پایگاه دانش|مرکز آموزش/).first().waitFor({
      timeout: 20_000,
    });
    await page.unroute("**/api/knowledge/tours?page=*");
    await page.keyboard.press("Escape");
  });
} finally {
  if (failures.length > 0) await shot(page, "desktop-failure").catch(() => {});
  desktopState = await desktop.storageState().catch(() => null);
  await desktop.close();
}

// ---------------------------------------------------------------------------
// Ineligible member + mobile/RTL
// ---------------------------------------------------------------------------
const cashierContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  locale: "fa-IR",
  timezoneId: "Asia/Tehran",
  reducedMotion: "reduce",
});
try {
  const cashier = await cashierContext.newPage();
  await cashier.goto(`${BASE_URL}/api/health`);
  const roster = await browserApi(cashier,
    `${BASE_URL}/api/auth/pin-login/roster?businessSlug=${encodeURIComponent(BUSINESS_SLUG)}`,
  );
  assert(roster.ok(), `cashier roster failed (${roster.status()})`);
  const rosterBody = roster.json();
  const employee = (rosterBody.employees ?? []).find((entry) => entry.role === "cashier");
  assert(employee, "the seed has no PIN cashier");
  const pinLogin = await browserApi(cashier, `${BASE_URL}/api/auth/pin-login`, {
    pin: CASHIER_PIN, employeeId: employee.id, businessSlug: BUSINESS_SLUG,
  });
  assert(pinLogin.ok(), `cashier PIN login failed (${pinLogin.status()})`);

  await assertSessionRole(cashier, "cashier", ownerBusinessId);
  await step("an ineligible member is refused the protected tour", async () => {
    const denied = await browserApi(cashier,
      `${BASE_URL}/api/knowledge/tours/crm.directory.first-customer`,
    );
    assert(denied.status() === 404, `expected 404, got ${denied.status()}`);
  });
} finally {
  await cashierContext.close();
}

assert(desktopState, "the owner session was not captured for the mobile pass");
const mobileContext = await browser.newContext({
  storageState: desktopState,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  locale: "fa-IR",
  timezoneId: "Asia/Tehran",
  reducedMotion: "reduce",
});
try {
  const mobile = await mobileContext.newPage();
  await step("mobile/RTL: the button, the modal and the overlay fit the viewport", async () => {
    await openPage(mobile, "/accounting/pos");
    assert((await mobile.locator("html").getAttribute("dir")) === "rtl", "mobile page is not RTL");
    const horizontal = await mobile.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    assert(!horizontal, "mobile page scrolls horizontally");

    const help = mobile.getByRole("button", { name: /^آموزش / }).first();
    await help.click();
    const dialog = mobile.getByRole("dialog");
    await dialog.waitFor({ timeout: 15_000 });
    const dialogBox = await dialog.boundingBox();
    assert(dialogBox, "modal has no box");
    assert(dialogBox.width <= 390 + 1, `modal is wider than the phone: ${dialogBox.width}`);

    const start = dialog.getByRole("button", { name: /شروع تور|ادامهٔ تور/ }).first();
    assert(await start.count(), "the owner's POS tour was not offered on mobile");
    await start.click();
    await waitForOverlay(mobile);
    const box = await overlay(mobile).getByRole("dialog").boundingBox();
    assert(box, "overlay has no box");
    assert(box.x >= -1 && box.x + box.width <= 391, `overlay overflows the phone: ${JSON.stringify(box)}`);
    await shot(mobile, "mobile-overlay");
    await mobile.keyboard.press("Escape");
  });
} finally {
  await mobileContext.close();
}

await browser.close();

if (failures.length > 0) {
  console.error(`\n[e2e-tours] ${failures.length} step(s) failed:`);
  for (const failure of failures) console.error(` - ${failure.name}: ${failure.error}`);
  process.exitCode = 1;
} else {
  console.log("\n[e2e-tours] all steps passed");
}
