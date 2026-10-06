import { describe, expect, it } from "vitest";
import {
  ACTIVITY_VIEW_FILTER_KEYS,
  ACTIVITY_VIEW_STATES,
  activityViewAssigneeUserId,
  activityViewErrorLine,
  activityViewFilterCount,
  activityViewQuery,
  activityViewSearchParams,
  activityViewUnownedOnly,
  describeActivityView,
  hasActivityViewFilters,
  parseActivityViewFilters,
} from "./crm-activity-views";

function source(query: Record<string, string>) {
  const params = new URLSearchParams(query);
  return { get: (key: string) => params.get(key) };
}

const MEMBER = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";

describe("parseActivityViewFilters", () => {
  it("reads every declared key", () => {
    const { filters, error } = parseActivityViewFilters(
      source({ q: "  تماس  ", kind: "call", state: "overdue", assignee: "none" }),
    );
    expect(error).toBeNull();
    expect(filters).toEqual({ q: "تماس", kind: "call", state: "overdue", assignee: "none" });
  });

  it("defaults to the whole list rather than to nothing", () => {
    const { filters, error } = parseActivityViewFilters(source({}));
    expect(error).toBeNull();
    expect(hasActivityViewFilters(filters)).toBe(false);
  });

  it("refuses a kind outside the vocabulary, naming the field", () => {
    const { error, filters } = parseActivityViewFilters(source({ kind: "telepathy" }));
    expect(error).toBe("kind");
    // The refusal is total: a half-parsed filter is a filter nobody can see.
    expect(filters).toEqual(parseActivityViewFilters(source({})).filters);
  });

  it("refuses a state outside the vocabulary", () => {
    expect(parseActivityViewFilters(source({ state: "paused" })).error).toBe("state");
    expect(parseActivityViewFilters(source({ state: "done" })).error).toBeNull();
  });

  it("carries both the row states and the two a list can be in", () => {
    // `today` is the row badge's «امروز» — and the «کارهای امروز» queue's
    // filter; `open` and `due` are list-only questions. A queue that opens as
    // a view needs the first, which is why the two vocabularies share it.
    expect(parseActivityViewFilters(source({ state: "today" })).filters.state).toBe("today");
    expect(ACTIVITY_VIEW_STATES).toEqual(["open", "done", "today", "overdue", "planned", "due"]);
  });

  it("refuses an assignee by name", () => {
    expect(parseActivityViewFilters(source({ assignee: "سارا" })).error).toBe("assignee");
  });

  it("reads the legacy `due` key as the state it names", () => {
    // `due` is the key this screen's links and its stored views shipped with.
    // Dropping it would have turned those views into names that do nothing.
    const { filters, error } = parseActivityViewFilters(source({ due: "1" }));
    expect(error).toBeNull();
    expect(filters.state).toBe("due");
  });

  it("lets an explicit state win over the legacy key", () => {
    const { filters } = parseActivityViewFilters(source({ due: "1", state: "done" }));
    expect(filters.state).toBe("done");
  });

  it("reads the screen's own older parameters for links already in the wild", () => {
    // `open` and `mine` were never in the vocabulary — they were the preset
    // buttons' own parameters — but they are sitting in bookmarks.
    const open = parseActivityViewFilters(source({ open: "1" })).filters;
    expect(open.state).toBe("open");
    expect(parseActivityViewFilters(source({ mine: "1" })).filters.assignee).toBe("mine");
    // An explicit value still wins.
    expect(parseActivityViewFilters(source({ mine: "1", assignee: "none" })).filters.assignee).toBe(
      "none",
    );
  });

  it("ignores a key it has never heard of", () => {
    const { filters, error } = parseActivityViewFilters(source({ bogus: "1", kind: "task" }));
    expect(error).toBeNull();
    expect(filters.kind).toBe("task");
  });
});

describe("activityViewQuery", () => {
  it("omits what is not in force", () => {
    expect(activityViewQuery(parseActivityViewFilters(source({})).filters)).toEqual({});
  });

  it("round-trips through the parser, and writes `state` even for a legacy `due`", () => {
    const parsed = parseActivityViewFilters(source({ due: "1", kind: "call", assignee: "mine" }));
    const query = activityViewQuery(parsed.filters);
    // The normalisation: the legacy key is read but never written, so every
    // re-save of a view is expressed in the vocabulary the filter applies.
    expect(query).toEqual({ kind: "call", state: "due", assignee: "mine" });
    expect(parseActivityViewFilters(source(query)).filters).toEqual(parsed.filters);
    expect(activityViewSearchParams(parsed.filters).toString()).toBe(
      new URLSearchParams(query).toString(),
    );
    expect(activityViewFilterCount(parsed.filters)).toBe(3);
  });
});

describe("activityViewAssigneeUserId", () => {
  it("resolves mine from the session, never from the query string", () => {
    const { filters } = parseActivityViewFilters(source({ assignee: "mine" }));
    expect(activityViewAssigneeUserId(filters, "abc")).toBe("abc");
    expect(activityViewAssigneeUserId(filters, null)).toBeNull();
  });

  it("treats none as nobody, not as anybody", () => {
    const { filters } = parseActivityViewFilters(source({ assignee: "none" }));
    expect(activityViewUnownedOnly(filters)).toBe(true);
    expect(activityViewAssigneeUserId(filters, "abc")).toBeNull();
  });

  it("passes an explicit member id through", () => {
    const { filters } = parseActivityViewFilters(source({ assignee: MEMBER }));
    expect(activityViewAssigneeUserId(filters, "abc")).toBe(MEMBER);
    expect(activityViewUnownedOnly(filters)).toBe(false);
  });
});

describe("describeActivityView", () => {
  it("describes exactly what is in force", () => {
    const { filters } = parseActivityViewFilters(
      source({ q: "تماس", kind: "call", state: "overdue", assignee: "none" }),
    );
    expect(describeActivityView(filters)).toEqual([
      "جست‌وجو: «تماس»",
      "نوع: تماس",
      "وضعیت: عقب‌افتاده",
      "بدون مسئول",
    ]);
  });

  it("names a member when it can and never drops a filter when it cannot", () => {
    const { filters } = parseActivityViewFilters(source({ assignee: MEMBER }));
    expect(describeActivityView(filters, { memberName: () => "سارا" })).toEqual(["مسئول: سارا"]);
    expect(describeActivityView(filters)).toEqual(["مسئول: 0f1e2d3c"]);
  });

  it("calls the session's own the same thing the screen does", () => {
    const { filters } = parseActivityViewFilters(source({ assignee: "mine" }));
    expect(describeActivityView(filters)).toEqual(["کارهای من"]);
  });

  it("names the five list states in Persian", () => {
    const labels = ACTIVITY_VIEW_STATES.map((state) => {
      const { filters } = parseActivityViewFilters(source({ state }));
      return describeActivityView(filters)[0];
    });
    expect(labels).toEqual([
      "وضعیت: انجام‌نشده",
      "وضعیت: انجام‌شده",
      "وضعیت: امروز",
      "وضعیت: عقب‌افتاده",
      "وضعیت: برنامه‌ریزی‌شده",
      "وضعیت: سررسیدشده",
    ]);
  });
});

describe("activityViewErrorLine", () => {
  it("names the field in Persian and falls back for the rest", () => {
    expect(activityViewErrorLine("state")).toBe("وضعیت انتخاب‌شده معتبر نیست.");
    expect(activityViewErrorLine("something_else")).toBe("فیلترهای این نما معتبر نیستند.");
  });
});

describe("ACTIVITY_VIEW_FILTER_KEYS", () => {
  it("is the list the saved views service refuses against", () => {
    expect([...ACTIVITY_VIEW_FILTER_KEYS]).toEqual(["q", "kind", "state", "assignee", "due"]);
  });
});
