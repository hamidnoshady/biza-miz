// @vitest-environment jsdom
/**
 * Issue #885 — the login door chooser's wiring.
 *
 * The next-path rule itself is pure and covered in `login-contract.test.ts`.
 * What cannot be proven by calling a function is whether the chooser actually
 * *uses* it: whether choosing the manager door really carries `?next=` across,
 * or drops it the way the hard-coded `/admin` did (L06); whether the offline
 * card really stops claiming «نیازی به اینترنت ندارد» on a cloud origin (L04);
 * and whether the copy still promises access the authorization layer does not
 * grant (L16). Each of those was the defect, and each lives in JSX.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.hoisted(() => vi.fn());

import { LoginDoorChooser, OfflineLoginNote } from "./login-door-chooser";

/** Answer the capability probe, or make it fail the way a blocked network does. */
function stubCapabilities(body: unknown) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => body,
  });
}

function stubCapabilitiesFailure() {
  fetchMock.mockRejectedValue(new Error("network down"));
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  router.push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LoginDoorChooser — destination survives a door change (L06)", () => {
  it("carries a validated next onto the manager door instead of dropping it", async () => {
    stubCapabilities({
      deploymentProfile: "cloud",
      phoneOtpEnforcement: "off",
      phoneOtpDaysLeft: null,
    });
    render(<LoginDoorChooser next="/settings/profile" onChoose={() => {}} />);

    fireEvent.click(await screen.findByText("ورود مدیر / مالک"));

    // The defect: `router.push("/admin")`, hard-coded, so
    // /login?next=/settings/profile lost the destination the moment the
    // manager card was chosen and the user had to find it again after signing in.
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push.mock.calls[0][0]).toContain("/admin?");
    expect(router.push.mock.calls[0][0]).toContain("next=%2Fsettings%2Fprofile");
  });

  it("does not carry an unsafe destination, whatever was passed in", async () => {
    stubCapabilities({
      deploymentProfile: "cloud",
      phoneOtpEnforcement: "off",
      phoneOtpDaysLeft: null,
    });
    render(<LoginDoorChooser next="//evil.example" onChoose={() => {}} />);
    fireEvent.click(await screen.findByText("ورود مدیر / مالک"));

    expect(router.push).toHaveBeenCalledWith("/admin");
  });

  it("navigates plainly when there is no destination to preserve", async () => {
    stubCapabilities({
      deploymentProfile: "cloud",
      phoneOtpEnforcement: "off",
      phoneOtpDaysLeft: null,
    });
    render(<LoginDoorChooser onChoose={() => {}} />);
    fireEvent.click(await screen.findByText("ورود مدیر / مالک"));

    expect(router.push).toHaveBeenCalledWith("/admin");
  });
});

describe("LoginDoorChooser — the offline promise matches the install (L04)", () => {
  it("does not claim Internet-free login on a cloud origin", async () => {
    stubCapabilities({
      deploymentProfile: "cloud",
      phoneOtpEnforcement: "off",
      phoneOtpDaysLeft: null,
    });
    render(<LoginDoorChooser onChoose={() => {}} />);

    // The defect: this exact sentence appeared on the hosted origin, where the
    // page is by definition reached over the Internet and pressing the card
    // only mounted the same same-origin staff form.
    await waitFor(() =>
      expect(
        screen.queryByText("نیازی به اینترنت ندارد", { exact: false }),
      ).toBeNull(),
    );
    expect(
      await screen.findByText(/اپلیکیشن محلی/, { exact: false }),
    ).toBeTruthy();
  });

  it("keeps the claim on a local install, where it is true", async () => {
    stubCapabilities({
      deploymentProfile: "local",
      phoneOtpEnforcement: "pending_sms",
      phoneOtpDaysLeft: null,
    });
    render(<LoginDoorChooser onChoose={() => {}} />);

    expect(
      await screen.findByText("نیازی به اینترنت ندارد"),
    ).toBeTruthy();
  });

  it("states the phone-verification prerequisite once enforcement is live", async () => {
    stubCapabilities({
      deploymentProfile: "hybrid",
      phoneOtpEnforcement: "enforced",
      phoneOtpDaysLeft: 0,
    });
    render(<LoginDoorChooser onChoose={() => {}} />);

    // A local install whose policy enforces OTP still needs a fresh SMS once
    // the member's seven-day window closes; saying so beats letting them
    // discover it at the keypad.
    expect(
      await screen.findByText(/تأیید پیامکی/, { exact: false }),
    ).toBeTruthy();
  });

  it("falls back to the cloud wording when the probe cannot complete", async () => {
    stubCapabilitiesFailure();
    render(<LoginDoorChooser onChoose={() => {}} />);

    // Guessing optimistically here is exactly the bug being fixed, so a probe
    // that fails must not produce the Internet-free claim.
    await waitFor(() =>
      expect(
        screen.queryByText("نیازی به اینترنت ندارد", { exact: false }),
      ).toBeNull(),
    );
  });
});

describe("LoginDoorChooser — copy does not over-promise (L16)", () => {
  it("names the mechanism rather than guaranteeing full administrative access", async () => {
    stubCapabilities({
      deploymentProfile: "cloud",
      phoneOtpEnforcement: "off",
      phoneOtpDaysLeft: null,
    });
    render(<LoginDoorChooser onChoose={() => {}} />);

    // A manager is not an owner; what they can open is decided by their role's
    // permissions in authorize.ts. The old bullet promised «دسترسی کامل به
    // تنظیمات و گزارش‌ها», which the authorization layer does not keep.
    await waitFor(() =>
      expect(
        screen.queryByText("دسترسی کامل به تنظیمات و گزارش‌ها"),
      ).toBeNull(),
    );
    expect(
      await screen.findByText("دسترسی مطابق نقش و مجوزهای شما"),
    ).toBeTruthy();
  });

  it("says the remembered-choice checkbox stores no credential", async () => {
    stubCapabilities({
      deploymentProfile: "cloud",
      phoneOtpEnforcement: "off",
      phoneOtpDaysLeft: null,
    });
    render(<LoginDoorChooser onChoose={() => {}} />);

    // It is a device-local UI shortcut, and it must not read as the seven-day
    // device trust — which is earned by completing a verification and held
    // server-side.
    expect(
      await screen.findByText("نوع ورود را روی این مرورگر به خاطر بسپار"),
    ).toBeTruthy();
    expect(await screen.findByText(/رمز عبور ذخیره نمی‌شود/)).toBeTruthy();
  });
});

describe("OfflineLoginNote — the footnote agrees with the install (L04)", () => {
  it("does not repeat the untrue claim on a cloud origin", async () => {
    stubCapabilities({
      deploymentProfile: "cloud",
      phoneOtpEnforcement: "off",
      phoneOtpDaysLeft: null,
    });
    render(<OfflineLoginNote />);

    await waitFor(() =>
      expect(screen.queryByText(/نیازی به اینترنت ندارد/)).toBeNull(),
    );
    expect(await screen.findByText(/این نشانی ابری است/)).toBeTruthy();
  });

  it("keeps it on a local install, and adds the prerequisite when enforced", async () => {
    stubCapabilities({
      deploymentProfile: "local",
      phoneOtpEnforcement: "enforced",
      phoneOtpDaysLeft: 0,
    });
    render(<OfflineLoginNote />);

    expect(
      await screen.findByText(/سرور محلی همین شبکه/, { exact: false }),
    ).toBeTruthy();
  });
});
