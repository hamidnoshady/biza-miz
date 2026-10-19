import { describe, expect, it } from "vitest";
import {
  MEMBER_HISTORY_RECORD_ATTRIBUTIONS,
  MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS,
  MEMBER_HISTORY_KEYS,
  MEMBER_HISTORY_LABELS,
  memberAttributionSql,
  memberHasHistory,
  memberHistoryLabels,
  type MemberHistoryFlags,
} from "./member-history";

function history(overrides: Partial<MemberHistoryFlags> = {}): MemberHistoryFlags {
  return {
    orders: false,
    shifts: false,
    journal: false,
    payroll: false,
    audit: false,
    file: false,
    reservations: false,
    records: false,
    ...overrides,
  };
}

describe("memberHasHistory", () => {
  it("is false for a member nothing in the business points at", () => {
    expect(memberHasHistory(history())).toBe(false);
  });

  it("is true for every flag on its own", () => {
    for (const key of MEMBER_HISTORY_KEYS) {
      expect(memberHasHistory(history({ [key]: true })), key).toBe(true);
    }
  });
});

describe("memberHistoryLabels", () => {
  it("lists nothing for a clean member", () => {
    expect(memberHistoryLabels(history())).toEqual([]);
  });

  it("names the kinds of history that are present, in catalogue order", () => {
    expect(
      memberHistoryLabels(history({ journal: true, orders: true })),
    ).toEqual([MEMBER_HISTORY_LABELS.orders, MEMBER_HISTORY_LABELS.journal]);
  });

  it("has a Persian label for every flag", () => {
    for (const key of MEMBER_HISTORY_KEYS) {
      expect(MEMBER_HISTORY_LABELS[key], key).toBeTruthy();
    }
  });
});

describe("memberAttributionSql (the reservations/records sweep)", () => {
  it("is FALSE for an empty catalogue, never an empty OR", () => {
    expect(memberAttributionSql([], "$2", "$1")).toBe("FALSE");
  });

  it("scopes a business_id table straight to the business", () => {
    const sql = memberAttributionSql(
      [{ table: "purchases", columns: ["created_by"] }],
      "$2",
      "$1",
    );
    expect(sql).toBe(
      "EXISTS (SELECT 1 FROM purchases a0 WHERE a0.business_id = $1 AND (a0.created_by = $2))",
    );
  });

  it("walks branch-scoped tables through locations (the reservations shape)", () => {
    const sql = memberAttributionSql(MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS, "$2", "$1");
    expect(sql).toBe(
      "EXISTS (SELECT 1 FROM reservations a0 JOIN locations l0 ON l0.id = a0.location_id WHERE l0.business_id = $1 AND (a0.created_by = $2))",
    );
  });

  it("walks parent-scoped tables through the parent row", () => {
    const sql = memberAttributionSql(
      [
        {
          table: "fixed_asset_transfers",
          columns: ["transferred_by"],
          scope: { kind: "join", table: "fixed_assets", on: "fixed_asset_id" },
        },
      ],
      "$2",
      "$1",
    );
    expect(sql).toBe(
      "EXISTS (SELECT 1 FROM fixed_asset_transfers a0 JOIN fixed_assets j0 ON j0.id = a0.fixed_asset_id WHERE j0.business_id = $1 AND (a0.transferred_by = $2))",
    );
  });

  it("ORs several columns of one table and several tables together", () => {
    const sql = memberAttributionSql(
      [
        { table: "expenses", columns: ["created_by", "reversed_by"] },
        { table: "cheques", columns: ["created_by"] },
      ],
      "$2",
      "$1",
    );
    expect(sql).toBe(
      "EXISTS (SELECT 1 FROM expenses a0 WHERE a0.business_id = $1 AND (a0.created_by = $2 OR a0.reversed_by = $2)) OR " +
        "EXISTS (SELECT 1 FROM cheques a1 WHERE a1.business_id = $1 AND (a1.created_by = $2))",
    );
  });

  it("pins the code-review P1: reservations.created_by is probed", () => {
    expect(
      MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS.some(
        (a) => a.table === "reservations" && a.columns.includes("created_by"),
      ),
    ).toBe(true);
  });

  it("catalogues never probe the same table twice", () => {
    const tables = [
      ...MEMBER_HISTORY_RESERVATION_ATTRIBUTIONS,
      ...MEMBER_HISTORY_RECORD_ATTRIBUTIONS,
    ].map((a) => a.table);
    expect(new Set(tables).size).toBe(tables.length);
  });
});
