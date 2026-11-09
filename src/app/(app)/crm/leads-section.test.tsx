// @vitest-environment jsdom

/**
 * `LeadsSection`'s list moved onto `DataCardTable` (issue #884's mobile
 * card-row follow-up, acceptance criterion #10) instead of a hand-rolled
 * `DataTable`. This pins that the conversion kept every column's data and
 * every row action working — the desktop table and the phone cards both
 * carry the same lead, and the "تبدیل"/"ویرایش" actions still fire the same
 * requests they did before.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeadsSection } from "./leads-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LEAD = {
  id: "lead-1",
  name: "رضا کریمی",
  organization: "فروشگاه رضا",
  phone: "09120000000",
  email: null,
  source: "instagram",
  sourceDetail: "",
  status: "new",
  rating: "hot",
  ownerId: null,
  ownerName: "سارا احمدی",
  nextAction: "تماس پیگیری",
  nextActionAt: null,
  convertedPartyId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 400,
    json: () => Promise.resolve(body),
  } as Response);
}

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/api/growth/marketing-touchpoints/by-lead")) {
        return jsonResponse({ touches: [{ id: "t", title: "ماموریت تست", target: "مقصد تست", agent: "بازاریاب تست", location_name: "شعبه تست", location_timezone: "Asia/Tehran", channel: "phone", source: "phone", recorded_at: "2026-11-05T10:00:00Z" }], hasMore: false });
      }
      if (url.includes("/api/crm/leads/") && url.includes("/convert")) {
        return jsonResponse({ duplicates: [] });
      }
      if (url.includes("/api/crm/leads")) {
        return jsonResponse({ leads: [LEAD], total: 1 });
      }
      if (url.includes("/api/crm/queues")) {
        return jsonResponse({ queues: [] });
      }
      if (url.includes("/api/crm/saved-views")) {
        return jsonResponse({ views: [] });
      }
      return jsonResponse({});
    }),
  );
  return calls;
}

describe("LeadsSection", () => {
  it("renders the lead in both the desktop table and the phone card list", async () => {
    stubFetch();
    render(<LeadsSection />);

    const table = await screen.findByRole("table", { name: "فهرست سرنخ‌ها" });
    expect(within(table).getAllByText("رضا کریمی")).toHaveLength(1);
    expect(within(table).getByText("فروشگاه رضا")).toBeTruthy();
    expect(within(table).getByText("سارا احمدی")).toBeTruthy();

    // The phone card list carries the same lead — name, organisation and the
    // owner column that became a label/value pair under it.
    const cardsList = document.querySelector("ul.sm\\:hidden");
    expect(cardsList).toBeTruthy();
    expect(cardsList?.textContent).toContain("رضا کریمی");
    expect(cardsList?.textContent).toContain("فروشگاه رضا");
    expect(cardsList?.textContent).toContain("سارا احمدی");
  });

  it("keeps the Growth projection behind its explicit permission and loads it only on request", async () => {
    const calls = stubFetch(); const user = userEvent.setup();
    const view = render(<LeadsSection canViewMarketingHistory={false} />);
    await screen.findByRole("table", { name: "فهرست سرنخ‌ها" });
    expect(screen.queryByRole("button", { name: "تعاملات بازاریابی" })).toBeNull();
    expect(calls.some((url) => url.includes("/api/growth/marketing-touchpoints/by-lead"))).toBe(false);
    view.rerender(<LeadsSection canViewMarketingHistory />);
    const table = screen.getByRole("table", { name: "فهرست سرنخ‌ها" });
    await user.click(within(table).getByRole("button", { name: "تعاملات بازاریابی" }));
    expect(await screen.findByText("ماموریت تست")).toBeTruthy();
    expect(screen.getByText(/مدرک ملاقات، رضایت، تبدیل یا فروش نیستند/)).toBeTruthy();
    expect(calls.some((url) => url.includes("leadId=lead-1&page=1"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "بستن تعاملات" }));
    expect(screen.queryByText("ماموریت تست")).toBeNull();
  });
  it("still opens the edit dialog from the row's action column after the conversion", async () => {
    stubFetch();
    const user = userEvent.setup();
    render(<LeadsSection />);

    const table = await screen.findByRole("table", { name: "فهرست سرنخ‌ها" });
    const [editButton] = within(table).getAllByRole("button", { name: "ویرایش" });
    await user.click(editButton);

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("still fires the convert request from the row's action column", async () => {
    const calls = stubFetch();
    const user = userEvent.setup();
    render(<LeadsSection />);

    const table = await screen.findByRole("table", { name: "فهرست سرنخ‌ها" });
    // Scoped to the table: the status filter chip row also has a button whose
    // label ("تبدیل‌شده") contains this row action's label as a substring.
    const [convertButton] = within(table).getAllByRole("button", { name: "تبدیل" });
    await user.click(convertButton);

    await waitFor(() => {
      expect(calls.some((url) => url.includes(`/api/crm/leads/${LEAD.id}/convert`))).toBe(true);
    });
  });
});
