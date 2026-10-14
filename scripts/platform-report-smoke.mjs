/**
 * Read-only browser smoke for #810. Run against a local seeded production build.
 * Requires PLATFORM_REPORT_BUSINESS_ID, PLATFORM_ADMIN_EMAIL/PASSWORD. Screenshots
 * are review artifacts, NOT auto-approved visual baselines. Never use a real
 * production tenant here. See docs/platform-business-reporting.md.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.VISUAL_BASE_URL ?? "http://127.0.0.1:3000";
const business = process.env.PLATFORM_REPORT_BUSINESS_ID;
const email = process.env.PLATFORM_ADMIN_EMAIL;
const password = process.env.PLATFORM_ADMIN_PASSWORD;
assert(business && email && password, "Set the business ID and local fixture platform-admin credentials");
const output = process.env.REPORT_SCREENSHOT_DIR ?? ".cache/platform-report-smoke";
mkdirSync(output, { recursive: true });
const executablePath = process.env.VISUAL_CHROMIUM_PATH;
const browser = await chromium.launch({ executablePath, args: executablePath ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [] });
const reportBase = `/api/platform/businesses/${business}/reports`;
try {
  const auth = await browser.newContext();
  const login = await auth.request.post(`${base}/api/platform/auth/login`, { data: { email, password } });
  assert.equal(login.status(), 200, "Local platform fixture login must succeed");
  const state = await auth.storageState();
  assert(state.cookies.some((c) => c.name === "pos_platform_session"), "Login must establish a platform session, not an MFA challenge");
  assert(!state.cookies.some((c) => c.name === "pos_session"), "Run with platform auth only");
  await auth.close();

  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ storageState: state, viewport: { width, height: 900 }, locale: "fa-IR", timezoneId: "Asia/Tehran", colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript((value) => localStorage.setItem("theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request); });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith(reportBase) && response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`);
    });
    async function ready() {
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], [data-slot="skeleton"]'), null, { timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => {
        const value = document.body.innerHTML.length;
        window.__reportStable = window.__reportLength === value ? (window.__reportStable ?? 0) + 1 : 0;
        window.__reportLength = value;
        return window.__reportStable >= 3;
      }, null, { polling: 150 });
    }
    async function capture(name) {
      await ready();
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), theme === "dark");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `${width}/${theme}/${name}: page overflowed by ${overflow}px`);
      await page.screenshot({ path: join(output, `${width}-${theme}-${name}.png`), fullPage: true });
    }
    await page.goto(`${base}/platform/businesses/${business}/reports`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "نمای کلی", exact: true }).waitFor();
    await capture("overview");
    assert(!requests.some((r) => /\/reports\/(crm|growth|websites|cms|health|standard)/.test(r.url())), "Only overview/day/catalog should load initially");
    // Use the browser's cookie handling here (Secure cookies on loopback HTTP
    // are accepted by Chromium but not by APIRequestContext).
    const catalog = await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`catalog: HTTP ${response.status}`);
      return response.json();
    }, `${reportBase}/catalog`);
    if (catalog.locations.length) await page.getByLabel("شعبه", { exact: true }).selectOption(catalog.locations[0].id);
    for (const [key, label] of [["accounting", "حسابداری و فروش"], ["operations", "عملیات و موجودی"], ["branches", "مقایسهٔ شعب"], ["crm", "مشتریان / CRM"], ["growth", "رشد و بازاریابی"], ["websites", "مدیریت وب‌سایت"], ["health", "سلامت سیستم"]]) {
      const tab = page.getByRole("tab", { name: label, exact: true });
      if (!await tab.count()) continue;
      await tab.click();
      if (key === "accounting") {
        await page.getByLabel("انتخاب گزارش", { exact: true }).selectOption("profit_and_loss");
        await ready();
        const comparison = page.getByRole("checkbox");
        if (await comparison.count()) await comparison.first().check();
      }
      if (key === "operations") {
        const choices = await page.getByLabel("انتخاب گزارش", { exact: true }).locator("option").evaluateAll((options) => options.map((o) => o.value).filter(Boolean));
        if (choices.length) {
          const selected = choices.includes("low_stock") ? "low_stock" : choices[0];
          const loaded = page.waitForResponse((r) => new URL(r.url()).pathname === `${reportBase}/standard/${selected}`);
          await page.getByLabel("انتخاب گزارش", { exact: true }).selectOption(selected);
          const first = await (await loaded).json();
          if (first.pagination) assert((first.report.rows ?? first.report.items ?? first.report.summaries).length <= 50);
          if (first.pagination?.pages > 1) {
            const nextPage = page.waitForResponse((r) => {
              const url = new URL(r.url());
              return url.pathname === `${reportBase}/standard/${selected}` && url.searchParams.get("page") === "2";
            });
            await page.getByRole("button", { name: "جزئیات بعدی", exact: true }).click();
            const second = await (await nextPage).json();
            assert.equal(second.pagination.page, 2);
            assert.equal(second.pagination.total, first.pagination.total);
            assert((second.report.rows ?? second.report.items ?? second.report.summaries).length <= 50);
          }
        }
      }
      await capture(key);
    }
    const refreshed = page.waitForResponse((r) => new URL(r.url()).pathname === `${reportBase}/health`);
    await page.getByRole("button", { name: "تازه‌سازی", exact: true }).click();
    await refreshed;
    assert.deepEqual(errors, [], "Report requests and browser runtime must be error-free");
    assert(!requests.some((r) => !new URL(r.url()).pathname.startsWith("/api/platform/")), "Reports must not call tenant-authenticated APIs");
    assert(!requests.some((r) => !["GET", "HEAD"].includes(r.method())), "Browsing/refreshing must not write");
    console.log(`PASS ${width}px ${theme}: lazy tabs, structured comparison, refresh, no writes/tenant APIs, no document overflow`);
    await context.close();
  }
} finally { await browser.close(); }
console.log(`Review screenshots in ${output}`);
