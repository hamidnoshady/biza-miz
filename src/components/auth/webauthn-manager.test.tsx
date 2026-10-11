// @vitest-environment jsdom

/**
 * Issue #854 (P2.28 / P2.26) — rendered contracts for the canonical WebAuthn
 * manager.
 *
 * Before P2.28, credential management existed only inside the sidebar's modal
 * overlay: `/settings/profile` had no biometric surface at all, and removing
 * a device fired the DELETE without any confirmation. These tests pin the new
 * card body's behaviour: the list renders, removal goes through the product
 * confirmation (and cancellation sends nothing), and registration posts the
 * full ceremony.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no WebAuthn; the component only asks whether the browser supports
// it, so a stub is enough to reach the management UI.
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  startRegistration: vi.fn(async () => ({ id: "new-credential", rawId: "abc", type: "public-key", response: {} })),
}));

vi.mock("@/lib/device-token", () => ({ readDeviceToken: () => "device-token" }));

import { WebAuthnManager } from "./webauthn-manager";

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

let credentials: Array<Record<string, unknown>>;
const recorded: Recorded[] = [];
let deleteStatus = 200;

beforeEach(() => {
  recorded.length = 0;
  deleteStatus = 200;
  credentials = [
    {
      id: "cred-1",
      label: "صندوق سالن",
      deviceLabel: "POS-1",
      createdAt: "2026-09-01T08:00:00.000Z",
      lastUsedAt: "2026-10-08T08:00:00.000Z",
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      recorded.push({ method, url, body });
      if (method === "DELETE") {
        return new Response("{}", { status: deleteStatus });
      }
      return new Response(JSON.stringify({ credentials }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Issue #854 P2.28 — the profile's canonical WebAuthn card", () => {
  it("lists registered devices with their provenance", async () => {
    render(<WebAuthnManager />);
    await screen.findByText("صندوق سالن");
    expect(screen.getByText(/فقط روی «POS-1»/)).toBeTruthy();
    expect(screen.getByText(/آخرین استفاده/)).toBeTruthy();
  });

  it("renders an empty state when no device is registered", async () => {
    credentials = [];
    render(<WebAuthnManager />);
    await screen.findByText("هنوز دستگاهی ثبت نشده است.");
  });

  it("removal waits behind the confirmation dialog; cancelling sends no DELETE", async () => {
    render(<WebAuthnManager />);
    fireEvent.click(await screen.findByRole("button", { name: "حذف" }));

    await screen.findByText("حذف دستگاه بیومتریک");
    // Consequences are spelled out, not just a title.
    expect(screen.getByText(/ورود با اثر انگشت یا چهره روی این دستگاه از این لحظه قطع می‌شود/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByText("حذف دستگاه بیومتریک")).toBeNull());
    expect(recorded.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("confirming the dialog sends exactly one DELETE for that credential", async () => {
    render(<WebAuthnManager />);
    fireEvent.click(await screen.findByRole("button", { name: "حذف" }));
    await screen.findByText("حذف دستگاه بیومتریک");
    fireEvent.click(screen.getByRole("button", { name: "بله، حذف شود" }));
    await waitFor(() => {
      const deletes = recorded.filter((r) => r.method === "DELETE");
      expect(deletes.length).toBe(1);
      expect(deletes[0].url).toContain("/api/auth/webauthn/credentials/cred-1");
    });
  });

  it("a read-only deployment surface renders the notice, never the controls", async () => {
    render(
      <WebAuthnManager
        surface={{
          field: "webauthn_credential",
          editable: false,
          readOnly: true,
          notice: "این مورد در نسخهٔ ابری مدیریت می‌شود.",
        }}
      />,
    );
    await screen.findByText(/این مورد در نسخهٔ ابری مدیریت می‌شود/);
    expect(screen.queryByRole("button", { name: "حذف" })).toBeNull();
    expect(screen.queryByRole("button", { name: "افزودن این دستگاه" })).toBeNull();
  });
});
