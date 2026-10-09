// @vitest-environment jsdom
/**
 * The system health dashboard's migration block — the part the production
 * incident was about.
 *
 * `/platform/system` used to show one generic "running code is ahead of the
 * database, run npm run db:migrate" warning for every pending migration, which
 * is wrong for the deliberately deferred `0209_ai_gateway_secret_cutover.sql`
 * (a bare `db:migrate` defers it again) and actively misleading for an
 * unreadable migration inventory (which used to render as zero pending).
 *
 * These tests render the real page against the real API contract and assert the
 * distinct operator guidance for each state, that the dashboard stays read-only
 * (no migration or credential-cleanup button), and that a stale response can
 * never overwrite a newer one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SystemPage from "./page";
import { buildMigrationStatus } from "@/lib/migration-status-service";

const CUTOVER = "0209_ai_gateway_secret_cutover.sql";

function status(overrides: Parameters<typeof buildMigrationStatus>[0]) {
  return buildMigrationStatus({
    now: new Date("2026-10-08T10:00:00.000Z"),
    ...overrides,
  });
}

function baseDb(secretsStored: boolean) {
  return {
    secretsStored,
    legacyColumnsPresent: secretsStored,
    rowsMissingCiphertext: 0,
    legacyPlaintextRows: secretsStored ? 2 : 0,
  };
}

/** Minimal `/api/platform/system` payload with the given migration status. */
function payload(migrationStatus: unknown) {
  return {
    status: {
      migrations: [],
      pendingMigrations: (migrationStatus as { pendingTotal: number | null }).pendingTotal,
      migrationStatus,
      pool: { total: 4, idle: 2, waiting: 0 },
      rlsEffective: true,
      backups: [],
      platformBackup: null,
      counts: { businesses: 1, platformUsers: 2, platformAdmins: 1 },
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function respondWith(body: unknown) {
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
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

describe("/platform/system migration states", () => {
  it("shows a skeleton while the first load is in flight", async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify(payload(status({ files: [], applied: new Map(), cutoverDatabase: baseDb(false) }))), {
                  status: 200,
                }),
              ),
            5,
          );
        }),
    );
    render(<SystemPage />);
    expect(await screen.findByLabelText("در حال بارگذاری وضعیت سامانه")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("سیستم")).toBeTruthy());
  });

  it("explains the gated cutover and never offers to run the migration", async () => {
    respondWith(
      payload(
        status({
          files: ["0208_x.sql", CUTOVER],
          applied: new Map([["0208_x.sql", "2026-09-01T00:00:00.000Z"]]),
          cutoverDatabase: baseDb(true),
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() =>
      expect(screen.getByText("پاک‌سازی کلیدهای قدیمی هوش مصنوعی در انتظار تأیید است")).toBeTruthy(),
    );
    // The filename is shown, LTR and wrapped, and never as a bare number.
    expect(screen.getByText(CUTOVER)).toBeTruthy();
    expect(screen.getByText(CUTOVER).getAttribute("dir")).toBe("ltr");
    // The next required action is the verification sequence, not db:migrate.
    expect(screen.getByText("npm run db:encrypt-ai-secrets -- --dry-run")).toBeTruthy();
    expect(screen.getByText("npm run db:encrypt-ai-secrets -- --verify-only")).toBeTruthy();
    expect(
      screen.getByText(
        "AI_GATEWAY_SECRET_CUTOVER_DEFER=false AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true npm run db:migrate",
      ),
    ).toBeTruthy();
    // Read-only: no browser-side migration or credential cleanup control.
    expect(screen.queryByRole("button", { name: /اجرای مهاجرت/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /پاک‌سازی کلید/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /حذف کلید/ })).toBeNull();
    // …and a link to the existing AI diagnostics instead.
    expect(screen.getByRole("link", { name: /مشاهدهٔ وضعیت اتصال و کلیدهای هوش مصنوعی/ }).getAttribute("href")).toBe(
      "/platform/ai",
    );
  });

  it("keeps the schema warning for an ordinary pending migration", async () => {
    respondWith(
      payload(
        status({
          files: ["0001_a.sql", "0002_b.sql"],
          applied: new Map([["0001_a.sql", "2026-09-01T00:00:00.000Z"]]),
          cutoverDatabase: baseDb(false),
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() => expect(screen.getByText(/مهاجرت هنوز روی پایگاه‌داده اعمال/)).toBeTruthy());
    expect(screen.getByText("npm run db:migrate")).toBeTruthy();
    // The cutover guidance must not appear for an ordinary pending migration.
    expect(screen.queryByText(/پاک‌سازی کلیدهای قدیمی هوش مصنوعی در انتظار تأیید است/)).toBeNull();
  });

  it("shows both categories separately when they are mixed", async () => {
    respondWith(
      payload(
        status({
          files: ["0208_x.sql", CUTOVER, "0210_a.sql", "0211_b.sql"],
          applied: new Map([["0208_x.sql", "2026-09-01T00:00:00.000Z"]]),
          cutoverDatabase: baseDb(true),
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() =>
      expect(screen.getByText("پاک‌سازی کلیدهای قدیمی هوش مصنوعی در انتظار تأیید است")).toBeTruthy(),
    );
    expect(screen.getByText(/مهاجرت هنوز روی پایگاه‌داده اعمال/)).toBeTruthy();
    expect(screen.getByText("0210_a.sql")).toBeTruthy();
    expect(screen.getByText("0211_b.sql")).toBeTruthy();
    expect(screen.getByText(CUTOVER)).toBeTruthy();
  });

  it("reports an unreadable inventory as unknown, not as zero pending", async () => {
    respondWith(
      payload(
        status({
          files: null,
          applied: null,
          cutoverDatabase: {
            secretsStored: null,
            legacyColumnsPresent: null,
            rowsMissingCiphertext: null,
            legacyPlaintextRows: null,
          },
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() => expect(screen.getByText("وضعیت مهاجرت‌ها نامشخص است.")).toBeTruthy());
    expect(screen.queryByText(/مهاجرت هنوز روی پایگاه‌داده اعمال/)).toBeNull();
    expect(screen.queryByText("npm run db:encrypt-ai-secrets -- --dry-run")).toBeNull();
    // It still shows the ordinary command as the operator's next check.
    expect(screen.getAllByText("npm run db:migrate").length).toBeGreaterThan(0);
  });

  it("reports conflicting defer/verification settings", async () => {
    respondWith(
      payload(
        status({
          files: [CUTOVER],
          applied: new Map(),
          cutoverDatabase: baseDb(true),
          flags: { defer: true, verified: true, conflict: true },
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() =>
      expect(screen.getByText("تناقض در تنظیمات مهاجرت کلید هوش مصنوعی")).toBeTruthy(),
    );
    expect(screen.getByText(/هر دو تنظیم AI_GATEWAY_SECRET_CUTOVER_DEFER/)).toBeTruthy();
  });

  it("reports a later migration that blocks the deferral", async () => {
    respondWith(
      payload(
        status({
          files: [CUTOVER, "0210_reads_master_key.sql"],
          applied: new Map(),
          cutoverDatabase: baseDb(true),
          blockedBy: "0210_reads_master_key.sql",
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() => expect(screen.getByText("یک مهاجرت بعدی به ستون قدیدی وابسته است")).toBeTruthy());
    // Named twice on purpose: once as the blocking migration, once as its row.
    expect(screen.getAllByText("0210_reads_master_key.sql").length).toBeGreaterThan(0);
  });

  it("reports a completed cutover with no warning", async () => {
    respondWith(
      payload(
        status({
          files: ["0183_ai_gateway_hardening.sql", CUTOVER],
          applied: new Map([
            ["0183_ai_gateway_hardening.sql", "2026-09-01T00:00:00.000Z"],
            [CUTOVER, "2026-09-05T00:00:00.000Z"],
          ]),
          cutoverDatabase: baseDb(false),
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() =>
      expect(screen.getByText("همهٔ مهاجرت‌های این نسخه روی پایگاه‌داده اعمال شده‌اند.")).toBeTruthy(),
    );
    expect(screen.queryByText(/پاک‌سازی کلیدهای قدیمی هوش مصنوعی در انتظار تأیید است/)).toBeNull();
    expect(screen.queryByText(/مهاجرت هنوز روی پایگاه‌داده اعمال/)).toBeNull();
  });

  it("shows the last successful application timestamp", async () => {
    respondWith(
      payload(
        status({
          files: ["0001_a.sql"],
          applied: new Map([["0001_a.sql", "2026-09-01T00:00:00.000Z"]]),
          cutoverDatabase: baseDb(false),
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() => expect(screen.getByText(/آخرین مهاجرت موفق:/)).toBeTruthy());
  });
});

describe("/platform/system refresh behaviour", () => {
  it("keeps the last successful data visible when a background refresh fails", async () => {
    respondWith(
      payload(
        status({
          files: ["0001_a.sql", "0002_b.sql"],
          applied: new Map([["0001_a.sql", "2026-09-01T00:00:00.000Z"]]),
          cutoverDatabase: baseDb(false),
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() => expect(screen.getByText(/مهاجرت هنوز روی پایگاه‌داده اعمال/)).toBeTruthy());

    // The next refresh fails: the page must keep showing what it last knew
    // rather than blanking, and must say that the data is stale.
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: "server_error" }), { status: 500 }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /تازه‌سازی/ }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(screen.getByText(/مهاجرت هنوز روی پایگاه‌داده اعمال/)).toBeTruthy();
    expect(screen.getByText(/نمایش آخرین وضعیت موفق/)).toBeTruthy();
  });

  it("never lets an older response overwrite a newer one", async () => {
    respondWith(
      payload(
        status({
          files: ["0001_a.sql", "0002_b.sql"],
          applied: new Map([["0001_a.sql", "2026-09-01T00:00:00.000Z"]]),
          cutoverDatabase: baseDb(false),
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() => expect(screen.getByText(/مهاجرت هنوز روی پایگاه‌داده اعمال/)).toBeTruthy());

    // The first refresh is held open: its response arrives only after a newer
    // one has already been rendered.
    let releaseOlder: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseOlder = resolve;
        }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /تازه‌سازی/ }));
    });

    // The second refresh resolves immediately with a different (newer) state.
    respondWith(
      payload(
        status({
          files: ["0001_a.sql"],
          applied: new Map([["0001_a.sql", "2026-09-01T00:00:00.000Z"]]),
          cutoverDatabase: baseDb(false),
        }),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /تازه‌سازی/ }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText("همهٔ مهاجرت‌های این نسخه روی پایگاه‌داده اعمال شده‌اند.")).toBeTruthy();

    // The held-open older response now lands and must be discarded.
    await act(async () => {
      releaseOlder(
        new Response(
          JSON.stringify(
            payload(
              status({
                files: ["0001_a.sql", "0002_b.sql"],
                applied: new Map([["0001_a.sql", "2026-09-01T00:00:00.000Z"]]),
                cutoverDatabase: baseDb(false),
              }),
            ),
          ),
          { status: 200 },
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText("همهٔ مهاجرت‌های این نسخه روی پایگاه‌داده اعمال شده‌اند.")).toBeTruthy();
    expect(screen.queryByText(/مهاجرت هنوز روی پایگاه‌داده اعمال/)).toBeNull();
  });
});

describe("/platform/system accessibility", () => {
  it("exposes the migration state as an accessible status region", async () => {
    respondWith(
      payload(
        status({
          files: ["0001_a.sql"],
          applied: new Map([["0001_a.sql", "2026-09-01T00:00:00.000Z"]]),
          cutoverDatabase: baseDb(false),
        }),
      ),
    );
    render(<SystemPage />);
    await waitFor(() => expect(screen.getByLabelText("وضعیت مهاجرت‌های پایگاه‌داده")).toBeTruthy());
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    // Keyboard reachable, with a visible focus treatment.
    const refresh = screen.getByRole("button", { name: /تازه‌سازی/ });
    refresh.focus();
    expect(document.activeElement).toBe(refresh);
    expect(refresh.className).toContain("focus-visible:ring");
  });
});
