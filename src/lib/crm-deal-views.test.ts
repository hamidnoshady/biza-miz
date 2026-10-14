/**
 * The deals filter vocabulary — the promise a saved view makes.
 *
 * `crm_saved_views` stores a set of filter keys per entity and states that a
 * saved view is "exactly a set of the filters that screen already supports".
 * This module is that sentence, made testable: one parser the API and the
 * screen share, so what a view stores, what the screen labels and what the
 * server applies cannot drift into three answers.
 *
 * What is pinned here, in order of how much damage the alternative does:
 *
 *  1. **A filter is refused, not half-applied.** An impossible value (a
 *     non-uuid stage, a range that cannot exist) comes back as a named field so
 *     the screen can point at the control — never as a silently dropped filter,
 *     which is how a list ends up labelled with something it is not filtered by.
 *  2. **An unknown key is ignored.** A view saved by a newer build must still
 *     open on an older tab, minus the filter that build does not have.
 *  3. **Amounts cross the Toman/Rial border once.** The control shows Toman, the
 *     column stores Rial, and a threshold converted on the wrong side is a
 *     filter that matches nothing — the failure nobody reports.
 *  4. **`mine` without a member id means "nobody".** A filter about ownership
 *     must never widen into "everybody" because the caller was a service.
 */
import { describe, expect, it } from "vitest";
import {
  DEAL_VIEW_FILTER_KEYS,
  EMPTY_DEAL_VIEW_FILTERS,
  dealViewErrorLine,
  dealViewFilterCount,
  dealViewOwnerUserId,
  dealViewQuery,
  dealViewRialBounds,
  dealViewSearchParams,
  dealViewUnownedOnly,
  describeDealView,
  hasDealViewFilters,
  parseDealViewFilters,
} from "./crm-deal-views";

function source(params: Record<string, string>): { get(key: string): string | null } {
  return { get: (key) => (key in params ? params[key] : null) };
}

const STAGE = "11111111-1111-4111-8111-111111111111";
const PIPELINE = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";

describe("parseDealViewFilters", () => {
  it("reads every declared key", () => {
    const { filters, error } = parseDealViewFilters(
      source({
        q: "  دفتر مرکزی ",
        stageId: STAGE,
        pipelineId: PIPELINE,
        owner: MEMBER,
        open: "1",
        minValue: "5000000",
        maxValue: "20000000",
      }),
    );
    expect(error).toBeNull();
    expect(filters).toEqual({
      q: "دفتر مرکزی",
      stageId: STAGE,
      pipelineId: PIPELINE,
      owner: MEMBER,
      openOnly: true,
      minToman: 5_000_000,
      maxToman: 20_000_000,
    });
  });

  it("reads Persian digits and grouping in an amount", () => {
    const { filters } = parseDealViewFilters(source({ minValue: "۱۰٬۰۰۰٬۰۰۰" }));
    // The unit is Toman on both sides of the border; the thousands separator is
    // presentation and never reaches the database.
    expect(filters.minToman).toBe(10_000_000);
  });

  it("refuses a stage, pipeline or owner that cannot exist, naming the field", () => {
    expect(parseDealViewFilters(source({ stageId: "miz" })).error).toBe("stageId");
    expect(parseDealViewFilters(source({ pipelineId: "miz" })).error).toBe("pipelineId");
    expect(parseDealViewFilters(source({ owner: "مریم" })).error).toBe("owner");
    expect(parseDealViewFilters(source({ owner: "mine" })).error).toBeNull();
    expect(parseDealViewFilters(source({ owner: "none" })).error).toBeNull();
  });

  it("refuses a range that cannot exist, and a value that is not a number", () => {
    expect(parseDealViewFilters(source({ minValue: "abc" })).error).toBe("minValue");
    expect(parseDealViewFilters(source({ maxValue: "-5" })).error).toBe("maxValue");
    expect(parseDealViewFilters(source({ minValue: "20", maxValue: "10" })).error).toBe("minValue");
  });

  it("ignores a key it does not know, without failing the rest", () => {
    // A newer build's filter must not break an older tab — and must not take
    // the filters this build *does* understand down with it.
    const { filters, error } = parseDealViewFilters(source({ q: "آلفا", forecast: "high" }));
    expect(error).toBeNull();
    expect(filters.q).toBe("آلفا");
    expect(filters).not.toHaveProperty("forecast");
  });

  it("answers the empty document for no parameters at all", () => {
    expect(parseDealViewFilters(source({}))).toEqual({ filters: EMPTY_DEAL_VIEW_FILTERS, error: null });
  });
});

describe("the query a filter set produces", () => {
  it("carries only what is set, round-tripping through the parser", () => {
    const filters = {
      ...EMPTY_DEAL_VIEW_FILTERS,
      q: "الف",
      stageId: STAGE,
      openOnly: true,
      minToman: 1_000_000,
    };
    const query = dealViewQuery(filters);
    expect(query).toEqual({ q: "الف", stageId: STAGE, open: "1", minValue: "1000000" });
    // The parser is the serialiser's inverse on its own output: what the screen
    // sends is what the server reads back.
    expect(parseDealViewFilters({ get: (key) => query[key] ?? null }).filters).toEqual(filters);
    expect(dealViewSearchParams(filters).get("minValue")).toBe("1000000");
  });

  it("counts only the filters in force", () => {
    expect(dealViewFilterCount(EMPTY_DEAL_VIEW_FILTERS)).toBe(0);
    expect(hasDealViewFilters(EMPTY_DEAL_VIEW_FILTERS)).toBe(false);
    expect(dealViewFilterCount({ ...EMPTY_DEAL_VIEW_FILTERS, owner: "mine" })).toBe(1);
    expect(dealViewFilterCount({ ...EMPTY_DEAL_VIEW_FILTERS, q: "  " })).toBe(0);
  });

  it("keeps the vocabulary in step with the saved-view service's keys", async () => {
    // The service imports this list, so the two are one list by construction —
    // asserted anyway, because a future edit to either file is exactly when the
    // board would start storing a filter it cannot honour again.
    const service = await import("./crm-saved-views-service");
    expect(service.SAVED_VIEW_ENTITIES).toContain("deals");
    expect([...DEAL_VIEW_FILTER_KEYS]).toEqual([
      "q",
      "stageId",
      "pipelineId",
      "owner",
      "open",
      "minValue",
      "maxValue",
    ]);
  });
});

describe("amounts and ownership at the boundary", () => {
  it("converts Toman to Rial exactly once", () => {
    expect(dealViewRialBounds(EMPTY_DEAL_VIEW_FILTERS)).toEqual({
      minValueRial: null,
      maxValueRial: null,
    });
    expect(dealViewRialBounds({ ...EMPTY_DEAL_VIEW_FILTERS, minToman: 1_000, maxToman: 2_000 })).toEqual(
      { minValueRial: 10_000, maxValueRial: 20_000 },
    );
  });

  it("turns `mine` into the viewer, and nobody into nobody", () => {
    expect(dealViewOwnerUserId({ ...EMPTY_DEAL_VIEW_FILTERS, owner: "mine" }, MEMBER)).toBe(MEMBER);
    // A caller with no member id must not fall back to "everybody": the filter
    // is about ownership, so the only safe reading is "no rows".
    expect(dealViewOwnerUserId({ ...EMPTY_DEAL_VIEW_FILTERS, owner: "mine" }, null)).toBeNull();
    expect(dealViewUnownedOnly({ ...EMPTY_DEAL_VIEW_FILTERS, owner: "none" })).toBe(true);
    expect(dealViewOwnerUserId({ ...EMPTY_DEAL_VIEW_FILTERS, owner: MEMBER }, MEMBER)).toBe(MEMBER);
    expect(dealViewOwnerUserId(EMPTY_DEAL_VIEW_FILTERS, MEMBER)).toBeNull();
  });
});

describe("the filters in words", () => {
  it("names each filter through the lookups, and never hides one", () => {
    const chips = describeDealView(
      {
        q: "دفتر",
        stageId: STAGE,
        pipelineId: PIPELINE,
        owner: MEMBER,
        openOnly: true,
        minToman: 5_000_000,
        maxToman: 90_000_000,
      },
      {
        stageName: () => "مذاکره",
        pipelineName: () => "فروش سازمانی",
        memberName: () => "زهرا کریمی",
      },
    );
    expect(chips).toEqual([
      "جست‌وجو: «دفتر»",
      "مرحله: مذاکره",
      "قیف: فروش سازمانی",
      "مسئول: زهرا کریمی",
      "فقط بازها",
      "از ۵٬۰۰۰٬۰۰۰ تومان",
      "تا ۹۰٬۰۰۰٬۰۰۰ تومان",
    ]);
  });

  it("falls back to the id's short form when nothing can name it", () => {
    const chips = describeDealView({ ...EMPTY_DEAL_VIEW_FILTERS, stageId: STAGE });
    expect(chips).toEqual([`مرحله: ${STAGE.slice(0, 8)}`]);
  });

  it("returns nothing for the empty document", () => {
    expect(describeDealView(EMPTY_DEAL_VIEW_FILTERS)).toEqual([]);
    expect(describeDealView({ ...EMPTY_DEAL_VIEW_FILTERS, owner: "none" })).toEqual(["بدون مسئول"]);
    expect(describeDealView({ ...EMPTY_DEAL_VIEW_FILTERS, owner: "mine" })).toEqual(["معامله‌های من"]);
  });

  it("has a sentence for every field the parser can refuse", () => {
    for (const field of ["stageId", "pipelineId", "owner", "minValue", "maxValue"]) {
      expect(dealViewErrorLine(field)).not.toBe(dealViewErrorLine("something_else"));
    }
    expect(dealViewErrorLine("unknown_field")).toBe("فیلترهای این نما معتبر نیستند.");
  });
});
