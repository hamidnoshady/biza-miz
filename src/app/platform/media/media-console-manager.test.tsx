// @vitest-environment jsdom
/**
 * The Superadmin media console's error, status and localization behaviour
 * (issue #1080, section 6).
 *
 * Every case here is a defect a code review found in the shipped page:
 *
 *  • a failed initial load left `config` null and the page on skeleton rows
 *    forever, with no error and no way to retry;
 *  • the connection test rendered only a `detail` field, so an incomplete
 *    configuration or a body with no detail said nothing at all;
 *  • the reconciliation row read `youngSkippedCount` / `unscopedCount` — fields
 *    the API does not return — and printed the literal `undefined`;
 *  • audit actions and statuses (`migration_completed`, `config_saved`, `ok`)
 *    were printed as raw English codes;
 *  • an empty library rendered as «۱ کیلوبایت» because the formatter floored at
 *    one kilobyte.
 *
 * The page is rendered for real against a stubbed `fetch`; nothing is mocked
 * except the capability list (so the buttons are not disabled).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../ui", async () => {
  const actual = await vi.importActual<typeof import("../ui")>("../ui");
  return { ...actual, useCan: () => () => true };
});

import { MediaConsoleManager } from "./media-console-manager";

const CONFIG = {
  enabled: true,
  endpoint: "https://s3.parspack.com",
  region: "ir-thr-at1",
  bucket: "media-bucket",
  keyPrefix: "media/",
  accessKeyId: "AKIA_TEST",
  secretAccessKeySet: true,
  billingEnabled: false,
  dailyFlatRial: 0,
  dailyPerGbRial: 0,
  freeQuotaMb: 0,
  enhanceModel: "gpt-image-1",
  enhancePriceRial: 0,
};

function overview(over: Record<string, unknown> = {}) {
  return {
    config: CONFIG,
    usage: { businesses: 0, assets: 0, bytes: 0 },
    canRollback: false,
    previousStorage: null,
    migrations: [],
    orphanScans: [],
    migrationState: "idle",
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

function routeFetch(handlers: { overview: () => Response | Promise<Response>; test?: () => Response | Promise<Response> }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("/api/platform/media/test")) {
      if (!handlers.test) throw new Error("unexpected connection test call");
      return handlers.test();
    }
    return handlers.overview();
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/platform/media — loading and recovery", () => {
  it("shows an error with a Retry action when the initial load fails (not an endless skeleton)", async () => {
    let calls = 0;
    routeFetch({
      overview: () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ error: "server_error" }, 500) : jsonResponse(overview());
      },
    });
    render(<MediaConsoleManager />);

    const retry = await screen.findByRole("button", { name: "تلاش دوباره" });
    expect(screen.getByText(/خواندن تنظیمات فضای ذخیره‌سازی ناموفق بود/)).toBeTruthy();

    await userEvent.click(retry);
    // The retry really re-fetches and the page recovers.
    expect(await screen.findByText(/اتصال فضای ذخیره‌سازی/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "تلاش دوباره" })).toBeNull();
  });

  it("renders an empty library as «۰ بایت», never as 1 kilobyte", async () => {
    routeFetch({ overview: () => jsonResponse(overview()) });
    render(<MediaConsoleManager />);

    await screen.findByText(/اتصال فضای ذخیره‌سازی/);
    expect(screen.getByText(`۰ بایت`)).toBeTruthy();
    expect(screen.queryByText(/۱ کیلوبایت/)).toBeNull();
  });
});

describe("/platform/media — connection test reporting", () => {
  it("renders the server's sentence, the support reference and the failing step", async () => {
    routeFetch({
      overview: () => jsonResponse(overview()),
      test: () =>
        jsonResponse(
          {
            ok: false,
            error: "storage_credentials_rejected",
            message: "سرویس ذخیره‌سازی ابری کلید دسترسی را نپذیرفت. این مورد باید توسط مدیر پلتفرم اصلاح شود؛ فایل شما ثبت نشد.",
            reference: "media-ref-42",
            steps: [
              { id: "config", label: "خواندن پیکربندی ذخیره‌شده", ok: true, providerStatus: null, providerCode: null, detail: null },
              {
                id: "buffered_write",
                label: "نوشتن آزمایشی حجم کوچک در باکت",
                ok: false,
                providerStatus: 403,
                providerCode: "SignatureDoesNotMatch",
                detail: "upload …",
              },
            ],
            capabilities: { write: false, readBack: false, integrity: false, streamedUpload: false, delete: false },
          },
          502,
        ),
    });
    render(<MediaConsoleManager />);
    await screen.findByText(/اتصال فضای ذخیره‌سازی/);

    await userEvent.click(screen.getByRole("button", { name: "آزمایش اتصال" }));

    expect(await screen.findByText(/کلید دسترسی را نپذیرفت/)).toBeTruthy();
    expect(screen.getByText("کد پیگیری: media-ref-42")).toBeTruthy();
    expect(screen.getByText("نوشتن آزمایشی حجم کوچک در باکت")).toBeTruthy();
    expect(screen.getByText(/پاسخ سرویس: ۴۰۳|پاسخ سرویس: 403/)).toBeTruthy();
  });

  it("explains an incomplete configuration even when the failure has no detail field", async () => {
    routeFetch({
      overview: () => jsonResponse(overview()),
      test: () => jsonResponse({ ok: false, error: "incomplete_config" }, 400),
    });
    render(<MediaConsoleManager />);
    await screen.findByText(/اتصال فضای ذخیره‌سازی/);

    await userEvent.click(screen.getByRole("button", { name: "آزمایش اتصال" }));

    expect(await screen.findByText(/پیکربندی ذخیره‌سازی کامل نیست/)).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("reports a fully verified connection with the tested capabilities", async () => {
    routeFetch({
      overview: () => jsonResponse(overview()),
      test: () =>
        jsonResponse({
          ok: true,
          testedSavedConfiguration: true,
          message: "اتصال سالم است.",
          reference: "media-ref-ok",
          steps: [
            { id: "config", label: "خواندن پیکربندی ذخیره‌شده", ok: true, providerStatus: null, providerCode: null, detail: null },
          ],
          capabilities: { write: true, readBack: true, integrity: true, streamedUpload: true, delete: true },
        }),
    });
    render(<MediaConsoleManager />);
    await screen.findByText(/اتصال فضای ذخیره‌سازی/);

    await userEvent.click(screen.getByRole("button", { name: "آزمایش اتصال" }));

    expect(await screen.findByText(/آزمایش اتصال موفق بود/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/قابلیت‌های تأییدشده/)).toBeTruthy());
    // The capability summary and the step list both mention it; either is fine.
    expect(screen.getAllByText(/بارگذاری جریانی بیش از ۱ مگابایت/).length).toBeGreaterThan(0);
  });
});

describe("/platform/media — reconciliation and audit history", () => {
  it("renders the reconciliation numbers without ever printing `undefined`", async () => {
    routeFetch({
      overview: () =>
        jsonResponse(
          overview({
            orphanScans: [
              {
                id: "scan-1",
                mode: "manual_scan",
                status: "alert",
                scannedObjects: 20,
                dbKeysCount: 18,
                orphanCount: 2,
                orphanBytes: 4096,
                youngSkipped: 3,
                prefixSkipped: 1,
                deletedCount: 0,
                oldestOrphanAt: null,
                sampleKeys: [],
                errorDetail: null,
                createdAt: "2026-10-20T00:00:00.000Z",
              },
            ],
          }),
        ),
    });
    render(<MediaConsoleManager />);
    await screen.findByText(/اتصال فضای ذخیره‌سازی/);

    expect(screen.getByText(/نیازمند بررسی/)).toBeTruthy();
    expect(screen.getAllByText(/۳/).length).toBeGreaterThan(0);
    expect(screen.getByText(/کلید خارج از ساختار شناسهٔ کسب‌وکار/)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain("undefined");
  });

  it("translates audit actions/statuses and marks a stale `running` row as interrupted", async () => {
    routeFetch({
      overview: () =>
        jsonResponse(
          overview({
            migrationState: "idle",
            migrations: [
              {
                id: "m1",
                actorEmail: "root@bizamiz.test",
                action: "migration_completed",
                status: "completed",
                totalAssets: 12,
                copiedAssets: 12,
                verifiedAssets: 12,
                totalBytes: 2048,
                errorDetail: null,
                createdAt: "2026-10-19T00:00:00.000Z",
                completedAt: "2026-10-19T00:05:00.000Z",
              },
              {
                id: "m2",
                actorEmail: "root@bizamiz.test",
                action: "migration_started",
                status: "running",
                totalAssets: 12,
                copiedAssets: 0,
                verifiedAssets: 0,
                totalBytes: 2048,
                errorDetail: null,
                createdAt: "2026-10-18T00:00:00.000Z",
                completedAt: null,
              },
              {
                id: "m3",
                actorEmail: "root@bizamiz.test",
                action: "config_saved",
                status: "completed",
                totalAssets: 0,
                copiedAssets: 0,
                verifiedAssets: 0,
                totalBytes: 0,
                errorDetail: null,
                createdAt: "2026-10-17T00:00:00.000Z",
                completedAt: null,
              },
            ],
          }),
        ),
    });
    render(<MediaConsoleManager />);
    await screen.findByText(/اتصال فضای ذخیره‌سازی/);

    expect(screen.getByText("پایان موفق مهاجرت")).toBeTruthy();
    expect(screen.getByText("ذخیرهٔ تنظیمات اتصال")).toBeTruthy();
    // A `running` row with no active migration is history, not progress.
    expect(screen.getByText(/ناتمام — فرایند متوقف شده است/)).toBeTruthy();
    // Raw codes never reach the operator.
    expect(document.body.textContent ?? "").not.toContain("migration_completed");
    expect(document.body.textContent ?? "").not.toContain("config_saved");
  });
});
