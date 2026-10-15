#!/usr/bin/env node
/**
 * #869: real multi-user browser acceptance, no mocked routes or financial responses.
 * Start the production server with its unprivileged RLS role, then:
 * COMMISSION_E2E_SEED=1 DATABASE_URL=<disposable local provisioning DB> npm run test:e2e:commission
 * The fixture only seeds identities, a sale and its real accrual. Every run,
 * transition, payout, reversal and carry below goes through the running app.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import axe from "axe-core";

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const fixturePath = process.env.COMMISSION_E2E_FIXTURE ?? ".cache/commission-e2e.json";
if (!process.env.COMMISSION_E2E_FIXTURE) execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-commission-e2e.ts", fixturePath], { stdio: "inherit" });
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
if (!process.env.COMMISSION_E2E_FIXTURE) rmSync(fixturePath);
const browser = await chromium.launch({ headless: true, executablePath: process.env.VISUAL_CHROMIUM_PATH || undefined });
const errors = [];
const expectedFailures = new Set();
const contexts = [];
async function actor(member) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "fa-IR", timezoneId: "Asia/Tehran", reducedMotion: "reduce" });
  contexts.push(context);
  const login = await context.request.post(`${base}/api/auth/login`, { data: { email: member.email, password: fixture.password } });
  assert.equal(login.status(), 200, await login.text());
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !expectedFailures.has(`${response.status()} ${new URL(response.url()).pathname}`)) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${base}/growth/commission/runs`);
  return page;
}
async function api(page, method, path, body, expected = 200, headers = {}) {
  if (expected >= 400) expectedFailures.add(`${expected} ${path.split("?")[0]}`);
  const result = await page.evaluate(async ({ method, path, body, headers }) => {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  }, { method, path, body, headers });
  assert.equal(result.status, expected, `${method} ${path}: ${result.text}`);
  return JSON.parse(result.text);
}
async function detail(page, id) { return (await api(page, "GET", `/api/commission/runs/${id}`)).run; }
async function transition(page, id, label, status, confirmation = false) {
  await page.goto(`${base}/growth/commission/runs/${id}`);
  const posted = page.waitForResponse((response) => response.url().includes(`/api/commission/runs/${id}`) && response.request().method() === "POST" && response.ok());
  await page.getByRole("button", { name: label, exact: true }).click();
  if (confirmation) await page.getByRole("button", { name: `تأیید: ${label}`, exact: true }).click();
  await posted;
  assert.equal((await detail(page, id)).status, status);
}
async function pay(page, id, amount) {
  await page.goto(`${base}/growth/commission/runs/${id}`);
  await page.getByRole("button", { name: "پرداخت به فروشندگان", exact: true }).click();
  await page.getByRole("checkbox", { name: "همهٔ مانده برای فروشنده آزمون" }).uncheck();
  await page.getByRole("textbox", { name: "مبلغ پرداخت به فروشنده آزمون" }).fill(String(fixture.unit === "toman" ? amount / 10 : amount));
  const posted = page.waitForResponse((response) => response.url().endsWith(`/runs/${id}/payouts`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "ثبت پرداخت", exact: true }).click();
  const response = await posted;
  assert.equal(response.status(), 201, await response.text());
  const payout = (await response.json()).payout;
  const key = response.request().headers()["idempotency-key"];
  assert.ok(key, "UI payout must send its retry key");
  // Retry through the same browser fetch/Origin/tenant-context path as the
  // original UI request; an out-of-page APIRequestContext is not that path.
  const replay = await api(page, "POST", new URL(response.url()).pathname,
    response.request().postDataJSON(), 200, { "Idempotency-Key": key });
  assert.equal(replay.replayed, true);
  assert.equal(replay.payout.id, payout.id, "HTTP retry must return the original payment, not post again");
  return payout;
}
try {
  const manager = await actor(fixture.manager);
  await manager.getByRole("button", { name: "از تاریخ دوره", exact: true }).click();
  await manager.getByRole("button", { name: "امروز", exact: true }).click();
  assert.equal(await manager.getByRole("button", { name: "از تاریخ دوره", exact: true }).getAttribute("aria-expanded"), "false", "Today must close the calendar, not reopen it via label activation");
  const [calculation] = await Promise.all([
    manager.waitForResponse((response) => /\/runs\/[^/]+\/calculate$/.test(response.url()) && response.request().method() === "POST"),
    manager.getByRole("button", { name: "ساخت و محاسبهٔ دوره", exact: true }).click(),
  ]);
  assert.equal(calculation.status(), 200, await calculation.text());
  const run = (await calculation.json()).run;
  assert.equal(run.commissionTotal, "5000");
  await api(manager, "POST", `/api/commission/runs/${run.id}/release`, {}, 403);
  await api(manager, "POST", `/api/commission/runs/${run.id}/payouts`, { allocations: [{ employeeId: fixture.seller.id, amount: "1000" }], method: "cash" }, 403);
  const reviewer = await actor(fixture.reviewer);
  await api(reviewer, "POST", `/api/commission/runs/${run.id}/approve`, {}, 409); // cannot skip review
  await transition(reviewer, run.id, "بازبینی", "reviewed");
  await api(manager, "POST", `/api/commission/runs/${run.id}/approve`, {}, 403); // calculator, even with approval permission
  // Keep the authenticated contexts, but release idle rendered workspaces on
  // small local builders; this changes no workflow or financial assertion.
  await manager.goto("about:blank");
  await reviewer.goto("about:blank");
  const accountant = await actor(fixture.accountant);
  await transition(accountant, run.id, "تأیید", "approved");
  await transition(accountant, run.id, "آزادسازی برای پرداخت", "payable", true);
  const partial = await pay(accountant, run.id, 1000);
  assert.equal((await detail(accountant, run.id)).outstandingTotal, "4000");
  assert.equal((await detail(accountant, run.id)).status, "partially_paid");
  const overpay = await api(accountant, "POST", `/api/commission/runs/${run.id}/payouts`, {
    allocations: [{ employeeId: fixture.seller.id, amount: "4001" }], method: "cash",
  }, 409, { "Idempotency-Key": crypto.randomUUID() });
  assert.equal(overpay.error, "allocation_exceeds_outstanding");
  assert.equal((await detail(accountant, run.id)).paidTotal, "1000");
  const finalPayout = await pay(accountant, run.id, 4000);
  assert.equal((await detail(accountant, run.id)).status, "paid");
  await accountant.getByRole("button", { name: "ابطال", exact: true }).first().click();
  const reverse = accountant.waitForResponse((response) => response.url().endsWith(`/payouts/${partial.id}/reverse`) && response.request().method() === "POST");
  await accountant.getByRole("button", { name: "تأیید ابطال", exact: true }).click();
  const reversalResponse = await reverse;
  assert.equal(reversalResponse.status(), 201, await reversalResponse.text());
  const reversed = await detail(accountant, run.id);
  assert.equal(reversed.outstandingTotal, "1000");
  assert.ok(reversed.payouts.find((payout) => payout.reversesPayoutId === partial.id)?.entryId);
  const tieOut = (await api(accountant, "GET", "/api/commission/liability")).tieOut;
  assert.equal(tieOut.difference, "0"); assert.equal(tieOut.subledgerDifference, "0");
  await accountant.getByRole("button", { name: "نمایش", exact: true }).click();
  await accountant.getByRole("table", { name: "ردیف‌های پورسانت فروشنده" }).waitFor();
  assert.ok(await accountant.locator(`a[href='/accounting/orders?order=${fixture.orderId}']`).count());
  assert.ok(await accountant.locator("a[href*='/accounting/entries?entry=']").count());
  const downloadPromise = accountant.waitForEvent("download");
  await accountant.getByRole("link", { name: "خروجی کامل CSV", exact: true }).click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const stream = await download.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString("utf8");
  assert.ok(csv.startsWith("\uFEFF")); assert.ok(csv.includes("برگشت پرداخت"));
  assert.ok(!csv.includes(fixture.today)); // displayed/exported dates are Jalali
  assert.ok(csv.includes(fixture.unit === "toman" ? "تومان" : "ریال"));
  // Follow the exact historical payroll claim, not just the payroll landing page.
  const exactSource = accountant.locator(`a[href='/accounting/payroll?run=${fixture.payrollRunId}']`);
  assert.equal(await exactSource.count(), 1);
  await exactSource.click();
  await accountant.getByRole("list", { name: "لیست حقوق پیوندشده", exact: true }).waitFor();
  assert.ok(await accountant.getByText("فروشنده آزمون", { exact: true }).count());
  assert.equal(await accountant.getByRole("list", { name: "لیست حقوق پیوندشده", exact: true }).getByRole("button", { name: "ثبت پرداخت حقوق" }).count(), 0);
  // The source panel is read-only; monthly payroll's normal controls are unchanged.
  for (const theme of ["light", "dark"]) {
    await accountant.evaluate((value) => localStorage.setItem("theme", value), theme);
    await accountant.goto(`${base}/growth/commission/runs/${run.id}`);
    await accountant.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, theme === "dark");
    await accountant.getByRole("button", { name: "نمایش", exact: true }).click();
    await accountant.getByRole("table", { name: "ردیف‌های پورسانت فروشنده" }).waitFor();
    const date = accountant.getByRole("button", { name: "از تاریخ صورت‌حساب", exact: true });
    await date.focus();
    await date.press("Enter");
    assert.equal(await date.getAttribute("aria-expanded"), "true");
    await accountant.keyboard.press("Escape");
    await accountant.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "از تاریخ صورت‌حساب");
    assert.equal(await date.getAttribute("aria-expanded"), "false");
    await accountant.addScriptTag({ content: axe.source });
    const panel = accountant.getByRole("heading", { name: "صورت‌حساب فروشنده آزمون", exact: true }).locator("xpath=ancestor::section[1]");
    for (const width of [1440, 768, 390]) {
      await accountant.setViewportSize({ width, height: 1000 });
      assert.equal(await accountant.locator("html").getAttribute("dir"), "rtl");
      assert.ok(await accountant.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `page overflow at ${width}/${theme}`);
      const violations = await panel.evaluate(async (element) => (await window.axe.run(element, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      })).violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target }) => target) })));
      assert.deepEqual(violations, [], `statement accessibility at ${width}/${theme}`);
    }
    const totals = (await api(accountant, "GET", `/api/commission/statement?employeeId=${fixture.seller.id}`)).totals;
    const select = accountant.getByRole("combobox", { name: "دوره تسویه", exact: true });
    const selected = accountant.waitForResponse((response) => response.url().includes("/api/commission/statement?") && new URL(response.url()).searchParams.get("runId") === run.id);
    await select.selectOption(run.id);
    assert.deepEqual((await (await selected).json()).totals, totals, "filters must not change lifetime totals");
    await accountant.getByRole("table", { name: "ردیف‌های پورسانت فروشنده" }).waitFor();
    if (theme === "light") {
      // Delay an actual upstream response (never invent or edit financial data)
      // so a newer filter deterministically wins over an older answer.
      let release, announced, completed;
      const gate = new Promise((resolve) => { release = resolve; });
      const received = new Promise((resolve) => { announced = resolve; });
      const finished = new Promise((resolve) => { completed = resolve; });
      const pattern = /\/api\/commission\/statement\?/;
      const hold = async (route) => {
        if (new URL(route.request().url()).searchParams.get("runId")) return route.continue();
        try {
          const upstream = await route.fetch();
          announced();
          await gate;
          await route.fulfill({ response: upstream });
        } catch (error) {
          if (route.request().failure()?.errorText !== "net::ERR_ABORTED") errors.push(String(error));
        } finally { completed(); }
      };
      await accountant.route(pattern, hold);
      try {
        await select.selectOption("");
        let deadline;
        try {
          await Promise.race([received, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Upstream statement did not arrive")), 30_000); })]);
        } finally { clearTimeout(deadline); }
        const newer = accountant.waitForResponse((response) => response.url().includes("/api/commission/statement?") && new URL(response.url()).searchParams.get("runId") === run.id);
        await select.selectOption(run.id);
        await newer;
        const table = accountant.getByRole("table", { name: "ردیف‌های پورسانت فروشنده" });
        await table.waitFor();
        assert.equal(await table.locator("tbody tr").count(), 1);
        release(); await finished;
        await accountant.evaluate(() => new Promise(requestAnimationFrame));
        assert.equal(await table.locator("tbody tr").count(), 1, "late unfiltered answer must not replace the selected run");
      } finally { release(); await accountant.unroute(pattern, hold); }
      // Real browser offline/online recovery, not a fabricated 500 response.
      await accountant.context().setOffline(true);
      try {
        await select.selectOption("");
        await panel.getByRole("button", { name: "تلاش دوباره", exact: true }).waitFor();
      } finally { await accountant.context().setOffline(false); }
      const recovered = accountant.waitForResponse((response) => response.url().includes("/api/commission/statement?") && response.ok());
      await panel.getByRole("button", { name: "تلاش دوباره", exact: true }).click();
      assert.deepEqual((await (await recovered).json()).totals, totals);
      await accountant.getByRole("table", { name: "ردیف‌های پورسانت فروشنده" }).waitFor();
    }
  }
  await transition(accountant, run.id, "بستن دوره", "closed", true);
  await api(accountant, "POST", `/api/commission/payouts/${finalPayout.id}/reverse`, {}, 409);
  await manager.goto(`${base}/growth/commission/runs`);
  await manager.getByRole("button", { name: "از تاریخ دوره", exact: true }).click();
  await manager.getByRole("button", { name: "امروز", exact: true }).click();
  const [nextResponse] = await Promise.all([
    manager.waitForResponse((response) => /\/runs\/[^/]+\/calculate$/.test(response.url()) && response.request().method() === "POST"),
    manager.getByRole("button", { name: "ساخت و محاسبهٔ دوره", exact: true }).click(),
  ]);
  assert.equal(nextResponse.status(), 200, await nextResponse.text());
  const next = (await nextResponse.json()).run;
  assert.equal(next.commissionTotal, "1000");
  const lines = await api(manager, "GET", `/api/commission/runs/${next.id}/lines`);
  assert.ok(lines.lines.some((line) => line.carriedFromRunId === run.id && line.amount === "1000"));
  await transition(reviewer, next.id, "بازگشت به پیش‌نویس", "draft", true);
  assert.equal((await detail(reviewer, next.id)).lineCount, 0, "rejection must release the unposted snapshot");
  await transition(manager, next.id, "محاسبهٔ پورسانت‌ها", "calculated");
  assert.equal((await detail(manager, next.id)).commissionTotal, "1000", "released carry must be reclaimed once");
  await manager.getByRole("button", { name: "ابطال", exact: true }).click();
  await manager.getByRole("textbox", { name: "دلیل ابطال", exact: true }).fill("ابطال پیش از پرداخت در آزمون واقعی");
  const voided = manager.waitForResponse((response) => response.url().endsWith(`/runs/${next.id}/void`) && response.request().method() === "POST");
  await manager.getByRole("button", { name: "تأیید: ابطال", exact: true }).click();
  assert.equal((await voided).status(), 200);
  assert.equal((await detail(manager, next.id)).status, "voided");
  await api(manager, "POST", `/api/commission/runs/${next.id}/calculate`, {}, 409);
  const finalTieOut = (await api(accountant, "GET", "/api/commission/liability")).tieOut;
  assert.equal(finalTieOut.difference, "0"); assert.equal(finalTieOut.subledgerDifference, "0");
  assert.deepEqual(errors, [], "unexpected browser errors");
  console.log("Commission multi-user browser lifecycle passed (real application, PostgreSQL/RLS runtime)");
} catch (error) {
  // Keep the exact failure/stack available through check annotations as well
  // as runner logs and screenshots (some clients cannot download log blobs).
  const diagnostic = String(error?.stack ?? error).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.error(`::error::${diagnostic}`);
  mkdirSync(".cache/commission-e2e", { recursive: true });
  for (const [index, context] of contexts.entries()) {
    for (const page of context.pages()) await page.screenshot({ path: `.cache/commission-e2e/actor-${index}.png`, fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
