/**
 * @vitest-environment jsdom
 *
 * Mounted-UI regression for the administrator console (audit F01). The page
 * renders for real; only the network boundary (`platformFetch`) is replaced.
 * The assertions are on what the operator sees and on the exact method, URL
 * and body the console sends — the contract the server route now enforces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ platformFetch: vi.fn() }));

vi.mock("@/lib/platform-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform-client")>();
  return { ...actual, platformFetch: mocks.platformFetch };
});

import AdminsPage from "./page";

const ADMINS = [
  {
    id: "a1",
    email: "support@example.com",
    fullName: "اپراتور یک",
    role: "support",
    isActive: true,
    lastLoginAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    mfaMethods: ["totp"],
    activeSessionsCount: 1,
  },
];

function listResult() {
  return { ok: true, status: 200, data: { admins: ADMINS }, code: undefined };
}

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("administrators page — mounted contract (audit F01)", () => {
  it("has no initial-password field: credentials are never chosen by the inviting admin", async () => {
    mocks.platformFetch.mockResolvedValueOnce(listResult());
    render(<AdminsPage />);
    await screen.findByText("اپراتور یک");
    expect(screen.queryByText("رمز عبور اولیه (اختیاری)")).toBeNull();
    expect(document.querySelectorAll('input[type="password"]').length).toBe(0);
  });

  it("suspends an admin with PATCH + typed update action keyed by adminId", async () => {
    mocks.platformFetch.mockResolvedValueOnce(listResult());
    render(<AdminsPage />);
    await screen.findByText("اپراتور یک");

    mocks.platformFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true }, code: undefined });
    mocks.platformFetch.mockResolvedValueOnce(listResult());
    fireEvent.click(screen.getByRole("button", { name: "تعلیق" }));

    await waitFor(() =>
      expect(mocks.platformFetch).toHaveBeenCalledWith(
        "/api/platform/admins",
        expect.objectContaining({
          method: "PATCH",
          body: { action: "update", adminId: "a1", isActive: false },
        }),
      ),
    );
  });

  it("uses reset_password (not the retired send_password_reset) for the reset link", async () => {
    mocks.platformFetch.mockResolvedValueOnce(listResult());
    render(<AdminsPage />);
    await screen.findByText("اپراتور یک");

    mocks.platformFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { ok: true, resetUrl: "/reset-password?token=t" },
      code: undefined,
    });
    mocks.platformFetch.mockResolvedValueOnce(listResult());
    fireEvent.click(screen.getByRole("button", { name: "لینک بازیابی رمز" }));

    await waitFor(() =>
      expect(mocks.platformFetch).toHaveBeenCalledWith(
        "/api/platform/admins",
        expect.objectContaining({
          method: "PATCH",
          body: { action: "reset_password", adminId: "a1" },
        }),
      ),
    );
    expect(await screen.findByDisplayValue("/reset-password?token=t")).toBeTruthy();
  });

  it("opens the step-up prompt on recent_auth_required and replays the same request after re-verification", async () => {
    mocks.platformFetch.mockResolvedValueOnce(listResult());
    render(<AdminsPage />);
    await screen.findByText("اپراتور یک");

    // The mutation is refused as stale …
    mocks.platformFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      data: undefined,
      code: "recent_auth_required",
    });
    fireEvent.click(screen.getByRole("button", { name: "ابطال نشست‌ها" }));
    expect(await screen.findByText(/تأیید مجدد هویت/)).toBeTruthy();

    // … the password is re-verified, and the SAME revoke request is replayed.
    mocks.platformFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true }, code: undefined });
    mocks.platformFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true }, code: undefined });
    mocks.platformFetch.mockResolvedValueOnce(listResult());
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: "current-password" } });
    fireEvent.click(screen.getByRole("button", { name: "تأیید و ادامه" }));

    await waitFor(() =>
      expect(mocks.platformFetch).toHaveBeenCalledWith(
        "/api/platform/admins",
        expect.objectContaining({
          method: "PATCH",
          body: { action: "revoke_sessions", adminId: "a1" },
        }),
      ),
    );
  });
});
