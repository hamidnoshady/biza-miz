// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CampaignCalendar } from "./campaign-calendar";
vi.mock("@/app/dashboard/jalali-date-picker", () => ({
  JalaliDatePicker: ({
    value,
    onChange,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    ariaLabel: string;
    disabled: boolean;
  }) => (
    <input
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock("./customer-search", () => ({ CustomerSearchField: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const event = (id: string) => ({
  id,
  number: `CA-${id}`,
  title: `Campaign ${id}`,
  partyName: "Client",
  projectId: null,
  start: "2026-10-01",
  end: null,
  status: "planned",
});
function dates() {
  fireEvent.change(screen.getByLabelText("آغاز بازهٔ تقویم"), {
    target: { value: "2026-10-01" },
  });
  fireEvent.change(screen.getByLabelText("پایان بازهٔ تقویم"), {
    target: { value: "2026-10-31" },
  });
}
describe("permission-filtered campaign agenda", () => {
  it("does not request an unbounded calendar and rejects invalid ranges locally", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<CampaignCalendar />);
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "نمایش تقویم" }));
    expect(screen.getByText(/بازهٔ معتبر حداکثر/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses server pages independently of campaign metrics, retaining open ends and clearing old windows", async () => {
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("offset=100")
              ? { events: [event("second")], nextOffset: null }
              : { events: [event("first")], nextOffset: 100 },
          ),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<CampaignCalendar />);
    dates();
    await userEvent.click(screen.getByRole("button", { name: "نمایش تقویم" }));
    await screen.findByText(/Campaign first/);
    expect(fetch.mock.calls[0][0]).toContain(
      "/calendar?start=2026-10-01&end=2026-10-31&offset=0",
    );
    expect(screen.getByText(/پایان تعیین نشده/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "صفحهٔ بعدی تقویم" }),
    );
    await screen.findByText(/Campaign second/);
    expect(screen.getByText(/Campaign first/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "صفحهٔ بعدی تقویم" }),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText("پایان بازهٔ تقویم"), {
      target: { value: "2026-10-30" },
    });
    expect(screen.queryByText(/Campaign first/)).toBeNull();
  });
  it("reports refusal without displaying fabricated scheduling data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      ),
    );
    render(<CampaignCalendar />);
    dates();
    await userEvent.click(screen.getByRole("button", { name: "نمایش تقویم" }));
    await screen.findByText(/خواندن تقویم ممکن نشد/);
    expect(screen.queryByRole("article")).toBeNull();
  });
});
