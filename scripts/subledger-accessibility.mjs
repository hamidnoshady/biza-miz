/** Seeded-browser accessibility review of #825; run against a running app.
 * Real API data, with the requested page size narrowed to one to exercise the
 * load-more control in the two-customer visual fixture. No synthetic balances.
 * Uses the same Chromium/locale/viewport defaults as the visual harness.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
const require = createRequire(import.meta.url);
const base = process.env.VISUAL_BASE_URL ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({
  executablePath: process.env.VISUAL_CHROMIUM_PATH || undefined,
  args: process.env.VISUAL_CHROMIUM_PATH ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [],
});
// Same major enforced by scripts/visual-regression.mjs (playwright@1.56.0).
assert.equal(browser.version().split(".")[0], "141");
try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: "fa-IR", timezoneId: "Asia/Tehran", reducedMotion: "reduce", colorScheme: theme });
    await context.addInitScript((value) => localStorage.setItem("theme", value), theme);
    const login = await context.request.post(`${base}/api/auth/login`, { data: { email: process.env.SEED_OWNER_EMAIL ?? "owner@example.com", password: process.env.SEED_OWNER_PASSWORD ?? "owner1234" } });
    assert.ok(login.ok(), `login ${login.status()}`);
    await context.route("**/api/ledger/ar/customers?*", async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set("limit", "1");
      const response = await route.fetch({ url: url.toString() });
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.error(`Browser console: ${message.text()}`);
        if (/hydrat/i.test(message.text())) browserErrors.push(message.text());
      }
    });
    page.setDefaultTimeout(30_000);
    await page.goto(`${base}/accounting/receivables`, { waitUntil: "domcontentloaded" });
    const search = page.getByRole("searchbox", { name: "جست‌وجوی مشتری" });
    await search.waitFor();
    const more = page.getByRole("button", { name: "نمایش موارد بیشتر", exact: true });
    await more.waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
    assert.equal(await page.locator("html").evaluate((el) => el.classList.contains("dark")), theme === "dark");
    assert.match(await page.evaluate(() => document.querySelector("body > script").nonce), /^[0-9a-f]{32}$/, "CSP nonce remains present on the script property");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    async function audit(selector, label) {
      await page.getByText(/^سرور محلی در دسترس نیست/).waitFor({ state: "hidden" });
      await page.evaluate(() => document.fonts.ready);
      // Audit settled geometry, not the frame between a skeleton and its rows.
      await page.evaluate(() => { delete window.__a11yFrame; });
      await page.waitForFunction((selector) => {
        const element = document.querySelector(selector);
        if (!element || element.querySelector('[data-slot="skeleton"]')) return false;
        const rect = element.getBoundingClientRect();
        const signature = `${element.innerHTML}:${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
        const prior = window.__a11yFrame;
        const stable = prior?.signature === signature ? prior.stable + 1 : 0;
        window.__a11yFrame = { signature, stable };
        return stable >= 3;
      }, selector, { polling: 150 });
      const result = await page.evaluate(async (selector) => window.axe.run({ include: [[selector]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }), selector);
      if (process.env.A11Y_SCREENSHOT_DIR) {
        mkdirSync(process.env.A11Y_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.A11Y_SCREENSHOT_DIR, `${theme}-${width}-${label}.png`) });
      }
      if (result.incomplete.length) console.log(JSON.stringify(result.incomplete, null, 2));
      if (result.violations.length) console.error(JSON.stringify(result.violations, null, 2));
      assert.deepEqual(result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })), [], `${theme}/${width}/${label}`);
      // Axe can leave a transparent text cell indeterminate in stacked mobile
      // dialogs. Do not waive contrast: verify the rendered, opaque surface and
      // the WCAG ratio directly, and reject any occluded/unsupported geometry.
      const targets = result.incomplete.filter((check) => check.id === "color-contrast").flatMap((check) => check.nodes.map((node) => node.target));
      const measured = await page.evaluate((targets) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const rgb = (color) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data);
        };
        const luminance = (color) => color.slice(0, 3).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
        return targets.map((target) => {
          if (target.length !== 1) throw new Error("Cannot directly measure a shadow/frame contrast target");
          const element = document.querySelector(target[0]);
          if (!element) throw new Error("Missing contrast target");
          const foreground = rgb(getComputedStyle(element).color);
          let background;
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (Number(style.opacity) !== 1 || style.backgroundImage !== "none" || style.filter !== "none") throw new Error("Contrast requires manual review of compositing");
            const color = rgb(style.backgroundColor);
            if (color[3] === 255) { background = color; break; }
            if (color[3] !== 0) throw new Error("Contrast requires manual review of translucency");
          }
          if (!background || foreground[3] !== 255) throw new Error("No opaque contrast surface");
          const range = document.createRange();
          range.selectNodeContents(element);
          const rects = Array.from(range.getClientRects());
          if (!rects.length) throw new Error("No visible text geometry");
          for (const rect of rects) {
            for (const fraction of [0.1, 0.5, 0.9]) {
              const hit = document.elementFromPoint(rect.left + rect.width * fraction, rect.top + rect.height / 2);
              if (hit !== element && !element.contains(hit)) throw new Error(`Text is occluded: ${target[0]}`);
            }
          }
          const a = luminance(foreground), b = luminance(background);
          return { target, foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        });
      }, targets);
      for (const check of measured) assert.ok(check.ratio >= 4.5, `Direct small-text contrast ${JSON.stringify(check)}`);
      if (measured.length) console.log(JSON.stringify({ theme, width, label, directContrast: measured }));
      console.log(JSON.stringify({ theme, width, label, violations: 0, incomplete: result.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })) }));
    }
    await audit("main", "search-summary-load-more");
    await search.focus();
    // Navigate from the search with real Tab presses, then activate paging by Enter.
    for (let i = 0; i < 30 && !(await more.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
    assert.ok(await more.evaluate((el) => el === document.activeElement), "load more is keyboard reachable");
    await page.keyboard.press("Enter");
    await page.getByText("۲ از ۲ مشتری", { exact: true }).waitFor();
    await more.waitFor({ state: "hidden" });
    await search.fill("سارا");
    await page.getByRole("button", { name: "رضا کریمی", exact: true }).waitFor({ state: "hidden" });
    await search.fill("");
    await more.waitFor();
    const customer = page.getByRole("button", { name: "سارا محمدی", exact: true });
    await customer.focus();
    await page.keyboard.press("Enter");
    const statement = page.getByRole("dialog", { name: /صورتحساب/ });
    const drill = statement.getByRole("button", { name: "نمایش سند", exact: true }).first();
    await drill.waitFor();
    await audit("[data-ledger-dialog]", "statement");
    await page.keyboard.press("Shift+Tab");
    assert.ok(await statement.evaluate((el) => el.contains(document.activeElement)), "backward focus remains in statement");
    await page.keyboard.press("Tab");
    assert.ok(await statement.evaluate((el) => el.contains(document.activeElement)), "forward focus remains in statement");
    await drill.focus();
    await page.keyboard.press("Enter");
    const entry = page.getByRole("dialog", { name: "سند حسابداری", exact: true });
    await entry.getByText(/حساب‌های دریافتنی/).waitFor();
    await audit('[aria-labelledby="statement-entry-heading"]', "entry");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    assert.ok(await entry.evaluate((el) => el.contains(document.activeElement)), "entry contains focus");
    await page.keyboard.press("Escape");
    await entry.waitFor({ state: "hidden" });
    assert.ok(await statement.isVisible(), "Escape preserves parent statement");
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "نمایش سند");
    await page.keyboard.press("Escape");
    await statement.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "سارا محمدی");
    assert.deepEqual(browserErrors, [], "no uncaught browser errors");
    console.log(`PASS keyboard, focus restore, RTL and axe ${theme}/${width}`);
    await context.close();
  }
} catch (error) {
  const message = String(error).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.log(`::error file=scripts/subledger-accessibility.mjs,title=Subledger accessibility::${message}`);
  throw error;
} finally {
  await browser.close();
}
