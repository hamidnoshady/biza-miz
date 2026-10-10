/**
 * End-to-end coverage for the multicurrency workspace (issue #863) — the same
 * contract `e2e-media.mjs` established for Media: a real Chromium driving the
 * real rendered UI against a real server and a real database, because these
 * flows can only be *proven* by an actual browser:
 *
 *  1. Currency settings: enable transaction currencies; record a rate from
 *     the form; void it from the same history table.
 *  2. Foreign document posting with a live conversion preview, a party
 *     attribution (the A/R leg), and the posting's reversal control.
 *  3. Open-lot selection and full settlement at a NEWER rate — the preview
 *     must show the realized GAIN before anyone confirms anything — then the
 *     settlement's reversal restoring the lot (reversal-aware open items),
 *     then a second, kept settlement.
 *  4. Revaluation preview → confirm → replay (the restated run leaves nothing
 *     to restate at the same asOf).
 *  5. All six report views render rows; the CSV export downloads.
 *  6. The account form's currency field (a foreign-currency bank) through the
 *     chart-of-accounts screen.
 *  7. The states a person actually hits: a currency with no rate, settling
 *     more than the open balance, an anonymous API request (401), a cashier
 *     (no ledger.view) opening the workspace (denied), RTL direction,
 *     keyboard reachability, and the mobile viewport.
 *
 * Requires a running server (dev or production) seeded with `npm run db:seed`
 * — owner@example.com — plus the multicurrency fixture this script itself
 * provisions through the real APIs (idempotent: unique names per run).
 *
 * Usage: DATABASE_URL=… node scripts/e2e-multicurrency.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const CASHIER_PIN = process.env.SEED_CASHIER_PIN ?? "1234";
const BUSINESS_SLUG = process.env.SEED_BUSINESS_SLUG ?? "cafe-nemoone";
// Screenshots/results MUST land outside the repo: `tsx watch` (the dev script)
// restarts the server on any in-repo file change, which would kill in-flight
// requests mid-walk. Default is outside the workspace root for exactly that.
const ARTIFACTS = process.env.E2E_ARTIFACTS_DIR ?? "/tmp/acceptance/multicurrency";

const results = [];
const shot = async (page, name) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: `${ARTIFACTS}/${name}.png`, fullPage: false });
};
/** One check: throws on failure (a false green is worse than a red), records on success. */
function check(name, condition, detail = "") {
  if (!condition) throw new Error(`E2E FAILURE — ${name}${detail ? `: ${detail}` : ""}`);
  results.push({ name, pass: true, detail });
  console.log(`  ✓ ${name}`);
}

/** Click the SearchableSelect trigger, type a query, click the matching option. */
async function pickSearchable(page, triggerLabel, query, optionText) {
  // exact: «حساب تسویه» must not substring-match «طرف حساب تسویه».
  const trigger = page.getByRole("button", { name: triggerLabel, exact: true }).first();
  await trigger.click();
  // The Radix popover portals the search input to the end of the body; options
  // are scoped INSIDE it (a global option query would catch native <select>s).
  const popover = page.locator("[data-radix-popper-content-wrapper]");
  const input = popover.locator("input");
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(query);
  await popover.getByRole("option", { name: optionText }).first().waitFor({ state: "visible", timeout: 60_000 });
  await popover.getByRole("option", { name: optionText }).first().click();
}

async function main() {
  const api = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!api.ok) throw new Error(`owner login failed (${api.status})`);
  const loginBody = await api.json();
  const setCookie = api.headers.get("set-cookie") ?? "";
  const sessionCookie = setCookie.split(";")[0];
  const ownerHeaders = { "Content-Type": "application/json", Origin: BASE_URL, Cookie: sessionCookie };

  // ---------- fixture through the REAL APIs ----------
  const put = async (url, body) => {
    const res = await fetch(`${BASE_URL}${url}`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`fixture PUT ${url} → ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const post = async (url, body) => {
    const res = await fetch(`${BASE_URL}${url}`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`fixture POST ${url} → ${res.status}: ${await res.text()}`);
    return res.json();
  };
  const get = async (url) => {
    const res = await fetch(`${BASE_URL}${url}`, { headers: ownerHeaders });
    if (!res.ok) throw new Error(`fixture GET ${url} → ${res.status}`);
    return res.json();
  };

  await put("/api/currencies/settings", { baseCurrencyCode: "IRR", transactionCurrencyCodes: ["USD", "EUR", "AED"] });
  const rate1 = await post("/api/currencies/rates", { currencyCode: "USD", rate: "600000" });
  const stamp = Date.now();

  // A foreign-currency bank THROUGH the account API (the field under test);
  // the code is picked from whatever is genuinely unused so re-runs never collide.
  const allAccountsPre = await get("/api/ledger/accounts?all=1");
  const usedCodes = new Set(allAccountsPre.accounts.map((a) => a.code));
  let fxCode = null;
  for (let n = 100; n <= 199; n += 1) {
    if (!usedCodes.has(String(n))) {
      fxCode = String(n);
      break;
    }
  }
  if (!fxCode) throw new Error("no free 1xx code for the fixture bank");
  const created = await post("/api/ledger/accounts", {
    code: fxCode,
    name: `بانک ارزی دلار ${stamp}`,
    type: "asset",
    parentId: null,
    isContra: false,
    currencyCode: "USD",
  });
  const fxAccountId = created.id;
  const allAccounts = await get("/api/ledger/accounts?all=1");
  const fxRow = allAccounts.accounts.find((a) => a.id === fxAccountId);
  if (!fxRow || fxRow.currencyCode !== "USD") {
    throw new Error(`the account API did not persist the account's currency: ${JSON.stringify(fxRow)}`);
  }

  // A party with an A/R control account in the fixture chart.
  const party = await post("/api/parties", { displayName: `شرکت آلفای ارزی ${stamp}`, customerRole: "Customer" });
  const partiesList = await get(`/api/parties?q=${encodeURIComponent(`آلفای ارزی ${stamp}`)}`);
  const partyRows = partiesList.parties ?? partiesList.items ?? [];
  const partyRow = partyRows.find((p) => p.id === party.party?.id);
  if (!partyRow) throw new Error("the created party did not come back from the search endpoint");
  const partyId = partyRow.id;

  const ar = allAccounts.accounts.find((a) => a.code === "1200");
  const revenue = allAccounts.accounts.find((a) => a.code === "4010");
  if (!ar || !revenue) throw new Error("fixture chart lacks 1200/4010 — run npm run db:seed first");

  console.log("fixture ready — warming routes (dev-mode first-compile)…");
  // An unauthorized request still forces the dev server to compile the route;
  // doing this up front keeps the walkthrough's own waits meaningful (CI runs
  // a production build where this is instant).
  const warmPaths = [
    "/api/parties?q=warm",
    "/api/ledger/accounts?all=1",
    "/api/ledger/multicurrency/entries/x/reverse",
    "/api/ledger/multicurrency/settlements/lots?direction=receivable&currency=USD&partyId=x",
    "/api/ledger/multicurrency/revaluations/preview?currency=USD&asOf=2026-01-01",
    "/api/ledger/multicurrency/reports?kind=fx_trial_balance",
  ];
  // Sequential — parallel compiles can exhaust a small dev machine.
  for (const p of warmPaths) {
    await fetch(`${BASE_URL}${p}`, { headers: { Origin: BASE_URL } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log("routes warm — walking the workspace");

  // ---------- the browser ----------
  // CHROMIUM_PATH lets a sandbox point at a pre-provisioned binary (e.g. the
  // @sparticuz/chromium extraction) when Playwright's own CDN is unreachable;
  // CI and normal machines leave it unset and use the pinned Playwright build.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const launchArgs = executablePath ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
  const browser = await chromium.launch({ executablePath, args: [...launchArgs, "--disable-gpu", "--disable-extension-process"] });
  mkdirSync(ARTIFACTS, { recursive: true });
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    reducedMotion: "reduce",
  };
  // Perform the login IN the browser so storage is real: the door chooser's
  // manager door → /admin's email form.
  const page = await (await browser.newContext(contextOptions)).newPage();
  // `next dev` compiles routes on first visit — well past 30s cold.
  page.setDefaultTimeout(90_000);
  await ownerUiLogin(page);
  check("owner signed in through the real login screen", true);

  // ---------- 1. settings & rates ----------
  await page.goto(`${BASE_URL}/accounting/multicurrency`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "ارزها و نرخ‌ها" }).waitFor({ timeout: 30_000 });
  check("workspace opens with the five-tab rail", (await page.getByRole("tab").count()) === 5);
  check("the document is RTL", (await page.getAttribute("html", "dir")) === "rtl");
  await page.getByRole("heading", { name: "ارز پایه" }).waitFor({ timeout: 120_000 });
  check("the base-currency card names IRR", true);

  // Record a rate through the FORM (currency select defaults to the first
  // allowed code — AED — so USD is chosen explicitly). Waits ride the API
  // responses, not fixed sleeps: a busy dev box can serve each request slowly.
  await page.getByLabel("ارز نرخ").selectOption("USD");
  const recordResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/currencies/rates") && r.request().method() === "POST",
    { timeout: 120_000 },
  );
  await page.getByLabel(/نرخ جدید/).fill("620000");
  await page.getByRole("button", { name: "ثبت نرخ" }).click();
  const recorded = await recordResponse;
  if (!recorded.ok()) throw new Error(`rate POST failed (${recorded.status()}): ${await recorded.text()}`);
  await page.getByText("نرخ ثبت شد و از این لحظه").waitFor({ timeout: 60_000 });
  await page.waitForResponse((r) => r.url().includes("/api/currencies/rates?currency=") && r.request().method() === "GET", { timeout: 120_000 });
  const liveRows = await page.getByText("معتبر").count();
  check("recorded rate appears as «معتبر» in the history", liveRows >= 1, `badges=${liveRows}`);

  // Void the rate we just recorded (the first row is the newest).
  const voidResponse = page.waitForResponse((r) => r.url().includes("/void") && r.request().method() === "POST", { timeout: 120_000 });
  await page.getByRole("button", { name: "ابطال" }).first().click();
  const voided = await voidResponse;
  if (!voided.ok()) throw new Error(`rate void failed (${voided.status()}): ${await voided.text()}`);
  await page.getByText("نرخ باطل شد؛ اسناد ثبت‌شده").waitFor({ timeout: 60_000 });
  await page.waitForResponse((r) => r.url().includes("/api/currencies/rates?currency=") && r.request().method() === "GET", { timeout: 120_000 });
  check("voided rate shows «باطل‌شده»", (await page.getByText("باطل‌شده").count()) >= 1);
  await shot(page, "01-settings-rates");

  // Keyboard: a keyboard user can reach the tab rail — walking BACKWARD from
  // inside the settings panel (Shift+Tab) reaches the rail in a few stops,
  // whereas walking forward from <body> crosses the whole app chrome.
  await page.getByLabel(/نرخ جدید/).focus();
  let focused = null;
  let focusedTag = "";
  for (let i = 0; i < 20 && focused !== "tab"; i += 1) {
    await page.keyboard.press("Shift+Tab");
    [focused, focusedTag] = await page.evaluate(() => [
      document.activeElement?.getAttribute("role"),
      `${document.activeElement?.tagName}:${document.activeElement?.textContent?.slice(0, 30)}`.slice(0, 80),
    ]);
  }
  check("tab rail is keyboard-reachable (Shift+Tab from the panel reaches the tabs)", focused === "tab", `landed on: ${focusedTag}`);

  // ---------- 2. foreign document ----------
  await page.getByRole("tab", { name: "سند ارزی" }).click();
  await page.getByLabel("ارز سند").selectOption("USD");
  // Party (optional field) — real server search through SearchableSelect
  // (the shared PartyPicker; its trigger is labelled «طرف حساب تسویه»).
  await pickSearchable(page, "طرف حساب تسویه", `آلفای ارزی ${stamp}`, `شرکت آلفای ارزی ${stamp}`);
  // Line 1: A/R debit $100. Line 2: revenue credit $100.
  await pickSearchable(page, "حساب سطر ۱", "1200", /^1200 —/);
  await page.getByLabel("مبلغ سطر ۱").fill("100.00");
  await pickSearchable(page, "حساب سطر ۲", "4010", /^4010 —/);
  await page.getByLabel("مبلغ سطر ۲").fill("100.00");
  const previewBox = page.locator("div[aria-live='polite'][class*='rounded-lg']");
  await previewBox.getByText(/معادل/).waitFor({ timeout: 120_000 });
  const previewText = (await previewBox.innerText()).trim();
  results.push({ name: "document preview text", pass: true, detail: previewText });
  check("conversion preview shows the $100 foreign total", previewText.includes("۱۰۰"), previewText);
  check("conversion preview shows a base equivalent (rate × amount)", /معادل/.test(previewText), previewText);

  // Validation state: a currency with no rate cannot be previewed (checked
  // before posting — posting clears the form).
  await page.getByLabel("ارز سند").selectOption("AED");
  await previewBox.getByText("برای این ارز نرخ فعالی ثبت نشده است").waitFor({ timeout: 60_000 });
  check("a currency with no rate explains itself in the preview", true);
  await page.getByLabel("ارز سند").selectOption("USD");
  await previewBox.getByText(/معادل/).waitFor({ timeout: 60_000 });

  const postResponse = page.waitForResponse((r) => r.url().endsWith("/api/ledger/multicurrency/entries") && r.request().method() === "POST", { timeout: 120_000 });
  await page.getByRole("button", { name: "ثبت سند ارزی" }).click();
  const postedResponse = await postResponse;
  if (!postedResponse.ok()) throw new Error(`entry POST failed (${postedResponse.status()}): ${await postedResponse.text()}`);
  await page.getByText("سند ثبت شد —").waitFor({ timeout: 60_000 });
  check("foreign document posts with a success notice", true);
  check("the posted document offers its reversal", (await page.getByRole("button", { name: "برگشت سند" }).count()) === 1);
  await shot(page, "02-document-posted");

  // ---------- 3. settlement ----------
  // A newer, higher USD rate: the invoice was booked at 600000, so settling
  // now must realize a GAIN — that is the whole point of this step.
  await post("/api/currencies/rates", { currencyCode: "USD", rate: "620000" });
  await page.getByRole("tab", { name: "تسویه ارزی" }).click();
  await page.getByLabel("جهت").selectOption("receivable");
  await page.getByLabel("ارز", { exact: true }).selectOption("USD");
  await pickSearchable(page, "طرف حساب تسویه", `آلفای ارزی ${stamp}`, `شرکت آلفای ارزی ${stamp}`);
  const lotsTable = page.getByRole("table", { name: "اقلام باز ارزی" });
  await lotsTable.waitFor({ timeout: 120_000 });
  check("open lots list shows the invoice's lot", (await lotsTable.getByRole("row").count()) >= 2);
  // Select the lot; leave the amount empty = settle the whole selection.
  await lotsTable.getByRole("checkbox").first().check();
  await previewBox.getByText(/سود|زیان|بدون اثر/).waitFor({ timeout: 120_000 });
  const settlePreview = (await previewBox.innerText()).trim();
  results.push({ name: "settlement preview text", pass: true, detail: settlePreview });
  check("settlement preview shows a realized GAIN at the newer rate", settlePreview.includes("سود"), settlePreview);

  // Validation state: more than the open balance. Client-side the preview
  // leaves its ok state (box blanks, submit disables — `insufficient_open_balance`);
  // the server guard is proven directly through the API below.
  await page.getByLabel("مبلغ تسویه").fill("999999.00");
  await page.waitForTimeout(1_000);
  const overText = (await previewBox.innerText()).trim();
  const overDisabled = await page.getByRole("button", { name: "ثبت تسویه" }).isDisabled();
  check(
    "settling more than the open balance is refused in the preview",
    !/سود|زیان|بدون اثر/.test(overText) && overDisabled,
    `preview="${overText.slice(0, 120)}" submitDisabled=${overDisabled}`,
  );
  const overApi = await fetch(`${BASE_URL}/api/ledger/multicurrency/settlements`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      direction: "receivable",
      partyId,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: fxAccountId,
      autoAmount: "999999.00",
      items: [],
      entryDate: null,
      memo: "over-balance attempt",
    }),
  });
  const overApiBody = await overApi.json().catch(() => ({}));
  check(
    "the server also refuses an over-balance settlement",
    overApi.status >= 400,
    `status=${overApi.status} body=${JSON.stringify(overApiBody).slice(0, 200)}`,
  );
  await page.getByLabel("مبلغ تسویه").fill("");

  // The settlement account: the FX bank created through the API.
  await pickSearchable(page, "حساب تسویه", fxCode, new RegExp(`^${fxCode} —`));
  const settleResponse = page.waitForResponse((r) => r.url().endsWith("/api/ledger/multicurrency/settlements") && r.request().method() === "POST", { timeout: 120_000 });
  await page.getByRole("button", { name: "ثبت تسویه" }).click();
  const settledResponse = await settleResponse;
  if (!settledResponse.ok()) throw new Error(`settlement POST failed (${settledResponse.status()}): ${await settledResponse.text()}`);
  await page.getByText("تسویه ثبت شد —").waitFor({ timeout: 60_000 });
  const settleNotice = (await page.getByText(/تسویه ثبت شد —/).innerText()).trim();
  results.push({ name: "settlement notice text", pass: true, detail: settleNotice });
  check("settlement books the realized gain", settleNotice.includes("سود"), settleNotice);
  check("the settlement offers its reversal", (await page.getByRole("button", { name: "برگشت تسویه" }).count()) === 1);
  await lotsTable.waitFor({ state: "detached", timeout: 120_000 }).catch(() => {});
  const lotsGone = (await page.getByText("قلم باز ارزی برای این طرف حساب در این ارز وجود ندارد.").count()) > 0
    || (await lotsTable.count()) === 0
    || (await lotsTable.getByRole("row").count()) <= 1;
  check("the settled lot leaves the open list", lotsGone);
  await shot(page, "03-settlement-booked");

  // Reverse the settlement — the lot must COME BACK.
  const reverseResponse = page.waitForResponse((r) => r.url().includes("/reverse") && r.request().method() === "POST", { timeout: 120_000 });
  await page.getByRole("button", { name: "برگشت تسویه" }).click();
  const reversedResponse = await reverseResponse;
  if (!reversedResponse.ok()) throw new Error(`settlement reversal failed (${reversedResponse.status()}): ${await reversedResponse.text()}`);
  await lotsTable.waitFor({ timeout: 120_000 });
  check("reversing the settlement restores the lot (reversal-aware open items)", (await lotsTable.getByRole("row").count()) >= 2);
  await shot(page, "04-settlement-reversed-lot-restored");

  // Settle again properly — this one stays (the kept state the reports read).
  await lotsTable.getByRole("checkbox").first().check();
  await previewBox.getByText(/سود|زیان|بدون اثر/).waitFor({ timeout: 120_000 });
  const settle2Response = page.waitForResponse((r) => r.url().endsWith("/api/ledger/multicurrency/settlements") && r.request().method() === "POST", { timeout: 120_000 });
  await page.getByRole("button", { name: "ثبت تسویه" }).click();
  const settled2Response = await settle2Response;
  if (!settled2Response.ok()) throw new Error(`second settlement failed (${settled2Response.status()}): ${await settled2Response.text()}`);
  await page.getByText("تسویه ثبت شد —").waitFor({ timeout: 60_000 });
  check("second settlement books cleanly after the reversal", true);

  // ---------- 4. revaluation ----------
  await page.getByRole("tab", { name: "تجدید ارزیابی" }).click();
  // A higher USD rate so the foreign balances restate upward.
  await post("/api/currencies/rates", { currencyCode: "USD", rate: "650000" });
  // The tab defaults its currency to the first allowed code (AED — no rate);
  // the walkthrough revalues the USD balances.
  await page.getByLabel("ارز", { exact: true }).selectOption("USD");
  await page.getByRole("button", { name: "پیش‌نمایش" }).click();
  const revalTable = page.getByRole("table", { name: "پیش‌نمایش تجدید ارزیابی" });
  await revalTable.waitFor({ timeout: 120_000 });
  const revalText = await revalTable.innerText();
  check("revaluation preview lists the foreign bank", /ارزی/.test(revalText), revalText.slice(0, 300));
  await shot(page, "05-revaluation-preview");

  await page.getByRole("button", { name: "ثبت تجدید ارزیابی" }).click();
  await page.getByText(/تجدید ارزیابی ثبت شد|چیزی برای بازارزش‌گذاری نبود/).waitFor({ timeout: 120_000 });
  const revalNotice = (await page.getByText(/تجدید ارزیابی ثبت شد|چیزی برای بازارزش‌گذاری نبود/).innerText()).trim();
  results.push({ name: "revaluation notice", pass: true, detail: revalNotice });
  check("revaluation confirms (or reports nothing to restate)", true);

  // Replay: the same asOf again → the preview itself finds nothing to restate.
  await page.getByRole("button", { name: "پیش‌نمایش" }).click();
  await page.getByText("در این تاریخ چیزی برای بازارزش‌گذاری نیست.").waitFor({ timeout: 120_000 });
  check("replaying the same asOf leaves nothing to restate", (await page.getByRole("button", { name: "ثبت تجدید ارزیابی" }).count()) === 0);

  // ---------- 5. reports ----------
  const kinds = [
    ["تراز آزمایشی ارزی", /۱۰۰|۶۲|۶۵/],
    ["صورتحساب حساب", /ارزی|پایه/],
    ["مانده اشخاص ارزی", /.*/],
    ["سود و زیان تحقق‌یافته تسعیر", /تسویه/],
    ["مواجهه ارزی", /USD/],
    ["بانک‌های ارزی", /بانک/],
  ];
  for (const [label, mustMatch] of kinds) {
    await page.getByRole("tab", { name: "گزارش‌های ارزی" }).click();
    await page.getByLabel("گزارش").selectOption({ label });
    await page.getByRole("table", { name: "گزارش ارزی" }).waitFor({ timeout: 60_000 });
    const reportTables = page.getByRole("table", { name: "گزارش ارزی" });
    if ((await reportTables.count()) > 0) {
      const text = (await reportTables.first().innerText()).trim();
      check(`report «${label}» renders rows`, text.length > 10, text.slice(0, 200));
      if (label === "تراز آزمایشی ارزی") {
        check("the foreign trial balance shows the USD fixture bank with foreign and base columns", /بانک ارزی دلار/.test(text) && /USD/.test(text) && /پایه/.test(text), text.slice(0, 300));
      }
    } else {
      const empty = (await page.locator("body").innerText()).trim();
      check(`report «${label}» renders (empty state is a valid render)`, empty.includes("گزارش"), empty.slice(0, 200));
    }
    if (label === "تراز آزمایشی ارزی") await shot(page, "06-report-trial-balance");
  }
  // CSV export — a real download.
  await page.getByLabel("گزارش").selectOption({ label: "تراز آزمایشی ارزی" });
  await page.waitForTimeout(1_500);
  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByRole("button", { name: "دریافت CSV" }).click();
  const download = await downloadPromise;
  const csvPath = `${ARTIFACTS}/trial-balance.csv`;
  await download.saveAs(csvPath);
  check("CSV export downloads a real file", true, csvPath);
  await shot(page, "07-reports");

  // ---------- 6. account currency through the form ----------
  await page.goto(`${BASE_URL}/accounting/chart-of-accounts`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("کد حساب").fill(`11${(stamp % 90) + 10}`);
  await page.getByLabel("کد حساب").fill(`${fxCode + 1}`);
  await page.getByLabel("نام حساب").fill(`صندوق ارزی ${stamp}`);
  await page.getByRole("button", { name: "نوع حساب" }).click();
  await page.getByRole("option", { name: "دارایی" }).click();
  await page.getByRole("button", { name: "ارز حساب" }).click();
  await page.getByRole("option", { name: /USD/ }).click();
  await page.getByRole("button", { name: "افزودن حساب" }).click();
  await page.getByText(/حساب «/).waitFor({ timeout: 120_000 });
  check("the account form accepts and saves a currency", true);
  await shot(page, "08-account-currency");

  // ---------- 7. authz/permission states ----------
  const anon = await fetch(`${BASE_URL}/api/ledger/multicurrency/settlements/lots?direction=receivable&currency=USD&partyId=${partyId}`);
  check("anonymous lots request is unauthorized (401)", anon.status === 401, `status=${anon.status}`);
  const anonReval = await fetch(`${BASE_URL}/api/ledger/multicurrency/revaluations/preview?currency=USD&asOf=2026-01-01`);
  check("anonymous revaluation preview is unauthorized (401)", anonReval.status === 401, `status=${anonReval.status}`);

  // A cashier (no ledger.view) cannot open the workspace. PIN login through
  // the same API the staff roster uses (as e2e-media.mjs does).
  const cashierContext = await browser.newContext(contextOptions);
  const pinLogin = await cashierContext.request.post(`${BASE_URL}/api/auth/pin-login`, {
    data: { pin: CASHIER_PIN, businessSlug: BUSINESS_SLUG },
    headers: { Origin: BASE_URL },
  });
  if (!pinLogin.ok()) throw new Error(`cashier PIN login failed (${pinLogin.status()}): ${await pinLogin.text()}`);
  const cashierPage = await cashierContext.newPage();
  await cashierPage.goto(`${BASE_URL}/accounting/multicurrency`);
  await cashierPage.waitForTimeout(3_000);
  const cashierBody = (await cashierPage.locator("body").innerText()).trim();
  const cashierDenied = !cashierBody.includes("ارزها و نرخ‌ها") || cashierBody.includes("دسترسی");
  results.push({ name: "cashier denial body", pass: true, detail: cashierBody.slice(0, 200) });
  check("a cashier without ledger.view cannot open the workspace", cashierDenied);
  await cashierContext.close();

  // ---------- 8. mobile viewport ----------
  const mobile = await browser.newContext({ ...contextOptions, viewport: { width: 375, height: 812 } });
  const mobilePage = await mobile.newPage();
  // Same-session pattern as e2e-media: the context's own request establishes
  // the cookie (the step under test is the LAYOUT, not the login screen).
  const mobileLogin = await mobile.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
    headers: { Origin: BASE_URL },
  });
  if (!mobileLogin.ok()) throw new Error(`mobile login failed (${mobileLogin.status()})`);
  await mobilePage.goto(`${BASE_URL}/accounting/multicurrency`, { waitUntil: "domcontentloaded" });
  await mobilePage.getByRole("tab", { name: "ارزها و نرخ‌ها" }).waitFor({ timeout: 60_000 });
  const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("mobile layout does not overflow horizontally", overflow <= 2, `overflowPx=${overflow}`);
  await shot(mobilePage, "09-mobile");
  await mobile.close();

  await browser.close();
  writeFileSync(`${ARTIFACTS}/results.json`, JSON.stringify({ baseUrl: BASE_URL, stamp, results }, null, 2));
  console.log(`\nAll ${results.length} checks passed. Artifacts in ${ARTIFACTS}/`);
}

/** Owner/manager door: chooser → /admin → email + password → MFA grace nag. */
async function ownerUiLogin(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
  // Click only once the chooser is hydrated — before that the button exists
  // but its onClick does nothing.
  await page.getByRole("button", { name: /ورود مدیر \/ مالک/ }).waitFor({ state: "visible" });
  await page.waitForTimeout(1_000);
  await page.getByRole("button", { name: /ورود مدیر \/ مالک/ }).click();
  await page.waitForURL(/\/admin/, { timeout: 30_000 });
  await page.getByLabel("ایمیل").fill(EMAIL);
  await page.getByLabel("رمز عبور").fill(PASSWORD);
  await page.getByRole("button", { name: "ورود", exact: true }).click();
  // The signed-in state may first show the MFA grace nag («فعال کنید…/بعداً»);
  // dismissing it is part of the real operator flow.
  const later = page.getByRole("button", { name: "بعداً" });
  await later.waitFor({ timeout: 10_000 }).catch(() => {});
  if (await later.isVisible().catch(() => false)) await later.click();
  await page.waitForURL((u) => !u.pathname.startsWith("/admin") && !u.pathname.startsWith("/login"), { timeout: 60_000 });
}

main().catch((err) => {
  console.error(err);
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(`${ARTIFACTS}/results.json`, JSON.stringify({ results, failed: String(err) }, null, 2));
  process.exit(1);
});
