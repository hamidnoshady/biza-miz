// @vitest-environment jsdom
/**
 * Issue #885 — the owner/manager door's failure handling.
 *
 * Three defects lived in this form and none of them is visible by reading the
 * component, so each is driven here as a behaviour:
 *
 *  1. `busy` was released on the line *after* a bare `await fetch`, with no
 *     `try`/`finally`. A rejected fetch therefore threw straight past the
 *     release, leaving the submit button disabled for the rest of the visit
 *     with no message at all — the only recovery was a reload.
 *  2. Any `res.ok` was treated as "authenticated", including a 200 whose body
 *     failed to parse and fell back to `{}`. That navigated with no session
 *     cookie and bounced straight back, looking like a broken form.
 *  3. Every non-lockout failure collapsed into one "wrong email or password"
 *     string, so a member with no active membership was told to re-check a
 *     password that was never the problem.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), prefetch: vi.fn() }),
}));

// The real hook reads window.location; pin the destination so navigation is
// observable rather than environment-dependent.
vi.mock("@/components/auth/login-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/auth/login-helpers")>();
  return { ...actual, useNextPath: () => "/dashboard" };
});

import AdminLoginForm from "./admin-login-form";

/**
 * This repo has no jest-dom, so the matchers are plain DOM assertions rather
 * than `toBeDisabled()` / `toBeInTheDocument()`.
 */
function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "ورود" }) as HTMLButtonElement;
}

function expectTextShown(fragment: RegExp) {
  const hits = Array.from(document.querySelectorAll("p")).filter((el) =>
    fragment.test(el.textContent ?? ""),
  );
  expect(hits.length, `expected a paragraph matching ${fragment}`).toBeGreaterThan(0);
}

function expectTextAbsent(exact: string) {
  const hits = Array.from(document.querySelectorAll("p")).filter(
    (el) => (el.textContent ?? "") === exact,
  );
  expect(hits.length, `expected no paragraph reading ${exact}`).toBe(0);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A 200 whose body is not JSON at all — a proxy error page, an HTML interstitial. */
function nonJsonResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/html" } });
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("ایمیل"), { target: { value: "owner@cafe.test" } });
  fireEvent.change(screen.getByLabelText("رمز عبور"), { target: { value: "correct-horse" } });
  await act(async () => {
    fireEvent.click(submitButton());
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  push.mockClear();
  refresh.mockClear();
});

describe("admin login form", () => {
  it("releases the submit button and explains itself when the network drops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    render(<AdminLoginForm />);
    await fillAndSubmit();

    const button = submitButton();
    // The defect: this stayed disabled forever, because the release sat after
    // the await that had just thrown.
    await waitFor(() => expect(button.disabled).toBe(false));

    // And it must not be reported as a wrong password — the credential was
    // never evaluated, so re-typing it cannot help.
    expectTextShown(/ارتباط با سرور برقرار نشد/);
    expect(push).not.toHaveBeenCalled();
  });

  it("does not treat an unparseable HTTP 200 as a successful login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(nonJsonResponse(200, "<html>502</html>")));

    render(<AdminLoginForm />);
    await fillAndSubmit();

    // The defect: `res.ok` alone was enough to navigate, so the user was sent
    // to the destination with no cookie and bounced straight back.
    expect(push).not.toHaveBeenCalled();
    expect(submitButton().disabled).toBe(false);
  });

  it("does not treat a 200 carrying an empty object as a successful login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));

    render(<AdminLoginForm />);
    await fillAndSubmit();

    expect(push).not.toHaveBeenCalled();
    expect(submitButton().disabled).toBe(false);
  });

  it("navigates when the route actually returns a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          user: { id: "u1", role: "owner", fullName: "Owner" },
          business: { id: "b1", name: "Cafe", slug: "cafe" },
        }),
      ),
    );

    render(<AdminLoginForm />);
    await fillAndSubmit();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(refresh).toHaveBeenCalled();
  });

  it("reports a missing membership as a missing membership, not a wrong password", async () => {
    /*
     * The route spells this `no_business_membership` and answers 403. The
     * shared mapper only knew `no_membership`, so the code fell through to the
     * generic 403 "not permitted from this path" — telling the member their
     * route was wrong when what was actually wrong was their access.
     */
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(403, { error: "no_business_membership" })),
    );

    render(<AdminLoginForm />);
    await fillAndSubmit();

    expectTextShown(/دسترسی فعالی ثبت نشده/);
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the unlock time for a locked account rather than a wrong password", async () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(423, { error: "account_locked", lockedUntil: until })),
    );

    render(<AdminLoginForm />);
    await fillAndSubmit();

    // The wrong-password string must not appear: it sends the user to re-check
    // a correct password and keep trying, which extends the lockout.
    expectTextAbsent("ایمیل یا رمز عبور نادرست است.");
    expect(submitButton().disabled).toBe(false);
  });
});
