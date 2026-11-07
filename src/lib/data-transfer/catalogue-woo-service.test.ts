import { describe, expect, it } from "vitest";
import { catalogueTaxonomyCandidates } from "./catalogue-woo-service";

describe("catalogue Woo taxonomy review", () => {
  const terms = [
    { taxonomy: "product_cat", remoteId: "21", slug: "sport", name: "اسپرت" },
    { taxonomy: "product_cat", remoteId: "22", slug: "sport-watches", name: "اسپرت" },
    { taxonomy: "product_brand", remoteId: "23", slug: "sport", name: "اسپرت" },
    { taxonomy: "pa_case-color", remoteId: "42", slug: "black", name: "مشكي" },
  ];

  it("preserves ambiguous candidates and keeps identical names in different taxonomies apart", () => {
    expect(catalogueTaxonomyCandidates(terms, "product_cat", " اسپرت ").map(({ remoteId }) => remoteId)).toEqual(["21", "22"]);
    expect(catalogueTaxonomyCandidates(terms, "product_brand", "sport").map(({ remoteId }) => remoteId)).toEqual(["23"]);
  });

  it("normalizes Persian names and reports missing values without inventing IDs", () => {
    expect(catalogueTaxonomyCandidates(terms, "pa_case-color", "مشکی").map(({ remoteId }) => remoteId)).toEqual(["42"]);
    expect(catalogueTaxonomyCandidates(terms, "pa_case-color", "Blue")).toEqual([]);
  });
});
