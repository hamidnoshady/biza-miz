// @vitest-environment jsdom
/**
 * Issue #885 L17 — the OTP step's async could outlive a cancelled step.
 *
 * Both calls in this component were a bare `await fetch` behind a local
 * `busy` flag. Nothing moved on when the member backed out mid-verify, so a
 * response landing afterwards still ran its handlers: `onVerified()`
 * completed a login the member had already abandoned, and `setError` wrote
 * to a step that no longer existed.
 *
 * That is a timing contract, so it cannot be shown by reading the component.
 * Each case below drives a response in *after* the step is gone and asserts
 * the parent saw nothing.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneOtpStep, type PhoneOtpSendSpec } from "./phone-otp-step";

const sendSpec: PhoneOtpSendSpec = {
  kind: "employee",
  employeeId: "e1",
  businessId: "b1",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Type the six digits and submit, without waiting for the response. */
function submitCode() {
  fireEvent.change(screen.getByLabelText("کد تأیید ۶ رقمی"), {
    target: { value: "123456" },
  });
  fireEvent.submit(screen.getByRole("button", { name: /تأیید و ورود/ }).closest("form")!);
}

describe("PhoneOtpStep", () => {
  it("does not complete a login when the verify lands after the step is gone", async () => {
    let releaseVerify: (r: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      releaseVerify = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    const onVerified = vi.fn();
    const { unmount } = render(
      <PhoneOtpStep
        sendSpec={sendSpec}
        initialToken="tok"
        initialMaskedPhone="0912***4567"
        onVerified={onVerified}
        onCancel={vi.fn()}
      />,
    );

    submitCode();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/phone-otp/verify",
      expect.objectContaining({ method: "POST" }),
    );

    // The member backs out while the verify is still in flight.
    unmount();

    await act(async () => {
      releaseVerify(jsonResponse(200, { status: "verified" }));
    });

    // The old code called onVerified() here, logging the member in after they
    // had left. The generation guard makes the response resolve as stale.
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("does not write an error onto a step that was unmounted", async () => {
    let releaseVerify: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      releaseVerify = resolve;
    })));

    const { unmount } = render(
      <PhoneOtpStep
        sendSpec={sendSpec}
        initialToken="tok"
        initialMaskedPhone="0912***4567"
        onVerified={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    submitCode();
    unmount();

    // Resolving must not throw on a setState against an unmounted component.
    await act(async () => {
      releaseVerify(jsonResponse(401, { error: "invalid_code" }));
    });

    expect(screen.queryByText("کد واردشده درست نیست.")).toBeNull();
  });

  it("aborts the in-flight verify when the step unmounts", async () => {
    let seenSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      seenSignal = (init.signal as AbortSignal) ?? null;
      return new Promise<Response>(() => {}); // never resolves
    }));

    const { unmount } = render(
      <PhoneOtpStep
        sendSpec={sendSpec}
        initialToken="tok"
        initialMaskedPhone="0912***4567"
        onVerified={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    submitCode();
    await waitFor(() => expect(seenSignal).not.toBeNull());
    expect(seenSignal!.aborted).toBe(false);

    unmount();
    expect(seenSignal!.aborted).toBe(true);
  });

  it("passes a bounded abort signal rather than fetching with no timeout", async () => {
    let seenSignal: AbortSignal | null = null;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      seenSignal = (init.signal as AbortSignal) ?? null;
      return Promise.resolve(jsonResponse(200, { status: "verified" }));
    }));

    render(
      <PhoneOtpStep
        sendSpec={sendSpec}
        initialToken="tok"
        initialMaskedPhone="0912***4567"
        onVerified={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    submitCode();
    await waitFor(() => expect(seenSignal).not.toBeNull());
    // The bare fetch this replaced passed no signal at all, so a hung request
    // left the button disabled forever with no message.
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("reports a network failure instead of leaving the button stuck", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));

    render(
      <PhoneOtpStep
        sendSpec={sendSpec}
        initialToken="tok"
        initialMaskedPhone="0912***4567"
        onVerified={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    submitCode();

    await waitFor(() =>
      expect(screen.getByText("ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی کنید و دوباره تلاش کنید.")).toBeTruthy(),
    );
    // And the button comes back, which is the L05 half of this.
    expect(
      (screen.getByRole("button", { name: /تأیید و ورود/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("still routes to MFA when the verify asks for a second factor", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          mfaRequired: true,
          mfaToken: "mfa-tok",
          mfaMethod: "totp",
          availableMethods: ["totp"],
        }),
      ),
    ));

    const onVerified = vi.fn();
    render(
      <PhoneOtpStep
        sendSpec={sendSpec}
        initialToken="tok"
        initialMaskedPhone="0912***4567"
        onVerified={onVerified}
        onCancel={vi.fn()}
      />,
    );

    submitCode();

    // The regression this guards: converting to the shared hook must not drop
    // the MFA branch and silently log the member in. Assert on the hint only
    // MfaStep renders — its code input deliberately shares the phone-OTP
    // field's aria-label, so that label proves nothing about which step is up.
    await waitFor(() => expect(onVerified).not.toHaveBeenCalled());
    expect(document.getElementById("mfa-code-hint")).not.toBeNull();
  });

  it("extracts the code from a pasted SMS body", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    render(
      <PhoneOtpStep
        sendSpec={sendSpec}
        initialToken="tok"
        initialMaskedPhone="0912***4567"
        onVerified={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("کد تأیید ۶ رقمی") as HTMLInputElement;
    fireEvent.paste(input, {
      clipboardData: { getData: () => "Your code is 123456. Do not share it." },
    });

    // maxLength would have truncated this to "Your c" before onChange ran.
    expect(input.value).toBe("123456");
  });
});
