// @vitest-environment jsdom

/**
 * #854 follow-up — rendered contracts for the shared step-up prompt.
 *
 *  - **F03**: WebAuthn is never rendered as a typed field. Even a stale server
 *    that still lists it gets no button and no input from this component, and
 *    nothing is ever posted with `method: "webauthn"`.
 *  - **F08**: the PIN door is a masked field that still opens the numeric
 *    keyboard and turns Persian/Arabic digits into the ASCII the server checks.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StepUpPrompt } from "./step-up-prompt";

interface Recorded {
  method: string;
  body: Record<string, unknown> | null;
}

let available: string[];
const recorded: Recorded[] = [];

beforeEach(() => {
  recorded.length = 0;
  available = ["pin"];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      recorded.push({ method, body });
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            availableMethods: available,
            methodLabels: {
              password: "رمز عبور",
              pin: "رمز عددی دستگاه",
              totp: "کد برنامهٔ احرازکننده",
              webauthn: "ورود زیست‌سنجی",
            },
            hasPassword: available.includes("password"),
            hasPin: available.includes("pin"),
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#854 F03 — no text field ever stands in for WebAuthn", () => {
  it("drops a WebAuthn method a stale server still advertises", async () => {
    available = ["password", "webauthn"];
    render(<StepUpPrompt open onCancel={() => {}} onVerified={() => {}} />);
    // Only one verifiable method is left, so no picker is rendered at all.
    await screen.findByLabelText("رمز عبور");
    expect(screen.queryByText("ورود زیست‌سنجی")).toBeNull();
    expect(screen.queryByRole("button", { name: "ورود زیست‌سنجی" })).toBeNull();
  });

  it("an account whose only advertised method is WebAuthn is told it has no usable door", async () => {
    available = ["webauthn"];
    render(<StepUpPrompt open onCancel={() => {}} onVerified={() => {}} />);
    await screen.findByText(/روش تأیید هویتی ثبت نشده است/);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect((screen.getByRole("button", { name: "تأیید" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("never posts method webauthn", async () => {
    available = ["webauthn", "pin"];
    render(<StepUpPrompt open onCancel={() => {}} onVerified={() => {}} />);
    const input = await screen.findByLabelText("رمز عددی دستگاه");
    fireEvent.change(input, { target: { value: "4821" } });
    fireEvent.click(screen.getByRole("button", { name: "تأیید" }));
    await waitFor(() => expect(recorded.some((r) => r.method === "POST")).toBe(true));
    expect(recorded.filter((r) => r.method === "POST").every((r) => r.body?.method !== "webauthn")).toBe(
      true,
    );
  });
});

describe("#854 F08 — the PIN step-up is masked and normalised", () => {
  it("renders a password-type field with the numeric keyboard and no autofill", async () => {
    render(<StepUpPrompt open onCancel={() => {}} onVerified={() => {}} />);
    const input = (await screen.findByLabelText("رمز عددی دستگاه")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.inputMode).toBe("numeric");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.maxLength).toBe(12);
  });

  it("turns Persian and Arabic-Indic digits into ASCII and drops everything else", async () => {
    const onVerified = vi.fn();
    render(<StepUpPrompt open onCancel={() => {}} onVerified={onVerified} />);
    const input = (await screen.findByLabelText("رمز عددی دستگاه")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "۴٨-۲ ١" } });
    expect(input.value).toBe("4821");

    fireEvent.click(screen.getByRole("button", { name: "تأیید" }));
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    const post = recorded.find((r) => r.method === "POST");
    expect(post?.body).toEqual({ method: "pin", credential: "4821" });
  });

  it("keeps the password field a password field", async () => {
    available = ["password"];
    render(<StepUpPrompt open onCancel={() => {}} onVerified={() => {}} />);
    const input = (await screen.findByLabelText("رمز عبور")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("current-password");
  });
});
