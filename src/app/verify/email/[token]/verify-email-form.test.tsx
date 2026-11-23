// @vitest-environment jsdom
/**
 * ESH-199 / #1384 follow-up — the email proof confirmation form.
 *
 * GET only renders this form; the token is spent by the button's POST. These
 * tests pin the success/error copy and that a network failure is recoverable.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerifyEmailForm } from "./verify-email-form";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the email verification form", () => {
  it("posts the token and reports success", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    render(<VerifyEmailForm token="opaque-token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تأیید ایمیل" }));
    });

    expect(await screen.findByText("ایمیل شما تأیید شد.")).toBeTruthy();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/auth/email/verify");
    expect(String(init.body)).toContain("opaque-token");
  });

  it("explains an address change and keeps a retry path", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "email_changed" }));
    render(<VerifyEmailForm token="opaque-token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تأیید ایمیل" }));
    });

    expect(await screen.findByText(/تغییر کرده است/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "تأیید ایمیل" })).toBeTruthy();
  });

  it("treats an invalid or spent proof as recoverable, not a crash", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "invalid_token" }));
    render(<VerifyEmailForm token="opaque-token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تأیید ایمیل" }));
    });

    expect(await screen.findByText(/معتبر یا قابل استفاده نیست/)).toBeTruthy();
  });

  it("shows a retry message when the network fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<VerifyEmailForm token="opaque-token" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تأیید ایمیل" }));
    });

    expect(await screen.findByText(/اتصال خود را بررسی/)).toBeTruthy();
  });
});
