// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupHealthNotice } from "./backup-health-notice";

afterEach(() => vi.unstubAllGlobals());

function healthResponse(level: "ok" | "warning" | "error", reason: string) {
  return new Response(JSON.stringify({ health: { alert: { level, reason } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("persistent backup health notice", () => {
  it("stays hidden when the canonical health calculation is ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthResponse("ok", "ok")));
    render(<BackupHealthNotice />);
    await waitFor(() => expect(screen.queryByLabelText("بررسی سلامت پشتیبان‌گیری")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a persistent stale-backup warning with a recovery link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(healthResponse("error", "local_stale")));
    render(<BackupHealthNotice />);
    expect((await screen.findByRole("alert")).textContent).toContain("نسخهٔ پشتیبان تازه‌ای وجود ندارد");
    expect(screen.getByRole("link", { name: "بررسی پشتیبان‌گیری" }).getAttribute("href")).toBe("/settings/backup");
  });
});
