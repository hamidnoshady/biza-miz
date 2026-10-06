import { describe, expect, it } from "vitest";
import {
  CASE_VIEW_FILTER_KEYS,
  caseViewAssigneeUserId,
  caseViewErrorLine,
  caseViewDuration,
  caseViewFilterCount,
  caseViewQuery,
  caseViewSearchParams,
  caseViewUnownedOnly,
  describeCaseView,
  hasCaseViewFilters,
  parseCaseViewFilters,
} from "./crm-case-views";

/** A `URLSearchParams`-shaped source, which is what the route hands in. */
function source(query: Record<string, string>) {
  const params = new URLSearchParams(query);
  return { get: (key: string) => params.get(key) };
}

describe("parseCaseViewFilters", () => {
  it("reads every declared key", () => {
    const { filters, error } = parseCaseViewFilters(
      source({
        q: "  یخچال  ",
        status: "waiting",
        priority: "urgent",
        assignee: "none",
        open: "1",
        breached: "1",
      }),
    );
    expect(error).toBeNull();
    expect(filters).toEqual({
      q: "یخچال",
      status: "waiting",
      priority: "urgent",
      assignee: "none",
      openOnly: true,
      breachedOnly: true,
    });
  });

  it("defaults to the whole desk rather than to nothing", () => {
    const { filters, error } = parseCaseViewFilters(source({}));
    expect(error).toBeNull();
    expect(hasCaseViewFilters(filters)).toBe(false);
    expect(filters.openOnly).toBe(false);
  });

  it("refuses a status outside the vocabulary, naming the field", () => {
    const { error, filters } = parseCaseViewFilters(source({ status: "pending" }));
    expect(error).toBe("status");
    // The refusal is total: a half-parsed filter would be a filter nobody can
    // see in the chips.
    expect(filters).toEqual(parseCaseViewFilters(source({})).filters);
  });

  it("refuses a priority outside the vocabulary", () => {
    expect(parseCaseViewFilters(source({ priority: "asap" })).error).toBe("priority");
  });

  it("accepts a member id, and its three sentinels", () => {
    for (const assignee of ["", "none", "mine", "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"]) {
      expect(parseCaseViewFilters(source({ assignee })).error).toBeNull();
    }
  });

  it("refuses an assignee by name", () => {
    // Two colleagues can share a name; a filter that guesses is how somebody
    // else's tickets end up in your queue.
    expect(parseCaseViewFilters(source({ assignee: "سارا" })).error).toBe("assignee");
  });

  it("ignores a key it has never heard of", () => {
    const { filters, error } = parseCaseViewFilters(source({ bogus: "1", priority: "high" }));
    expect(error).toBeNull();
    expect(filters.priority).toBe("high");
  });

  it("reads the flags only as 1", () => {
    const { filters } = parseCaseViewFilters(source({ open: "true", breached: "yes" }));
    expect(filters.openOnly).toBe(false);
    expect(filters.breachedOnly).toBe(false);
  });
});

describe("caseViewQuery", () => {
  it("omits what is not in force", () => {
    expect(caseViewQuery(parseCaseViewFilters(source({})).filters)).toEqual({});
  });

  it("round-trips through the parser", () => {
    const written = {
      q: "یخچال",
      status: "in_progress",
      priority: "high",
      assignee: "mine",
      openOnly: true,
      breachedOnly: true,
    };
    const query = caseViewQuery(written);
    expect(caseViewSearchParams(written).toString()).toBe(new URLSearchParams(query).toString());
    expect(parseCaseViewFilters(source(query)).filters).toEqual(written);
    expect(caseViewFilterCount(written)).toBe(6);
  });
});

describe("caseViewAssigneeUserId", () => {
  it("resolves mine from the session, never from the query string", () => {
    const { filters } = parseCaseViewFilters(source({ assignee: "mine" }));
    expect(caseViewAssigneeUserId(filters, "abc")).toBe("abc");
    // Nobody to be: no filter, rather than everybody's tickets relabelled
    // «مال من».
    expect(caseViewAssigneeUserId(filters, null)).toBeNull();
  });

  it("treats none as nobody, not as anybody", () => {
    const { filters } = parseCaseViewFilters(source({ assignee: "none" }));
    expect(caseViewUnownedOnly(filters)).toBe(true);
    expect(caseViewAssigneeUserId(filters, "abc")).toBeNull();
  });

  it("passes an explicit member id through", () => {
    const id = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
    const { filters } = parseCaseViewFilters(source({ assignee: id }));
    expect(caseViewAssigneeUserId(filters, "abc")).toBe(id);
    expect(caseViewUnownedOnly(filters)).toBe(false);
  });
});

describe("describeCaseView", () => {
  it("describes exactly what is in force", () => {
    const { filters } = parseCaseViewFilters(
      source({ q: "یخچال", status: "waiting", priority: "urgent", open: "1", breached: "1" }),
    );
    expect(describeCaseView(filters)).toEqual([
      "جست‌وجو: «یخچال»",
      "وضعیت: منتظر مشتری",
      "اولویت: فوری",
      "فقط بازها",
      "فقط معوق‌ها",
    ]);
  });

  it("names a member when it can and never drops a filter when it cannot", () => {
    const id = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
    const { filters } = parseCaseViewFilters(source({ assignee: id }));
    expect(describeCaseView(filters, { memberName: () => "سارا" })).toEqual(["مسئول: سارا"]);
    expect(describeCaseView(filters)).toEqual(["مسئول: 0f1e2d3c"]);
  });

  it("calls the session's own the same thing the screen does", () => {
    const { filters } = parseCaseViewFilters(source({ assignee: "mine" }));
    expect(describeCaseView(filters)).toEqual(["تیکت‌های من"]);
  });
});

describe("caseViewDuration", () => {
  it("reads seconds as minutes under an hour", () => {
    expect(caseViewDuration(90)).toBe("۲ دقیقه");
    expect(caseViewDuration(3540)).toBe("۵۹ دقیقه");
  });

  it("keeps the half-hour instead of rounding it away", () => {
    // 90 minutes is «۱.۵ ساعت» — a formatter that said «۲ ساعت» would flatter
    // the desk's median response.
    expect(caseViewDuration(5400)).toBe("۱.۵ ساعت");
    expect(caseViewDuration(7200)).toBe("۲ ساعت");
  });

  it("switches to days past two of them", () => {
    expect(caseViewDuration(3 * 24 * 3600)).toBe("۳ روز");
  });

  it("answers «—» for a figure it cannot read", () => {
    expect(caseViewDuration(-1)).toBe("—");
    expect(caseViewDuration(Number.NaN)).toBe("—");
  });
});

describe("caseViewErrorLine", () => {
  it("names the field in Persian and falls back for the rest", () => {
    expect(caseViewErrorLine("priority")).toBe("اولویت انتخاب‌شده معتبر نیست.");
    expect(caseViewErrorLine("something_else")).toBe("فیلترهای این نما معتبر نیستند.");
  });
});

describe("CASE_VIEW_FILTER_KEYS", () => {
  it("is the list the saved views service refuses against", () => {
    expect([...CASE_VIEW_FILTER_KEYS]).toEqual([
      "q",
      "status",
      "priority",
      "assignee",
      "open",
      "breached",
    ]);
  });
});
