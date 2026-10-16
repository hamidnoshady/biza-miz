// @vitest-environment jsdom

/**
 * #854 follow-up (third pass) — how the security center names the door a
 * session came through.
 *
 * Every door now opens an `employee_sessions` row, including the four that
 * open one without a sign-in form (business switch, first-run setup, the
 * desktop and company hand-offs). None of those carries a credential id, and
 * the card used to read "no credential id" as «پین» — so an owner's setup
 * session would have been listed as a PIN login. The recorded door now wins;
 * rows that recorded none keep the old credential-based label.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityCenterSettings } from "./security-center-settings";

const issuedAt = new Date(Date.now() - 5 * 60_000).toISOString();

function session(id: string, employeeName: string, loginMethod: string | null, credentialId: string | null = null) {
  return {
    id,
    employeeId: `employee-${id}`,
    employeeName,
    role: "owner",
    locationId: null,
    deviceLabel: null,
    credentialId,
    loginMethod,
    issuedAt,
    lastSeenAt: null,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

const SESSIONS = [
  session("1", "سارا", "business_switch"),
  session("2", "مالک", "setup"),
  session("3", "صندوق دسکتاپ", "desktop_handoff"),
  session("4", "کارمند شرکت", "company_handoff"),
  session("5", "رضا", "password"),
  session("6", "نیلوفر", null, "credential-1"),
  session("7", "علی", null, null),
  session("8", "مهدی", "cloud_account"),
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const reply = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/sessions") return reply(200, { sessions: SESSIONS });
      if (url.startsWith("/api/audit-log")) return reply(200, { entries: [] });
      if (url === "/api/security/lockouts") return reply(200, { lockouts: [] });
      // The phone-login card has its own suite; here it just shows its error state.
      return reply(404, { error: "not_found" });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function originOf(employeeName: string): Promise<string> {
  const name = await screen.findByText(employeeName);
  const row = name.closest("div.min-w-0") as HTMLElement;
  return within(row).getByText(/زمان ورود/).textContent ?? "";
}

describe("security center — the door each active session came through", () => {
  it("labels the doors without a sign-in form by the door, not as a PIN login", async () => {
    render(<SecurityCenterSettings />);
    expect(await originOf("سارا")).toMatch(/^تغییر کسب‌وکار · /);
    expect(await originOf("مالک")).toMatch(/^راه‌اندازی اولیه · /);
    expect(await originOf("صندوق دسکتاپ")).toMatch(/^ورود از برنامهٔ دسکتاپ · /);
    expect(await originOf("کارمند شرکت")).toMatch(/^ورود از کنسول مدیریت · /);
    expect(await originOf("رضا")).toMatch(/^ورود با رمز عبور · /);
  });

  it("names a desktop cloud-account session as such — no credential id no longer reads as a PIN login", async () => {
    render(<SecurityCenterSettings />);
    const origin = await originOf("مهدی");
    expect(origin).toMatch(/^ورود با حساب ابری · /);
    expect(origin).not.toMatch(/^پین/);
  });

  it("keeps the credential-based label for rows that recorded no door", async () => {
    render(<SecurityCenterSettings />);
    expect(await originOf("نیلوفر")).toMatch(/^بیومتریک · /);
    expect(await originOf("علی")).toMatch(/^پین · /);
  });
});
