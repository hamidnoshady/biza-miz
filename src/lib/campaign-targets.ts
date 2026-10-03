/**
 * «شامل چه کالاهایی می‌شود؟» — the product-eligibility step of a discount
 * campaign (issue #764).
 *
 * The promotion engine (`promotions.ts`) has always understood `itemIds`,
 * `brandIds` and `categoryIds`; the form sent three empty arrays, so every
 * campaign silently applied to the whole catalogue. This file is the pure half
 * of exposing that: which axes a trade can actually match on, and the
 * plain-language sentence an owner reads before saving. It invents no rule
 * the engine does not enforce — no exclusions, no customer targeting.
 *
 * Which axes exist is a fact about how the trade sells, not a preference:
 *
 *   - F&B (`order_ticket`) carts carry the menu item and its menu category
 *     (`order-totals.ts`); there are no brands on a menu.
 *   - Retail (`retail_invoice`) carts carry the item and its brand
 *     (`retail-invoice-service.ts`); retail items have no category column the
 *     cart passes, so offering one would save a rule that never matches.
 *
 * Within a promotion the axes are ANDed (`matchesScope`): an item rule and a
 * brand rule together mean "these items, and only if they are that brand".
 */
import { formatPersianNumber } from "./digits";
import type { SalesModel } from "./industry-profile";

export type CampaignTargetAxis = "items" | "categories" | "brands";

export interface CampaignTargetOption {
  id: string;
  name: string;
  /** The branch the row belongs to, when the business has more than one. */
  branch?: string | null;
}

export interface CampaignTargetCatalogue {
  axes: CampaignTargetAxis[];
  items: CampaignTargetOption[];
  categories: CampaignTargetOption[];
  brands: CampaignTargetOption[];
}

export const CAMPAIGN_TARGET_AXIS_LABELS: Record<CampaignTargetAxis, string> = {
  items: "کالاهای مشخص",
  categories: "دسته‌ها",
  brands: "برندها",
};

/** The scope axes the selling path of this trade actually passes to the engine. */
export function campaignTargetAxes(salesModel: SalesModel): CampaignTargetAxis[] {
  return salesModel === "order_ticket" ? ["items", "categories"] : ["items", "brands"];
}

export interface CampaignScopeSelection {
  itemIds: readonly string[];
  categoryIds: readonly string[];
  brandIds: readonly string[];
}

/** Drop ids for an axis this trade cannot match on, so a saved rule always means what it says. */
export function normaliseCampaignScope(
  selection: CampaignScopeSelection,
  axes: readonly CampaignTargetAxis[],
): { itemIds: string[]; categoryIds: string[]; brandIds: string[] } {
  const unique = (ids: readonly string[]) => [...new Set(ids.filter((id) => id.trim() !== ""))];
  return {
    itemIds: axes.includes("items") ? unique(selection.itemIds) : [],
    categoryIds: axes.includes("categories") ? unique(selection.categoryIds) : [],
    brandIds: axes.includes("brands") ? unique(selection.brandIds) : [],
  };
}

/** True when the campaign applies to the whole catalogue. */
export function isWholeCatalogue(selection: CampaignScopeSelection): boolean {
  return selection.itemIds.length === 0 && selection.categoryIds.length === 0 && selection.brandIds.length === 0;
}

function nameList(ids: readonly string[], options: readonly CampaignTargetOption[]): string {
  const byId = new Map(options.map((option) => [option.id, option.name]));
  const names = ids.map((id) => byId.get(id) ?? "مورد حذف‌شده");
  if (names.length <= 3) return names.join("، ");
  return `${names.slice(0, 3).join("، ")} و ${formatPersianNumber(names.length - 3)} مورد دیگر`;
}

/**
 * «روی همهٔ کالاها» / «روی کالاهای X، Y از دستهٔ Z» — the scope half of the
 * campaign summary. The schedule and the offer are described by the caller,
 * which already owns those labels (`campaign-rules.ts`).
 */
export function describeCampaignScope(
  selection: CampaignScopeSelection,
  catalogue: Pick<CampaignTargetCatalogue, "items" | "categories" | "brands">,
): string {
  if (isWholeCatalogue(selection)) return "روی همهٔ کالاها";
  const parts: string[] = [];
  if (selection.itemIds.length > 0) parts.push(`روی ${nameList(selection.itemIds, catalogue.items)}`);
  if (selection.categoryIds.length > 0) {
    parts.push(`${parts.length ? "و فقط اگر" : "روی کالاهای"} دستهٔ ${nameList(selection.categoryIds, catalogue.categories)}${parts.length ? " باشند" : ""}`);
  }
  if (selection.brandIds.length > 0) {
    parts.push(`${parts.length ? "و فقط اگر" : "روی کالاهای"} برند ${nameList(selection.brandIds, catalogue.brands)}${parts.length ? " باشند" : ""}`);
  }
  return parts.join(" ");
}
