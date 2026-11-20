// @vitest-environment jsdom
/**
 * Picking a name on the staff roster without a pointer.
 *
 * The roster is the front door of a Local/Hybrid install, and every name on it
 * is a button — but until now the only way through the list was Tab (or a
 * mouse), and the arrows did nothing. Moving through the list and confirming a
 * name has to work from a keyboard, while clicking stays exactly as it was:
 * the same buttons, the same own Tab stops, the same click handler.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
}));

const fetchMock = vi.hoisted(() => vi.fn());

import LoginForm from "./login-form";

interface RosterEmployeeFixture {
  id: string;
  fullName: string;
  role: string;
  photoUrl: string | null;
  hasWebauthn: boolean;
  loginMode: "pin" | "otp" | "pin_then_otp";
  phoneState: "none" | "unverified" | "verified";
}

function member(id: string, fullName: string): RosterEmployeeFixture {
  return {
    id,
    fullName,
    role: "cashier",
    photoUrl: null,
    hasWebauthn: false,
    loginMode: "pin",
    phoneState: "verified",
  };
}

/** Five names, so Up/Down can be checked against a full three-wide row. */
const EMPLOYEES = [
  member("e1", "آرش رضایی"),
  member("e2", "بهار محمدی"),
  member("e3", "پرویز کریمی"),
  member("e4", "تینا صادقی"),
  member("e5", "حسین موسوی"),
];

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, headers: new Headers() };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  window.localStorage.clear();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/login-capabilities")) {
      return jsonResponse({
        deploymentProfile: "local",
        localServer: true,
        phoneOtpEnforcement: "off",
        phoneOtpDaysLeft: null,
      });
    }
    if (url.includes("/api/auth/pin-login/roster")) {
      return jsonResponse({
        employees: EMPLOYEES,
        policy: { state: "off", daysLeft: null, enforcedAt: null },
        credentialSync: null,
      });
    }
    return jsonResponse({});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The name buttons, in the order the grid shows them. */
function rosterButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-roster-member]"));
}

function focusedMemberId(): string | null {
  const active = document.activeElement as HTMLElement | null;
  return active?.getAttribute("data-roster-member") ?? null;
}

/** Render the form and wait for the roster, as a real browser would. */
async function renderRoster(): Promise<HTMLButtonElement[]> {
  render(<LoginForm />);
  await waitFor(() => expect(rosterButtons()).toHaveLength(EMPLOYEES.length));
  return rosterButtons();
}

/** What the person at the till sees once a name is confirmed. */
async function expectPinStepFor(id: string) {
  expect(await screen.findByRole("progressbar", { name: "پین وارد شده" })).toBeTruthy();
  const picked = EMPLOYEES.find((employee) => employee.id === id);
  expect(picked).toBeTruthy();
  expect(screen.getByText(picked!.fullName)).toBeTruthy();
}

describe("Login roster keyboard picking", () => {
  it("puts focus on the first name as soon as the list arrives", async () => {
    await renderRoster();

    // Without this the arrows below have nowhere to start, and the list is
    // only reachable by tabbing past the rest of the page.
    await waitFor(() => expect(focusedMemberId()).toBe(rosterButtons()[0].getAttribute("data-roster-member")));
  });

  it("moves through the names with the arrow keys, right-to-left", async () => {
    const buttons = await renderRoster();
    await waitFor(() => expect(focusedMemberId()).not.toBeNull());

    // The grid reads right-to-left, so "the next name" is to the left.
    fireEvent.keyDown(buttons[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(buttons[1]);

    fireEvent.keyDown(buttons[1], { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("moves a row of three with Up/Down and wraps only on the horizontal arrows", async () => {
    const buttons = await renderRoster();
    await waitFor(() => expect(focusedMemberId()).not.toBeNull());

    fireEvent.keyDown(buttons[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[3]);

    fireEvent.keyDown(buttons[3], { key: "ArrowUp" });
    expect(document.activeElement).toBe(buttons[0]);

    // No row above the first one: stay put rather than jump to an unrelated name.
    fireEvent.keyDown(buttons[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(buttons[0]);

    // The horizontal arrows step one name and wrap at the ends.
    fireEvent.keyDown(buttons[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    fireEvent.keyDown(buttons[buttons.length - 1], { key: "End" });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    fireEvent.keyDown(buttons[buttons.length - 1], { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("confirms the focused name with Enter", async () => {
    const user = userEvent.setup();
    const buttons = await renderRoster();
    await waitFor(() => expect(focusedMemberId()).not.toBeNull());

    const target = buttons[1];
    const id = target.getAttribute("data-roster-member")!;
    target.focus();

    await user.keyboard("{Enter}");

    await expectPinStepFor(id);
  });

  it("still opens a name on click", async () => {
    const user = userEvent.setup();
    const buttons = await renderRoster();
    await waitFor(() => expect(focusedMemberId()).not.toBeNull());

    const target = buttons[3];
    const id = target.getAttribute("data-roster-member")!;
    await user.click(target);

    await expectPinStepFor(id);
  });

  it("keeps every name as its own Tab stop", async () => {
    const buttons = await renderRoster();

    for (const button of buttons) {
      expect(button.tabIndex).toBe(0);
    }
  });
});
