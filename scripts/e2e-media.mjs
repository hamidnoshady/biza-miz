/**
 * End-to-end coverage for the canonical Media Library — the one part of the
 * mandated test pyramid (unit / integration / E2E / permission / mobile /
 * RTL / a11y) this program had never actually attempted for Media. Every
 * layer below this one is unit or integration (a real database, but no real
 * browser); this is the first suite that drives the real rendered UI in a
 * real Chromium the way an operator actually would.
 *
 * Scope, deliberately: not "every Media feature" (that is what the unit and
 * RTL suites already pin) but the handful of flows that can *only* be proven
 * by an actual browser doing actual multi-step interaction against a real
 * server and a real database:
 *
 *  1. Upload → tag → search-by-tag — the core library lifecycle.
 *  2. Move an asset into a new folder via the folder tree, not a mock.
 *  3. Soft-delete → trash → restore — the safe-delete round trip.
 *  4. The *universal* Media Picker, exercised from a second, unrelated app
 *     (CRM's party form): an existing Library asset is *reused*, not
 *     re-uploaded — the concrete, end-to-end proof of "one canonical
 *     library, no per-app pickers" rather than a unit test asserting the
 *     same component is merely imported in two places.
 *  5. The named permission bug, exercised as the actual under-privileged
 *     role: a PIN-login Cashier (menu.view, no media.view) loads a real POS
 *     page and the browser's own network layer proves the photo's
 *     `/api/media/[id]/file` request came back 200 — not inferred from a
 *     mocked permission check, and not silently accepted from the DOM (this
 *     app's own `MenuItemImage` swallows a failed image into a placeholder
 *     icon by design, so only the actual HTTP response tells the truth).
 *
 * Every step throws with a specific, actionable message on failure — no step
 * swallows an error to "keep going" through the rest of the script, because
 * a false green here is worse than a red one: this suite exists to catch
 * exactly the class of bug (a real UI/permission wiring mistake) that no
 * amount of mocked-fetch unit testing can.
 *
 * Requires a running production server (see the `visual-regression`-style CI
 * job / `npm run test:visual`'s own setup) seeded with `npm run db:seed`
 * (owner + sample Cashier, PIN 1234) — nothing else. Idempotent: every
 * created row is uniquely named per run (a millisecond timestamp), so
 * re-running against a server that already has prior runs' leftovers does
 * not collide or need cleanup.
 *
 * Usage: node scripts/e2e-media.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "pg";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required (points this script at the same database the server under test uses).");
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const BUSINESS_SLUG = process.env.SEED_BUSINESS_SLUG ?? "cafe-nemoone";
// scripts/seed.ts's fixed sample Cashier PIN — floor-staff role, no media.view.
const CASHIER_PIN = "1234";

const RUN_ID = Date.now().toString(36);
const FILE_NAME = `e2e-media-${RUN_ID}.png`;
const FOLDER_NAME = `پوشهٔ E2E ${RUN_ID}`;
const TAG_TEXT = `e2e-tag-${RUN_ID}`;
const PARTY_NAME = `مشتری E2E ${RUN_ID}`;
const CATEGORY_NAME = `دستهٔ E2E ${RUN_ID}`;
const ITEM_NAME = `آیتم E2E ${RUN_ID}`;

// A genuine, tiny, valid PNG (1×1, transparent) — real magic bytes and a
// real IHDR/IDAT/IEND chain, not a text file wearing a `.png` extension, so
// it passes byte-signature validation and sharp's dimension probe like any
// real upload would.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const contextOptions = {
  viewport: { width: 1360, height: 900 },
  locale: "fa-IR",
  timezoneId: "Asia/Tehran",
  reducedMotion: "reduce",
};

function log(step, message) {
  console.log(`[e2e-media] ${step}: ${message}`);
}

function fail(step, message) {
  throw new Error(`[e2e-media] ${step}: ${message}`);
}

/**
 * The same three-condition "loaded, not racing it" wait `visual-regression.mjs`
 * uses: the app holds an open WebSocket, so `networkidle` never fires, and a
 * page whose data arrives in two waves can paint once, look done, and then
 * change under the test.
 */
async function waitSettled(page) {
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
      { timeout: 20_000, polling: 150 },
    )
    .catch(() => {});
}

async function goto(page, path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
  await waitSettled(page);
}

/** Waits for the debounced search/filter effect (300ms in every screen that has one) to settle. */
async function waitDebounce(page) {
  await page.waitForTimeout(500);
  await waitSettled(page);
}

/**
 * A path-style S3 mock — PUT/GET/DELETE /{bucket}/{key...} — identical in
 * shape to the one `integration/media-library.integration.test.ts` already
 * proved correct against this app's own `s3-lite` SigV4 client. The Media
 * Library's "بارگذاری فایل" control is disabled whenever
 * `platform_media_config` is not `enabled` with a real endpoint/bucket/keys
 * (`isMediaStorageReady`, src/lib/media-service.ts) — a real browser upload
 * needs a real (if fake) bucket behind it, not a mocked fetch.
 */
function startMockS3(bucket) {
  const objects = new Map();
  const server = createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "").replace(new RegExp(`^/${bucket}/`), "").split("?")[0]);
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    if (req.method === "GET") {
      const body = objects.get(key);
      if (!body) {
        res.statusCode = 404;
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.statusCode = 200;
      res.end(body);
      return;
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  // ---- Point the running server's Media Library at a real (fake) bucket ---
  const bucket = "media-e2e";
  const { server: s3Server, port: s3Port } = await startMockS3(bucket);
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query(
    `UPDATE platform_media_config SET
       enabled = true, endpoint = $1, region = 'us-east-1', bucket = $2, key_prefix = 'media/',
       access_key_id = 'e2e-access', secret_access_key = 'e2e-secret', updated_at = now()
     WHERE id = true`,
    [`http://127.0.0.1:${s3Port}`, bucket],
  );
  log("storage", `platform_media_config pointed at an in-process mock S3 on 127.0.0.1:${s3Port}`);

  const executablePath = process.env.VISUAL_CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    args: executablePath ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [],
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "e2e-media-"));
  const uploadPath = join(tmpDir, FILE_NAME);
  writeFileSync(uploadPath, Buffer.from(PNG_BASE64, "base64"));

  const ownerContext = await browser.newContext(contextOptions);
  // Every confirm() in the Media manager (trash, permanent delete) must be
  // accepted for this script's flows to proceed — a headless browser
  // dismisses an unhandled dialog by default, which would silently no-op
  // the action rather than fail loudly, so this is registered once, up front.
  ownerContext.on("page", (page) => page.on("dialog", (dialog) => dialog.accept()));

  try {
    // ---- Auth: owner session, the same way visual-regression.mjs logs in ----
    const login = await ownerContext.request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
    });
    if (!login.ok()) {
      fail("auth", `owner login failed (${login.status()}) — is the seeded database up?`);
    }
    log("auth", "owner session established");

    const page = await ownerContext.newPage();
    page.on("dialog", (dialog) => dialog.accept());

    // ======================================================================
    // 1. Upload, tag, and search by tag
    // ======================================================================
    await goto(page, "/media");
    if (!page.url().includes("/media")) fail("upload", `expected to land on /media, got ${page.url()}`);

    await page.getByRole("button", { name: "بارگذاری فایل", exact: true }).click();
    await page.locator('input[type="file"]').first().setInputFiles(uploadPath);
    await page.locator(`button:has-text("${FILE_NAME}")`).first().waitFor({ timeout: 20_000 });
    log("upload", `«${FILE_NAME}» appeared in the library grid after a real multipart upload`);

    // Open the asset's edit drawer and give it a unique tag.
    await page.locator(`button:has-text("${FILE_NAME}")`).first().click();
    const drawer = page.locator('[role="dialog"]');
    await drawer.getByLabel("برچسب‌ها").fill(TAG_TEXT);
    await drawer.getByRole("button", { name: "ذخیره", exact: true }).click();
    await drawer.getByText("تغییرات ذخیره شد.").waitFor({ timeout: 10_000 });
    await drawer.getByRole("button", { name: "بستن", exact: true }).click();
    log("tag", `tag «${TAG_TEXT}» saved on the asset`);

    // Search must actually find it by the tag text — not just by file name —
    // proving the search really spans the tags field, not only the name.
    await page.getByPlaceholder("جست‌وجو در نام، دسته، برچسب و توضیح…").fill(TAG_TEXT);
    await waitDebounce(page);
    await page.locator(`button:has-text("${FILE_NAME}")`).first().waitFor({ timeout: 10_000 });
    log("search", `search by tag text «${TAG_TEXT}» found the asset`);
    await page.getByPlaceholder("جست‌وجو در نام، دسته، برچسب و توضیح…").fill("");
    await waitDebounce(page);

    // ======================================================================
    // 2. Folder move, via the real folder tree — not a mocked API call
    // ======================================================================
    await page.getByRole("button", { name: "پوشهٔ جدید", exact: true }).click();
    await page.getByLabel("پوشهٔ جدید در ریشه", { exact: true }).fill(FOLDER_NAME);
    await page.getByRole("button", { name: "ساخت", exact: true }).click();
    const tree = page.getByRole("list", { name: "درخت پوشه‌ها" });
    await tree.getByText(FOLDER_NAME).waitFor({ timeout: 10_000 });
    log("folder", `folder «${FOLDER_NAME}» created`);

    await page.locator(`button:has-text("${FILE_NAME}")`).first().click();
    await drawer.getByLabel("پوشه").selectOption({ label: FOLDER_NAME });
    await drawer.getByRole("button", { name: "ذخیره", exact: true }).click();
    await drawer.getByText("تغییرات ذخیره شد.").waitFor({ timeout: 10_000 });
    await drawer.getByRole("button", { name: "بستن", exact: true }).click();

    // Selecting "همهٔ فایل‌ها" then the new folder proves the move is real:
    // the asset must disappear from "root only" and appear under the folder.
    await tree.getByText("ریشه (بدون پوشه)").click();
    await waitDebounce(page);
    const inRootAfterMove = await page
      .locator(`button:has-text("${FILE_NAME}")`)
      .first()
      .isVisible()
      .catch(() => false);
    if (inRootAfterMove) fail("folder", "asset still listed under root after being moved into a folder");
    await tree.getByText(FOLDER_NAME).click();
    await waitDebounce(page);
    await page.locator(`button:has-text("${FILE_NAME}")`).first().waitFor({ timeout: 10_000 });
    log("folder", "asset confirmed moved: absent from root, present inside the new folder");
    await tree.getByText("همهٔ فایل‌ها").click();
    await waitDebounce(page);

    // ======================================================================
    // 3. Soft-delete → trash → restore
    // ======================================================================
    await page.locator(`button:has-text("${FILE_NAME}")`).first().click();
    await drawer.getByRole("button", { name: "انتقال به سطل زباله", exact: true }).click();
    await page.locator('[role="dialog"]').waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
    await waitDebounce(page);
    const inLibraryAfterTrash = await page
      .locator(`button:has-text("${FILE_NAME}")`)
      .first()
      .isVisible()
      .catch(() => false);
    if (inLibraryAfterTrash) fail("trash", "asset still visible in the library after being sent to trash");

    await page.getByRole("button", { name: "سطل زباله", exact: true }).click();
    await waitDebounce(page);
    await page.locator(`button:has-text("${FILE_NAME}")`).first().waitFor({ timeout: 10_000 });
    log("trash", "asset confirmed in the trash view after soft-delete");

    await page
      .locator(`div:has(> button:has-text("${FILE_NAME}"))`)
      .getByRole("button", { name: "بازیابی", exact: true })
      .click();
    await waitDebounce(page);
    const stillInTrash = await page
      .locator(`button:has-text("${FILE_NAME}")`)
      .first()
      .isVisible()
      .catch(() => false);
    if (stillInTrash) fail("trash", "asset still listed in trash after restore");
    await page.getByRole("button", { name: "کتابخانه", exact: true }).click();
    await waitDebounce(page);
    await page.locator(`button:has-text("${FILE_NAME}")`).first().waitFor({ timeout: 10_000 });
    log("trash", "asset confirmed restored back into the live library");

    // ======================================================================
    // 4. Universal Media Picker, exercised from a second app (CRM)
    // ======================================================================
    await goto(page, "/crm/directory");
    await page.getByRole("button", { name: /^افزودن/ }).click();
    const partyDialog = page.locator('[role="dialog"], form').filter({ hasText: "نام" }).first();
    await page.getByLabel("نام", { exact: true }).first().fill(PARTY_NAME);
    await page.getByLabel("نام خانوادگی", { exact: true }).first().fill("E2E");

    await page.getByRole("button", { name: "انتخاب از کتابخانه", exact: true }).click();
    const picker = page.locator('[role="dialog"]').filter({ hasText: "جست‌وجو در تصاویر کتابخانه" });
    await picker.getByPlaceholder("جست‌وجو در تصاویر کتابخانه…").fill(FILE_NAME);
    await waitDebounce(page);
    await picker.locator(`button[title="${FILE_NAME}"]`).click();
    await page.getByRole("button", { name: "تغییر تصویر", exact: true }).waitFor({ timeout: 10_000 });
    log("picker", "CRM party form picked the EXISTING Library asset — no second upload happened");

    await page.getByRole("button", { name: "ذخیره", exact: true }).click();
    await page.getByText(PARTY_NAME).first().waitFor({ timeout: 10_000 });
    log("picker", `party «${PARTY_NAME}» saved with the reused Media Library asset as its avatar`);
    void partyDialog; // kept for readability of intent above; not asserted further

    // ======================================================================
    // 5. The named permission bug: a menu photo, rendered as a real Cashier
    // ======================================================================
    await goto(page, "/settings/menu");
    await page.getByLabel("نام دسته", { exact: true }).fill(CATEGORY_NAME);
    await page.getByRole("button", { name: "افزودن", exact: true }).click();
    await waitDebounce(page);

    await page.getByRole("button", { name: "دسته را انتخاب کنید…", exact: true }).click();
    await page.getByRole("option", { name: CATEGORY_NAME, exact: true }).click();
    await page.getByLabel("نام آیتم", { exact: true }).fill(ITEM_NAME);
    await page.getByLabel(/قیمت/).fill("100000");
    await page.getByRole("button", { name: "انتخاب از کتابخانه", exact: true }).click();
    const itemPicker = page.locator('[role="dialog"]').filter({ hasText: "جست‌وجو در تصاویر کتابخانه" });
    await itemPicker.getByPlaceholder("جست‌وجو در تصاویر کتابخانه…").fill(FILE_NAME);
    await waitDebounce(page);
    await itemPicker.locator(`button[title="${FILE_NAME}"]`).click();
    await page.getByRole("button", { name: "افزودن آیتم", exact: true }).click();
    await page.getByText(ITEM_NAME).first().waitFor({ timeout: 10_000 });
    log("permission-setup", `menu item «${ITEM_NAME}» created with the Library asset as its photo`);

    // A fresh, unrelated context: a floor-staff PIN login, not the owner's
    // session. This role has menu.view but deliberately NOT media.view
    // (src/lib/permissions.ts) — the exact gap the named bug was about.
    const cashierContext = await browser.newContext(contextOptions);
    const pinLogin = await cashierContext.request.post(`${BASE_URL}/api/auth/pin-login`, {
      data: { pin: CASHIER_PIN, businessSlug: BUSINESS_SLUG },
    });
    if (!pinLogin.ok()) {
      fail(
        "permission",
        `Cashier PIN login failed (${pinLogin.status()}): ${await pinLogin.text()} — ` +
          "is scripts/seed.ts's sample Cashier (PIN 1234) present?",
      );
    }
    const pinBody = await pinLogin.json().catch(() => ({}));
    if (pinBody && pinBody.phoneVerification) {
      fail(
        "permission",
        "Cashier PIN login returned a phone-OTP challenge instead of a session " +
          `(${pinBody.phoneVerification}) — this business has phone-OTP enforcement ` +
          "enabled, which the seeded fixture does not expect; this is an environment " +
          "difference, not a Media bug, but it blocks this step from running.",
      );
    }
    log("permission", "Cashier session established via PIN login (no media.view permission)");

    // Collected rather than raced: the POS screen may also request other
    // authorized images (a business logo, another item's photo) through the
    // same route, and any one of them failing is just as real a regression
    // in the same usage-based authorization code path — this asserts on all
    // of them, not just whichever happens to resolve first.
    const mediaFileResponses = [];
    const cashierPage = await cashierContext.newPage();
    cashierPage.on("response", (response) => {
      if (/\/api\/media\/[^/]+\/file(\?|$)/.test(response.url())) {
        mediaFileResponses.push({ url: response.url(), status: response.status() });
      }
    });
    await cashierPage.goto(`${BASE_URL}/accounting/pos`, { waitUntil: "domcontentloaded" });
    await waitSettled(cashierPage);
    // Images are `loading="lazy"`; give any still-off-screen ones a moment to
    // fire before deciding none arrived.
    await cashierPage.waitForTimeout(1_500);

    if (mediaFileResponses.length === 0) {
      fail(
        "permission",
        "the Cashier's POS screen never requested /api/media/[id]/file for the " +
          `photographed item «${ITEM_NAME}» — the image was not rendered at all, so the ` +
          "permission path this step exists to check was never exercised.",
      );
    }
    const failedResponses = mediaFileResponses.filter((r) => r.status !== 200);
    if (failedResponses.length > 0) {
      fail(
        "permission",
        "the Cashier's own browser received a non-200 response for a menu photo it should " +
          "be authorized to see — this IS the named permission bug (a floor-staff role " +
          `without media.view must still render a menu item's own authorized image): ${JSON.stringify(failedResponses)}`,
      );
    }
    log(
      "permission",
      `REGRESSION CONFIRMED FIXED: Cashier (menu.view, no media.view) received HTTP 200 for ` +
        `${mediaFileResponses.length} authorized image request(s) on the real POS screen`,
    );
    await cashierContext.close();

    console.log("\n[e2e-media] ALL STEPS PASSED\n");
  } finally {
    await ownerContext.close();
    await browser.close();
    await new Promise((resolve) => s3Server.close(resolve));
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
