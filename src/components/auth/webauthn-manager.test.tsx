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
 *
 * #854 follow-up:
 *  - **F02** — registration is offered only when the server's policy says the
 *    caller may enrol (`canRegister`), never by default;
 *  - **F09** — a removal that fails on the wire releases the buttons, keeps the
 *    list, explains itself, and can be retried;
 *  - **F12** — an unsupported browser or a read-only deployment never hides the
 *    registered devices; listing, removing and registering are separate.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ supported: true }));

// jsdom has no WebAuthn; the component only asks whether the browser supports
// it, so a stub is enough to reach the management UI.
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => browser.supported,
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
let listPolicy: { canRegister: boolean; canRemove: boolean; registerBlockedBy: "role" | "deployment" | null };
const recorded: Recorded[] = [];
/** What the next DELETE does: answer with a status, or reject like a dropped connection. */
let deleteBehaviour: { kind: "status"; status: number; body?: unknown } | { kind: "reject" };
let listBehaviour: "ok" | "reject";

beforeEach(() => {
  recorded.length = 0;
  browser.supported = true;
  deleteBehaviour = { kind: "status", status: 200 };
  listBehaviour = "ok";
  listPolicy = { canRegister: true, canRemove: true, registerBlockedBy: null };
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
        if (deleteBehaviour.kind === "reject") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(deleteBehaviour.body ?? {}), {
          status: deleteBehaviour.status,
        });
      }
      if (listBehaviour === "reject") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify({ credentials, ...listPolicy }), { status: 200 });
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

  it("a read-only deployment surface renders the notice and the list, never the controls", async () => {
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
    // F12: the devices themselves stay visible to their owner.
    expect(await screen.findByText("صندوق سالن")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "حذف" })).toBeNull();
    expect(screen.queryByRole("button", { name: "افزودن این دستگاه" })).toBeNull();
  });
});

describe("#854 F02 — registration is the server's answer, not a default", () => {
  it("offers «افزودن این دستگاه» when the policy allows enrolment", async () => {
    render(<WebAuthnManager />);
    expect(await screen.findByRole("button", { name: "افزودن این دستگاه" })).toBeTruthy();
  });

  it("a role the policy does not let enrol sees and removes old devices, but is offered no ceremony", async () => {
    listPolicy = { canRegister: false, canRemove: true, registerBlockedBy: "role" };
    render(<WebAuthnManager />);
    await screen.findByText("صندوق سالن");
    expect(screen.getByText(/برای نقش شما دستگاه تازه‌ای ثبت نمی‌شود/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "افزودن این دستگاه" })).toBeNull();
    expect(screen.getByRole("button", { name: "حذف" })).toBeTruthy();
    // No registration request was ever made on the member's behalf.
    expect(recorded.some((r) => r.url.includes("/register/"))).toBe(false);
  });

  it("an older server that does not answer the policy offers nothing it did not confirm", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ credentials }), { status: 200 })),
    );
    render(<WebAuthnManager />);
    await screen.findByText("صندوق سالن");
    expect(screen.queryByRole("button", { name: "افزودن این دستگاه" })).toBeNull();
    expect(screen.queryByRole("button", { name: "حذف" })).toBeNull();
  });
});

describe("#854 F12 — browser support only gates registration", () => {
  it("an unsupported browser still lists the devices and can remove them", async () => {
    browser.supported = false;
    render(<WebAuthnManager />);
    await screen.findByText("صندوق سالن");
    expect(screen.getByText(/مرورگر این دستگاه از ثبت ورود بیومتریک پشتیبانی نمی‌کند/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "افزودن این دستگاه" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "حذف" }));
    await screen.findByText("حذف دستگاه بیومتریک");
    fireEvent.click(screen.getByRole("button", { name: "بله، حذف شود" }));
    await waitFor(() => expect(recorded.filter((r) => r.method === "DELETE")).toHaveLength(1));
    await screen.findByText("دستگاه حذف شد.");
  });
});

describe("#854 F09 — a failed removal never strands the card", () => {
  async function confirmRemoval() {
    fireEvent.click(await screen.findByRole("button", { name: "حذف" }));
    await screen.findByText("حذف دستگاه بیومتریک");
    fireEvent.click(screen.getByRole("button", { name: "بله، حذف شود" }));
  }

  it("a dropped connection releases busy, keeps the list, explains, and allows a retry", async () => {
    deleteBehaviour = { kind: "reject" };
    render(<WebAuthnManager />);
    await confirmRemoval();

    await screen.findByText(/ارتباط با سرور برقرار نشد و معلوم نیست دستگاه حذف شده باشد/);
    // The device is still listed and its button is usable again.
    const list = screen.getByRole("list", { name: "دستگاه‌های بیومتریک ثبت‌شده" });
    expect(within(list).getByText("صندوق سالن")).toBeTruthy();
    const removeButton = screen.getByRole("button", { name: "حذف" }) as HTMLButtonElement;
    await waitFor(() => expect(removeButton.disabled).toBe(false));

    // Retry succeeds once the connection is back.
    deleteBehaviour = { kind: "status", status: 200 };
    await confirmRemoval();
    await screen.findByText("دستگاه حذف شد.");
    expect(recorded.filter((r) => r.method === "DELETE")).toHaveLength(2);
  });

  it("a server refusal releases busy and says so instead of failing silently", async () => {
    deleteBehaviour = { kind: "status", status: 500, body: { error: "internal_error" } };
    render(<WebAuthnManager />);
    await confirmRemoval();
    await screen.findByText("حذف دستگاه ممکن نشد. دوباره تلاش کنید.");
    const removeButton = screen.getByRole("button", { name: "حذف" }) as HTMLButtonElement;
    await waitFor(() => expect(removeButton.disabled).toBe(false));
  });

  it("a stale session goes through the step-up prompt instead of an error", async () => {
    deleteBehaviour = { kind: "status", status: 403, body: { error: "recent_auth_required" } };
    render(<WebAuthnManager />);
    await confirmRemoval();
    await screen.findByText("تأیید هویت برای حذف دستگاه");
  });

  it("a failed refresh keeps the devices already on screen and offers a retry", async () => {
    render(<WebAuthnManager />);
    await screen.findByText("صندوق سالن");
    listBehaviour = "reject";
    deleteBehaviour = { kind: "reject" };
    await confirmRemoval();
    await screen.findByText("بارگذاری دستگاه‌های ثبت‌شده ممکن نشد.");
    expect(screen.getByText("صندوق سالن")).toBeTruthy();

    listBehaviour = "ok";
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() => expect(screen.queryByText("بارگذاری دستگاه‌های ثبت‌شده ممکن نشد.")).toBeNull());
  });

  it("a first load that fails says so, with a retry, instead of an empty list", async () => {
    listBehaviour = "reject";
    render(<WebAuthnManager />);
    await screen.findByText("بارگذاری دستگاه‌های ثبت‌شده ممکن نشد.");
    expect(screen.queryByText("هنوز دستگاهی ثبت نشده است.")).toBeNull();
    listBehaviour = "ok";
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await screen.findByText("صندوق سالن");
  });
});
