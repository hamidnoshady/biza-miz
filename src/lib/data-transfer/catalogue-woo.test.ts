import { describe, expect, it } from "vitest";
import { resolveWooCatalogueAction } from "./catalogue-woo";

const watch = { id: "42", name: "Store presentation", sku: "w12", type: "simple", parent: null };
describe("reviewed Woo catalogue matches", () => {
  it("proposes only an exact compatible store match", () => {
    expect(resolveWooCatalogueAction("W12", "simple", null, [watch])).toEqual({ action: "link", remote: watch });
    expect(resolveWooCatalogueAction("W12", "variable", null, [watch]).action).toBe("conflict");
    expect(resolveWooCatalogueAction("W12", "simple", null, [{ ...watch, parent: "4" }]).action).toBe("conflict");
  });

  it("does not repoint links or resolve ambiguous SKU matches", () => {
    expect(resolveWooCatalogueAction("W12", "simple", "other", [{ ...watch, linkedTo: "local" }]).action).toBe("conflict");
    expect(resolveWooCatalogueAction("W12", "simple", "local", [{ ...watch, linkedTo: "local" }]).action).toBe("linked");
    expect(resolveWooCatalogueAction("W12", "simple", null, [watch, { ...watch, id: "71" }]).action).toBe("conflict");
  });
});
