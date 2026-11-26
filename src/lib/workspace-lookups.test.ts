import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db", () => ({ query: m.query }));

import {
  WORKSPACE_PARTY_MAX_PAGE_SIZE,
  WORKSPACE_PARTY_MAX_TERM,
  normalizePartySearchTerm,
  partyIdsFrom,
  partyPageRequest,
  searchWorkspaceParties,
} from "./workspace-lookups";

const ID_A = "8b1f5f9e-0000-4000-8000-000000000001";
const ID_B = "8b1f5f9e-0000-4000-8000-000000000002";

interface Answer {
  page?: Array<{ id: string; name: string }>;
  total?: number;
  selected?: Array<{ id: string; name: string }>;
}

/** Answer by what the statement asks for, so the test never depends on ordering. */
function answerWith(answer: Answer) {
  m.query.mockImplementation((sql: string) => {
    if (sql.includes("count(*)")) return Promise.resolve({ rows: [{ total: String(answer.total ?? 0) }] });
    if (sql.includes("id::text = ANY")) return Promise.resolve({ rows: answer.selected ?? [] });
    return Promise.resolve({ rows: answer.page ?? [] });
  });
}

const callFor = (needle: string) =>
  m.query.mock.calls.find(([sql]) => (sql as string).includes(needle)) as [string, unknown[]];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("party picker input (#907 F10)", () => {
  it("bounds the term so a scan cannot be driven by a pasted paragraph", () => {
    expect(normalizePartySearchTerm("  شرکت   آلفا  ")).toBe("شرکت آلفا");
    expect(normalizePartySearchTerm(null)).toBe("");
    expect(normalizePartySearchTerm("x".repeat(500))).toHaveLength(WORKSPACE_PARTY_MAX_TERM);
  });

  it("clamps page and page size, and derives the offset", () => {
    expect(partyPageRequest({ page: "2", pageSize: "10" })).toEqual({
      page: 2,
      pageSize: 10,
      offset: 10,
    });
    expect(partyPageRequest({ page: "0", pageSize: "1000" })).toEqual({
      page: 1,
      pageSize: WORKSPACE_PARTY_MAX_PAGE_SIZE,
      offset: 0,
    });
    expect(partyPageRequest({ page: null, pageSize: null })).toEqual({
      page: 1,
      pageSize: 25,
      offset: 0,
    });
  });

  it("keeps only well-formed, unique ids from the selected row", () => {
    expect(partyIdsFrom(`${ID_A}, ${ID_A}, not-an-id, ${ID_B}`)).toEqual([ID_A, ID_B]);
    expect(partyIdsFrom("' OR 1=1 --")).toEqual([]);
  });
});

describe("searchWorkspaceParties", () => {
  it("pages the authorised, live directory and reports the true total", async () => {
    answerWith({ page: [{ id: ID_A, name: "شرکت آلفا" }], total: 40 });

    const page = await searchWorkspaceParties("business-1", { q: "آلفا", page: 2, pageSize: 1 });

    const [pageSql, pageParams] = callFor("LIMIT $3 OFFSET $4");
    expect(pageSql).toContain("business_id = $1 AND is_active AND merged_into_id IS NULL");
    expect(pageParams).toEqual(["business-1", "%آلفا%", 1, 1]);
    expect(page).toMatchObject({ total: 40, page: 2, pageSize: 1, hasMore: true });
    expect(page.parties).toEqual([{ id: ID_A, name: "شرکت آلفا" }]);
  });

  it("resolves the selected row by id, even when it matches no term and sits on another page", async () => {
    answerWith({ page: [], total: 3, selected: [{ id: ID_B, name: "طرف حساب انتخاب‌شده" }] });

    const page = await searchWorkspaceParties("business-1", { q: "نام دیگر", ids: [ID_B] });

    const [selectedSql, selectedParams] = callFor("id::text = ANY($2::text[])");
    expect(selectedSql).toContain("business_id = $1");
    expect(selectedParams).toEqual(["business-1", [ID_B]]);
    expect(page.selected).toEqual([{ id: ID_B, name: "طرف حساب انتخاب‌شده" }]);
    expect(page.parties).toEqual([]);
    expect(page.hasMore).toBe(true);
  });

  it("treats LIKE wildcards as the member's literal characters", async () => {
    answerWith({});

    await searchWorkspaceParties("business-1", { q: "50%_x" });

    const [, params] = callFor("LIMIT $3 OFFSET $4");
    expect(params[1]).toBe("%50\\%\\_x%");
  });

  it("says there is no more when the last page ends at the total", async () => {
    answerWith({ page: [{ id: ID_A, name: "آلفا" }, { id: ID_B, name: "بتا" }], total: 2 });

    const page = await searchWorkspaceParties("business-1", { q: "" });
    expect(page.hasMore).toBe(false);
    expect(page.total).toBe(2);
  });
});
