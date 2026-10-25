import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIELD_AUTHORITY_POLICY,
  diffFields,
  fieldClassFor,
  isRejectedRemoteEdit,
  remoteEditFingerprint,
  resolveFieldAction,
  resolveFieldOwner,
} from "./field-authority";

const policy = DEFAULT_FIELD_AUTHORITY_POLICY;

describe("field authority", () => {
  it("classifies cost, price and stock as protected and titles as presentation", () => {
    expect(fieldClassFor("product", "cost")).toBe("financial");
    expect(fieldClassFor("product", "stock_quantity")).toBe("stock");
    expect(fieldClassFor("product", "sale_price")).toBe("store_price");
    expect(fieldClassFor("product", "title")).toBe("presentation");
    expect(fieldClassFor("inventory", "quantity")).toBe("stock");
  });

  it("never lets an incoming financial or stock value win by arriving", () => {
    expect(resolveFieldAction(policy, "product", "cost", "100", "120")).toBe("review");
    expect(resolveFieldAction(policy, "product", "stock_quantity", "4", "9")).toBe("review");
  });

  it("ignores a policy that tries to hand a source financial authority", () => {
    const sneaky = { version: 2, classOwners: { financial: "source" as const, stock: "source" as const } };
    expect(resolveFieldOwner(sneaky, "product", "cost")).toBe("canonical");
    expect(resolveFieldAction(sneaky, "product", "cost", "100", "120")).toBe("review");
  });

  it("keeps a per-store price on the source and never on the canonical row", () => {
    expect(resolveFieldAction(policy, "product", "sale_price", "90", "80")).toBe("keep_source_local");
  });

  it("fills blank presentation fields and keeps existing canonical ones", () => {
    expect(resolveFieldAction(policy, "product", "description", "", "text")).toBe("fill_blank");
    expect(resolveFieldAction(policy, "product", "description", "mine", "theirs")).toBe("keep_canonical");
  });

  it("lets a source own presentation when the policy says so, per connection", () => {
    const web = { version: 3, classOwners: { presentation: "source" as const } };
    expect(resolveFieldAction(web, "product", "description", "mine", "theirs")).toBe("keep_source_local");
  });

  it("reviews a changed identity field and fills a blank one", () => {
    expect(resolveFieldAction(policy, "product", "unit", "kg", "g")).toBe("review");
    expect(resolveFieldAction(policy, "product", "unit", null, "g")).toBe("fill_blank");
  });

  it("honours an explicit owner override, and only then takes the source value", () => {
    expect(resolveFieldAction(policy, "product", "cost", "100", "120", { cost: "source" })).toBe("take_source");
    expect(resolveFieldAction(policy, "product", "cost", "100", "120", { cost: "canonical" })).toBe("keep_canonical");
  });

  it("treats an equal value as no conflict and ignores absent fields", () => {
    const conflicts = diffFields(policy, "product", { cost: "100", title: "a" }, { cost: "100" });
    expect(conflicts).toEqual([]);
    const some = diffFields(policy, "product", { cost: "100", title: "a" }, { cost: "110", title: "b" });
    expect(some.map((c) => [c.field, c.action, c.needsReview])).toEqual([
      ["cost", "review", true],
      ["title", "keep_canonical", false],
    ]);
  });

  it("recognises a remote value that was already rejected so it is not echoed again", () => {
    const rejected = new Set([remoteEditFingerprint("price", 120)]);
    expect(isRejectedRemoteEdit(rejected, "price", 120)).toBe(true);
    expect(isRejectedRemoteEdit(rejected, "price", 130)).toBe(false);
  });
});
