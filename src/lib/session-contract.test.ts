/**
 * Issue #854 (P1.4 / P1.5 / P2.27) — the session card's contract.
 *
 * Three findings, three pinned behaviours:
 *
 *  - the UI read `startedAt` while the route returned `issuedAt`, so the date
 *    column rendered empty for every row;
 *  - `lastSeenAt` is null for a session nobody has used yet, and the UI has to
 *    fall back rather than print an invalid date;
 *  - the revoke actions must describe what they *reach*, because that is what
 *    the confirmation dialog shows.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SESSION_LOGIN_METHODS,
  SESSION_REVOKE_ACTIONS,
  describeDevice,
  isSessionLoginMethod,
  isSessionRevokeAction,
  sessionActivityIso,
  sessionLoginMethodLabel,
  sessionRevokeDescription,
  type SelfSessionView,
} from "./session-contract";

function view(overrides: Partial<SelfSessionView> = {}): SelfSessionView {
  return {
    id: "s1",
    businessId: "b1",
    businessName: "کافه",
    locationId: "l1",
    locationName: "شعبهٔ مرکزی",
    deviceLabel: "Chrome روی Windows",
    userAgent: null,
    loginMethod: "password",
    issuedAt: "2026-01-01T10:00:00.000Z",
    lastSeenAt: null,
    expiresAt: "2026-01-02T10:00:00.000Z",
    isCurrent: false,
    ...overrides,
  };
}

describe("sessionActivityIso", () => {
  it("falls back to issuedAt for a session never seen since it was minted", () => {
    expect(sessionActivityIso(view())).toBe("2026-01-01T10:00:00.000Z");
  });

  it("prefers the real activity timestamp when there is one", () => {
    expect(sessionActivityIso(view({ lastSeenAt: "2026-01-01T12:30:00.000Z" }))).toBe(
      "2026-01-01T12:30:00.000Z",
    );
  });
});

describe("revoke actions", () => {
  it("knows exactly the three actions the route implements", () => {
    expect([...SESSION_REVOKE_ACTIONS]).toEqual(["revoke_one", "revoke_others", "revoke_all"]);
    for (const action of SESSION_REVOKE_ACTIONS) {
      expect(isSessionRevokeAction(action)).toBe(true);
      expect(sessionRevokeDescription(action).length).toBeGreaterThan(0);
    }
    expect(isSessionRevokeAction("revoke_everything")).toBe(false);
    expect(isSessionRevokeAction(undefined)).toBe(false);
  });

  it("says a business-scoped revoke does not touch other businesses", () => {
    expect(sessionRevokeDescription("revoke_others")).toContain(
      "کسب‌وکارهای دیگر بسته نمی‌شوند",
    );
  });

  it("says the global sign-out reaches every business and ends impersonation", () => {
    const description = sessionRevokeDescription("revoke_all");
    expect(description).toContain("همهٔ کسب‌وکارها");
    expect(description).toContain("پشتیبانی");
  });
});

describe("login method labels", () => {
  it("labels every method, and nothing else", () => {
    for (const method of SESSION_LOGIN_METHODS) {
      expect(isSessionLoginMethod(method)).toBe(true);
      expect(sessionLoginMethodLabel(method)).toBeTruthy();
    }
    expect(isSessionLoginMethod("fax")).toBe(false);
    expect(sessionLoginMethodLabel(null)).toBeNull();
  });

  it("gives every door its own label, so two different doors never read the same", () => {
    const labels = SESSION_LOGIN_METHODS.map((method) => sessionLoginMethodLabel(method));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names the doors that open a session without a sign-in form (#854 follow-up, third pass)", () => {
    expect(sessionLoginMethodLabel("business_switch")).toBe("تغییر کسب‌وکار");
    expect(sessionLoginMethodLabel("setup")).toBe("راه‌اندازی اولیه");
    expect(sessionLoginMethodLabel("desktop_handoff")).toBe("ورود از برنامهٔ دسکتاپ");
    expect(sessionLoginMethodLabel("company_handoff")).toBe("ورود از کنسول مدیریت");
  });

  it("names the desktop's cloud-account sign-in for what it is — not a local password or PIN", () => {
    expect(sessionLoginMethodLabel("cloud_account")).toBe("ورود با حساب ابری");
    expect(sessionLoginMethodLabel("cloud_account")).not.toBe(sessionLoginMethodLabel("password"));
    expect(sessionLoginMethodLabel("cloud_account")).not.toBe(sessionLoginMethodLabel("pin"));
    expect(isSessionLoginMethod("cloud_account")).toBe(true);
  });

  it("is exactly the list the database constraint accepts, as of the latest migration that defines it", () => {
    // A door added here but not to the CHECK would make createSession throw at
    // sign-in; one added to the CHECK but not here would render unlabelled.
    const dir = join(process.cwd(), "migrations");
    const latest = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .filter((sql) => /ADD CONSTRAINT employee_sessions_login_method_check/.test(sql))
      .at(-1);
    expect(latest).toBeTruthy();
    const list = /employee_sessions_login_method_check[\s\S]*?IN \(([\s\S]*?)\)/.exec(latest!)?.[1] ?? "";
    const accepted = [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect([...accepted].sort()).toEqual([...SESSION_LOGIN_METHODS].sort());
  });
});

describe("describeDevice", () => {
  it("names a browser and platform a person recognises", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      ),
    ).toBe("Chrome · Windows");
  });

  it("prefers the desktop shell when the request comes from Electron", () => {
    /**
     * The packaged desktop app is not "some browser" to a person reading the
     * list — and the Electron shell's UA does carry the platform, so the
     * second half survives.
     */
    expect(
      describeDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/28.0 Chrome/120.0 Safari/537.36",
      ),
    ).toBe("برنامهٔ دسکتاپ · macOS");
  });

  it("returns null rather than inventing a device", () => {
    expect(describeDevice(null)).toBeNull();
    expect(describeDevice("   ")).toBeNull();
    expect(describeDevice("curl/8.0")).toBe("curl/8.0");
  });
});
