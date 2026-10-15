// @vitest-environment jsdom

/**
 * #854 follow-up — the sidebar menu's «خروج» and «تعویض حساب», rendered.
 *
 * The menu used to navigate whatever `/api/auth/logout` answered (a 5xx looked
 * exactly like a sign-out) and to fail silently offline after its panel had
 * already closed. These tests drive the real Radix menu against a fake server
 * and pin what the member is told (a toast — the panel is gone by then), where
 * they end up, and that every failure leaves a working retry.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/dashboard" }));
vi.mock("@/components/bug-report/bug-report-provider", () => ({
  useBugReport: () => ({ openReport: vi.fn() }),
}));
const toast = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
const loginDoor = vi.hoisted(() => ({ clearRememberedLoginDoor: vi.fn() }));
vi.mock("@/lib/login-door", () => loginDoor);

import { PlatformUserMenu } from "./platform-user-menu";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type Answer = { status: number; data: unknown } | "reject";
let answers: Record<string, Answer[]>;
const posted: string[] = [];

const signedOut = { status: 200, data: { ok: true, outcome: "revoked", sessionCookieCleared: true, pendingRevocations: 0 } };
const unconfirmed = {
  status: 503,
  data: { ok: false, outcome: "unconfirmed", sessionCookieCleared: true, pendingRevocations: 1, error: "logout_unconfirmed" },
};
const retryConfirmed = {
  status: 200,
  data: { ok: true, outcome: "revoked", sessionCookieCleared: false, pendingRevocations: 0 },
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  posted.length = 0;
  answers = {};
  for (const fn of [router.replace, router.refresh, router.push, loginDoor.clearRememberedLoginDoor]) fn.mockReset();
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

function mount(role = "owner") {
  return render(<PlatformUserMenu role={role} fullName="سارا" />);
}

async function choose(label: string) {
  const trigger = screen.getByRole("button", { name: /سارا/ });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const item = await screen.findByRole("menuitem", { name: label });
  fireEvent.click(item);
}

/** The retry wired into the most recent toast of this kind. */
function toastRetry(kind: "error" | "warning"): () => void {
  const call = toast[kind].mock.calls.at(-1);
  if (!call) throw new Error(`no ${kind} toast was raised`);
  const options = call[1] as { action?: { label: string; onClick: () => void }; duration?: number; closeButton?: boolean };
  expect(options.action?.label).toBe("تلاش دوباره");
  // A security warning stays until it is read and dismissed.
  expect(options.duration).toBe(Number.POSITIVE_INFINITY);
  expect(options.closeButton).toBe(true);
  return options.action!.onClick;
}

describe("«خروج» from the sidebar menu", () => {
  it("leaves for the role's door only after a confirmed sign-out, clearing any old warning", async () => {
    answers["/api/auth/logout"] = [signedOut];
    mount("owner");
    await choose("خروج");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin"));
    expect(router.refresh).toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("sends a PIN role back to the staff door", async () => {
    answers["/api/auth/logout"] = [signedOut];
    mount("cashier");
    await choose("خروج");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("a server failure stays put, says the session may still be open, and the retry works", async () => {
    answers["/api/auth/logout"] = [{ status: 500, data: { error: "internal" } }, signedOut];
    mount("owner");
    await choose("خروج");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toMatch(/ممکن است هنوز باز باشد/);
    expect(router.replace).not.toHaveBeenCalled();

    // Busy is released: the item is usable again.
    fireEvent.keyDown(screen.getByRole("button", { name: /سارا/ }), { key: "Enter" });
    const item = await screen.findByRole("menuitem", { name: "خروج" });
    expect(item.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.keyDown(item, { key: "Escape" });

    toastRetry("error")();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin"));
    expect(posted.filter((p) => p === "POST /api/auth/logout")).toHaveLength(2);
  });

  it("a dropped connection is not a sign-out", async () => {
    answers["/api/auth/logout"] = ["reject"];
    mount("owner");
    await choose("خروج");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toMatch(/نشست شما هنوز باز است/);
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("an unconfirmed end leaves (the cookie is gone) with a warning whose retry uses the ticket", async () => {
    answers["/api/auth/logout"] = [unconfirmed];
    answers["/api/auth/logout/retry"] = [retryConfirmed];
    mount("owner");
    await choose("خروج");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0][0]).toMatch(/از این دستگاه خارج شدید/);

    toastRetry("warning")();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success.mock.calls[0][0]).toBe("نشست روی سرور هم پایان یافت.");
    expect(posted).toEqual(["POST /api/auth/logout", "POST /api/auth/logout/retry"]);
  });

  it("a retry that still cannot confirm keeps warning, with another retry", async () => {
    answers["/api/auth/logout"] = [unconfirmed];
    answers["/api/auth/logout/retry"] = [{ ...unconfirmed, data: { ...unconfirmed.data, sessionCookieCleared: false } }];
    mount("owner");
    await choose("خروج");
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    toastRetry("warning")();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(2));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning.mock.calls[1][0]).toMatch(/از این دستگاه خارج شدید/);
  });
});

describe("«تعویض حساب» from the sidebar menu", () => {
  it("forgets the remembered door and lands on the chooser after a confirmed sign-out", async () => {
    answers["/api/auth/logout"] = [signedOut];
    mount("owner");
    await choose("تعویض حساب");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(loginDoor.clearRememberedLoginDoor).toHaveBeenCalled();
  });

  it("never switches while the old session may still be open, and its retry switches", async () => {
    answers["/api/auth/logout"] = ["reject", signedOut];
    mount("owner");
    await choose("تعویض حساب");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(router.replace).not.toHaveBeenCalled();
    toastRetry("error")();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
  });

  it("switches when the cookie is cleared despite a server error, and says the old session is unconfirmed", async () => {
    answers["/api/auth/logout"] = [unconfirmed];
    mount("manager");
    await choose("تعویض حساب");
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(toast.warning.mock.calls[0][0]).toMatch(/سرور پایان نشست را تأیید نکرد/);
  });
});
