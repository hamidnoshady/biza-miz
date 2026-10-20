// @vitest-environment jsdom

/**
 * Issue #1008 — the settings button must ask Central, not re-read a cache.
 *
 * These tests drive the real component with a fake desktop bridge, so they pin
 * the two halves of the bug together: one click performs
 * `POST /api/desktop-update/check`, and only the manifest that exchange
 * returned is handed to `bridge.check`. The old handler passed the cached
 * `targetRelease` (null on a live install), which the engine answered
 * «no update» without a network call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "@/app/dashboard/ui";
import type { DesktopUpdateState } from "@/lib/desktop-bridge";
import { DesktopUpdateSettings } from "./desktop-update-settings";

vi.mock("@/app/dashboard/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/dashboard/ui")>();
  return { ...actual, api: vi.fn() };
});

const request = vi.mocked(api);

const POLICY = { automaticChecks: false, backgroundDownload: false, automaticInstall: false as const, channel: "stable" as const };

const TARGET = {
  version: "1.0.69",
  buildCommit: "b".repeat(40),
  buildId: "production-169",
  channel: "stable" as const,
  releasedAt: "2026-10-17T08:00:00.000Z",
  minimumSupportedVersion: "1.0.0",
  mandatory: false,
  installer: {
    url: "https://github.com/example/product/update.exe",
    sha256: "c".repeat(64),
    size: 4096,
    signatureRequired: true as const,
    expectedPublisher: "Business Suite",
  },
  database: { migrationVersion: 227, minimumSchemaVersion: 1, maximumSchemaVersion: 227, backupRequired: true as const },
  releaseNotes: ["رفع اشکال بررسی به‌روزرسانی"],
  recovery: { knownGoodVersion: null, notes: null },
};

const LOCAL_STATUS = {
  checkedAt: "2026-10-18T09:00:00.000Z",
  installed: { version: "1.0.60", buildCommit: "a".repeat(40), buildId: "desktop-1.0.60", channel: "stable" as const },
  centralRuntime: null,
  targetRelease: null,
  compliance: "unknown",
  error: null as string | null,
  currentVersion: "1.0.60",
};

function desktopState(over: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    state: "no_update",
    installedVersion: "1.0.60",
    target: null,
    progress: null,
    installerPath: null,
    backupPath: null,
    errorCode: null,
    errorDetail: null,
    checkedAt: "2026-10-18T09:31:00.000Z",
    updatedAt: "2026-10-18T09:31:00.000Z",
    policy: { ...POLICY },
    installOnNextRestart: false,
    previousVersion: null,
    ...over,
  };
}

function fakeBridge() {
  const check = vi.fn(async (manifest: DesktopUpdateState["target"]) =>
    manifest
      ? desktopState({ state: "update_available", target: manifest })
      : desktopState({ state: "no_update", target: null }));
  const configure = vi.fn(async () => desktopState());
  return {
    status: vi.fn(async () => desktopState()),
    configure,
    check,
    download: vi.fn(async () => desktopState()),
    pause: vi.fn(async () => desktopState()),
    cancel: vi.fn(async () => desktopState()),
    selectOfflinePackage: vi.fn(async () => desktopState()),
    installNow: vi.fn(async () => desktopState()),
    installOnNextRestart: vi.fn(async () => desktopState()),
    showBackup: vi.fn(async () => null),
    onState: () => () => undefined,
  };
}

function statusAnswer(status: typeof LOCAL_STATUS) {
  return { ok: true, status: 200, data: { status, policy: POLICY }, aborted: false };
}

function checkAnswer(over: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    data: {
      status: LOCAL_STATUS,
      policy: POLICY,
      targetRelease: null,
      checkedAt: "2026-10-18T09:31:00.000Z",
      offline: false,
      error: null,
      outcome: "up_to_date",
      ...over,
    },
    aborted: false,
  };
}

let bridge: ReturnType<typeof fakeBridge>;

beforeEach(() => {
  vi.clearAllMocks();
  bridge = fakeBridge();
  (window as unknown as { businessSuiteDesktop?: unknown }).businessSuiteDesktop = { update: bridge };
  request.mockResolvedValue(statusAnswer(LOCAL_STATUS) as never);
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { businessSuiteDesktop?: unknown }).businessSuiteDesktop;
});

describe("Desktop update settings — check for updates", () => {
  it("asks Central on click and hands the fresh manifest to the engine", async () => {
    request.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/desktop-update/check" && init?.method === "POST") {
        return checkAnswer({ outcome: "update_available", targetRelease: TARGET }) as never;
      }
      return statusAnswer(LOCAL_STATUS) as never;
    });

    render(<DesktopUpdateSettings />);

    fireEvent.click(await screen.findByRole("button", { name: /بررسی دوباره/ }));

    expect(await screen.findByText(/نسخهٔ ۱\.۰\.۶۹ در سرور مرکزی موجود است/)).toBeTruthy();
    expect(request).toHaveBeenCalledWith("/api/desktop-update/check", { method: "POST" });
    // The manifest from the exchange — not the cached null the old handler used.
    expect(bridge.check).toHaveBeenCalledTimes(1);
    expect(bridge.check.mock.calls[0][0]).toMatchObject({ version: "1.0.69" });
    expect(screen.getByRole("button", { name: "دانلود" })).toBeTruthy();
    expect(screen.getByText("رفع اشکال بررسی به‌روزرسانی")).toBeTruthy();
  });

  it("shows the offline state and never runs a manifest-less 'check' when Central is unreachable", async () => {
    request.mockImplementation(async (url: string) => {
      if (url === "/api/desktop-update/check") {
        return checkAnswer({
          outcome: "offline",
          offline: true,
          error: "remote_unreachable",
          status: { ...LOCAL_STATUS, error: "remote_unreachable", checkedAt: "2026-10-18T09:31:00.000Z" },
        }) as never;
      }
      return statusAnswer(LOCAL_STATUS) as never;
    });

    render(<DesktopUpdateSettings />);

    fireEvent.click(await screen.findByRole("button", { name: /بررسی دوباره/ }));

    expect(await screen.findByText("برای بررسی به‌روزرسانی به اینترنت وصل شوید.")).toBeTruthy();
    expect(bridge.check).not.toHaveBeenCalled();
  });

  it("keeps the offline hint visible from the cached status until a check succeeds", async () => {
    request.mockResolvedValue(statusAnswer({ ...LOCAL_STATUS, error: "remote_unreachable" }) as never);

    render(<DesktopUpdateSettings />);

    expect(await screen.findByText("برای بررسی به‌روزرسانی به اینترنت وصل شوید.")).toBeTruthy();
    expect(bridge.check).not.toHaveBeenCalled();
  });

  it("disables the button and says what it is doing while the exchange is in flight", async () => {
    let resolveCheck!: (value: ReturnType<typeof checkAnswer>) => void;
    request.mockImplementation(async (url: string) => {
      if (url === "/api/desktop-update/check") {
        return new Promise((resolve) => { resolveCheck = resolve; }) as never;
      }
      return statusAnswer(LOCAL_STATUS) as never;
    });

    render(<DesktopUpdateSettings />);

    fireEvent.click(await screen.findByRole("button", { name: /بررسی دوباره/ }));

    const busy = await screen.findByRole("button", { name: /در حال بررسی…/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("در حال بررسی به‌روزرسانی در سرور مرکزی…")).toBeTruthy();

    resolveCheck(checkAnswer({ outcome: "up_to_date" }));
    expect(await screen.findByRole("button", { name: /بررسی دوباره/ })).toBeTruthy();
    expect(screen.getByText(/برنامه به‌روز است/)).toBeTruthy();
  });

  it("names the reason when the install is not paired with Central", async () => {
    request.mockImplementation(async (url: string) => {
      if (url === "/api/desktop-update/check") {
        return checkAnswer({ outcome: "error", error: "sync_not_configured" }) as never;
      }
      return statusAnswer(LOCAL_STATUS) as never;
    });

    render(<DesktopUpdateSettings />);

    fireEvent.click(await screen.findByRole("button", { name: /بررسی دوباره/ }));

    expect(await screen.findByText(/این دستگاه به سرور مرکزی متصل نیست/)).toBeTruthy();
  });

  it("surfaces the engine's channel-mismatch refusal as the error reason", async () => {
    request.mockImplementation(async (url: string) => {
      if (url === "/api/desktop-update/check") {
        return checkAnswer({ outcome: "update_available", targetRelease: TARGET }) as never;
      }
      return statusAnswer(LOCAL_STATUS) as never;
    });
    bridge.check.mockResolvedValue(desktopState({
      state: "failed",
      errorCode: "release_channel_mismatch",
      errorDetail: "manifest channel beta != policy channel stable",
    }));

    render(<DesktopUpdateSettings />);

    fireEvent.click(await screen.findByRole("button", { name: /بررسی دوباره/ }));

    expect(await screen.findByText(/کانال به‌روزرسانی این دستگاه هم‌خوان نیست/)).toBeTruthy();
  });
});
