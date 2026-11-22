// @vitest-environment jsdom
/**
 * ESH-200 / #1385 — the public signup screen's contract.
 *
 * The screen is deliberately narrow: three fields, then one code. These tests
 * pin that shape and the two safe outcomes of verification — continue to
 * onboarding, or go to sign-in when the proved number already belongs to an
 * account — without ever exposing an OTP or a full number in a failure message.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

import SignupPage from "./page";

const REQUEST_TOKEN = "a".repeat(43);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  push.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillDetails() {
  fireEvent.change(screen.getByLabelText("نام"), { target: { value: "نگار" } });
  fireEvent.change(screen.getByLabelText("نام خانوادگی"), { target: { value: "احمدی" } });
  fireEvent.change(screen.getByLabelText(/شمارهٔ موبایل/), {
    target: { value: "۰۹۱۲۱۲۳۴۵۶۷" },
  });
}

async function requestCode() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "ارسال کد تأیید" }));
  });
}

describe("the signup form", () => {
  it("asks for exactly first name, last name and mobile", () => {
    render(<SignupPage />);

    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(inputs.map((input) => input.name)).toEqual(["firstName", "lastName", "phone"]);
    expect(inputs.every((input) => input.required)).toBe(true);
    expect(document.querySelector('input[type="email"]')).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/کد ملی|ایمیل|گذرواژه|نام کسب‌وکار/);
  });

  it("shows the masked destination and continues to onboarding after verification", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/signup/request")) {
        return jsonResponse(200, {
          ok: true,
          status: "sent",
          maskedPhone: "+989***4567",
          requestToken: REQUEST_TOKEN,
          expiresInSeconds: 300,
          resendAfterSeconds: 0,
        });
      }
      if (url.includes("/api/auth/signup/verify")) {
        return jsonResponse(200, { ok: true, created: true, next: "/onboarding" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    render(<SignupPage />);
    fillDetails();
    await requestCode();

    await screen.findByText(/پیامک شد/);
    expect(document.body.textContent).toContain("۹۸۹");
    const code = screen.getByLabelText(/کد تأیید/) as HTMLInputElement;
    expect(code.autocomplete).toBe("one-time-code");

    fireEvent.change(code, { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تأیید و ساخت حساب" }));
    });

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
    const verifyCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/api/auth/signup/verify"),
    );
    expect(verifyCall).toBeTruthy();
    const body = JSON.parse(String((verifyCall?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      firstName: "نگار",
      lastName: "احمدی",
      phone: "۰۹۱۲۱۲۳۴۵۶۷",
      requestToken: REQUEST_TOKEN,
      code: "123456",
    });
  });

  it("sends an already-registered number to sign-in without creating a duplicate", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/signup/request")) {
        return jsonResponse(200, {
          ok: true,
          status: "sent",
          maskedPhone: "+989***4567",
          requestToken: REQUEST_TOKEN,
          expiresInSeconds: 300,
          resendAfterSeconds: 0,
        });
      }
      return jsonResponse(200, {
        ok: true,
        created: false,
        next: "/login",
        message: "account_exists",
      });
    });

    render(<SignupPage />);
    fillDetails();
    await requestCode();
    fireEvent.change(screen.getByLabelText(/کد تأیید/), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تأیید و ساخت حساب" }));
    });

    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });

  it("keeps the person on the code step for a wrong code and announces the error", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/signup/request")) {
        return jsonResponse(200, {
          ok: true,
          status: "sent",
          maskedPhone: "+989***4567",
          requestToken: REQUEST_TOKEN,
          expiresInSeconds: 300,
          resendAfterSeconds: 0,
        });
      }
      return jsonResponse(401, { ok: false, error: "invalid_code" });
    });

    render(<SignupPage />);
    fillDetails();
    await requestCode();
    fireEvent.change(screen.getByLabelText(/کد تأیید/), { target: { value: "000000" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تأیید و ساخت حساب" }));
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("درست یا معتبر نیست");
    expect(push).not.toHaveBeenCalled();
  });

  it("accepts a pasted code with Persian digits and separators", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, {
        ok: true,
        status: "sent",
        maskedPhone: "+989***4567",
        requestToken: REQUEST_TOKEN,
        expiresInSeconds: 300,
        resendAfterSeconds: 0,
      }),
    );

    render(<SignupPage />);
    fillDetails();
    await requestCode();

    const code = screen.getByLabelText(/کد تأیید/) as HTMLInputElement;
    fireEvent.paste(code, {
      clipboardData: { getData: () => "۱۲۳ ۴۵۶" },
    });
    expect(code.value).toBe("123456");
  });

  it("shows a live resend cooldown instead of allowing an immediate second SMS", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, {
        ok: true,
        status: "sent",
        maskedPhone: "+989***4567",
        requestToken: REQUEST_TOKEN,
        expiresInSeconds: 300,
        resendAfterSeconds: 60,
      }),
    );

    render(<SignupPage />);
    fillDetails();
    await requestCode();

    const resend = screen.getByRole("button", { name: /ارسال دوباره/ }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    expect(resend.textContent).toMatch(/ارسال دوباره تا/);
  });
});
