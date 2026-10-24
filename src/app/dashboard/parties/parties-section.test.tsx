// @vitest-environment jsdom

/**
 * Issue #1006 — rendered coverage for the staff-directory recovery action.
 *
 * The directory is a client component, so the important regression is not that
 * source happens to contain a fetch call: an owner must see the missing-code
 * warning, click the one bulk action, get a refreshed list, and see a useful
 * refusal when the server answers 403 or 409.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import { partyScopeFor } from "@/lib/parties-scopes";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children?: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// These panels are outside the directory recovery workflow. Keeping them inert
// makes this test exercise the real list, toolbar, alerts and fetch lifecycle.
vi.mock("./party-form", () => ({ PartyFormDialog: () => null }));
vi.mock("@/app/(app)/accounting/ar-statement-panel", () => ({ ArStatementPanel: () => null }));
vi.mock("@/app/(app)/accounting/ap-statement-panel", () => ({ ApStatementPanel: () => null }));
vi.mock("@/components/mobile/post-call-activity-sheet", () => ({ PostCallActivitySheet: () => null }));

import { PartiesSection } from "./parties-section";

type AssignResponse = { status: number; body: Record<string, unknown> };

const staffWithoutCode = {
  id: "staff-1",
  displayName: "مریم احمدی",
  name: "مریم احمدی",
  role: "Employee",
  roles: ["Employee"],
  personType: "Real",
  status: true,
  isActive: true,
  accountingCode: null,
  accountingCodeMode: "Automatic",
  phone: null,
  email: null,
};

let assigned = false;
let assignResponse: AssignResponse;
let fetchMock: ReturnType<typeof vi.fn>;

function response(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function renderDirectory() {
  return render(
    <div dir="rtl">
      <PartiesSection
        scope={partyScopeFor("team")}
        role="owner"
        permissions={[PERMISSIONS.partiesManage]}
      />
    </div>,
  );
}

beforeEach(() => {
  assigned = false;
  assignResponse = {
    status: 200,
    body: { assigned: [{ id: "staff-1", code: "300001" }], skipped: [], failed: [] },
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/parties?")) {
      const party = assigned
        ? { ...staffWithoutCode, accountingCode: "300001" }
        : staffWithoutCode;
      return response({ parties: [party], total: 1, businessId: "business-1" });
    }
    if (url === "/api/parties/categories?includeInactive=1") {
      return response({ categories: [] });
    }
    if (url === "/api/parties/assign-codes") {
      expect(init?.method).toBe("POST");
      if (assignResponse.status === 200) assigned = true;
      return response(assignResponse.body, assignResponse.status);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PartiesSection — Issue #1006 bulk staff-code recovery", () => {
  it("shows the missing-code badge, posts the bulk action, and refreshes to the assigned RTL code", async () => {
    const user = userEvent.setup();
    renderDirectory();

    await waitFor(() => expect(screen.getAllByText("نیاز به کد").length).toBeGreaterThan(0));
    const initialListRequests = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/parties?")).length;

    await user.click(screen.getByRole("button", { name: "تخصیص کد به کارکنان بدون کد" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        String(url) === "/api/parties/assign-codes" && (init as RequestInit | undefined)?.method === "POST",
      )).toBe(true);
      expect(screen.getAllByText("۳۰۰۰۰۱").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("کد حسابداری برای ۱ کارکن بدون کد تخصیص داده شد.")).toBeTruthy();
    expect(screen.queryByText("نیاز به کد")).toBeNull();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/parties?")).length).toBeGreaterThan(initialListRequests);
    expect(screen.getAllByText("۳۰۰۰۰۱")[0].closest("[dir='ltr']")).toBeTruthy();
  });

  it("shows the server's 403 refusal instead of hiding it", async () => {
    assignResponse = { status: 403, body: { error: "forbidden" } };
    const user = userEvent.setup();
    renderDirectory();
    await screen.findAllByText("نیاز به کد");

    await user.click(screen.getByRole("button", { name: "تخصیص کد به کارکنان بدون کد" }));

    expect(await screen.findByText("دسترسی مجاز نیست.")).toBeTruthy();
    expect(screen.getAllByText("نیاز به کد").length).toBeGreaterThan(0);
  });

  it("shows a 409 namespace refusal in Persian", async () => {
    assignResponse = { status: 409, body: { error: "accounting_code_namespace_full" } };
    const user = userEvent.setup();
    renderDirectory();
    await screen.findAllByText("نیاز به کد");

    await user.click(screen.getByRole("button", { name: "تخصیص کد به کارکنان بدون کد" }));

    expect(await screen.findByText("فضای شماره‌گذاری کدهای حسابداری کارکنان پر شده است؛ با مدیر حسابداری تماس بگیرید.")).toBeTruthy();
    expect(screen.getAllByText("نیاز به کد").length).toBeGreaterThan(0);
  });
});
