// @vitest-environment jsdom

/**
 * GitHub #1580 — the two inline write affordances added after the first slice.
 *
 * These are real renderings (jsdom) driving the components the wizard mounts:
 *
 *  1. **Activation** must show the canonical quote, refuse to submit when the
 *     wallet is short, and — when it is affordable — POST exactly one explicit
 *     `activate` with an idempotency key. It must never fire on render.
 *  2. **Manual party entry** must POST the canonical party payload (role, name,
 *     mobile) and show the created record, or the server's validation message.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { SetupActivationPanel } from "./activation-panel";
import { SetupPartyManualForm } from "./party-manual-form";

let fetchMock: ReturnType<typeof vi.fn>;

function stub(handler: (url: string, init?: RequestInit) => Response | undefined) {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return handler(url, init) ?? new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function calls(url: string, method: string) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === url && ((init as RequestInit | undefined)?.method ?? "GET") === method,
  );
}

function quote(overrides: Record<string, unknown> = {}) {
  return {
    eligible: true,
    reason: "ready",
    setupRial: 0,
    hourlyRial: 0,
    firstHourRial: 0,
    reserveRial: 0,
    walletBalanceRial: 0,
    balanceAfterSetupRial: 0,
    setupWaivedReason: "complimentary_grant",
    rentalWaived: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SetupActivationPanel", () => {
  it("shows the canonical quote and never activates on render", async () => {
    stub((url, init) => {
      if (url === "/api/services/app/accounting" && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            activation: null,
            quote: quote(),
            commercial: { purchasable: true, activationState: "pending" },
          }),
          { status: 200 },
        );
      }
      return undefined;
    });

    render(
      <MoneyProvider unit="toman">
        <SetupActivationPanel
          apps={[{ appKey: "accounting", label: "حسابداری" }]}
          onActivated={() => {}}
        />
      </MoneyProvider>,
    );

    await waitFor(() => expect(screen.getByText("حسابداری")).toBeTruthy());
    expect(screen.getAllByText(/رایگان/).length).toBeGreaterThan(0);
    // Reading the quote is not an activation.
    expect(calls("/api/services/app/accounting", "POST")).toHaveLength(0);
  });

  it("refuses the button when the wallet cannot cover the first interval", async () => {
    stub((url, init) => {
      if (url === "/api/services/app/accounting" && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            activation: null,
            quote: quote({
              setupWaivedReason: null,
              rentalWaived: false,
              reserveRial: 900_000,
              setupRial: 900_000,
              walletBalanceRial: 100_000,
            }),
            commercial: { purchasable: true, activationState: "pending" },
          }),
          { status: 200 },
        );
      }
      return undefined;
    });

    render(
      <MoneyProvider unit="toman">
        <SetupActivationPanel
          apps={[{ appKey: "accounting", label: "حسابداری" }]}
          onActivated={() => {}}
        />
      </MoneyProvider>,
    );

    await waitFor(() => expect(screen.getByText(/کم است/)).toBeTruthy());
    const button = screen.getByRole("button", { name: /فعال‌سازی/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(calls("/api/services/app/accounting", "POST")).toHaveLength(0);
  });

  it("activates once, explicitly, with an idempotency key", async () => {
    let activated = false;
    stub((url, init) => {
      if (url === "/api/services/app/accounting" && (init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            activation: null,
            quote: quote(),
            commercial: { purchasable: true, activationState: "pending" },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/services/app/accounting" && init?.method === "POST") {
        activated = true;
        return new Response(JSON.stringify({ status: "activated" }), { status: 200 });
      }
      return undefined;
    });

    const onActivated = vi.fn();
    render(
      <MoneyProvider unit="toman">
        <SetupActivationPanel
          apps={[{ appKey: "accounting", label: "حسابداری" }]}
          onActivated={onActivated}
        />
      </MoneyProvider>,
    );

    const button = await screen.findByRole("button", { name: /فعال‌سازی/ });
    fireEvent.click(button);

    await waitFor(() => expect(activated).toBe(true));
    const posts = calls("/api/services/app/accounting", "POST");
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0][1]?.body));
    expect(body.action).toBe("activate");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(10);
    await waitFor(() => expect(onActivated).toHaveBeenCalled());
  });
});

describe("SetupPartyManualForm", () => {
  it("creates a party through the canonical endpoint with the chosen role", async () => {
    stub((url, init) => {
      if (url === "/api/parties" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ party: { displayName: "علی رضایی" } }),
          { status: 201 },
        );
      }
      return undefined;
    });

    render(<SetupPartyManualForm />);
    fireEvent.change(screen.getByLabelText("نام"), {
      target: { value: "علی رضایی" },
    });
    fireEvent.change(screen.getByLabelText("موبایل (اختیاری)"), {
      target: { value: "09121112233" },
    });
    fireEvent.click(screen.getByRole("button", { name: /افزودن/ }));

    await waitFor(() =>
      expect(
        screen.getAllByText(/مشتری «علی رضایی» ثبت شد/).length,
      ).toBeGreaterThan(0),
    );
    const posts = calls("/api/parties", "POST");
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0][1]?.body));
    expect(body).toMatchObject({
      displayName: "علی رضایی",
      role: "Customer",
      roles: ["Customer"],
      personType: "Real",
      contact_info: { mobile: "09121112233" },
    });
  });

  it("surfaces a server field error instead of claiming success", async () => {
    stub((url, init) => {
      if (url === "/api/parties" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ error: "validation_failed", fieldErrors: { displayName: "name_required" } }),
          { status: 400 },
        );
      }
      return undefined;
    });

    render(<SetupPartyManualForm />);
    fireEvent.change(screen.getByLabelText("نام"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /افزودن/ }));

    await waitFor(() =>
      expect(screen.queryAllByText(/ثبت شد/)).toHaveLength(0),
    );
    expect(screen.getByRole("alert").textContent?.length ?? 0).toBeGreaterThan(0);
  });
});
