/**
 * The pure half of the shared hierarchy rules (account-hierarchy.ts). The DB
 * half is exercised against real Postgres in integration/holoo and
 * integration/chart-of-accounts; these pin the rules themselves.
 */
import { describe, expect, it } from "vitest";
import { AccountTreeError, attachmentLevel, orderAccountTree, type AttachableParent } from "./account-hierarchy";
import { AccountsError } from "./accounts-error";

function parent(overrides: Partial<AttachableParent> = {}): AttachableParent {
  return { id: "p", code: "1000", type: "asset", level: "group", isActive: true, ...overrides };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountsError);
    return (err as AccountsError).message;
  }
  throw new Error("expected the attachment to be refused");
}

describe("attachmentLevel", () => {
  it("gives the child the tier below its parent, at every depth", () => {
    expect(attachmentLevel(parent({ level: "group" }), "asset")).toBe("kol");
    expect(attachmentLevel(parent({ level: "kol" }), "asset")).toBe("moein");
    expect(attachmentLevel(parent({ level: "moein" }), "asset")).toBe("tafsili");
  });

  it("refuses an archived parent, even one that would otherwise accept the child", () => {
    expect(errorCode(() => attachmentLevel(parent({ isActive: false }), "asset"))).toBe("parent_archived");
  });

  it("refuses a parent already at the deepest tier, rather than clamping the child onto it", () => {
    expect(errorCode(() => attachmentLevel(parent({ level: "tafsili" }), "asset"))).toBe("parent_too_deep");
  });

  it("refuses a child whose type differs from its parent's", () => {
    expect(errorCode(() => attachmentLevel(parent({ type: "asset" }), "liability"))).toBe("parent_type_mismatch");
  });

  it("checks archive before depth before type, so the first failing rule is the one reported", () => {
    expect(errorCode(() => attachmentLevel(parent({ isActive: false, level: "tafsili", type: "asset" }), "liability"))).toBe(
      "parent_archived",
    );
    expect(errorCode(() => attachmentLevel(parent({ level: "tafsili", type: "asset" }), "liability"))).toBe("parent_too_deep");
  });
});

describe("orderAccountTree", () => {
  it("orders parents before children and derives every level from its parent", () => {
    const { ordered, levelByCode } = orderAccountTree([
      { code: "1000-1", parentCode: "1000" },
      { code: "1000", parentCode: null },
      { code: "1000-1-1", parentCode: "1000-1" },
      { code: "1000-1-1-1", parentCode: "1000-1-1" },
    ]);
    expect(ordered.map((n) => n.code)).toEqual(["1000", "1000-1", "1000-1-1", "1000-1-1-1"]);
    expect(Object.fromEntries(levelByCode)).toEqual({
      "1000": "group",
      "1000-1": "kol",
      "1000-1-1": "moein",
      "1000-1-1-1": "tafsili",
    });
  });

  it("handles several roots and siblings, each placed under its own parent", () => {
    const { levelByCode } = orderAccountTree([
      { code: "a", parentCode: null },
      { code: "b", parentCode: null },
      { code: "a1", parentCode: "a" },
      { code: "a2", parentCode: "a" },
      { code: "b1", parentCode: "b" },
    ]);
    expect(levelByCode.get("a1")).toBe("kol");
    expect(levelByCode.get("a2")).toBe("kol");
    expect(levelByCode.get("b1")).toBe("kol");
  });

  it("refuses a fifth tier rather than clamping it onto تفصیلی", () => {
    const chain = [
      { code: "1", parentCode: null },
      { code: "11", parentCode: "1" },
      { code: "111", parentCode: "11" },
      { code: "1111", parentCode: "111" },
      { code: "11111", parentCode: "1111" },
    ];
    expect(() => orderAccountTree(chain)).toThrow(AccountTreeError);
    try {
      orderAccountTree(chain);
    } catch (err) {
      expect((err as AccountTreeError).reason).toBe("too_deep");
    }
  });

  it("refuses a parent that is not in the list, rather than re-rooting the child", () => {
    try {
      orderAccountTree([{ code: "1100", parentCode: "1000" }]);
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(AccountTreeError);
      expect((err as AccountTreeError).reason).toBe("parent_missing");
    }
  });

  it("refuses a cycle, including one the starting node is not part of", () => {
    for (const nodes of [
      [{ code: "a", parentCode: "b" }, { code: "b", parentCode: "a" }],
      [{ code: "x", parentCode: "a" }, { code: "a", parentCode: "b" }, { code: "b", parentCode: "a" }],
      [{ code: "self", parentCode: "self" }],
    ]) {
      try {
        orderAccountTree(nodes);
        throw new Error("expected refusal");
      } catch (err) {
        expect(err).toBeInstanceOf(AccountTreeError);
        expect((err as AccountTreeError).reason).toBe("parent_cycle");
      }
    }
  });

  it("refuses duplicate codes, since a code names exactly one account", () => {
    try {
      orderAccountTree([{ code: "1000", parentCode: null }, { code: "1000", parentCode: null }]);
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as AccountTreeError).reason).toBe("duplicate_code");
    }
  });

  it("refuses a child whose type differs from its parent's, with the reason and the child's code (issue #824 finding 1)", () => {
    const err = (() => {
      try {
        orderAccountTree([
          { code: "1000", parentCode: null, type: "asset" },
          { code: "1100", parentCode: "1000", type: "liability" },
        ]);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(AccountTreeError);
    expect(err).toMatchObject({ reason: "type_mismatch", code: "1100" });
  });

  it("refuses a mismatch deeper in the chain, not only at the first tier", () => {
    expect(() =>
      orderAccountTree([
        { code: "1000", parentCode: null, type: "asset" },
        { code: "1100", parentCode: "1000", type: "asset" },
        { code: "1110", parentCode: "1100", type: "expense" },
      ]),
    ).toThrow("account_tree_type_mismatch:1110");
  });

  it("orders by structure alone when the nodes carry no type", () => {
    const { levelByCode } = orderAccountTree([
      { code: "1000", parentCode: null },
      { code: "1100", parentCode: "1000" },
    ]);
    expect(levelByCode.get("1100")).toBe("kol");
  });

  it("accepts an empty chart", () => {
    expect(orderAccountTree([]).ordered).toEqual([]);
  });
});
