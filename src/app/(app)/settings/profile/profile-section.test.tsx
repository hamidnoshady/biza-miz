// @vitest-environment jsdom

/**
 * #854 follow-up — rendered contracts for `/settings/profile`.
 *
 * The routes behind this page are proven against a real database in
 * `integration/profile-security-854.integration.test.ts`; these tests pin what
 * the *screen* offers and what it sends, against a fake server:
 *
 *  - **F01** ending one other session goes through step-up and retries that
 *    exact session;
 *  - **F02** no biometric card is rendered when the server says there is
 *    nothing to offer;
 *  - **F06** a reloaded phone verification resends, cancels and verifies
 *    without sending any number — the server owns the destination;
 *  - **F08** the PIN fields are masked, numeric, and normalise Persian digits;
 *  - **F10 + logout** sign-out navigates only after the server confirmed it,
 *    and an unconfirmed end retries through the server's retry ticket;
 *  - **F11** a read-only login phone renders no form, including a pending one;
 *  - **F13** the active and home branches are shown from server data, apart —
 *    and a missing or deactivated home branch is never presented as this one.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

// The two heavyweight children have their own suites; here they are markers.
vi.mock("../two-factor-settings", () => ({ TwoFactorSettings: () => <div>two-factor-card</div> }));
vi.mock("@/components/auth/webauthn-manager", () => ({
  WebAuthnManager: () => <div>webauthn-manager</div>,
}));

import { ProfileSection, type ProfileSectionProps } from "./profile-section";

type Handler = (body: Record<string, unknown> | null) => { status: number; data: unknown } | "reject";

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

const recorded: Recorded[] = [];
let routes: Record<string, Handler>;

function json(status: number, data: unknown) {
  return { status, data };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const minutesAhead = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

function defaultRoutes(): Record<string, Handler> {
  return {
    "GET /api/sessions/self": () =>
      json(200, {
        sessions: [
          {
            id: "s-current",
            deviceLabel: "این مرورگر",
            isCurrent: true,
            issuedAt: minutesAgo(30),
            lastSeenAt: minutesAgo(1),
            loginMethod: "password",
            businessName: "کافه",
            locationName: "شعبهٔ مرکزی",
          },
          {
            id: "s-other",
            deviceLabel: "تبلت سالن",
            isCurrent: false,
            issuedAt: minutesAgo(300),
            lastSeenAt: minutesAgo(200),
            loginMethod: "pin",
            businessName: "کافه",
            locationName: "شعبهٔ مرکزی",
          },
        ],
      }),
    "GET /api/native-devices/self": () => json(200, { devices: [] }),
    "GET /api/auth/phone/self": () =>
      json(200, { phone: "+989121110001", phoneState: "verified", pendingChallenge: null }),
    "GET /api/auth/pin/self": () => json(200, { hasPin: true, pinPolicyHint: "۴ تا ۱۲ رقم" }),
    "GET /api/auth/step-up": () =>
      json(200, { availableMethods: ["pin"], methodLabels: { pin: "رمز عددی دستگاه" }, hasPin: true }),
    "POST /api/auth/step-up": () => json(200, { ok: true, recentAuth: true }),
  };
}

beforeEach(() => {
  recorded.length = 0;
  router.replace.mockReset();
  router.refresh.mockReset();
  router.push.mockReset();
  routes = defaultRoutes();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      recorded.push({ method, url, body });
      const handler = routes[`${method} ${url}`];
      if (!handler) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      const answer = handler(body);
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

function mount(overrides: Partial<ProfileSectionProps> = {}) {
  return render(
    <ProfileSection
      fullName="سارا"
      phone="+989121110001"
      email={null}
      role="cashier"
      isOwner={false}
      canUseMfa={false}
      {...overrides}
    />,
  );
}

const posts = (url: string) => recorded.filter((r) => r.method !== "GET" && r.url === url);

/**
 * The step-up prompt's own PIN field. Scoped to the prompt's form because the
 * PIN card's `SectionCard` carries the same accessible name.
 */
async function stepUpPinField(title: string): Promise<HTMLInputElement> {
  const heading = await screen.findByText(title);
  const form = heading.closest("form");
  if (!form) throw new Error("step-up prompt is not a form");
  return (await within(form).findByLabelText("رمز عددی دستگاه")) as HTMLInputElement;
}

/** The sign-out contract's answers (`@/lib/logout-contract`). */
const signedOutAnswer = (outcome = "revoked") =>
  json(200, { ok: true, outcome, sessionCookieCleared: true, pendingRevocations: 0 });
const unconfirmedAnswer = (sessionCookieCleared = true) =>
  json(503, {
    ok: false,
    outcome: "unconfirmed",
    sessionCookieCleared,
    pendingRevocations: 1,
    error: "logout_unconfirmed",
  });

describe("#854 F10 + logout — sign-out only leaves once the server confirmed it", () => {
  it("navigates to /login after a confirmed sign-out", async () => {
    routes["POST /api/auth/logout"] = () => signedOutAnswer();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("treats an already-ended or missing session as signed out", async () => {
    for (const outcome of ["already_ended", "no_session"]) {
      router.replace.mockReset();
      routes["POST /api/auth/logout"] = () => signedOutAnswer(outcome);
      const view = mount();
      fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
      view.unmount();
    }
  });

  it("a server failure keeps the member on the page, says so, and offers a retry", async () => {
    routes["POST /api/auth/logout"] = () => json(500, { error: "internal" });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/خروج از حساب کامل نشد/);
    expect(router.replace).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "تلاش دوباره برای خروج" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);

    routes["POST /api/auth/logout"] = () => signedOutAnswer();
    fireEvent.click(retry);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    // Still the plain sign-out route: the cookie was never cleared.
    expect(posts("/api/auth/logout/retry")).toHaveLength(0);
  });

  it("a dropped connection is not a sign-out, and the button is usable again", async () => {
    routes["POST /api/auth/logout"] = () => "reject";
    mount();
    fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
    await screen.findByText(/نشست شما هنوز باز است/);
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: "تلاش دوباره برای خروج" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("an unconfirmed end says so, retries through the retry ticket, then leaves", async () => {
    routes["POST /api/auth/logout"] = () => unconfirmedAnswer();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/سرور پایان نشست را تأیید نکرد/);
    expect(router.replace).not.toHaveBeenCalled();
    // The way out is offered, but not taken for them.
    expect(screen.getByRole("button", { name: "رفتن به صفحهٔ ورود" })).toBeTruthy();

    // A retry that fails again is still "unconfirmed", never "still signed in".
    routes["POST /api/auth/logout/retry"] = () => "reject";
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره برای پایان نشست" }));
    await waitFor(() => expect(posts("/api/auth/logout/retry")).toHaveLength(1));
    expect((await screen.findByRole("alert")).textContent).toMatch(/سرور پایان نشست را تأیید نکرد/);
    expect(screen.queryByText(/نشست شما هنوز باز است/)).toBeNull();

    routes["POST /api/auth/logout/retry"] = () =>
      json(200, { ok: true, outcome: "revoked", sessionCookieCleared: false, pendingRevocations: 0 });
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره برای پایان نشست" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    // Never a second plain sign-out: that would find no cookie and "succeed".
    expect(posts("/api/auth/logout")).toHaveLength(1);
    expect(posts("/api/auth/logout/retry")).toHaveLength(2);
  });

  it("from an unconfirmed end, the member may go to the login page themselves", async () => {
    routes["POST /api/auth/logout"] = () => unconfirmedAnswer();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
    fireEvent.click(await screen.findByRole("button", { name: "رفتن به صفحهٔ ورود" }));
    expect(router.replace).toHaveBeenCalledWith("/login");
  });

  // #854 follow-up (third pass): a support operator's sign-out closes the
  // support session and the server names the console as the way back.
  const consolePath = "/platform/businesses/7198892a-cca7-4e29-80a1-ff9f5f64fa97/support";

  it("a support operator's confirmed sign-out goes back to the console, not the staff sign-in", async () => {
    routes["POST /api/auth/logout"] = () =>
      json(200, { ok: true, outcome: "revoked", sessionCookieCleared: true, pendingRevocations: 0, redirectTo: consolePath });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(consolePath));
    expect(router.replace).not.toHaveBeenCalledWith("/login");
  });

  it("an unconfirmed support sign-out offers the way back to the console, and the retry keeps it", async () => {
    routes["POST /api/auth/logout"] = () =>
      json(503, {
        ok: false,
        outcome: "unconfirmed",
        sessionCookieCleared: true,
        pendingRevocations: 1,
        error: "logout_unconfirmed",
        redirectTo: consolePath,
      });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/سرور پایان نشست را تأیید نکرد/);
    expect(screen.queryByRole("button", { name: "رفتن به صفحهٔ ورود" })).toBeNull();
    expect(screen.getByRole("button", { name: "بازگشت به کنسول" })).toBeTruthy();

    routes["POST /api/auth/logout/retry"] = () =>
      json(200, { ok: true, outcome: "revoked", sessionCookieCleared: false, pendingRevocations: 0 });
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره برای پایان نشست" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(consolePath));
  });

  it("ignores a destination that would leave the origin", async () => {
    routes["POST /api/auth/logout"] = () =>
      json(200, {
        ok: true,
        outcome: "revoked",
        sessionCookieCleared: true,
        pendingRevocations: 0,
        redirectTo: "https://evil.example/phish",
      });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "خروج از حساب" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });
});

describe("#854 P2.27 — the device list names the door each session came through", () => {
  it("names a desktop cloud-account session as such, never as a local password or PIN sign-in", async () => {
    routes["GET /api/sessions/self"] = () =>
      json(200, {
        sessions: [
          {
            id: "s-cloud",
            deviceLabel: "برنامهٔ دسکتاپ",
            isCurrent: true,
            issuedAt: minutesAgo(10),
            lastSeenAt: minutesAgo(1),
            loginMethod: "cloud_account",
            businessName: "کافه",
            locationName: "شعبهٔ مرکزی",
          },
        ],
      });
    mount();
    const row = (await screen.findByText("برنامهٔ دسکتاپ")).closest("div.flex") as HTMLElement;
    expect(row.textContent).toContain("ورود با حساب ابری");
    expect(row.textContent).not.toContain("ورود با رمز عبور");
    expect(row.textContent).not.toContain("ورود با رمز عددی");
  });
});

describe("#854 F13 — active and home branch, from the server", () => {
  const north = { id: "l-n", name: "شعبهٔ شمال" };
  const main = { id: "l-m", name: "شعبهٔ مرکزی" };

  it("shows the active branch and, separately, a different home branch", () => {
    mount({ branch: { active: north, home: main, homeStatus: "different", canSwitch: true } });
    expect(screen.getByText("شعبهٔ فعال")).toBeTruthy();
    expect(screen.getByText("شعبهٔ شمال")).toBeTruthy();
    expect(screen.getByText("شعبهٔ اصلی")).toBeTruthy();
    expect(screen.getAllByText("شعبهٔ مرکزی").length).toBeGreaterThan(0);
    expect(screen.queryByText("(شعبهٔ اصلی شما)")).toBeNull();
    expect(screen.getByText(/از انتخابگر شعبه در بالای صفحه تغییر دهید/)).toBeTruthy();
  });

  it("marks the active branch as home only when they are the same, with no second row", () => {
    mount({ branch: { active: main, home: main, homeStatus: "same", canSwitch: false } });
    expect(screen.getByText("(شعبهٔ اصلی شما)")).toBeTruthy();
    expect(screen.queryByText("شعبهٔ اصلی")).toBeNull();
    expect(screen.queryByText(/از انتخابگر شعبه/)).toBeNull();
  });

  it("never calls the active branch home when the member has no home branch", () => {
    mount({ branch: { active: north, home: null, homeStatus: "unassigned", canSwitch: false } });
    expect(screen.getByText("شعبهٔ شمال")).toBeTruthy();
    expect(screen.queryByText("(شعبهٔ اصلی شما)")).toBeNull();
    expect(screen.getByText("شعبهٔ اصلی")).toBeTruthy();
    expect(screen.getByText("تعیین نشده")).toBeTruthy();
  });

  it("never calls the active branch home when the home branch is deactivated", () => {
    mount({ branch: { active: north, home: null, homeStatus: "unavailable", canSwitch: true } });
    expect(screen.queryByText("(شعبهٔ اصلی شما)")).toBeNull();
    expect(screen.getByText("شعبهٔ اصلی")).toBeTruthy();
    expect(screen.getByText(/دیگر فعال نیست/)).toBeTruthy();
  });

  it("shows no branch row at all when the server resolved none", () => {
    mount({ branch: null });
    expect(screen.queryByText("شعبهٔ فعال")).toBeNull();
    expect(screen.queryByText("شعبهٔ اصلی")).toBeNull();
  });
});

describe("#854 F02 — the biometric card follows the server's policy", () => {
  it("is absent when the server says there is nothing to offer", () => {
    mount({ role: "manager", showBiometric: false });
    expect(screen.queryByText("ورود بیومتریک (اثر انگشت / چهره)")).toBeNull();
    expect(screen.queryByText("webauthn-manager")).toBeNull();
  });

  it("is present when the role may enrol or already holds an authenticator", () => {
    mount({ showBiometric: true });
    expect(screen.getByText("ورود بیومتریک (اثر انگشت / چهره)")).toBeTruthy();
    expect(screen.getByText("webauthn-manager")).toBeTruthy();
  });
});

describe("#854 F01 — ending one other session goes through step-up", () => {
  it("opens the step-up prompt on recent_auth_required and then retries that exact session", async () => {
    let deletes = 0;
    routes["DELETE /api/sessions/self"] = (body) => {
      deletes += 1;
      expect(body).toEqual({ action: "revoke_one", sessionId: "s-other" });
      return deletes === 1
        ? json(403, { error: "recent_auth_required" })
        : json(200, { ok: true, action: "revoke_one", revokedCount: 1, signedOut: false });
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "خاتمه دادن" }));

    const pin = await stepUpPinField("تأیید مجدد هویت برای خاتمه دادن به نشست‌ها");
    fireEvent.change(pin, { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: "تأیید" }));

    await screen.findByText("نشست انتخاب‌شده خاتمه یافت.");
    expect(deletes).toBe(2);
    expect(posts("/api/auth/step-up").at(-1)?.body).toEqual({ method: "pin", credential: "4821" });
  });

  it("cancelling the step-up sends no second revocation", async () => {
    routes["DELETE /api/sessions/self"] = () => json(403, { error: "recent_auth_required" });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "خاتمه دادن" }));
    await screen.findByText("تأیید مجدد هویت برای خاتمه دادن به نشست‌ها");
    fireEvent.click(screen.getAllByRole("button", { name: "انصراف" })[0]);
    await waitFor(() =>
      expect(screen.queryByText("تأیید مجدد هویت برای خاتمه دادن به نشست‌ها")).toBeNull(),
    );
    expect(posts("/api/sessions/self")).toHaveLength(1);
  });

  it("a session that is already gone refreshes the list instead of failing silently", async () => {
    routes["DELETE /api/sessions/self"] = () =>
      json(404, { error: "session_not_found", message: "نشست موردنظر یافت نشد." });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "خاتمه دادن" }));
    await screen.findByText("نشست موردنظر یافت نشد.");
    await waitFor(() =>
      expect(recorded.filter((r) => r.method === "GET" && r.url === "/api/sessions/self").length).toBe(2),
    );
  });
});

describe("#854 F06 — a reloaded phone verification never sends a number", () => {
  function pendingChange() {
    routes["GET /api/auth/phone/self"] = () =>
      json(200, {
        phone: "+989121110001",
        phoneState: "verified",
        pendingChallenge: {
          maskedPhone: "+989***0002",
          purpose: "change_login_phone",
          requestedAt: minutesAgo(2),
          expiresAt: minutesAhead(3),
        },
      });
  }

  it("resumes on the server's challenge and resends with action resend only", async () => {
    pendingChange();
    routes["POST /api/auth/phone/self"] = () =>
      json(200, {
        status: "sent",
        maskedPhone: "+989***0002",
        purpose: "change_login_phone",
        expiresInSeconds: 300,
      });
    mount();
    await screen.findByText(/کد ۶ رقمی ارسال‌شده به شمارهٔ جدید/);
    const resend = (await screen.findByRole("button", { name: "ارسال مجدد کد" })) as HTMLButtonElement;
    await waitFor(() => expect(resend.disabled).toBe(false));
    fireEvent.click(resend);
    await waitFor(() => expect(posts("/api/auth/phone/self")).toHaveLength(1));
    expect(posts("/api/auth/phone/self")[0].body).toEqual({ action: "resend" });
    await screen.findByText("کد تأیید دوباره ارسال شد.");
  });

  it("verifies with the code alone", async () => {
    pendingChange();
    routes["POST /api/auth/phone/self"] = () =>
      json(200, { status: "verified", purpose: "change_login_phone", maskedPhone: "+989***0002" });
    mount();
    const code = await screen.findByLabelText("کد ۶ رقمی تأیید");
    fireEvent.change(code, { target: { value: "۱۲۳۴۵۶" } });
    fireEvent.click(screen.getByRole("button", { name: "تأیید کد" }));
    await waitFor(() => expect(posts("/api/auth/phone/self")).toHaveLength(1));
    expect(posts("/api/auth/phone/self")[0].body).toEqual({ action: "verify", code: "123456" });
    await screen.findByText("شمارهٔ موبایل ورود شما تغییر کرد و تأیید شد.");
  });

  it("cancel burns the code on the server, then shows the idle card", async () => {
    pendingChange();
    routes["POST /api/auth/phone/self"] = () => {
      // After the cancel the server has nothing pending.
      routes["GET /api/auth/phone/self"] = () =>
        json(200, { phone: "+989121110001", phoneState: "verified", pendingChallenge: null });
      return json(200, { status: "cancelled", cancelled: 1 });
    };
    mount();
    await screen.findByText(/کد ۶ رقمی ارسال‌شده به شمارهٔ جدید/);
    // The PIN card has an «انصراف» only once opened; this is the phone card's.
    fireEvent.click(screen.getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(posts("/api/auth/phone/self")[0]?.body).toEqual({ action: "cancel" }));
    await screen.findByRole("button", { name: "تغییر شماره" });
    expect(screen.queryByLabelText("کد ۶ رقمی تأیید")).toBeNull();
  });

  it("an expired challenge on resend resets to the start instead of looping", async () => {
    pendingChange();
    routes["POST /api/auth/phone/self"] = () => {
      routes["GET /api/auth/phone/self"] = () =>
        json(200, { phone: "+989121110001", phoneState: "verified", pendingChallenge: null });
      return json(400, {
        error: "challenge_expired",
        message: "زمان کد تأیید به پایان رسیده است؛ کد تازه‌ای درخواست کنید.",
      });
    };
    mount();
    const resend = (await screen.findByRole("button", { name: "ارسال مجدد کد" })) as HTMLButtonElement;
    await waitFor(() => expect(resend.disabled).toBe(false));
    fireEvent.click(resend);
    await screen.findByText("زمان کد تأیید به پایان رسیده است؛ کد تازه‌ای درخواست کنید.");
    await screen.findByRole("button", { name: "تغییر شماره" });
  });

  it("a lapsed code offers a fresh start rather than a dead form", async () => {
    routes["GET /api/auth/phone/self"] = () =>
      json(200, {
        phone: "+989121110001",
        phoneState: "unverified",
        pendingChallenge: {
          maskedPhone: "+989***0001",
          purpose: "verify_login_phone",
          requestedAt: minutesAgo(6),
          expiresAt: minutesAgo(1),
        },
      });
    mount();
    await screen.findByText(/اعتبار این کد تمام شده است/);
    expect(screen.queryByLabelText("کد ۶ رقمی تأیید")).toBeNull();
    expect(screen.getByRole("button", { name: "درخواست کد تازه" })).toBeTruthy();
  });
});

describe("#854 F11 — a read-only login phone renders no form at all", () => {
  it("hides even a pending verification adopted from the server", async () => {
    routes["GET /api/auth/phone/self"] = () =>
      json(200, {
        phone: "+989121110001",
        phoneState: "unverified",
        pendingChallenge: {
          maskedPhone: "+989***0002",
          purpose: "change_login_phone",
          requestedAt: minutesAgo(2),
          expiresAt: minutesAhead(3),
        },
      });
    mount({
      credentialSurfaces: {
        login_phone: {
          field: "login_phone",
          editable: false,
          readOnly: true,
          notice: "این مورد در نسخهٔ ابری مدیریت می‌شود.",
        },
      },
    });
    await screen.findAllByText("این مورد در نسخهٔ ابری مدیریت می‌شود.");
    await waitFor(() =>
      expect(recorded.some((r) => r.url === "/api/auth/phone/self" && r.method === "GET")).toBe(true),
    );
    await screen.findByText("تأییدنشده");
    expect(screen.queryByLabelText("کد ۶ رقمی تأیید")).toBeNull();
    expect(screen.queryByRole("button", { name: "ارسال مجدد کد" })).toBeNull();
    expect(screen.queryByRole("button", { name: "تغییر شماره" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ارسال کد تأیید" })).toBeNull();
  });
});

describe("#854 F08 / F07 — the PIN card", () => {
  async function openPinForm() {
    fireEvent.click(await screen.findByRole("button", { name: "تغییر رمز عددی" }));
    return {
      current: (await screen.findByLabelText("رمز عددی فعلی")) as HTMLInputElement,
      next: screen.getByLabelText(/^رمز عددی جدید/) as HTMLInputElement,
      confirm: screen.getByLabelText("تکرار رمز عددی جدید") as HTMLInputElement,
    };
  }

  it("masks all three fields, keeps the numeric keyboard, and normalises Persian digits", async () => {
    mount();
    const fields = await openPinForm();
    for (const input of [fields.current, fields.next, fields.confirm]) {
      expect(input.type).toBe("password");
      expect(input.inputMode).toBe("numeric");
      expect(input.getAttribute("autocomplete")).toBe("off");
    }
    fireEvent.change(fields.next, { target: { value: "۵۶٧۸" } });
    expect(fields.next.value).toBe("5678");
  });

  it("refuses an unchanged PIN before sending anything", async () => {
    mount();
    const fields = await openPinForm();
    fireEvent.change(fields.current, { target: { value: "4821" } });
    fireEvent.change(fields.next, { target: { value: "4821" } });
    fireEvent.change(fields.confirm, { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ رمز عددی" }));
    await screen.findByText("رمز عددی جدید باید با رمز فعلی متفاوت باشد.");
    expect(posts("/api/auth/pin/self")).toHaveLength(0);
  });

  it("translates the server's pin_unchanged", async () => {
    routes["POST /api/auth/pin/self"] = () => json(400, { error: "pin_unchanged" });
    mount();
    const fields = await openPinForm();
    fireEvent.change(fields.current, { target: { value: "4821" } });
    fireEvent.change(fields.next, { target: { value: "1357" } });
    fireEvent.change(fields.confirm, { target: { value: "1357" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ رمز عددی" }));
    await screen.findByText("رمز عددی جدید باید با رمز فعلی متفاوت باشد.");
  });

  it("retries the same change after a step-up instead of dropping it", async () => {
    let attempts = 0;
    routes["POST /api/auth/pin/self"] = (body) => {
      attempts += 1;
      expect(body).toEqual({ currentPin: "4821", newPin: "1357", confirmPin: "1357" });
      return attempts === 1 ? json(403, { error: "recent_auth_required" }) : json(200, { ok: true, hasPin: true });
    };
    mount();
    const fields = await openPinForm();
    fireEvent.change(fields.current, { target: { value: "4821" } });
    fireEvent.change(fields.next, { target: { value: "1357" } });
    fireEvent.change(fields.confirm, { target: { value: "1357" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ رمز عددی" }));

    const stepUpPin = await stepUpPinField("تأیید مجدد هویت");
    fireEvent.change(stepUpPin, { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: "تأیید" }));

    await screen.findByText("رمز عددی شما تغییر کرد. از این پس با رمز عددی جدید وارد می‌شوید.");
    expect(attempts).toBe(2);
  });

  it("a read-only PIN surface offers no change button", async () => {
    mount({
      credentialSurfaces: {
        staff_pin: { field: "staff_pin", editable: false, readOnly: true, notice: "مدیریت در نسخهٔ ابری" },
      },
    });
    await screen.findByText("رمز عددی فعال است");
    expect(screen.queryByRole("button", { name: "تغییر رمز عددی" })).toBeNull();
  });
});
