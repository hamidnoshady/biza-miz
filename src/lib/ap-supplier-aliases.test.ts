import { describe, expect, it } from "vitest";
import { uniqueSupplierAliasByParty } from "./ap-supplier-aliases";

describe("uniqueSupplierAliasByParty", () => {
  it("maps one supplier alias to the party directory's statement key", () => {
    expect(uniqueSupplierAliasByParty([
      { supplierId: "supplier-main", supplierPartyId: "party-one", locationName: "Main" },
      { supplierId: "unlinked", supplierPartyId: null, locationName: "Spare" },
    ])).toEqual({ "party-one": { supplierId: "supplier-main", locationName: "Main" } });
  });

  it("withholds ambiguous multi-branch parties instead of selecting an arbitrary alias", () => {
    expect(uniqueSupplierAliasByParty([
      { supplierId: "supplier-main", supplierPartyId: "party-one", locationName: "Main" },
      { supplierId: "supplier-branch", supplierPartyId: "party-one", locationName: "Branch" },
      { supplierId: "supplier-unique", supplierPartyId: "party-two", locationName: "Main" },
    ])).toEqual({ "party-two": { supplierId: "supplier-unique", locationName: "Main" } });
  });
});
