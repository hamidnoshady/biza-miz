import { createHash } from "node:crypto";
import { attributeComparisonKey } from "../product-attributes";
import type { WooCommerceClient } from "./woocommerce-client";

interface ReviewedSpec {
  field: string;
  value: string;
  slug: string;
  attributeId: number | null;
  term: { id: number; name: string; slug: string } | null;
}

export function catalogueTermSlug(value: string) {
  return `bizamiz-${createHash("sha256").update(attributeComparisonKey(value)).digest("hex").slice(0, 20)}`;
}

/** Resolve reviewed ids again at delivery. Only a confirmed missing term may be created. */
export async function cataloguePublicationTaxonomies(
  client: WooCommerceClient,
  body: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const specs = (payload.__catalogueAttributes ?? []) as ReviewedSpec[];
  const global = specs.length ? await client.listAttributes() : [];
  const attributes = [];
  const terms = [];
  for (const spec of specs) {
    let attribute = spec.attributeId
      ? global.find(a => a.id === spec.attributeId)
      : global.find(a => a.slug.replace(/^pa_/, "") === spec.slug);
    if (spec.attributeId && !attribute) throw new Error("publication_review:attribute_changed");
    if (!attribute) {
      if (!payload.__catalogueAllowCreate) throw new Error("publication_review:attribute_missing");
      attribute = await client.createAttribute({ name: spec.field, slug: spec.slug, type: "select" });
      global.push(attribute);
    }
    const available = await client.listAttributeTerms(attribute.id);
    const slug = catalogueTermSlug(spec.value);
    let term = spec.term ? available.find(t => t.id === spec.term!.id && t.slug === spec.term!.slug && t.name === spec.term!.name)
      : available.find(t => t.slug === slug && attributeComparisonKey(t.name) === attributeComparisonKey(spec.value));
    if (spec.term && !term) throw new Error("publication_review:attribute_term_changed");
    if (!term) {
      if (!payload.__catalogueAllowCreate || available.some(t => t.slug === slug || attributeComparisonKey(t.name) === attributeComparisonKey(spec.value))) {
        throw new Error("publication_review:attribute_term_changed");
      }
      term = await client.createAttributeTerm(attribute.id, { name: spec.value, slug });
    }
    attributes.push({ id: attribute.id, visible: true, variation: false, options: [term.name] });
    terms.push({ field: spec.field, local: spec.value, attributeId: attribute.id, taxonomy: `pa_${attribute.slug.replace(/^pa_/, "")}`,
      id: term.id, name: term.name, slug: term.slug });
  }
  if (attributes.length) body.attributes = attributes;

  const category = payload.__catalogueCategory as { id: number | null; name: string; slug: string } | undefined;
  let categoryAck: { id: number; name: string; slug: string } | null = null;
  if (category) {
    const available = await client.listCategories();
    let term = category.id ? available.find(t => t.id === category.id && t.slug === category.slug && t.name === category.name)
      : available.find(t => t.slug === category.slug && attributeComparisonKey(t.name) === attributeComparisonKey(category.name));
    if (!term) {
      if (category.id || !payload.__catalogueAllowCreate || available.some(t => t.slug === category.slug ||
          attributeComparisonKey(t.name) === attributeComparisonKey(category.name))) throw new Error("publication_review:category_changed");
      term = await client.createCategory({ name: category.name, slug: category.slug });
    }
    body.categories = [{ id: term.id }];
    categoryAck = { id: term.id, name: term.name, slug: term.slug };
  }
  const brand = payload.__catalogueBrand as { id: number; name: string; slug: string } | undefined;
  if (brand) {
    const taxonomy = (await client.listTaxonomies()).find(t => t.slug === "product_brand");
    if (!taxonomy || !(await client.listTerms(taxonomy.rest_base)).some(t => t.id === brand.id && t.slug === brand.slug && t.name === brand.name)) {
      throw new Error("publication_review:brand_changed");
    }
    body.brands = [{ id: brand.id }];
  }
  return { category: categoryAck, brand: brand ?? null, terms };
}
