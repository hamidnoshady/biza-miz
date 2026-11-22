// @vitest-environment jsdom
/**
 * #1386 — the account door's default and its two one-time-code journeys.
 *
 * The regression this pins is the pre-#1386 conflation: the only way to reach
 * the SMS option was «رمز عبورم را فراموش کرده‌ام», so a passwordless sign-in
 * and a password reset looked like the same thing. They are now distinct
 * buttons, distinct screens, and (on the server) distinct OTP purposes.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { AccountLoginForm } from "./account-login-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("cloud account login form", () => {
  it("opens on phone + password", () => {
    render(<AccountLoginForm />);

    expect(screen.getByLabelText("شمارهٔ موبایل")).toBeTruthy();
    expect(screen.getByLabelText("رمز عبور")).toBeTruthy();
    expect(screen.getByRole("button", { name: "ورود" })).toBeTruthy();
    // The legacy-email compatibility hint is visible but secondary.
    expect(screen.getByText(/حساب‌های قدیمی/)).toBeTruthy();
  });

  it("offers passwordless login as its own visible method", () => {
    render(<AccountLoginForm />);

    expect(screen.getByRole("button", { name: "ورود با کد یک‌بارمصرف پیامکی" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "رمز عبورم را فراموش کرده‌ام" })).toBeTruthy();
  });

  it("routes the OTP button to a login screen, not to recovery", () => {
    render(<AccountLoginForm />);

    fireEvent.click(screen.getByRole("button", { name: "ورود با کد یک‌بارمصرف پیامکی" }));

    expect(screen.getByRole("heading", { name: "ورود با کد یک‌بارمصرف" })).toBeTruthy();
    expect(screen.getByText(/نیازی به رمز عبور نیست/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "بازیابی رمز عبور" })).toBeNull();
  });

  it("routes the forgot-password link to the separate recovery screen", () => {
    render(<AccountLoginForm />);

    fireEvent.click(screen.getByRole("button", { name: "رمز عبورم را فراموش کرده‌ام" }));

    expect(screen.getByRole("heading", { name: "بازیابی رمز عبور" })).toBeTruthy();
    expect(screen.getByText(/رمز عبور را عوض می‌کند/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "ورود با کد یک‌بارمصرف" })).toBeNull();
  });

  it("keeps the owner door's historical email label when asked to", () => {
    render(<AccountLoginForm identifierLabel="ایمیل" identifierType="email" />);

    expect(screen.getByLabelText("ایمیل")).toBeTruthy();
    expect(screen.queryByText(/حساب‌های قدیمی/)).toBeNull();
  });
});
