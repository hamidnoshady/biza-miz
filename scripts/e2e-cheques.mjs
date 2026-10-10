#!/usr/bin/env node
/**
 * Cheque register — browser acceptance against a running production server
 * (issue #828). Run in the media E2E job, which owns a fresh seeded database,
 * so the 220 cheques this script registers never touch the visual fixture.
 *
 *   npm run test:e2e:cheques        (server on E2E_BASE_URL, default :3000)
 *
 * What it proves, in a real browser:
 *   1. Paging walks every row exactly once, across a tied sort (same due
 *      date and amount), while a row the reader has already passed changes
 *      status between pages — nothing skipped, nothing repeated on screen.
 *   2. A filter changed while a page is pending resets the register, and the
 *      stale answer, arriving late, is not painted.
 *   3. A failed page keeps the rows already read and retries on request.
 *   4. Keyboard: every filter has a name; filters are reached in visual
 *      order; Tab stays inside the detail, journal and create dialogs; Escape
 *      closes each one and hands focus back to the control that opened it.
 *   5. A 390px phone frame has no horizontal page scroll, reaches «بیشتر»,
 *      and loads through it.
 *
 * Exits non-zero if any expectation fails. Nothing here is skipped or
 * retried into a pass.
 */
import { chromium } from "playwright";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const EXECUTABLE = process.env.VISUAL_CHROMIUM_PATH || undefined;

/** Tied rows: 120 share one due date and one amount — the sort's worst case. */
const TIED = 120;
/** Spread rows: 100 more across June, two amounts. Total 220 > the 200-row cap. */
const SPREAD = 100;
const TOTAL = TIED + SPREAD;
const PAGE = 50;

const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";
const toAscii = (s) => s.replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)));
const toPersian = (s) => s.replace(/[0-9]/g, (d) => PERSIAN[Number(d)]);

const serialOf = (index) => `E2E-${String(index).padStart(4, "0")}`;
const expectedSerials = Array.from({ length: TOTAL }, (_, i) => serialOf(i + 1));

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Polls until `fn` is truthy or the deadline passes. Radix restores focus on a timer, so this is not a guess. */
async function until(fn, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function login(context) {
  const response = await context.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!response.ok()) throw new Error(`owner login failed (${response.status()})`);
}

/**
 * Calls the API the way the app's own UI does: `fetch` inside a page on the
 * app's origin. The request API does not send the Secure session cookie over
 * plain http://127.0.0.1, and a bare request carries no Origin header, which
 * the origin check refuses for every mutation.
 */
async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        text: await response.text(),
        retryAfter: response.headers.get("retry-after"),
      };
    },
    { method, path, body },
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The API allows a business 300 requests a minute, and this job's media tests
 * spend part of that budget on the same business before this script starts.
 * A 429 is therefore waited out for the `Retry-After` the server gives, and
 * retried a bounded number of times — a real refusal still fails the run.
 */
async function apiPaced(page, method, path, body) {
  let response = await api(page, method, path, body);
  for (let attempt = 1; response.status === 429 && attempt <= 4; attempt += 1) {
    const seconds = Number(response.retryAfter ?? 5);
    await sleep((Number.isFinite(seconds) ? seconds : 5) * 1000 + 250);
    response = await api(page, method, path, body);
  }
  return response;
}

/**
 * A fresh database has no chart of accounts (`db:seed` only creates a login),
 * and a cheque posts into 1200/1241. Provisions the industry template through
 * the same setup route the setup wizard uses, if the chart lacks the cheque
 * accounts. A chart that already has journal lines is left alone.
 */
async function ensureChartOfAccounts(page) {
  const current = JSON.parse((await api(page, "GET", "/api/setup/accounts")).text);
  const codes = new Set((current.existing ?? []).map((a) => a.code));
  if (codes.has("1241") && codes.has("1200")) return;
  const posted = await api(page, "POST", "/api/setup/accounts", { accounts: current.template });
  if (posted.status >= 300) throw new Error(`provisioning the chart failed (${posted.status}): ${posted.text}`);
  console.log(`[e2e-cheques] chart of accounts provisioned from the template (${current.template.length} accounts)`);
}

/** Registers the fixture through the real API, a few requests at a time. */
async function seedCheques(page) {
  const bodyFor = (index) => {
    const tied = index <= TIED;
    const day = tied ? 1 : ((index - TIED - 1) % 28) + 1;
    return {
      direction: "receivable",
      serialNumber: serialOf(index),
      bankName: "ملت",
      amount: tied ? 1_000_000 : index % 2 === 0 ? 2_000_000 : 3_000_000,
      issueDate: "2026-01-10",
      dueDate: `2026-06-${String(day).padStart(2, "0")}`,
      counterpartyName: `مشتری ${toPersian(String(index % 7))}`,
      allowUnattributed: true,
    };
  };
  const indexes = Array.from({ length: TOTAL }, (_, i) => i + 1);
  // Three at a time with a pause between: about 170 requests a minute, under the budget.
  for (let i = 0; i < indexes.length; i += 3) {
    await Promise.all(
      indexes.slice(i, i + 3).map(async (index) => {
        const response = await apiPaced(page, "POST", "/api/ledger/cheques", bodyFor(index));
        if (response.status >= 300) {
          throw new Error(`registering ${serialOf(index)} failed (${response.status}): ${response.text}`);
        }
      }),
    );
    await sleep(1000);
  }
  const list = JSON.parse((await api(page, "GET", "/api/ledger/cheques?direction=receivable&limit=1")).text);
  if (list.total < TOTAL) throw new Error(`register holds ${list.total}, expected at least ${TOTAL}`);
}

/** A status change on a row the reader has already passed — the moving-data case. */
async function bounceBySerial(page, serial) {
  const list = JSON.parse(
    (await api(page, "GET", `/api/ledger/cheques?direction=receivable&q=${serial}&limit=5`)).text,
  );
  const cheque = list.cheques.find((c) => c.serialNumber === serial);
  if (!cheque) throw new Error(`no cheque ${serial}`);
  const response = await apiPaced(page, "POST", `/api/ledger/cheques/${cheque.id}/bounce`, {
    occurredOn: "2026-02-01",
  });
  if (response.status >= 300) throw new Error(`bouncing ${serial} failed (${response.status}): ${response.text}`);
}

/** Serials of the rows on screen, in DOM order (the desktop table; the cards mirror it). */
async function rowSerials(page) {
  const labels = await page
    .locator('button[aria-label^="جزئیات چک "]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  return labels.map((label) => toAscii(label.replace("جزئیات چک ", "")));
}

async function gotoRegister(page) {
  await page.goto(`${BASE_URL}/accounting/cheques`, { waitUntil: "domcontentloaded" });
  await until(async () => (await rowSerials(page)).length > 0, 30_000);
}

function loadMoreButton(page) {
  return page.getByRole("button", { name: /مورد بیشتر/ });
}

/** Presses «بیشتر» until it is gone. */
async function loadAll(page) {
  for (let guard = 0; guard < 20; guard += 1) {
    const button = loadMoreButton(page);
    if ((await button.count()) === 0) return;
    const before = (await rowSerials(page)).length;
    await button.click();
    await until(async () => (await rowSerials(page)).length > before, 15_000);
  }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: EXECUTABLE ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [],
  });
  const desktopOptions = {
    viewport: { width: 1360, height: 900 },
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    reducedMotion: "reduce",
  };
  const desktop = await browser.newContext(desktopOptions);
  try {
    await login(desktop);
    // A page on the app's origin carries the session cookie and Origin for every API call.
    const page = await desktop.newPage();
    await page.goto(`${BASE_URL}/api/health`, { waitUntil: "domcontentloaded" });
    await ensureChartOfAccounts(page);
    console.log("[e2e-cheques] seeding 220 receivables through the API");
    await seedCheques(page);

    // ---------------------------------------------------------------------
    console.log("1. paging: every row once, tied sort, a status change mid-walk");
    await gotoRegister(page);
    const first = await rowSerials(page);
    check("first window is one page", first.length === PAGE, `got ${first.length}`);
    // Bounce a row the reader has already read; it moves to the closed group.
    const bounced = first[2];
    await bounceBySerial(page, bounced);
    await loadAll(page);
    const seen = await rowSerials(page);
    const unique = new Set(seen);
    check(`all ${TOTAL} rows on screen`, seen.length === TOTAL, `got ${seen.length}`);
    check("no row repeated on screen", unique.size === seen.length, `${seen.length - unique.size} repeated`);
    const missing = expectedSerials.filter((s) => !unique.has(s));
    check("no row missing", missing.length === 0, missing.slice(0, 5).join(", "));
    check("the rows above the reader kept their place", seen[0] === first[0] && seen[1] === first[1]);

    // ---------------------------------------------------------------------
    console.log("2. a filter changed while a page is pending");
    await gotoRegister(page);
    let holdNextCursor = true;
    let release;
    let heldStarted;
    const held = new Promise((resolve) => (heldStarted = resolve));
    await page.route("**/api/ledger/cheques?*", async (route) => {
      const url = new URL(route.request().url());
      if (holdNextCursor && url.searchParams.has("cursor")) {
        holdNextCursor = false;
        heldStarted();
        await new Promise((resolve) => (release = resolve));
      }
      await route.continue();
    });
    await loadMoreButton(page).click();
    await held;
    const search = page.getByLabel("جستجوی چک‌ها");
    await search.fill(serialOf(77));
    const filtered = await until(async () => {
      const rows = await rowSerials(page);
      return rows.length === 1 && rows[0] === serialOf(77) ? rows : null;
    }, 10_000);
    check("the register answers the new filter alone", Boolean(filtered));
    release();
    await page.waitForTimeout(800);
    const afterStale = await rowSerials(page);
    check(
      "the stale page does not paint over the filtered register",
      afterStale.length === 1 && afterStale[0] === serialOf(77),
      `${afterStale.length} rows on screen`,
    );
    const more = loadMoreButton(page);
    check(
      "«بیشتر» is not stuck busy after the reset",
      (await more.count()) === 0 || (await more.isEnabled()),
    );
    await page.unroute("**/api/ledger/cheques?*");

    // ---------------------------------------------------------------------
    console.log("3. a failed page is retried without losing the register");
    await search.fill("");
    await until(async () => (await rowSerials(page)).length === PAGE, 10_000);
    let failNextCursor = true;
    await page.route("**/api/ledger/cheques?*", async (route) => {
      const url = new URL(route.request().url());
      if (failNextCursor && url.searchParams.has("cursor")) {
        failNextCursor = false;
        return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      }
      return route.continue();
    });
    await loadMoreButton(page).click();
    const retry = page.getByRole("button", { name: "تلاش دوباره" });
    await retry.waitFor({ timeout: 10_000 });
    check(
      "the failure says so, in words",
      (await page.getByRole("alert").filter({ hasText: "ناموفق" }).count()) > 0,
    );
    check("the rows already read stay on screen", (await rowSerials(page)).length === PAGE);
    await retry.click();
    await until(async () => (await rowSerials(page)).length === PAGE * 2, 10_000);
    check("retry appends the next window", (await rowSerials(page)).length === PAGE * 2);
    await page.unroute("**/api/ledger/cheques?*");
    await loadAll(page);

    // ---------------------------------------------------------------------
    console.log("4. keyboard: names, tab order, dialogs, focus return");
    await gotoRegister(page);
    for (const name of ["فیلتر وضعیت چک", "فیلتر بانک", "مرتب‌سازی چک‌ها"]) {
      check(`filter «${name}» is named`, (await page.getByRole("combobox", { name }).count()) === 1);
    }
    check("search is named", (await page.getByLabel("جستجوی چک‌ها").count()) === 1);

    // Narrow to one row first: the register's own order is not what this checks.
    await search.fill(serialOf(3));
    await until(async () => (await rowSerials(page)).length === 1, 10_000);
    const rowName = `جزئیات چک ${toPersian(serialOf(3))}`;
    check("each row action has its own name", (await page.getByRole("button", { name: rowName }).count()) === 1);

    await search.focus();
    const tabOrder = [await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      tabOrder.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
    }
    const order = ["جستجوی چک‌ها", "فیلتر وضعیت چک", "فیلتر بانک", "مرتب‌سازی چک‌ها"];
    const idx = order.map((label) => tabOrder.indexOf(label));
    check(
      "filters are reached in visual order, search first",
      idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]),
      tabOrder.join(" | "),
    );

    // Detail dialog: open from the row, Tab stays in, Escape closes, focus returns.
    const opener = page.getByRole("button", { name: rowName });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator('[role="dialog"]').first();
    await dialog.waitFor({ timeout: 10_000 });
    let escaped = false;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      if (!(await dialog.evaluate((d) => d.contains(document.activeElement)))) {
        escaped = true;
        break;
      }
    }
    check("Tab stays inside the detail dialog", !escaped);
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator('[role="dialog"]').count()) === 0, 5_000);
    check("Escape closes the detail dialog", (await page.locator('[role="dialog"]').count()) === 0);
    const returned = await until(() => opener.evaluate((el) => el === document.activeElement), 3_000);
    check("focus returns to the row that opened the detail", returned === true);

    // Journal dialog, from the bounced cheque's history (the bounce posted an entry).
    await search.fill(bounced);
    await until(async () => (await rowSerials(page)).length === 1, 10_000);
    await page.getByRole("button", { name: `جزئیات چک ${toPersian(bounced)}` }).click();
    const detail = page.locator('[role="dialog"]').first();
    await detail.waitFor({ timeout: 10_000 });
    const journalLink = detail.getByRole("button", { name: "مشاهده سند حسابداری" }).first();
    const hasJournal = (await journalLink.count()) > 0;
    check("the bounced cheque's history links its journal entry", hasJournal);
    if (hasJournal) {
      await journalLink.focus();
      await page.keyboard.press("Enter");
      await until(async () => (await page.locator('[role="dialog"]').count()) === 2, 10_000);
      check("the journal entry opens as a second dialog", (await page.locator('[role="dialog"]').count()) === 2);
      const journalPanel = page.locator('[aria-labelledby="journal-peek-heading"]');
      check("focus moves into the journal panel when it opens", await journalPanel.evaluate((p) => p.contains(document.activeElement)));
      let journalLeaked = false;
      for (let i = 0; i < 30; i += 1) {
        await page.keyboard.press("Tab");
        if (!(await journalPanel.evaluate((p) => p.contains(document.activeElement)))) {
          journalLeaked = true;
          break;
        }
      }
      check("Tab stays inside the journal panel", !journalLeaked);
      await page.keyboard.press("Escape");
      await until(async () => (await page.locator('[role="dialog"]').count()) === 1, 5_000);
      check("Escape closes only the journal dialog", (await page.locator('[role="dialog"]').count()) === 1);
      const back = await until(() => journalLink.evaluate((el) => el === document.activeElement), 3_000);
      check("focus returns to the journal link", back === true);
    }
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator('[role="dialog"]').count()) === 0, 5_000);

    // Create dialog.
    const create = page.getByRole("button", { name: "ثبت چک جدید" });
    await create.focus();
    await page.keyboard.press("Enter");
    const createDialog = page.locator('[role="dialog"]').first();
    await createDialog.waitFor({ timeout: 10_000 });
    let leaked = false;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      if (!(await createDialog.evaluate((d) => d.contains(document.activeElement)))) {
        leaked = true;
        break;
      }
    }
    check("Tab stays inside the create dialog", !leaked);
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator('[role="dialog"]').count()) === 0, 5_000);
    const createBack = await until(() => create.evaluate((el) => el === document.activeElement), 3_000);
    check("focus returns to «ثبت چک جدید»", createBack === true);

    // ---------------------------------------------------------------------
    console.log("5. phone frame (390px): no page scroll, cards visible, «بیشتر» reachable");
    const phone = await browser.newContext({
      ...desktopOptions,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    await login(phone);
    const mobile = await phone.newPage();
    await gotoRegister(mobile);
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check("no horizontal page scroll at 390px", overflow <= 1, `overflows by ${overflow}px`);
    const card = mobile.getByRole("button", { name: /^جزئیات و تاریخچهٔ چک / }).first();
    const box = await card.boundingBox();
    check(
      "the first card is visible inside the phone width",
      Boolean(box) && box.x >= 0 && box.x + box.width <= 390 + 1,
      JSON.stringify(box),
    );
    const mobileMore = loadMoreButton(mobile);
    await mobileMore.scrollIntoViewIfNeeded();
    check("«بیشتر» is visible on the phone frame", await mobileMore.isVisible());
    const before = (await rowSerials(mobile)).length;
    await mobileMore.click();
    await until(async () => (await rowSerials(mobile)).length > before, 10_000);
    check("«بیشتر» loads the next window on the phone frame", (await rowSerials(mobile)).length > before);
    await mobile.screenshot({ path: "/tmp/e2e-cheques-mobile.png", fullPage: false });
    await phone.close();
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\n[e2e-cheques] ${failures.length} expectation(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\n[e2e-cheques] all expectations passed");
}

main().catch((error) => {
  console.error(`[e2e-cheques] ${error.stack ?? error}`);
  process.exit(1);
});
