/**
 * Visual regression for the approved design system.
 *
 * Renders a short, deliberately-chosen list of screens — at least one per app,
 * including both Website Management managers — in a pinned Chromium and
 * compares each against a committed PNG baseline.
 *
 * Determinism is the whole game here; a flaky snapshot gets ignored, and an
 * ignored check is not a check. So:
 *
 *  - one desktop viewport (1440×900, DPR 1), a 390×844 mobile viewport where a
 *    screen claims one, and one timezone (Asia/Tehran), set on the
 *    browser context rather than inherited from the machine;
 *  - `prefers-reduced-motion: reduce`, which the app already honours globally —
 *    this parks every transition, skeleton shimmer and staggered entry at its
 *    final frame instead of photographing them mid-animation;
 *  - the seeded demo business, never production data;
 *  - each shot waits for the page's loading skeletons to disappear, so a
 *    snapshot is of the loaded state rather than a race with it.
 *
 * Baselines live next to this harness's output in docs/design/visual/. They are
 * reviewed as images in the PR. **Never re-record a baseline to clear a failing
 * run** — read docs/design/visual-regression.md first; a diff is either a bug
 * you introduced or a design change you can describe in the PR body.
 *
 * Usage:
 *   node scripts/visual-regression.mjs            # compare against baselines
 *   node scripts/visual-regression.mjs --update   # re-record (deliberate only)
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_DIR = join(ROOT, "docs", "design", "visual");
const DIFF_DIR = join(BASELINE_DIR, "__diff__");

const BASE_URL = process.env.VISUAL_BASE_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const UPDATE = process.argv.includes("--update");

/**
 * Per-pixel tolerance. Text antialiasing differs by a hair between machines
 * even with the same browser build, so an exact match would be permanently
 * red; 0.5% of pixels keeps the suite below structural layout changes while
 * absorbing runner-level font raster drift.
 *
 * Calibrated on evidence, 2026-09-20: with the baseline-recording binary the
 * whole suite renders byte-identical, while the same commit on ubuntu-latest
 * measured 0.36% on `crm-deals` — the densest small-RTL-text screen, and so
 * the one with the most glyph edges to redden — after a live-installed
 * runner library shifted rasterisation slightly. Nobody's code had touched
 * that screen. Real regressions remain far away: a wrong colour, a missing
 * card or a shifted layout moves whole percent, not tenths — 0.36% was the
 * measured *upper edge of noise*, and 0.5% clears it with headroom without
 * approaching the structural floor. If a failure lands between 0.3% and
 * 0.5%, open the diff image before assuming either way.
 */
const MAX_DIFF_RATIO = 0.005;

/**
 * Per-channel colour tolerance for one pixel. CI's pinned Chromium is stable,
 * but GitHub runner font libraries still move edge antialiasing by more than
 * the old 12/255 threshold; 64 keeps glyph-edge noise out while black-vs-white
 * layout/content shifts still count as real changed pixels.
 */
const PIXEL_CHANNEL_TOLERANCE = 64;

/** One or two CSS pixels of glyph drift is font rasterisation, not layout. */
const PIXEL_NEIGHBOURHOOD_RADIUS = 2;

/**
 * The Chromium the baselines were recorded with — the build pinned by the
 * `playwright` devDependency, which is itself pinned to an exact version (not
 * `^`) precisely so this cannot drift. Only the major is enforced; patch
 * releases do not move glyph rasterisation.
 *
 * Keep this in step with `playwright` in package.json. If you upgrade
 * Playwright, every baseline must be re-recorded in the same commit, and the
 * PR should say so — that is a deliberate, reviewable re-record, not a
 * silently accepted diff.
 */
const EXPECTED_CHROMIUM_VERSION = "141.0.7390.37";

/**
 * The screens under watch — one or more per app, chosen because each is the
 * canonical example of a shared pattern rather than because it is pretty.
 *
 * `theme` covers the language's two surfaces; `state` names a non-default
 * interaction worth freezing (an empty list, a focused control). `viewport`
 * overrides the default 1440×900 window for the mobile form of a screen —
 * same DPR 1, so the comparison stays pixel-honest.
 */
const SCREENS = [
  // — Accounting — the reference trial balance: table hierarchy + status pill.
  { id: "accounting-trial-balance", path: "/accounting/trial-balance", theme: "light" },
  { id: "accounting-trial-balance-dark", path: "/accounting/trial-balance", theme: "dark" },
  // — Accounting — the orders queue: filter chips, search, rich empty state.
  { id: "accounting-orders", path: "/accounting/orders", theme: "light" },
  // — Accounting — inventory: section nav, form card, filters, data table.
  { id: "accounting-inventory", path: "/accounting/inventory", theme: "light" },
  /*
   * Three ledger registers, added when the hand-rolled tables were migrated
   * onto `DataTable`. The eleven screens above all passed that migration
   * unchanged — which proved nothing, because not one of them rendered a
   * migrated table. These do: the chart of accounts is the widest (seven
   * columns, indentation, two badge kinds), expenses is the money-column case
   * the trial-balance screenshot governs, and receivables pairs a table with
   * the tab bar and an in-row action link.
   */
  // Both registers sit below an entry form, so the default viewport frames the
  // form and one row of the table. `anchor` scrolls the table itself into
  // view, which is the point of these baselines.
  {
    id: "accounting-chart-of-accounts",
    path: "/accounting/chart-of-accounts",
    theme: "light",
    anchor: "table",
  },
  {
    id: "accounting-expenses",
    path: "/accounting/expenses",
    theme: "light",
    anchor: "table",
  },
  { id: "accounting-receivables", path: "/accounting/receivables", theme: "light" },
  /*
   * The «دریافت و پرداخت» register: filter chips, search, the voucher table
   * with its method/account column and status pill, and the ثبت action. The
   * fixture holds one fully-reversed receipt (net-zero in every aggregation,
   * so no other baseline moves), which is what makes the باطل‌شده status —
   * the register's whole reason to keep reversed vouchers visible — appear.
   * Mobile is a first-class layout here (stacked cards, full-width actions),
   * so it gets its own baselines in both themes.
   */
  { id: "accounting-receipts", path: "/accounting/receipts", theme: "light" },
  { id: "accounting-receipts-dark", path: "/accounting/receipts", theme: "dark" },
  { id: "accounting-receipts-mobile", path: "/accounting/receipts", theme: "light", viewport: { width: 390, height: 844 } },
  { id: "accounting-receipts-mobile-dark", path: "/accounting/receipts", theme: "dark", viewport: { width: 390, height: 844 } },
  // — CRM —
  { id: "crm-overview", path: "/crm/overview", theme: "light" },
  { id: "crm-deals", path: "/crm/deals", theme: "light" },
  // — Growth and Marketing —
  { id: "growth-overview", path: "/growth/overview", theme: "light" },
  { id: "growth-customers", path: "/growth/customers", theme: "light" },
  // — Website Management: both peer managers —
  { id: "websites-cms", path: "/websites/cms", theme: "light" },
  { id: "websites-wp", path: "/websites/wp", theme: "light" },
  // — Business settings: the selected money-unit control —
  { id: "settings-business", path: "/settings", theme: "light" },
];

function channelsClose(data, offset, r, g, bl) {
  return (
    Math.abs(data[offset] - r) <= PIXEL_CHANNEL_TOLERANCE &&
    Math.abs(data[offset + 1] - g) <= PIXEL_CHANNEL_TOLERANCE &&
    Math.abs(data[offset + 2] - bl) <= PIXEL_CHANNEL_TOLERANCE
  );
}

function neighbourhoodHasColour(image, x, y, r, g, bl) {
  for (let dy = -PIXEL_NEIGHBOURHOOD_RADIUS; dy <= PIXEL_NEIGHBOURHOOD_RADIUS; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= image.height) continue;
    for (let dx = -PIXEL_NEIGHBOURHOOD_RADIUS; dx <= PIXEL_NEIGHBOURHOOD_RADIUS; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= image.width) continue;
      const offset = (yy * image.width + xx) * 4;
      if (channelsClose(image.data, offset, r, g, bl)) return true;
    }
  }
  return false;
}

function comparePng(actualBuf, expectedBuf) {
  const a = PNG.sync.read(actualBuf);
  const b = PNG.sync.read(expectedBuf);
  if (a.width !== b.width || a.height !== b.height) {
    return { mismatch: 1, reason: `size ${a.width}×${a.height} vs ${b.width}×${b.height}`, diff: null };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  let changed = 0;
  let minX = a.width;
  let minY = a.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < a.data.length; i += 4) {
    const pixel = i / 4;
    const x = pixel % a.width;
    const y = Math.floor(pixel / a.width);
    const directMatch = channelsClose(a.data, i, b.data[i], b.data[i + 1], b.data[i + 2]);
    // CI runner font libraries can move glyph edges slightly even with the
    // same Chromium major. Treat only symmetric near-neighbour colour matches
    // as equivalent: a shifted glyph is ignored, but removed/new text still
    // lacks the opposite-colour neighbour and is counted.
    const shiftedMatch =
      !directMatch &&
      neighbourhoodHasColour(b, x, y, a.data[i], a.data[i + 1], a.data[i + 2]) &&
      neighbourhoodHasColour(a, x, y, b.data[i], b.data[i + 1], b.data[i + 2]);
    const differs = !directMatch && !shiftedMatch;
    if (differs) {
      changed++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    diff.data[i] = differs ? 255 : a.data[i];
    diff.data[i + 1] = differs ? 0 : a.data[i + 1];
    diff.data[i + 2] = differs ? 0 : a.data[i + 2];
    diff.data[i + 3] = 255;
  }
  const bounds = changed > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  return { mismatch: changed / (a.width * a.height), reason: null, diff: PNG.sync.write(diff), bounds };
}

async function main() {
  mkdirSync(BASELINE_DIR, { recursive: true });
  rmSync(DIFF_DIR, { recursive: true, force: true });

  // `VISUAL_CHROMIUM_PATH` lets a sandbox that cannot reach Playwright's CDN
  // point at a Chromium it obtained another way. CI leaves it unset and uses
  // the browser pinned by the `playwright` devDependency.
  const executablePath = process.env.VISUAL_CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    // Needed only for the unprivileged-container case above; harmless in CI.
    args: executablePath ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [],
  });

  // Refuse to compare — or worse, to *record* — with the wrong browser.
  //
  // This is not defensive padding; it is the bug that made the first CI run
  // red on every screen. Baselines had been recorded locally with Chromium 153
  // (extracted from an npm package, because this sandbox cannot reach
  // Playwright's CDN) while CI installed the Chromium pinned by
  // `playwright@1.56.0`, which is 141. Chromium rasterises text differently
  // between majors, so every screen differed by more than the tolerance and
  // the diff images looked like "everything changed" — which tells you
  // nothing. A version check turns that into one clear sentence.
  //
  // The repo also carries `playwright-core` (1.61.x) as a *runtime* dependency
  // for PDF and receipt rendering; it pins a third Chromium. That is fine —
  // nothing visual is recorded with it — but it is why this check names the
  // version it wants instead of trusting whatever launched.
  const actualMajor = Number(browser.version().split(".")[0]);
  const expectedMajor = Number(EXPECTED_CHROMIUM_VERSION.split(".")[0]);
  if (actualMajor !== expectedMajor) {
    await browser.close();
    throw new Error(
      `Chromium major ${actualMajor} does not match the pinned major ${expectedMajor} ` +
        `(expected ${EXPECTED_CHROMIUM_VERSION}, got ${browser.version()}).\n` +
        "Baselines are only comparable within one Chromium major: text rasterises\n" +
        "differently between majors and every screen will differ.\n" +
        (executablePath
          ? `You set VISUAL_CHROMIUM_PATH=${executablePath}. Either point it at a ` +
            "matching Chromium, or unset it and run `npx playwright install chromium`.\n" +
            "Do NOT record baselines from a mismatched browser — CI will not match them."
          : "Run `npx playwright install chromium` to fetch the pinned build."),
    );
  }

  /** Identical for every screen — the determinism contract lives here. */
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    // The app kills every animation under this, so shots are of final frames.
    reducedMotion: "reduce",
  };

  // Log in once and keep the session, so each screen can still get a *fresh*
  // context. A fresh context per screen matters: init scripts accumulate on a
  // page, so reusing one context would leave every previous screen's theme
  // script attached and make the result depend on iteration order.
  const authContext = await browser.newContext(contextOptions);
  const login = await authContext.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(`login failed (${login.status()}) — is the seeded database up?`);
  }
  const storageState = await authContext.storageState();
  await authContext.close();

  const failures = [];
  const recorded = [];
  /** Screens still showing a loading region when photographed — reported, not hidden. */
  const busyAtCapture = [];
  /** Screens whose DOM never stopped changing — the other flake source. */
  const unsettled = [];

  for (const screen of SCREENS) {
    const context = await browser.newContext({
      ...contextOptions,
      viewport: screen.viewport ?? contextOptions.viewport,
      storageState,
      colorScheme: screen.theme,
    });
    // next-themes persists the choice in localStorage under "theme" (not a
    // cookie), and the provider is `defaultTheme="system" enableSystem`. Set
    // both: the storage key pins the explicit choice, and `colorScheme` makes
    // the `system` path resolve the same way if storage is ever cleared. It
    // must be an init script so the value is present before the provider's
    // blocking script runs, otherwise the first paint is the wrong theme.
    await context.addInitScript(
      (theme) => window.localStorage.setItem("theme", theme),
      screen.theme,
    );
    const page = await context.newPage();
    // NOT `networkidle`: this app holds an open WebSocket for live sync, so
    // the network is never idle and every navigation would time out. Wait for
    // the document, then for the app's own "finished loading" signal below.
    await page.goto(`${BASE_URL}${screen.path}`, { waitUntil: "domcontentloaded" });

    // The loaded state, not a race with it: every data region in this app
    // renders a role=status skeleton while fetching.
    // Three conditions, because any one alone is a lie:
    //  - a page that has not yet rendered its skeletons also reports zero
    //    busy regions, so require the shell to exist first;
    //  - `aria-busy` is only set by *standalone* skeletons — a `KpiRowSkeleton`
    //    composed inside a larger fallback deliberately omits it, so a screen
    //    can be mid-load with no busy attribute anywhere. Every skeleton,
    //    standalone or not, carries `data-slot="skeleton"`; that is the
    //    reliable signal.
    //  - and the DOM must then hold still, so we do not photograph the frame
    //    between "skeleton removed" and "content painted".
    await page
      .waitForFunction(
        () =>
          document.querySelectorAll("main, [data-page-shell]").length > 0 &&
          document.querySelectorAll('[aria-busy="true"]').length === 0 &&
          document.querySelectorAll('[data-slot="skeleton"]').length === 0,
        null,
        { timeout: 45_000 },
      )
      .catch(() => {
        busyAtCapture.push(screen.id);
      });

    // Settled, not merely loaded. Without this the suite is ~10% flaky: a
    // screen whose data arrives in two waves briefly shows content, so the
    // condition above passes, and the shot lands before the second render.
    await page.waitForFunction(
      () => {
        const w = window;
        const now = document.body.innerHTML.length;
        const stable = w.__vrLast === now ? (w.__vrStable ?? 0) + 1 : 0;
        w.__vrLast = now;
        w.__vrStable = stable;
        return stable >= 3;
      },
      null,
      { timeout: 20_000, polling: 150 },
    ).catch(() => {
      unsettled.push(screen.id);
    });

    // Fonts settled — Vazirmatn loads via next/font and reflows text if early.
    await page.evaluate(() => document.fonts.ready);

    // Assert the theme actually applied, rather than trusting it. A dark
    // baseline recorded from a light render is worse than no baseline.
    const isDark = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    if (isDark !== (screen.theme === "dark")) {
      throw new Error(
        `${screen.id}: expected the ${screen.theme} theme but the page rendered ` +
          `${isDark ? "dark" : "light"}. Refusing to record a mislabelled baseline.`,
      );
    }

    // Some registers live below a form or a filter bar, so the default viewport
    // would photograph chrome rather than the table under test. Scroll the
    // named element to the top of the viewport — `instant`, and reduced motion
    // is already on, so there is no smooth-scroll frame to race.
    if (screen.anchor) {
      const anchored = await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        element.scrollIntoView({ behavior: "instant", block: "start" });
        return true;
      }, screen.anchor);
      if (!anchored) {
        throw new Error(
          `${screen.id}: anchor "${screen.anchor}" not found. Refusing to record ` +
            `a baseline that frames something other than the intended element.`,
        );
      }
      // Let the scroll commit before the shot; two frames is enough and is not
      // a timing guess the way a sleep would be.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    }

    const actual = await page.screenshot({ fullPage: false });
    await context.close();
    const baselinePath = join(BASELINE_DIR, `${screen.id}.png`);

    if (UPDATE || !existsSync(baselinePath)) {
      writeFileSync(baselinePath, actual);
      recorded.push(screen.id);
      continue;
    }

    const { mismatch, reason, diff, bounds } = comparePng(actual, readFileSync(baselinePath));
    if (mismatch > MAX_DIFF_RATIO) {
      mkdirSync(DIFF_DIR, { recursive: true });
      writeFileSync(join(DIFF_DIR, `${screen.id}.actual.png`), actual);
      if (diff) writeFileSync(join(DIFF_DIR, `${screen.id}.diff.png`), diff);
      const boundsText = bounds ? `, bounds ${bounds.x},${bounds.y} ${bounds.width}×${bounds.height}` : "";
      const message =
        reason ?? `${(mismatch * 100).toFixed(2)}% of pixels changed${boundsText}`;
      failures.push({ id: screen.id, message });
    }
  }

  await browser.close();

  if (unsettled.length > 0) {
    console.warn(
      `\nDOM never settled before capture: ${unsettled.join(", ")}.` +
        "\nThat screen re-renders indefinitely (a polling timer, an animation the" +
        "\nreduced-motion rule misses). Its baseline will be flaky until that stops.",
    );
  }
  if (busyAtCapture.length > 0) {
    console.warn(
      `\nStill loading when photographed: ${busyAtCapture.join(", ")}.` +
        "\nThat baseline captures a skeleton, which will be unstable. Fix the wait" +
        "\nor the screen before trusting it.",
    );
  }
  if (recorded.length > 0) {
    console.log(`Recorded ${recorded.length} baseline(s): ${recorded.join(", ")}`);
    console.log("Review each image before committing — a baseline is an approval.");
  }
  if (failures.length > 0) {
    // Workflow commands are only parsed from a step's STDOUT — a ::error on
    // stderr is invisible to the Checks UI and to the annotations API, which
    // left "which screens failed?" answerable only by downloading the log or
    // the diff artifact. One annotation per failing screen, each naming the
    // baseline file it belongs to.
    for (const failure of failures) {
      console.log(
        `::error file=docs/design/visual/${failure.id}.png,title=Visual regression::${failure.message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
      );
    }
    console.error(
      "\nVisual regressions:\n" + failures.map((f) => `  - ${f.id}: ${f.message}`).join("\n"),
    );
    console.error(
      "\nDiffs written to docs/design/visual/__diff__/." +
        "\nDo NOT re-record to clear this. Read docs/design/visual-regression.md:" +
        "\na diff is either a bug you introduced or a design change to describe.",
    );
    process.exit(1);
  }
  console.log(`Visual regression: ${SCREENS.length} screen(s) match their baselines.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
