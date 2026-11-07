import { createHash } from "node:crypto";
import { normalizeNameKey } from "../import-reconciliation/normalize";
import type { WooCommerceClient, WooTerm } from "./woocommerce-client";

export type CatalogueTaxonomyTerm = { name: string; slug: string; id?: number };
export type CatalogueTaxonomyPlan = {
  category?: CatalogueTaxonomyTerm;
  attributes: Array<{ name: string; slug: string; id?: number; term: CatalogueTaxonomyTerm }>;
};

/** Missing terms get a stable namespace independent of display language or retry. */
export function catalogueTermSlug(name: string) {
  const key = normalizeNameKey(name) ?? name;
  return `bizamiz-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

function uniqueReviewedTerm<T extends { id: number; name: string; slug: string }>(terms: T[], wanted: CatalogueTaxonomyTerm) {
  if (wanted.id !== undefined) {
    const term = terms.find((candidate) => candidate.id === wanted.id);
    if (!term || term.slug !== wanted.slug) throw new Error("publication_taxonomy_changed");
    return term;
  }
  const slug = terms.find((candidate) => candidate.slug === wanted.slug || candidate.slug === `pa_${wanted.slug}`);
  if (slug && normalizeNameKey(slug.name) !== normalizeNameKey(wanted.name)) throw new Error("publication_taxonomy_slug_conflict");
  const candidates = terms.filter((candidate) => normalizeNameKey(candidate.name) === normalizeNameKey(wanted.name));
  if (candidates.length > 1 || (slug && candidates.length === 1 && candidates[0].id !== slug.id)) {
    throw new Error("publication_taxonomy_ambiguous");
  }
  return slug ?? candidates[0];
}

export async function applyCatalogueTaxonomy(client: WooCommerceClient, plan: CatalogueTaxonomyPlan) {
  let category: WooTerm | undefined;
  if (plan.category) {
    const wanted = plan.category;
    category = uniqueReviewedTerm(await client.listCategories(), wanted) ??
      await client.createCategory({ name: wanted.name, slug: wanted.slug });
  }
  const attributes = [];
  const identities = [];
  const available = plan.attributes.length ? await client.listAttributes() : [];
  for (const wanted of plan.attributes) {
    const slug = wanted.slug.replace(/^pa_/, "");
    const local = available.map((attribute) => ({ ...attribute, slug: attribute.slug.replace(/^pa_/, "") }));
    const attribute = uniqueReviewedTerm(local, { ...wanted, slug }) ??
      await client.createAttribute({ name: wanted.name, slug, type: "select" });
    const term = uniqueReviewedTerm(await client.listAttributeTerms(attribute.id), wanted.term) ??
      await client.createAttributeTerm(attribute.id, { name: wanted.term.name, slug: wanted.term.slug });
    attributes.push({ id: attribute.id, visible: true, variation: false, options: [term.name] });
    identities.push({ attributeId: attribute.id, taxonomy: `pa_${attribute.slug.replace(/^pa_/, "")}`, termId: term.id, slug: term.slug });
  }
  return {
    body: { ...(category ? { categories: [{ id: category.id }] } : {}), attributes },
    identities: { categoryId: category?.id ?? null, attributes: identities },
  };
}
