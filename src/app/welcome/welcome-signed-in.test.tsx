// @vitest-environment jsdom

/**
 * #854 follow-up (third pass) — the first-run doors when the business exists
 * but its Owner could not be signed in.
 *
 * Bootstrap and pairing now open a revocable `employee_sessions` row before
 * they set a session cookie. If that row cannot be opened, the server still
 * answers `ok` (the business exists; bootstrap's second factor is shown only
 * once) with `signedIn: false` and no cookie. These tests pin what the screens
 * do with that answer: say so, keep the one-time factor on screen, and send
 * the Owner to the sign-in page instead of into a wizard that would bounce
 * them there unexplained. The server half is in
 * integration/session-revocation-854.integration.test.ts.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import WelcomePage from "./page";
import { PairForm } from "./pair-form";

type Reply = { status: number; body: unknown };
let replies: Record<string, Reply>;

beforeEach(() => {
  router.replace.mockReset();
  replies = {
    "GET /api/setup/restore": { status: 200, body: { available: false } },
    "GET /api/setup/state": { status: 200, body: { needsBootstrap: true } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      const reply = replies[key] ?? { status: 404, body: { error: "not_found" } };
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MFA = {
  method: "totp",
  totpSecret: "JBSWY3DPEHPK3PXP",
  totpUrl: null,
  totpQr: null,
  recoveryCodes: ["AAAA-BBBB", "CCCC-DDDD"],
};

async function bootstrapLocally(answer: Record<string, unknown>) {
  replies["POST /api/setup/bootstrap"] = { status: 200, body: answer };
  render(<WelcomePage />);
  const option = (await screen.findByRole("heading", { name: "ساخت یک کسب‌وکار جدید" })).closest("article")!;
  fireEvent.click(within(option as HTMLElement).getByRole("button", { name: /انتخاب و ادامه/ }));
  const form = (await screen.findByRole("button", { name: "ساخت و شروع راه‌اندازی" })).closest("form")!;
  const field = (label: string) => within(form).getByLabelText(label, { exact: false });
  fireEvent.change(field("آدرس سرور ابری"), { target: { value: "https://cafe.example.com" } });
  fireEvent.change(field("توکن فعال‌سازی آفلاین"), {
    target: { value: "OFL1-ABCD-EFGH-JKLM" },
  });
  fireEvent.change(field("نام کسب‌وکار"), { target: { value: "کافه آغاز" } });
  fireEvent.change(field("نام مالک"), { target: { value: "مالک" } });
  fireEvent.change(field("ایمیل مالک"), { target: { value: "owner@example.com" } });
  fireEvent.change(field("گذرواژه"), { target: { value: "a-long-owner-password" } });
  fireEvent.submit(form);
}

describe("first-run Full Offline Cloud activation (#974)", () => {
  it("fails closed without calling bootstrap when Cloud URL or OFL1 token is missing or invalid", async () => {
    render(<WelcomePage />);
    const option = (
      await screen.findByRole("heading", { name: "ساخت یک کسب‌وکار جدید" })
    ).closest("article")!;
    fireEvent.click(within(option as HTMLElement).getByRole("button", { name: /انتخاب و ادامه/ }));
    const form = (
      await screen.findByRole("button", { name: "ساخت و شروع راه‌اندازی" })
    ).closest("form")!;
    const field = (label: string) => within(form).getByLabelText(label, { exact: false });

    // Toggle Get Help
    fireEvent.click(within(form).getByRole("button", { name: "راهنمای دریافت توکن" }));
    expect(within(form).getByText(/OFL1-/)).toBeTruthy();

    fireEvent.change(field("آدرس سرور ابری"), { target: { value: "https://cafe.example.com" } });
    fireEvent.change(field("توکن فعال‌سازی آفلاین"), {
      target: { value: "ABCD-EFGH-JKLM" }, // Hybrid code instead of OFL1-
    });
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("supports live Verify preflight and Retry on transient Cloud failure", async () => {
    replies["POST /api/setup/bootstrap"] = {
      status: 502,
      body: { ok: false, error: "network_error" },
    };
    render(<WelcomePage />);
    const option = (
      await screen.findByRole("heading", { name: "ساخت یک کسب‌وکار جدید" })
    ).closest("article")!;
    fireEvent.click(within(option as HTMLElement).getByRole("button", { name: /انتخاب و ادامه/ }));
    const form = (
      await screen.findByRole("button", { name: "ساخت و شروع راه‌اندازی" })
    ).closest("form")!;
    const field = (label: string) => within(form).getByLabelText(label, { exact: false });

    fireEvent.change(field("آدرس سرور ابری"), { target: { value: "https://cafe.example.com" } });
    fireEvent.change(field("توکن فعال‌سازی آفلاین"), {
      target: { value: "OFL1-ABCD-EFGH-JKLM" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "بررسی و تأیید" }));

    const retryBtn = await screen.findByRole("button", { name: "تلاش مجدد" });
    expect(retryBtn).toBeTruthy();

    replies["POST /api/setup/bootstrap"] = {
      status: 200,
      body: {
        ok: true,
        cloudOrigin: "https://cafe.example.com",
        businessName: "کافه ابر",
        locationName: "شعبه نیاوران",
        plan: "pro",
      },
    };
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(screen.getByText(/تأیید شد: «کافه ابر»/)).toBeTruthy();
    });
  });
});

describe("first-run bootstrap — the once-only factor survives a failed automatic sign-in", () => {
  it("keeps the factor on screen, says the sign-in did not happen, and continues through the sign-in page", async () => {
    await bootstrapLocally({ ok: true, signedIn: false, mfa: MFA });

    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("ورود خودکار انجام نشد");
    const go = screen.getByRole("button", { name: "رفتن به صفحهٔ ورود" }) as HTMLButtonElement;
    // The handover's deliberate friction is unchanged: confirm first.
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(go);
    expect(router.replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/setup/business")}`);
  });

  it("goes straight on to the wizard when the Owner was signed in", async () => {
    await bootstrapLocally({ ok: true, signedIn: true, mfa: MFA });

    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "ادامه به راه‌اندازی" }));
    expect(router.replace).toHaveBeenCalledWith("/setup/business");
  });
});

describe("pairing — a connected device whose Owner could not be signed in", () => {
  async function pair(answer: Record<string, unknown>) {
    replies["POST /api/setup/pair"] = { status: 200, body: answer };
    render(<PairForm onBack={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("mybusiness.example.com"), {
      target: { value: "shop.example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("XXXX-XXXX-XXXX"), { target: { value: "ABCD-EFGH-JKLM" } });
    fireEvent.click(screen.getByRole("button", { name: "اتصال و دریافت تنظیمات" }));
  }

  it("says the device is connected and only the sign-in is missing, then goes to the sign-in page on request", async () => {
    await pair({ ok: true, signedIn: false, requiresOfflineCredential: true, ownerUserId: "owner-1" });

    expect((await screen.findByRole("status")).textContent).toContain("ورود خودکار انجام نشد");
    // Not the offline-PIN step: that step needs the session that was not opened.
    expect(screen.queryByText("رمز ورود آفلاین این دستگاه")).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "رفتن به صفحهٔ ورود" }));
    expect(router.replace).toHaveBeenCalledWith("/login");
  });

  it("still offers the offline-PIN step when the Owner was signed in", async () => {
    await pair({ ok: true, signedIn: true, requiresOfflineCredential: true, ownerUserId: "owner-1" });

    await waitFor(() => expect(screen.getByText("رمز ورود آفلاین این دستگاه")).toBeTruthy());
    expect(screen.queryByRole("status")).toBeNull();
  });
});
