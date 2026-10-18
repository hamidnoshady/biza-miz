import { describe, expect, it } from "vitest";
import {
  MEMBER_HISTORY_KEYS,
  MEMBER_HISTORY_LABELS,
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
