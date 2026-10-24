// @vitest-environment jsdom

/**
 * Issue #1006 — rendered coverage for the staff-directory recovery action.
 *
 * The directory is a client component, so the important regression is not that
 * source happens to contain a fetch call: an owner must see the missing-code
 * warning, click the one bulk action, get a refreshed list, and see a useful
 * refusal when the server answers 403 or 409.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import type { PartyListRow } from "./parties-section";
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

function partyRow(overrides: Partial<PartyListRow> = {}): PartyListRow {
  return {
    id: "party-1",
    displayName: "فروشگاه آرام",
    status: true,
    roles: ["Customer"],
    ...overrides,
  };
}

function listPayload(parties: PartyListRow[] = []) {
  return { parties, total: parties.length, businessId: "biz-1" };
}

function stubOtherRoutes() {
  return {
    "/api/parties/categories": () => ({ ok: true, status: 200, json: async () => ({ categories: [] }) }),
  };
}

const SCOPE = partyScopeFor("accounting");

function renderSection(permissions: string[] = []) {
  return render(<PartiesSection scope={SCOPE} role="owner" permissions={permissions} />);
}

describe("PartiesSection — a same-scope refresh (issue #909 item 4)", () => {
  it("clears a stale error banner once a later same-scope load succeeds", async () => {
    let listCall = 0;
    const routes = stubOtherRoutes();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/parties?")) {
          listCall += 1;
          // 1st: succeeds. 2nd (after the archive below): fails, banner
          // shown. 3rd (after archiving again): succeeds — must not still
          // show the previous failure's banner over fresh, good data.
          if (listCall === 2) return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
          return { ok: true, status: 200, json: async () => listPayload([partyRow()]) };
        }
        if (url === "/api/parties/party-1" && init?.method === "PUT") {
          return { ok: true, status: 200, json: async () => ({ party: partyRow() }) };
        }
        for (const [prefix, handler] of Object.entries(routes)) {
          if (url.startsWith(prefix)) return handler();
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    renderSection([PERMISSIONS.partiesManage]);
    await screen.findAllByText("فروشگاه آرام");

    const archiveButton = () => screen.getAllByRole("button", { name: 'بایگانی «فروشگاه آرام»' })[0];
    fireEvent.click(archiveButton());
    await waitFor(() => expect(listCall).toBe(2));
    expect(await screen.findByText("خطای غیرمنتظره. دوباره تلاش کنید.")).toBeTruthy();

    fireEvent.click(archiveButton());
    await waitFor(() => expect(listCall).toBe(3));
    await waitFor(() => expect(screen.queryByText("خطای غیرمنتظره. دوباره تلاش کنید.")).toBeNull());
  });

  it("keeps the rows on screen through a same-scope refresh, and a failed refresh leaves them alone", async () => {
    let listCall = 0;
    let toggleCalled = false;
    const routes = stubOtherRoutes();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/parties?")) {
          listCall += 1;
          if (listCall === 1) return { ok: true, status: 200, json: async () => listPayload([partyRow()]) };
          // The refresh after a successful archive — the same page/query —
          // itself fails this time.
          return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
        }
        if (url === "/api/parties/party-1" && init?.method === "PUT") {
          toggleCalled = true;
          return { ok: true, status: 200, json: async () => ({ party: partyRow({ status: false }) }) };
        }
        for (const [prefix, handler] of Object.entries(routes)) {
          if (url.startsWith(prefix)) return handler();
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    // `partiesManage` draws the archive control this test uses as a
    // same-scope refresh trigger (a successful mutation bumps `refreshKey`
    // without changing the page or any filter).
    renderSection([PERMISSIONS.partiesManage]);
    await screen.findAllByText("فروشگاه آرام");

    const archiveButtons = screen.getAllByRole("button", { name: 'بایگانی «فروشگاه آرام»' });
    fireEvent.click(archiveButtons[0]);
    await waitFor(() => expect(toggleCalled).toBe(true));
    await waitFor(() => expect(listCall).toBe(2));
    // Still there — a failed background refresh does not erase a good directory.
    expect(screen.getAllByText("فروشگاه آرام").length).toBeGreaterThan(0);
    expect(await screen.findByText("خطای غیرمنتظره. دوباره تلاش کنید.")).toBeTruthy();
  });

  it("names the very first load as slow after ~5s, and stops once it settles", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: unknown) => void;
      const deferred = new Promise((r) => {
        resolve = r;
      });
      const routes = stubOtherRoutes();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.startsWith("/api/parties?")) return deferred;
          for (const [prefix, handler] of Object.entries(routes)) {
            if (url.startsWith(prefix)) return handler();
          }
          throw new Error(`unexpected fetch ${url}`);
        }),
      );
      renderSection();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("status", { name: "بارگذاری فهرست اشخاص کمی طول کشیده…" })).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByRole("status", { name: "بارگذاری فهرست اشخاص کمی طول کشیده…" })).toBeTruthy();

      resolve({ ok: true, status: 200, json: async () => listPayload([partyRow()]) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByRole("status", { name: "بارگذاری فهرست اشخاص کمی طول کشیده…" })).toBeNull();
      expect(screen.getAllByText("فروشگاه آرام").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
