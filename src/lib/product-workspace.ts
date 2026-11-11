/**
 * Phase 42 — the products workspace («مدیریت محصولات»).
 *
 * The retail trade-goods industries used to manage their catalogue inside
 * each trade's own page «کالاها» tab (the shared VariantsSection over
 * `items`/`item_stock`). The workspace is the catalogue's one door: a
 * collapsible sidebar group — افزودن محصول، لیست محصولات، لیست قیمت، ویژگی
 * محصول، بارکد و برچسب محصولات (+ each trade's گزارش‌ها) — over `/accounting/products/*`,
 * with the trade's own items/stock APIs still doing the writing. Jewellery
 * and watch keep their own managers: their subject is one weighted piece or
 * one serialised unit per row, not a priced variant board.
 *
 * Framework-free like `apps.ts`: the sidebar (layout.tsx), the page guards
 * and the API guards all read the same two tables below.
 */
import { accountingProductsHref } from "./app-routes";
import { isRetailCatalogueIndustry, type Industry, type RetailCatalogueIndustry } from "./industries";
import { PERMISSIONS, type Permission } from "./permissions";

/** The trades whose catalogue is the variant board this workspace manages. */
export const PRODUCT_WORKSPACE_INDUSTRIES = [
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
] as const;
export type ProductWorkspaceIndustry = (typeof PRODUCT_WORKSPACE_INDUSTRIES)[number];

export function isProductWorkspaceIndustry(
  industry: Industry | null | undefined,
): industry is ProductWorkspaceIndustry {
  return (PRODUCT_WORKSPACE_INDUSTRIES as readonly string[]).includes(industry ?? "");
}

/**
 * Catalogue entry-point adapters. The variant workspace is not a suitable
 * implementation for weighted pieces, serialised watches or physical cars.
 * These specialist adapters point to their existing managers and read guards;
 * shared views use native APIs, never the variant workspace's APIs or mutations.
 *
 * `satisfies` makes adding an industry to the canonical retail registry a
 * compile-time prompt to select its native implementation and permission.
 */
type CatalogueAdapter =
  | { kind: "variants"; apiBase: string }
  | { kind: "specialist"; href: string; readPermission: Permission };

const CATALOGUE_ADAPTERS = {
  jewelry: { kind: "specialist", href: "/accounting/jewelry", readPermission: PERMISSIONS.inventoryView },
  watch: { kind: "specialist", href: "/accounting/watch", readPermission: PERMISSIONS.inventoryView },
  accessories: { kind: "variants", apiBase: "/api/accessories" },
  cosmetics: { kind: "variants", apiBase: "/api/cosmetics" },
  wholesale: { kind: "variants", apiBase: "/api/wholesale" },
  tools_fittings: { kind: "variants", apiBase: "/api/tools-fittings" },
  haberdashery: { kind: "variants", apiBase: "/api/haberdashery" },
  automotive: { kind: "specialist", href: "/accounting/automotive", readPermission: PERMISSIONS.vehiclesView },
} as const satisfies Record<RetailCatalogueIndustry, CatalogueAdapter>;

export function catalogueAdapterFor(industry: Industry | null | undefined): CatalogueAdapter | null {
  return isRetailCatalogueIndustry(industry) ? CATALOGUE_ADAPTERS[industry] : null;
}

/** The native items/stock API for the five variant-workspace trades only. */
export function productApiBaseFor(industry: ProductWorkspaceIndustry): string {
  return CATALOGUE_ADAPTERS[industry].apiBase;
}

/** The sidebar group's sub-sections, in the order the reference seats them. */
export const PRODUCT_WORKSPACE_SECTIONS = [
  { key: "new", label: "افزودن محصول", href: accountingProductsHref("new") },
  { key: "list", label: "لیست محصولات", href: accountingProductsHref() },
  { key: "prices", label: "لیست قیمت", href: accountingProductsHref("prices") },
  { key: "attributes", label: "ویژگی محصول", href: accountingProductsHref("attributes") },
  { key: "barcodes", label: "بارکد و برچسب محصولات", href: accountingProductsHref("barcode-templates") },
  { key: "reports", label: "گزارش‌ها", href: accountingProductsHref("reports") },
] as const;
export type ProductWorkspaceSectionKey = (typeof PRODUCT_WORKSPACE_SECTIONS)[number]["key"];
