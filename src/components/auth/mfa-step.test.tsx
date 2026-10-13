// @vitest-environment jsdom
/**
 * Issue #885, gap 5 — a 200 is not a verification.
 *
 * `submitVerify` read the body with `res.json().catch(() => ({}))`. That catch
 * is deliberate: a proxy error page or an HTML 502 must not throw out of the
 * submit handler, because an unhandled rejection there is exactly the stuck
 * «در حال ورود…» button L05 was about. But it also means `data` can legitimately
 * be `{}`, and the handler then treated "the request succeeded" as "the factor
 * was accepted" and called `onVerified()` — handing the parent a completed
 * login on an empty object, a truncated response, or an error page that
 * happened to carry a 200.
 *
 * Only the route's explicit `status: "verified"` verdict may complete the
 * step now. Each case below returns a 200 and asserts whether the parent was
 * told the login finished, because that callback — not the status code — is
 * what mints the session in the UI.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MfaStep } from "./mfa-step";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A 200 whose body is `body`, or raw text when `raw` is given. */
function stubVerify(status: number, body: unknown, raw?: string) {
  const text = raw ?? JSON.stringify(body);
  const fetchMock = vi.fn(async () =>
    new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderStep(onVerified: () => void) {
  return render(
    <MfaStep
      mfaToken="mfa-pending-token"
      mfaMethod="totp"
      availableMethods={["totp"]}
      onVerified={onVerified}
      onCancel={() => {}}
    />,
  );
}

/** Type the six digits and submit. */
function submitCode() {
  fireEvent.change(screen.getByLabelText("کد تأیید ۶ رقمی"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "تأیید و ورود" }));
}

describe("MFA verify response contract (gap 5)", () => {
  it("completes the step only on the route's explicit verified verdict", async () => {
    stubVerify(200, { status: "verified", user: { id: "u1" } });
    const onVerified = vi.fn();
    renderStep(onVerified);

    submitCode();

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
  });

  it("does not complete the step on a 200 with an empty object", async () => {
    // The exact shape the `.catch(() => ({}))` fallback produces. Before the
    // fix this was indistinguishable from success and called onVerified().
    stubVerify(200, {});
    const onVerified = vi.fn();
    renderStep(onVerified);

    submitCode();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBeTruthy(),
    );
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("does not complete the step on a 200 whose body is malformed JSON", async () => {
    // A truncated response or a proxy that returned 200 with garbage. The
    // parse fails, the fallback yields {}, and the step must refuse.
    stubVerify(200, null, "<html><body>502 Bad Gateway</body></html>");
    const onVerified = vi.fn();
    renderStep(onVerified);

    submitCode();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBeTruthy());
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("does not complete the step on a 200 carrying an error page", async () => {
    // A CDN that answers 200 for an upstream failure. Well-formed JSON, but
    // not the route's verdict.
    stubVerify(200, { error: "upstream_unavailable" });
    const onVerified = vi.fn();
    renderStep(onVerified);

    submitCode();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBeTruthy());
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("reports a wrong code as before", async () => {
    stubVerify(401, { error: "invalid_code" });
    const onVerified = vi.fn();
    renderStep(onVerified);

    submitCode();

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBeTruthy());
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("hands recovery codes to the handover sheet instead of completing", async () => {
    stubVerify(200, { status: "verified", recoveryCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] });
    const onVerified = vi.fn();
    renderStep(onVerified);

    submitCode();

    await waitFor(() =>
      expect(screen.getByText("کدهای بازیابی یک‌بارمصرف")).toBeTruthy(),
    );
    // The member has not confirmed they saved the codes yet, so the session
    // handover waits for that explicit click.
    expect(onVerified).not.toHaveBeenCalled();
  });
});
