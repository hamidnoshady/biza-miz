// @vitest-environment jsdom

/**
 * The builder's preview contract (issue #819) — driven through the real
 * component, with responses resolved by hand.
 *
 * Two failures are covered, and both of them rendered *plausible* numbers,
 * which is why they went unnoticed:
 *
 *  1. **The formatter came from the draft.** Rendering metadata was read off
 *     the live controls (`currentMetric?.money`, `currentView?.label`) while the
 *     rows came from `loadedConfig`, so switching the measure from a Rial amount
 *     to a count reformatted the rows already on screen through the money
 *     formatter — «۱۲۵٬۰۰۰ تومان» for a count of orders.
 *  2. **A source change did not invalidate an in-flight preview.** The sequence
 *     guard inside `preview()` only fires against a *newer preview*; changing
 *     the source or loading a saved report cleared the rows without one, so a
 *     slow response for the abandoned source landed afterwards and repainted its
 *     rows and its `loadedConfig` onto a form describing a different report.
 *
 * Both are ordering/state bugs, so both are tested by rendering the section and
 * resolving two `fetch` responses out of order. A unit test of a helper would
 * have seen neither: the helpers were never the problem.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { formatMoney } from "@/lib/money";
import type { ReportCapabilities } from "@/lib/report-permissions";
import { ReportBuilderSection } from "./report-builder-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CAPABILITIES: ReportCapabilities = {
  canViewReports: true,
  canBuildReports: true,
  canManageSavedReports: true,
  canExportReports: false,
  canViewBusinessWide: false,
  canManageRoleWidgets: false,
};

/** The engine catalogue, in the shape `/api/reports/views` returns it. */
const VIEWS = [
  {
    key: "sales",
    label: "فروش",
    hasDateColumn: true,
    filters: [
      { key: "category", label: "دسته", control: { kind: "entity", source: "menu-category" } },
      { key: "status", label: "وضعیت", control: { kind: "enum", options: [{ value: "open", label: "باز" }, { value: "closed", label: "بسته" }] } },
      { key: "vendor", label: "طرف حساب", control: { kind: "text" } },
    ],
    metrics: [
      { key: "total", label: "جمع فروش", money: true, aggregations: ["sum"] },
      { key: "orders", label: "تعداد سفارش", money: false, aggregations: ["count"] },
    ],
    dimensions: [{ key: "location", label: "شعبه" }],
  },
  {
    key: "staff",
    label: "کارکنان",
    hasDateColumn: false,
    filters: [],
    metrics: [{ key: "shifts", label: "تعداد شیفت", money: false, aggregations: ["count"] }],
    dimensions: [{ key: "staff_name", label: "کارمند" }],
  },
];

const SAVED_REPORT = {
  id: "saved-1",
  name: "شیفت‌های هفته",
  description: null,
  is_standard: false,
  version: 1,
  config: {
    view: "staff",
    metric: "shifts",
    dimension: "staff_name",
    aggregation: "count",
    visualization: "bar",
  },
};

const ROWS_FOR_SALES = {
  rows: [{ dim: "شعبهٔ مرکزی", value: "1250000" }],
  columns: [
    { key: "dim", label: "شعبه" },
    { key: "value", label: "مقدار" },
  ],
};

const ROWS_FOR_STAFF = {
  rows: [{ dim: "علی", value: "7" }],
  columns: [
    { key: "dim", label: "کارمند" },
    { key: "value", label: "مقدار" },
  ],
};

interface QueryCall {
  url: string;
  body: Record<string, unknown> | null;
  aborted: boolean;
}

/**
 * Stubs `fetch` for the section's three endpoints. `/api/reports/query` is
 * answered by `answerQuery`, which tests replace when they need to hold a
 * response open.
 */
function stubFetch(overrides: {
  onQuery?: (body: Record<string, unknown>, call: QueryCall) => Promise<Response> | Response;
  onFilterOptions?: (view: string, signal?: AbortSignal) => Promise<Response> | Response;
  saved?: unknown[];
  views?: unknown[];
}): QueryCall[] {
  const calls: QueryCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.startsWith("/api/reports/views")) {
        return { ok: true, status: 200, json: async () => ({ views: overrides.views ?? VIEWS }) } as Response;
      }
      if (href.startsWith("/api/reports/filter-options")) {
        const source = new URL(href, "http://localhost").searchParams.get("view") ?? "";
        if (overrides.onFilterOptions) return overrides.onFilterOptions(source, init?.signal ?? undefined);
        return {
          ok: true,
          status: 200,
          json: async () => ({ options: { category: [{ value: "cat-1", label: "نوشیدنی" }] } }),
        } as Response;
      }
      if (href.startsWith("/api/reports/saved")) {
        return { ok: true, status: 200, json: async () => ({ reports: overrides.saved ?? [] }) } as Response;
      }
      if (href.startsWith("/api/reports/query")) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
        const call: QueryCall = { url: href, body, aborted: false };
        calls.push(call);
        init?.signal?.addEventListener("abort", () => {
          call.aborted = true;
        });
        if (overrides.onQuery) return overrides.onQuery(body ?? {}, call);
        return { ok: true, status: 200, json: async () => ROWS_FOR_SALES } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
  return calls;
}

/** Opens a `SearchableSelect` by the label it currently shows and picks an option. */
function pick(kind: "trigger" | "option", name: string) {
  if (kind === "trigger") {
    const trigger = screen.getAllByRole("button").find((button) => button.textContent?.includes(name));
    if (!trigger) throw new Error(`no select trigger showing «${name}»`);
    fireEvent.click(trigger);
    return;
  }
  const option = within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .find((item) => item.textContent?.includes(name));
  if (!option) throw new Error(`no option named «${name}»`);
  fireEvent.click(option);
}

describe("preview rendering uses the loaded result's own metadata", () => {
  it("still formats the loaded rows as money after the measure is switched to a count", async () => {
    stubFetch({});
    render(<ReportBuilderSection capabilities={CAPABILITIES} />);

    // The section auto-selects the first view/metric, then previews on demand.
    const previewButton = await screen.findByRole("button", { name: "پیش‌نمایش" });
    fireEvent.click(previewButton);

    // 1,250,000 Rial shown in the business's unit (Toman by default): the
    // money formatter's own output, so this asserts the unit and the grouping
    // rather than a hand-copied string.
    const moneyText = formatMoney(1_250_000, "toman");
    await waitFor(() => expect(screen.getAllByText(moneyText).length).toBeGreaterThan(0));

    // Now switch the *measure* to a count without previewing. The rows on
    // screen are still the loaded sales figures, so they must keep the money
    // formatting they were rendered with — reading `money` off the draft here is
    // exactly the bug.
    pick("trigger", "جمع فروش");
    pick("option", "تعداد سفارش");

    expect(screen.getAllByText(moneyText).length).toBeGreaterThan(0);
    // The plain formatter would have produced the bare Rial number, ten times
    // the amount the business is looking at, with no unit.
    expect(screen.queryByText("۱,۲۵۰,۰۰۰")).toBeNull();
    // And the form is honest that the result no longer matches the controls.
    expect(screen.getByText(/تنظیمات تغییر کرده‌اند/)).toBeTruthy();
  });
});

describe("source-aware filter controls", () => {
  it("renders entity, enum, and text filters from canonical metadata and round-trips selections", async () => {
    const calls = stubFetch({});
    render(<ReportBuilderSection capabilities={CAPABILITIES} />);

    const category = await screen.findByRole("button", { name: "دسته" });
    fireEvent.click(category);
    fireEvent.click(await screen.findByRole("option", { name: "نوشیدنی" }));

    fireEvent.click(screen.getByRole("button", { name: "وضعیت" }));
    fireEvent.click(screen.getByRole("option", { name: "باز" }));
    fireEvent.change(screen.getByRole("textbox", { name: "طرف حساب" }), { target: { value: "تأمین‌کنندهٔ یک" } });

    fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toMatchObject({
      filters: {
        equals: {
          category: "cat-1",
          status: "open",
          vendor: "تأمین‌کنندهٔ یک",
        },
      },
    });
  });

  it("aborts and ignores a late entity-options response after switching report source", async () => {
    let resolveOld: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    let oldRequestStarted = false;
    let oldRequestAborted = false;
    stubFetch({
      onFilterOptions: (source, signal) => {
        if (source === "sales") {
          oldRequestStarted = true;
          signal?.addEventListener("abort", () => { oldRequestAborted = true; });
          return held;
        }
        return { ok: true, status: 200, json: async () => ({ options: {} }) } as Response;
      },
    });

    render(<ReportBuilderSection capabilities={CAPABILITIES} />);
    await waitFor(() => expect(oldRequestStarted).toBe(true));
    pick("trigger", "فروش");
    pick("option", "کارکنان");
    await waitFor(() => expect(oldRequestAborted).toBe(true));

    resolveOld({
      ok: true,
      status: 200,
      json: async () => ({ options: { category: [{ value: "old-cat", label: "دستهٔ قدیمی" }] } }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole("button", { name: "دسته" })).toBeNull();
    expect(screen.queryByText("دستهٔ قدیمی")).toBeNull();
  });
});

describe("an in-flight preview cannot land after the source changes", () => {
  it("drops a late response for the previous source and stays usable", async () => {
    let resolveOld: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const calls = stubFetch({
      onQuery: (body) => (body.view === "sales" ? held : ({ ok: true, status: 200, json: async () => ROWS_FOR_STAFF } as Response)),
    });

    render(<ReportBuilderSection capabilities={CAPABILITIES} />);
    const previewButton = await screen.findByRole("button", { name: "پیش‌نمایش" });

    // Preview the first source, whose response will be held open.
    fireEvent.click(previewButton);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body?.view).toBe("sales");

    // Change the source while that request is still open.
    pick("trigger", "فروش");
    pick("option", "کارکنان");

    // Let the old response arrive last, carrying the abandoned source's rows.
    // (Resolved even though the request was aborted, which is the interesting
    // case: a response that is already in the network cannot be recalled.)
    resolveOld({ ok: true, status: 200, json: async () => ROWS_FOR_SALES } as Response);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The late rows must not be on screen…
    expect(screen.queryByText("شعبهٔ مرکزی")).toBeNull();
    // …and the form must not be stuck busy from the request that was dropped.
    expect((screen.getByRole("button", { name: "پیش‌نمایش" }) as HTMLButtonElement).disabled).toBe(false);
    // And the abandoned request was aborted rather than left to run, since
    // nothing is going to read its result.
    expect(calls[0].aborted).toBe(true);
  });

  it("drops a late response for the report being edited when another is loaded", async () => {
    let resolveOld: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const calls = stubFetch({
      onQuery: () => held,
      saved: [SAVED_REPORT],
    });

    render(<ReportBuilderSection capabilities={CAPABILITIES} />);
    const previewButton = await screen.findByRole("button", { name: "پیش‌نمایش" });

    fireEvent.click(previewButton);
    await waitFor(() => expect(calls.length).toBe(1));

    // Loading a saved report replaces the whole form — source, measure,
    // dimension, name. The draft it discards must not be able to repaint.
    const loadButton = await screen.findByRole("button", { name: "ویرایش / تغییر نام" });
    fireEvent.click(loadButton);
    // The form now describes the loaded report, not the previous draft.
    await waitFor(() => expect(screen.getByText("شیفت‌های هفته")).toBeTruthy());

    resolveOld({ ok: true, status: 200, json: async () => ROWS_FOR_SALES } as Response);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(screen.queryByText("شعبهٔ مرکزی")).toBeNull();
    expect(screen.queryByRole("region", { name: "خروجی پیش‌نمایش گزارش" })).toBeNull();
    expect((screen.getByRole("button", { name: "پیش‌نمایش" }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls[0].aborted).toBe(true);
  });
});
