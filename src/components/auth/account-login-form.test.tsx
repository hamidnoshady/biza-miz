// @vitest-environment jsdom
/**
 * #1386 — the account door's default and its two one-time-code journeys.
 *
 * The regression this pins is the pre-#1386 conflation: the only way to reach
 * the SMS option was the forgot-password link, so a passwordless sign-in
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

    expect(screen.getByRole("button", { name: "ورود با رمز یک‌بارمصرف" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "فراموشی رمز عبور؟" })).toBeTruthy();
  });

  it("routes the OTP button to a login screen, not to recovery", () => {
    render(<AccountLoginForm />);

    fireEvent.click(screen.getByRole("button", { name: "ورود با رمز یک‌بارمصرف" }));

    expect(screen.getByRole("heading", { name: "ورود با رمز یک‌بارمصرف" })).toBeTruthy();
    expect(screen.getByText(/نیازی به رمز عبور نیست/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "بازیابی رمز عبور" })).toBeNull();
  });

  it("routes the forgot-password link to the separate recovery screen", () => {
    render(<AccountLoginForm />);

    fireEvent.click(screen.getByRole("button", { name: "فراموشی رمز عبور؟" }));

    expect(screen.getByRole("heading", { name: "بازیابی رمز عبور" })).toBeTruthy();
    expect(screen.getByText(/رمز عبور را عوض می‌کند/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "ورود با رمز یک‌بارمصرف" })).toBeNull();
  });

  it("labels the OTP phone field and lets the browser autofill it", () => {
    render(<AccountLoginForm />);
    fireEvent.change(screen.getByLabelText("شمارهٔ موبایل"), { target: { value: "۰۹۱۲۱۲۳۴۵۶۷" } });

    fireEvent.click(screen.getByRole("button", { name: "ورود با رمز یک‌بارمصرف" }));

    // A real <label>, not only aria-label, and the typed number carried over
    // so the member does not retype it (no unnecessary intermediate screen).
    const phone = screen.getByLabelText("شمارهٔ موبایل") as HTMLInputElement;
    expect(phone.getAttribute("autocomplete")).toBe("tel");
    expect(phone.getAttribute("type")).toBe("tel");
    expect(phone.value).toBe("۰۹۱۲۱۲۳۴۵۶۷");
    expect(screen.getByRole("button", { name: "ارسال کد" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "بازگشت به ورود با رمز عبور" })).toBeTruthy();
  });

  it("toggles password visibility with an accessible, pressed-state button", () => {
    render(<AccountLoginForm />);
    const field = screen.getByLabelText("رمز عبور") as HTMLInputElement;
    expect(field.type).toBe("password");

    const show = screen.getByRole("button", { name: "نمایش رمز عبور" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(show);

    expect(field.type).toBe("text");
    const hide = screen.getByRole("button", { name: "پنهان کردن رمز عبور" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(hide);
    expect(field.type).toBe("password");
  });

  it("keeps «رمز عبور» label lookups pointing at the field alone, in both toggle states", () => {
    // Browser E2E scripts locate the field with a substring label match
    // (`getByLabel("رمز عبور")` on /admin). The toggle's name contains the same
    // words, so it must not be exposed as a *label* or that lookup would
    // match two elements.
    render(<AccountLoginForm />);
    expect(screen.getAllByLabelText(/رمز عبور/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "نمایش رمز عبور" }));
    expect(screen.getAllByLabelText(/رمز عبور/)).toHaveLength(1);
    expect((screen.getByLabelText(/رمز عبور/) as HTMLInputElement).id).toBe("password");
  });

  it("never puts credentials in the URL: the form posts JSON, not a GET query", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_credentials" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AccountLoginForm />);
    fireEvent.change(screen.getByLabelText("شمارهٔ موبایل"), { target: { value: "09121234567" } });
    fireEvent.change(screen.getByLabelText("رمز عبور"), { target: { value: "s3cret-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "ورود" }));

    await screen.findByRole("alert");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(url).not.toContain("s3cret");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("s3cret-pass");
  });

  it("keeps the owner door's historical email label when asked to", () => {
    render(<AccountLoginForm identifierLabel="ایمیل" identifierType="email" />);

    expect(screen.getByLabelText("ایمیل")).toBeTruthy();
    expect(screen.queryByText(/حساب‌های قدیمی/)).toBeNull();
  });
});
