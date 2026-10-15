// @vitest-environment jsdom

/**
 * #854 follow-up — the signed-in notice on /login and /admin (#948 P0-2).
 *
 * The account switch used to say «حساب قبلی خارج شد» whether the revoke
 * request succeeded *or was rejected*. These tests pin that only a confirmed
 * end says so, that a failure says the previous session is still open and
 * offers a retry, and that an unconfirmed end retries through the server's
 * retry ticket rather than a second plain sign-out.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const toast = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

import { SignedInNotice } from "./signed-in-notice";

type Answer = { status: number; data: unknown } | "reject";
let answers: Record<string, Answer[]>;
const posted: string[] = [];

const signedOut = { status: 200, data: { ok: true, outcome: "revoked", sessionCookieCleared: true, pendingRevocations: 0 } };
const unconfirmed = {
  status: 503,
  data: { ok: false, outcome: "unconfirmed", sessionCookieCleared: true, pendingRevocations: 1, error: "logout_unconfirmed" },
};

beforeEach(() => {
  posted.length = 0;
  answers = {};
  for (const fn of [router.replace, router.refresh, router.push]) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      posted.push(`${init?.method ?? "GET"} ${url}`);
      const queue = answers[url] ?? [];
      const answer = queue.length > 1 ? queue.shift()! : queue[0];
      if (!answer) return new Response("{}", { status: 404 });
      if (answer === "reject") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(answer.data), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("switch mode (/login?changeAccount=1) — the previous session is revoked on mount", () => {
  it("says «حساب قبلی خارج شد» only after a confirmed sign-out", async () => {
    answers["/api/auth/logout"] = [signedOut];
    render(<SignedInNotice fullName="صندوق" role="cashier" switchMode />);
    expect(screen.getByRole("status").textContent).toMatch(/در حال خروج از حساب قبلی/);
    await screen.findByText("حساب قبلی خارج شد");
    expect(screen.getByText("برای ادامه، حساب تازه را انتخاب کنید.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(posted).toEqual(["POST /api/auth/logout"]);
  });

  it("a rejected request is not a sign-out: it says so and the retry works", async () => {
    answers["/api/auth/logout"] = ["reject", signedOut];
    render(<SignedInNotice fullName="صندوق" role="cashier" switchMode />);
    await screen.findByText("خروج از حساب قبلی انجام نشد");
    expect(screen.getByRole("alert").textContent).toMatch(/نشست شما هنوز باز است/);
    expect(screen.queryByText("حساب قبلی خارج شد")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await screen.findByText("حساب قبلی خارج شد");
    expect(posted).toEqual(["POST /api/auth/logout", "POST /api/auth/logout"]);
  });

  it("a server failure that is not the contract is not a sign-out either", async () => {
    answers["/api/auth/logout"] = [{ status: 502, data: "bad gateway" }];
    render(<SignedInNotice fullName="صندوق" role="cashier" switchMode />);
    await screen.findByText("خروج از حساب قبلی انجام نشد");
    expect(screen.getByRole("alert").textContent).toMatch(/ممکن است هنوز باز باشد/);
  });

  it("an unconfirmed end says exactly that, and retries through the retry ticket", async () => {
    answers["/api/auth/logout"] = [unconfirmed];
    answers["/api/auth/logout/retry"] = [
      { status: 200, data: { ok: true, outcome: "revoked", sessionCookieCleared: false, pendingRevocations: 0 } },
    ];
    render(<SignedInNotice fullName="صندوق" role="cashier" switchMode />);
    await screen.findByText("از این دستگاه خارج شدید");
    expect(screen.getByRole("alert").textContent).toMatch(/سرور پایان نشست را تأیید نکرد/);

    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await screen.findByText("حساب قبلی خارج شد");
    expect(posted).toEqual(["POST /api/auth/logout", "POST /api/auth/logout/retry"]);
  });
});

describe("the explicit «خروج و تغییر حساب»", () => {
  it("continues as the same account without touching the session", () => {
    render(<SignedInNotice fullName="سارا" role="owner" next="/accounting" />);
    fireEvent.click(screen.getByRole("button", { name: "ادامه با همین حساب" }));
    expect(router.replace).toHaveBeenCalledWith("/accounting");
    expect(posted).toHaveLength(0);
  });

  it("switches only after a confirmed sign-out", async () => {
    answers["/api/auth/logout"] = [signedOut];
    render(<SignedInNotice fullName="سارا" role="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "خروج و تغییر حساب" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?changeAccount=1"));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a failure keeps the notice, explains, releases the button and offers a retry", async () => {
    answers["/api/auth/logout"] = [{ status: 500, data: { error: "internal" } }, signedOut];
    render(<SignedInNotice fullName="سارا" role="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "خروج و تغییر حساب" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/ممکن است هنوز باز باشد/);
    expect(router.replace).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "تلاش دوباره برای خروج" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?changeAccount=1"));
  });

  it("when the cookie is cleared despite a server error, it switches and carries the warning along", async () => {
    answers["/api/auth/logout"] = [unconfirmed];
    render(<SignedInNotice fullName="سارا" role="owner" />);
    fireEvent.click(screen.getByRole("button", { name: "خروج و تغییر حساب" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login?changeAccount=1"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0][0]).toMatch(/از این دستگاه خارج شدید/);
  });
});
