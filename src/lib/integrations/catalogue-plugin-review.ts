import { z } from "zod";

const id = z.number().int().positive().safe();
const term = z.object({ id, name: z.string().max(250), slug: z.string().max(250) });
const product = z.object({
  id, name: z.string().max(300), sku: z.string().max(120), type: z.string().max(40), parent: id.nullable(),
  options: z.array(z.object({ name: z.string().max(250), option: z.string().max(250) })).max(40),
  categories: z.array(term).max(100),
});
export const cataloguePluginReviewSchema = z.object({
  matches: z.array(product).max(10),
  variations: z.array(product).max(101),
  categories: z.array(term).max(20),
  brands: z.array(term).max(20),
  attributes: z.array(term.extend({ terms: z.array(term).max(20) })).max(10),
});
