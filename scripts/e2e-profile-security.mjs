#!/usr/bin/env node
/**
 * Profile & sign-out security — browser acceptance against a running
 * production server and its seeded database (issue #854 follow-up).
 *
 *   npm run test:e2e:profile        (server on E2E_BASE_URL, default http://localhost:3000)
 *
 * Needs the same thing the media E2E job has — a production build serving a
 * database seeded with `npm run db:seed` (owner + sample Cashier, PIN 1234) —
 * plus DATABASE_URL pointing at that database with a role that may change
 * settings and create a trigger: the script flips the deployment profile
 * between Cloud/Hybrid/Local and injects one audit failure, the same way the
 * DB integration suite does. Everything it changes it puts back.
 *
 * The base URL defaults to `localhost`, not 127.0.0.1, because WebAuthn
 * refuses an IP address as the relying party: the biometric checks register a
 * real credential through Chromium's *virtual* authenticator (CDP). That is
 * the browser's own WebAuthn stack end to end — not a physical authenticator,
 * which no headless run can provide.
 *
 * What it proves, in a real browser:
 *   1. RTL + branch facts: the page is `dir="rtl"`; a member with no home
 *      branch is never told the active branch is their home.
 *   2. F02/F12: an owner (no authenticator) is offered no biometric card; a
 *      Cashier is — registration works with a virtual authenticator, and with
 *      WebAuthn removed from the page the registered device is still listed
 *      and removable while registration is withheld.
 *   3. F09: a removal whose request is dropped keeps the list, says so, and
 *      releases the button; the retry removes it.
 *   4. F11: Cloud and Local render the login phone and the staff PIN
 *      editable. Hybrid depends on the server's deployment role
 *      (E2E_DEPLOYMENT_ROLE, below): on a Hybrid *site* the Profile screen is
 *      the cloud's (the cloud pane), with no local credential control; on the
 *      central server it is local, with the login phone read-only (and the
 *      reason given) and the staff PIN still self-service.
 *   5. F08: the PIN fields are masked and open the numeric keyboard.
 *   6. Sign-out (F10 + the logout follow-up): a dropped request is not a
 *      sign-out; a real server-side audit failure is reported as unconfirmed
 *      with the cookie cleared, a retained copy of the token is still
 *      truthfully alive, and the retry finishes it — after which the copy is
 *      refused. The sidebar menu and the /login account switch read the same
 *      contract.
 *   7. Keyboard and labels: the sign-out button is reachable and operable by
 *      keyboard; axe-core finds no serious/critical violation in the Profile
 *      content (colour contrast is reported, not failed — it is a design-token
 *      property outside this surface).
 *   8. A 390px phone frame has no horizontal page scroll.
 *
 * Exits non-zero if any expectation fails. Nothing is skipped or retried into
 * a pass. Screenshots go to E2E_ARTIFACTS (default /tmp/e2e-profile).
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "pg";

const require = createRequire(import.meta.url);

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required (the database the server under test uses).");
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const BUSINESS_SLUG = process.env.SEED_BUSINESS_SLUG ?? "cafe-nemoone";
const CASHIER_PIN = "1234";
const EXECUTABLE = process.env.VISUAL_CHROMIUM_PATH || undefined;
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? "/tmp/e2e-profile";
const SESSION_COOKIE = "pos_session";
/**
 * The WebAuthn registration ceremony needs a browser with a WebAuthn stack. CI's
 * Playwright-installed Chromium has one (launched as `channel: "chromium"`, the
 * full build in new-headless mode). A sandbox that can only obtain the
 * npm-packaged headless *shell* (VISUAL_CHROMIUM_PATH, see
 * docs/design/visual-regression.md) cannot: `navigator.credentials.create`
 * terminates that build, with or without a virtual authenticator. Such a run
 * sets E2E_WEBAUTHN_CEREMONY=0, and the step is reported as NOT RUN — never as
 * passed — while the checks that only need a registered device use one
 * inserted into the database instead.
 */
const WEBAUTHN_CEREMONY = process.env.E2E_WEBAUTHN_CEREMONY !== "0";
/**
 * The deployment role of the server under test. It decides what a Hybrid
 * business looks like (`isHybridSite` in src/lib/site-routes.ts):
 *  - `site` — the desktop of a Hybrid business: every screen that is not the
 *    till's, Profile included, is the cloud's and is shown as the cloud pane;
 *  - `central` — not a Hybrid site, so the Profile screen is local and each
 *    credential card follows the authority table
 *    (src/lib/credential-authority.ts): the login phone is the cloud's —
 *    read-only, with the reason — while the staff PIN stays self-service,
 *    because a till must be able to rotate it while the uplink is down.
 * Set it to the role the server was started with. The default is what a
 * server started without DEPLOYMENT_ROLE infers (`site`); CI's media E2E
 * server runs as `central`. A wrong value fails the Hybrid checks — it can
 * never turn them into a pass.
 */
const SERVER_ROLE = process.env.E2E_DEPLOYMENT_ROLE ?? "site";
if (SERVER_ROLE !== "site" && SERVER_ROLE !== "central") {
  throw new Error(`E2E_DEPLOYMENT_ROLE must be "site" or "central", not "${SERVER_ROLE}"`);
}
/** What a card the cloud owns says instead of its controls (AUTH_ERROR_MESSAGES.login_managed_by_cloud). */
const CLOUD_MANAGED_NOTICE = "این مورد در نسخهٔ ابری مدیریت می‌شود.";
/** Unique per run, so a re-run against the same database never matches an old device. */
const DEVICE_LABEL = `E2E ${Date.now().toString(36)}`;

const desktop = {
  viewport: { width: 1360, height: 900 },
  locale: "fa-IR",
  timezoneId: "Asia/Tehran",
  reducedMotion: "reduce",
};
const phone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "fa-IR",
  timezoneId: "Asia/Tehran",
  reducedMotion: "reduce",
};

const failures = [];
const notRun = [];
let passed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Polls until `fn` is truthy or the deadline passes. */
async function until(fn, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** The app keeps a socket open, so "settled" is: no skeleton, no busy region, stable DOM. */
async function settle(page) {
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('[aria-busy="true"]').length === 0 &&
        document.querySelectorAll('[data-slot="skeleton"]').length === 0,
      null,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page
    .waitForFunction(
      () => {
        const w = window;
        const now = document.body.innerHTML.length;
        const stable = w.__e2eLast === now ? (w.__e2eStable ?? 0) + 1 : 0;
        w.__e2eLast = now;
        w.__e2eStable = stable;
        return stable >= 3;
      },
      null,
      { timeout: 15_000, polling: 150 },
    )
    .catch(() => {});
}

async function open(page, path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
  await settle(page);
}

/** The card (`<section aria-label>`) a SectionCard renders. */
function card(page, title) {
  return page.locator(`section[aria-label="${title}"]`);
}

async function sessionToken(context) {
  return (await context.cookies()).find((c) => c.name === SESSION_COOKIE && c.value)?.value ?? null;
}

/** Whether a token would still be accepted, asked from a context that holds nothing else. */
async function tokenAccepted(browser, token) {
  const probe = await browser.newContext();
  try {
    const res = await probe.request.get(`${BASE_URL}/api/sessions/self`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    return res.status() === 200;
  } finally {
    await probe.close();
  }
}

async function loginOwner(context) {
  const res = await context.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!res.ok()) throw new Error(`owner login failed (${res.status()}): ${await res.text()}`);
}

async function loginCashier(context) {
  const roster = await context.request.get(
    `${BASE_URL}/api/auth/pin-login/roster?businessSlug=${encodeURIComponent(BUSINESS_SLUG)}`,
  );
  const cashier = ((await roster.json().catch(() => ({}))).employees ?? []).find((e) => e.role === "cashier");
  if (!cashier) throw new Error("the seeded Cashier is not on the PIN roster");
  const res = await context.request.post(`${BASE_URL}/api/auth/pin-login`, {
    data: { pin: CASHIER_PIN, employeeId: cashier.id, businessSlug: BUSINESS_SLUG },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok() || body.phoneVerification) {
    throw new Error(`cashier PIN login failed (${res.status()}): ${JSON.stringify(body)}`);
  }
  return cashier.id;
}

async function setProfile(db, businessId, profile) {
  await db.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'deployment.profile', $2)
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [businessId, JSON.stringify({ profile, pairedAt: new Date().toISOString() })],
  );
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

/** axe-core over the Profile content; returns [blocking, contrast] violation lists. */
async function axe(page) {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  const violations = await page.evaluate(async () => {
    const root = document.querySelector("main") ?? document.body;
    const result = await window.axe.run(root, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    }));
  });
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  return [serious.filter((v) => v.id !== "color-contrast"), serious.filter((v) => v.id === "color-contrast"), violations];
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  const { rows: businesses } = await db.query(`SELECT id FROM businesses WHERE slug = $1`, [BUSINESS_SLUG]);
  if (!businesses[0]) throw new Error(`no business with slug ${BUSINESS_SLUG} — is the database seeded?`);
  const businessId = businesses[0].id;
  const { rows: previous } = await db.query(
    `SELECT value FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = 'deployment.profile'`,
    [businessId],
  );
  // The branch check needs a member with no home branch: the seeded owner has
  // none, but earlier jobs may have touched it, so this run sets it and puts
  // it back.
  const { rows: ownerRows } = await db.query(
    `SELECT u.id, u.location_id FROM users u JOIN platform_users p ON p.id = u.platform_user_id
      WHERE u.business_id = $1 AND p.email = $2`,
    [businessId, EMAIL],
  );
  if (!ownerRows[0]) throw new Error(`the seeded owner ${EMAIL} is not a member of ${BUSINESS_SLUG}`);
  const ownerMembership = ownerRows[0];
  await db.query(`UPDATE users SET location_id = NULL WHERE id = $1`, [ownerMembership.id]);

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: EXECUTABLE ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [],
  });

  try {
    await setProfile(db, businessId, "cloud");

    // ======================================================================
    console.log(`Server under test: ${BASE_URL} (deployment role: ${SERVER_ROLE})`);
    section("1. Owner on Cloud — RTL, branch facts, no biometric offer, labels");
    // ======================================================================
    const ownerContext = await browser.newContext(desktop);
    await loginOwner(ownerContext);
    const owner = await ownerContext.newPage();
    await open(owner, "/settings/profile");
    check("the Profile page is served", owner.url().includes("/settings/profile"), owner.url());
    check(
      "the document is right-to-left Persian",
      (await owner.evaluate(() => document.documentElement.dir)) === "rtl",
    );
    const identity = card(owner, "مشخصات ورود");
    await identity.waitFor({ timeout: 15_000 });
    check("the active branch is named", await identity.getByText("شعبهٔ فعال").isVisible());
    // The seeded owner has no home branch (users.location_id is NULL).
    check(
      "a member without a home branch is never told the active branch is home",
      (await identity.getByText("(شعبهٔ اصلی شما)").count()) === 0,
    );
    check("…and is told plainly that none is set", await identity.getByText("تعیین نشده").isVisible());
    check(
      "F02: no biometric card for an owner with no authenticator",
      (await card(owner, "ورود بیومتریک (اثر انگشت / چهره)").count()) === 0,
    );
    check("the password card is offered on Cloud", await card(owner, "تغییر رمز عبور").isVisible());

    const [blocking, contrast, all] = await axe(owner);
    console.log(`    axe: ${all.length} violation kind(s) in the Profile content: ${all.map((v) => `${v.id}(${v.impact})`).join(", ") || "none"}`);
    for (const v of contrast) console.log(`    (reported, not failed) ${v.id}: ${v.help} — ${v.nodes.join(" | ")}`);
    check(
      "axe: no serious/critical violation in the Profile content (contrast excepted)",
      blocking.length === 0,
      blocking.map((v) => `${v.id}: ${v.help} @ ${v.nodes.join(" | ")}`).join("; "),
    );

    // Keyboard: Tab reaches «خروج از حساب» (bounded), and it is a real button.
    await owner.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
      await owner.keyboard.press("Tab");
      reached = await owner.evaluate(() => document.activeElement?.textContent?.trim() === "خروج از حساب");
    }
    check("keyboard: Tab reaches «خروج از حساب»", reached);
    await owner.screenshot({ path: join(ARTIFACTS, "owner-profile-desktop.png"), fullPage: true });

    // ======================================================================
    section("2. Sign-out from Profile — dropped, unconfirmed (real audit failure), retried");
    // ======================================================================
    const retained = await sessionToken(ownerContext);
    check("the owner session cookie exists", Boolean(retained));

    await owner.route("**/api/auth/logout", (route) => route.abort("internetdisconnected"));
    await owner.keyboard.press("Enter"); // the focused «خروج از حساب»
    const offline = await until(() => owner.getByRole("alert").filter({ hasText: "ارتباط با سرور برقرار نشد" }).isVisible());
    check("a dropped sign-out says the session is still open", Boolean(offline));
    check("…keeps the member on the page", owner.url().includes("/settings/profile"), owner.url());
    const retryOut = owner.getByRole("button", { name: "تلاش دوباره برای خروج" });
    // The card re-reads its state before it clears the in-flight flag, so the
    // button is released one round-trip AFTER the message appears. Wait for it
    // (bounded) instead of sampling it in the same tick — sampling was the
    // flake: the assertion failed on a slow runner while the behaviour, and the
    // defect it guards (F09: a dropped request leaving the button disabled
    // forever), were both correct.
    check("…and releases the button for a retry", Boolean(await until(() => retryOut.isEnabled())));
    check("…and the session really is still valid", await tokenAccepted(browser, retained));
    await owner.unroute("**/api/auth/logout");

    await db.query(`
      CREATE OR REPLACE FUNCTION e2e_fail_session_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'employee.session_revoked' THEN
          RAISE EXCEPTION 'e2e injected audit failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.query(`DROP TRIGGER IF EXISTS e2e_fail_session_audit ON audit_log`);
    await db.query(
      `CREATE TRIGGER e2e_fail_session_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION e2e_fail_session_audit()`,
    );
    try {
      await retryOut.click();
      const unconfirmed = await until(() =>
        owner.getByRole("alert").filter({ hasText: "سرور پایان نشست را تأیید نکرد" }).isVisible(),
      );
      check("a server-side audit failure is reported as unconfirmed", Boolean(unconfirmed));
      check("…the browser cookie is cleared regardless", !(await sessionToken(ownerContext)));
      check(
        "…the way to the login page is offered",
        await owner.getByRole("button", { name: "رفتن به صفحهٔ ورود" }).isVisible(),
      );
      check("…and, truthfully, a retained copy of the token is still alive", await tokenAccepted(browser, retained));
      await owner.screenshot({ path: join(ARTIFACTS, "owner-signout-unconfirmed.png") });
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS e2e_fail_session_audit ON audit_log`);
    }
    await owner.getByRole("button", { name: "تلاش دوباره برای پایان نشست" }).click();
    const finished = await until(() => Promise.resolve(owner.url().includes("/login")), 15_000);
    check("the retry finishes the sign-out and leaves for /login", Boolean(finished), owner.url());
    check("…after which the retained copy is refused", !(await tokenAccepted(browser, retained)));
    await ownerContext.close();

    // ======================================================================
    section("3. Cashier — biometric supported (virtual authenticator) and unsupported");
    // ======================================================================
    const ceremonyBrowser =
      WEBAUTHN_CEREMONY && !EXECUTABLE ? await chromium.launch({ channel: "chromium" }) : browser;
    const cashierContext = await ceremonyBrowser.newContext(desktop);
    const cashierId = await loginCashier(cashierContext);
    const cashier = await cashierContext.newPage();
    const cdp = WEBAUTHN_CEREMONY ? await cashierContext.newCDPSession(cashier) : null;
    if (cdp) {
      await cdp.send("WebAuthn.enable");
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
    }
    await open(cashier, "/settings/profile");
    const biometric = card(cashier, "ورود بیومتریک (اثر انگشت / چهره)");
    await biometric.waitFor({ timeout: 15_000 });
    check("F02: a Cashier is offered the biometric card", await biometric.isVisible());
    const add = biometric.getByRole("button", { name: "افزودن این دستگاه" });
    check("…with registration, in a browser that supports WebAuthn", await add.isVisible());
    if (WEBAUTHN_CEREMONY) {
      await biometric.getByLabel("نام دستگاه (اختیاری)").fill(DEVICE_LABEL);
      await add.click();
      const registered = await until(() => biometric.getByText(DEVICE_LABEL).isVisible(), 20_000);
      check("a credential registers end to end through Chromium's virtual authenticator", Boolean(registered));
    } else {
      notRun.push("WebAuthn registration ceremony (E2E_WEBAUTHN_CEREMONY=0: this browser build has no WebAuthn stack)");
      console.log("  - NOT RUN: the registration ceremony itself (E2E_WEBAUTHN_CEREMONY=0); a device row is inserted instead");
      await db.query(
        `INSERT INTO employee_credentials
           (employee_id, business_id, credential_type, webauthn_credential_id, webauthn_public_key, display_hint)
         VALUES ($1, $2, 'webauthn', $3, 'e2e-public-key', $4)`,
        [cashierId, businessId, `e2e-${Date.now().toString(36)}`, DEVICE_LABEL],
      );
    }

    const unsupportedContext = await browser.newContext(desktop);
    await unsupportedContext.addCookies(await cashierContext.cookies());
    await unsupportedContext.addInitScript(() => {
      // A browser without WebAuthn.
      delete window.PublicKeyCredential;
    });
    const unsupported = await unsupportedContext.newPage();
    await open(unsupported, "/settings/profile");
    const bio2 = card(unsupported, "ورود بیومتریک (اثر انگشت / چهره)");
    await bio2.waitFor({ timeout: 15_000 });
    check("F12: without WebAuthn the registered device is still listed", await bio2.getByText(DEVICE_LABEL).isVisible());
    check("…registration is withheld", (await bio2.getByRole("button", { name: "افزودن این دستگاه" }).count()) === 0);
    check("…and the reason is given", await bio2.getByText(/از ثبت ورود بیومتریک پشتیبانی نمی‌کند/).isVisible());
    const remove = bio2.getByRole("button", { name: "حذف" });
    check("…while removal stays available", await remove.isEnabled());

    await unsupported.route("**/api/auth/webauthn/credentials/**", (route) =>
      route.request().method() === "DELETE" ? route.abort("internetdisconnected") : route.continue(),
    );
    await remove.click();
    await unsupported.getByRole("button", { name: "بله، حذف شود" }).click();
    const removalFailed = await until(() => bio2.getByText(/معلوم نیست دستگاه حذف شده باشد/).isVisible());
    check("F09: a dropped removal says so", Boolean(removalFailed));
    check("…keeps the device on screen", await bio2.getByText(DEVICE_LABEL).isVisible());
    // Same shape as the sign-out retry above: `remove()` says so first, then
    // refreshes the list, and only then clears `busy` in its `finally`. The
    // button is released a round-trip later, so wait for it rather than reading
    // it in the same tick as the message. Still fails if it is never released.
    const removeAgain = bio2.getByRole("button", { name: "حذف" });
    check("…and releases the button", Boolean(await until(() => removeAgain.isEnabled())));
    await unsupported.unroute("**/api/auth/webauthn/credentials/**");
    await bio2.getByRole("button", { name: "حذف" }).click();
    await unsupported.getByRole("button", { name: "بله، حذف شود" }).click();
    const removed = await until(() => bio2.getByText("دستگاه حذف شد.").isVisible());
    check("…and the retry removes it", Boolean(removed));
    await unsupportedContext.close();

    // ======================================================================
    section("4. Cashier — Cloud / Hybrid / Local authority, PIN masking, phone frame");
    // ======================================================================
    for (const profile of ["cloud", "hybrid", "local"]) {
      await setProfile(db, businessId, profile);
      await open(cashier, "/settings/profile");
      if (profile === "hybrid" && SERVER_ROLE === "site") {
        // On a site, Hybrid makes it a *Hybrid site*: every screen that is not
        // the till's — Profile included — is the cloud's (src/lib/site-routes.ts)
        // and is shown as the cloud pane, never as a local copy with forms the
        // site's API would refuse.
        const pane = await until(() => cashier.getByText("این بخش در نسخهٔ ابری است").isVisible());
        check("F11 (hybrid site): Profile is the cloud's screen, shown as the cloud pane", Boolean(pane));
        check(
          "F11 (hybrid site): …with no local credential control at all",
          (await cashier
            .locator(
              'section[aria-label="شمارهٔ موبایل ورود"], section[aria-label="رمز عددی دستگاه"], section[aria-label="تغییر رمز عبور"]',
            )
            .count()) === 0,
        );
        continue;
      }
      if (profile === "hybrid") {
        // On the central server a Hybrid business is not a Hybrid site, so the
        // screen is local and the authority table decides each card: the page
        // must render exactly what the routes enforce (F11), with no form the
        // API would refuse.
        const phoneCard = card(cashier, "شمارهٔ موبایل ورود");
        await phoneCard.waitFor({ timeout: 15_000 });
        await settle(cashier);
        check(
          "F11 (hybrid, central server): the login phone is read-only",
          (await phoneCard.getByRole("button", { name: /ثبت شماره|تغییر شماره|ارسال کد تأیید/ }).count()) === 0,
        );
        check(
          "F11 (hybrid, central server): …and says the cloud manages it",
          await phoneCard.getByText(CLOUD_MANAGED_NOTICE).isVisible(),
        );
        const pinCard = card(cashier, "رمز عددی دستگاه");
        check(
          "F11 (hybrid, central server): the staff PIN stays self-service",
          (await pinCard.getByRole("button", { name: /تغییر رمز عددی|ثبت رمز عددی/ }).count()) > 0,
        );
        continue;
      }
      const phoneCard = card(cashier, "شمارهٔ موبایل ورود");
      await phoneCard.waitFor({ timeout: 15_000 });
      await settle(cashier);
      const hasForm =
        (await phoneCard.getByRole("button", { name: /ثبت شماره|تغییر شماره|ارسال کد تأیید/ }).count()) > 0;
      check(`F11 (${profile}): the login phone is editable`, hasForm);
      const pinCard = card(cashier, "رمز عددی دستگاه");
      check(
        `F11 (${profile}): the staff PIN stays editable`,
        (await pinCard.getByRole("button", { name: /تغییر رمز عددی|ثبت رمز عددی/ }).count()) > 0,
      );
    }
    await setProfile(db, businessId, "cloud");
    await open(cashier, "/settings/profile");
    const pinCard = card(cashier, "رمز عددی دستگاه");
    await pinCard.getByRole("button", { name: /تغییر رمز عددی|ثبت رمز عددی/ }).click();
    const pinInputs = pinCard.locator("input");
    const pinAttrs = await pinInputs.evaluateAll((els) => els.map((e) => [e.type, e.inputMode]));
    check(
      "F08: every PIN field is masked and opens the numeric keyboard",
      pinAttrs.length >= 2 && pinAttrs.every(([type, mode]) => type === "password" && mode === "numeric"),
      JSON.stringify(pinAttrs),
    );

    const phoneContext = await browser.newContext(phone);
    await phoneContext.addCookies(await cashierContext.cookies());
    const mobile = await phoneContext.newPage();
    await open(mobile, "/settings/profile");
    await card(mobile, "مشخصات ورود").waitFor({ timeout: 15_000 });
    check("a 390px phone frame has no horizontal page scroll", await noHorizontalScroll(mobile));
    await mobile.screenshot({ path: join(ARTIFACTS, "cashier-profile-390.png"), fullPage: true });
    await phoneContext.close();
    await cashierContext.close();
    if (ceremonyBrowser !== browser) await ceremonyBrowser.close();

    // ======================================================================
    section("5. The sidebar menu and the /login account switch read the same contract");
    // ======================================================================
    const menuContext = await browser.newContext(desktop);
    await loginOwner(menuContext);
    const menuPage = await menuContext.newPage();
    await open(menuPage, "/settings/profile");
    await menuPage.route("**/api/auth/logout", (route) => route.abort("internetdisconnected"));
    // The sidebar's identity control (a Radix menu trigger), by its own name.
    const trigger = menuPage.locator('button[aria-haspopup="menu"]').filter({ hasText: "مالک نمونه" }).first();
    await trigger.click();
    await menuPage.getByRole("menuitem", { name: "خروج" }).click();
    const toastShown = await until(() => menuPage.getByText(/نشست شما هنوز باز است/).isVisible());
    check("menu: a dropped sign-out is told in a toast", Boolean(toastShown));
    check("menu: …and nothing navigated", menuPage.url().includes("/settings/profile"), menuPage.url());
    await menuPage.unroute("**/api/auth/logout");
    await menuPage.getByRole("button", { name: "تلاش دوباره" }).click();
    const leftForDoor = await until(() => Promise.resolve(menuPage.url().includes("/admin")), 15_000);
    check("menu: the toast's retry signs out and lands on the owner door", Boolean(leftForDoor), menuPage.url());
    await menuContext.close();

    const switchContext = await browser.newContext(desktop);
    await loginOwner(switchContext);
    const switchPage = await switchContext.newPage();
    await switchPage.route("**/api/auth/logout", (route) => route.abort("internetdisconnected"));
    await open(switchPage, "/login?changeAccount=1");
    const switchFailed = await until(() => switchPage.getByText("خروج از حساب قبلی انجام نشد").isVisible());
    check("switch: a dropped revoke is never reported as «حساب قبلی خارج شد»", Boolean(switchFailed));
    check("switch: …the reason is an alert", await switchPage.getByRole("alert").filter({ hasText: "نشست شما هنوز باز است" }).isVisible());
    await switchPage.unroute("**/api/auth/logout");
    await switchPage.getByRole("button", { name: "تلاش دوباره" }).click();
    const switched = await until(() => switchPage.getByText("حساب قبلی خارج شد").isVisible());
    check("switch: the retry ends the previous session", Boolean(switched));
    check("switch: …and its cookie is gone", !(await sessionToken(switchContext)));
    await switchContext.close();
  } finally {
    if (previous[0]) {
      await db.query(
        `UPDATE settings SET value = $2, updated_at = now() WHERE business_id = $1 AND location_id IS NULL AND key = 'deployment.profile'`,
        [businessId, previous[0].value],
      );
    } else {
      await db.query(
        `DELETE FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = 'deployment.profile'`,
        [businessId],
      );
    }
    await db.query(`DROP TRIGGER IF EXISTS e2e_fail_session_audit ON audit_log`).catch(() => {});
    await db.query(`UPDATE users SET location_id = $2 WHERE id = $1`, [
      ownerMembership.id,
      ownerMembership.location_id,
    ]);
    await browser.close();
    await db.end();
  }

  console.log(`\n${failures.length === 0 ? "All profile security checks that ran passed." : `${failures.length} check(s) failed:`}`);
  for (const f of failures) console.log(`  - ${f}`);
  if (notRun.length > 0) {
    console.log(`Not run (${notRun.length}):`);
    for (const n of notRun) console.log(`  - ${n}`);
  }
  // On GitHub Actions, also leave the counts as a check-run annotation, so the
  // result is readable from the API without downloading the job log.
  if (process.env.GITHUB_ACTIONS === "true") {
    const summary =
      `${passed} passed, ${failures.length} failed, ${notRun.length} not run` +
      (WEBAUTHN_CEREMONY ? "; WebAuthn ceremony ran (virtual authenticator)" : "; WebAuthn ceremony NOT run") +
      `; server role ${SERVER_ROLE}` +
      (failures.length ? `; failures: ${failures.join(" | ")}` : "");
    console.log(`::${failures.length === 0 ? "notice" : "error"} title=Profile security E2E::${summary}`);
  }
  console.log(`Screenshots: ${ARTIFACTS}`);
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
