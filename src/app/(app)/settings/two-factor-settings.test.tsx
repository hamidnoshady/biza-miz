// @vitest-environment jsdom

/**
 * Issue #854 (P2.21 / P2.25 / P2.26) — rendered contracts for the tenant
 * two-factor card.
 *
 * The service-level tests proved the *backend* of the SMS replacement (the
 * atomic swap, the phone binding, the lock), but the screen itself used to
 * hide the replacement form behind `!hasSms` and omit the new number from the
 * confirmation — so a member with a confirmed SMS factor could never change
 * their number, and no integration test could see it. These tests render the
 * real component against a fake `/api/auth/mfa/self` and assert what the
 * member can reach and what the card is allowed to send.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwoFactorSettings } from "./two-factor-settings";

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

let server: {
  get: { status: number; data: Record<string, unknown> };
  post: { status: number; data: Record<string, unknown> };
};
const recorded: Recorded[] = [];

function baseStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applies: true,
    requirement: "required",
    graceDaysLeft: null,
    methods: [{ method: "sms_otp", isPrimary: true, phoneHint: "***0001", confirmedAt: "2026-01-01T00:00:00.000Z" }],
    methodNames: ["sms_otp"],
    pendingMethods: [],
    primaryMethod: "sms_otp",
    phone: "***0001",
    requireForManagers: true,
    unusedRecoveryCodes: 8,
    recoveryCodesRemaining: 8,
    recentAuth: true,
    deploymentProfile: "cloud",
    loginManagedByCloud: false,
    credential: { editable: true, readOnly: false },
    smsChallengeRequestedAt: null,
    smsChallengeExpiresAt: null,
    pendingSmsPhone: null,
    ...overrides,
  };
}

beforeEach(() => {
  recorded.length = 0;
  server = {
    get: { status: 200, data: baseStatus() },
    post: { status: 200, data: { status: "pending_confirmation", method: "sms_otp", phone: "+989121110002", maskedPhone: "***0002" } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
      recorded.push({ method, url, body });
      const which = method === "GET" ? server.get : server.post;
      return new Response(JSON.stringify(which.data), {
        status: which.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountCard(overrides: Record<string, unknown> = {}) {
  server.get.data = baseStatus(overrides);
  return render(<TwoFactorSettings isOwner />);
}

describe("Issue #854 P2.21 — SMS replacement on the tenant two-factor card", () => {
  it("offers «تغییر شمارهٔ دریافت» to a member who already has a confirmed SMS factor", async () => {
    mountCard();
    await screen.findByText("پیامک یک‌بارمصرف");
    expect(screen.getByRole("button", { name: "تغییر شمارهٔ دریافت" })).toBeTruthy();
  });

  it("sends the new number with the enrolment, then binds the confirmation to it", async () => {
    mountCard();
    fireEvent.click(await screen.findByRole("button", { name: "تغییر شمارهٔ دریافت" }));

    const input = await screen.findByPlaceholderText("09121234567");
    fireEvent.change(input, { target: { value: "09121110002" } });
    fireEvent.click(screen.getByRole("button", { name: "ارسال کد تأیید پیامکی" }));

    await waitFor(() => {
      const enrol = recorded.find((r) => r.body?.action === "enrol");
      expect(enrol?.body).toMatchObject({ action: "enrol", method: "sms_otp", phone: "09121110002" });
    });

    // The confirm panel names the *new* number as the replacement destination.
    await waitFor(() =>
      expect(screen.getAllByText(/کد ۶ رقمی ارسال‌شده به شمارهٔ جدید/).length).toBeGreaterThan(0),
    );
    const code = screen.getByPlaceholderText("123456");
    fireEvent.change(code, { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "تأیید شماره و جایگزینی" }));

    // The swap's confirmation dialog appears before any mutation is sent.
    await screen.findByText("جایگزینی شمارهٔ دریافت کد پیامکی");
    const postsSoFar = recorded.filter((r) => r.body?.action === "confirm");
    expect(postsSoFar.length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "بله، شماره جایگزین شود" }));
    await waitFor(() => {
      const confirm = recorded.find((r) => r.body?.action === "confirm");
      expect(confirm?.body).toMatchObject({
        action: "confirm",
        method: "sms_otp",
        code: "654321",
        phone: "+989121110002",
      });
    });
  });

  it("cancelling the swap dialog sends no mutation", async () => {
    mountCard();
    fireEvent.click(await screen.findByRole("button", { name: "تغییر شمارهٔ دریافت" }));
    fireEvent.change(await screen.findByPlaceholderText("09121234567"), {
      target: { value: "09121110002" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ارسال کد تأیید پیامکی" }));
    await waitFor(() =>
      expect(screen.getAllByText(/کد ۶ رقمی ارسال‌شده به شمارهٔ جدید/).length).toBeGreaterThan(0),
    );
    fireEvent.change(screen.getByPlaceholderText("123456"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "تأیید شماره و جایگزینی" }));
    await screen.findByText("جایگزینی شمارهٔ دریافت کد پیامکی");

    fireEvent.click(screen.getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByText("جایگزینی شمارهٔ دریافت کد پیامکی")).toBeNull());
    expect(recorded.some((r) => r.body?.action === "confirm")).toBe(false);
  });

  it("names the new number on a replacement resend, not the stored one", async () => {
    mountCard();
    fireEvent.click(await screen.findByRole("button", { name: "تغییر شمارهٔ دریافت" }));
    fireEvent.change(await screen.findByPlaceholderText("09121234567"), {
      target: { value: "09121110002" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ارسال کد تأیید پیامکی" }));
    await waitFor(() =>
      expect(screen.getAllByText(/کد ۶ رقمی ارسال‌شده به شمارهٔ جدید/).length).toBeGreaterThan(0),
    );

    // The send that just happened starts the 60s cooldown; age the clock past
    // it so the resend button becomes clickable (the interval clears it).
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);
    await waitFor(
      () => {
        const resend = screen.getByRole("button", { name: /ارسال مجدد کد/ }) as HTMLButtonElement;
        expect(resend.disabled).toBe(false);
      },
      { timeout: 3000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "ارسال مجدد کد" }));
    await waitFor(() => {
      const resend = recorded.find((r) => r.body?.action === "resend_challenge");
      expect(resend?.body).toMatchObject({
        action: "resend_challenge",
        method: "sms_otp",
        phone: "+989121110002",
      });
    });
  });

  it("resumes a fresh enrolment after a reload from the server's pending row", async () => {
    mountCard({
      methods: [],
      methodNames: [],
      pendingMethods: ["sms_otp"],
      primaryMethod: null,
      phone: "***0002",
      pendingSmsPhone: "+989121110002",
      smsChallengeRequestedAt: new Date(Date.now() - 5000).toISOString(),
      smsChallengeExpiresAt: new Date(Date.now() + 115_000).toISOString(),
    });
    await screen.findByText(/کد ۶ رقمی ارسال‌شده به/);
    // The expiry line renders from the server's timestamp.
    expect(screen.getByText(/اعتبار این کد تا/)).toBeTruthy();
  });
});

describe("Issue #854 P2.26 — destructive confirmations on the tenant two-factor card", () => {
  it("factor removal waits behind a dialog that spells out consequences; cancelling sends nothing", async () => {
    mountCard({
      methods: [
        { method: "totp", isPrimary: true, phoneHint: null, confirmedAt: "2026-01-01T00:00:00.000Z" },
        { method: "sms_otp", isPrimary: false, phoneHint: "***0001", confirmedAt: "2026-01-01T00:00:00.000Z" },
      ],
      methodNames: ["totp", "sms_otp"],
    });
    const removeButtons = await screen.findAllByRole("button", { name: "حذف" });
    fireEvent.click(removeButtons[0]);

    const dialog = await screen.findByText("حذف برنامهٔ رمزساز");
    expect(dialog).toBeTruthy();
    // A consequence, not just a title, is visible.
    expect(screen.getByText(/کد برنامهٔ رمزساز برای ورود شما پذیرفته نمی‌شود/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByText("حذف برنامهٔ رمزساز")).toBeNull());
    expect(recorded.some((r) => r.body?.action === "remove")).toBe(false);
  });

  it("recovery-code regeneration waits behind its dialog; confirming sends exactly one mutation", async () => {
    server.post.data = { recoveryCodes: ["11111111"] };
    mountCard();
    fireEvent.click(await screen.findByRole("button", { name: "ساخت کدهای جدید" }));
    await screen.findByText("ساخت کدهای بازیابی جدید");
    // The old set's invalidation is spelled out.
    expect(screen.getByText(/کدهای بازیابی قبلی همان لحظه باطل می‌شوند/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "بله، کدهای جدید بساز" }));
    await waitFor(() => {
      const regen = recorded.filter((r) => r.body?.action === "regenerate_recovery_codes");
      expect(regen.length).toBe(1);
    });
  });
});

describe("Issue #854 P2.25 — the limiter's own answer drives the cooldown", () => {
  it("a 429 answer surfaces the rate-limit message", async () => {
    mountCard({ methods: [], methodNames: [], primaryMethod: null, phone: null });
    // Two rows offer «فعال‌سازی» (TOTP and SMS); the SMS row renders second.
    const activateButtons = await screen.findAllByRole("button", { name: "فعال‌سازی" });
    fireEvent.click(activateButtons[activateButtons.length - 1]);
    fireEvent.change(await screen.findByPlaceholderText("09121234567"), {
      target: { value: "09121110003" },
    });
    server.post = { status: 429, data: { error: "rate_limited", retryAfterMs: 45_000 } };
    fireEvent.click(screen.getByRole("button", { name: "ارسال کد تأیید پیامکی" }));
    await screen.findByText(/تعداد درخواست‌ها بیش از حد مجاز است/);
  });
});
