/**
 * The pure plan behind `scripts/backfill-online-sale-lines.ts` — which
 * `online_sale_lines` fact a pre-migration-0209 online line gets, from facts
 * the database already holds. See the script's header for the rules; they are
 * here so they can be asserted without a database.
 */
import type { OnlineCostStatus, OnlineStockOutcome } from "./online-sale-policy";

export interface LegacyOnlineLine {
  orderItemId: string;
  orderId: string;
  locationId: string;
  itemId: string | null;
  sourceType: "woocommerce_order" | "cms_store_order";
  quantity: string;
  netRial: string;
  occurredAt: string;
  /** Σ cost_value of this line's batch allocations, Rial. */
  batchCostRial: string;
  hasBatch: boolean;
  /** Σ debit of the order's COGS entry (all lines), Rial. */
  orderCogsRial: string;
  isContainer: boolean | null;
}

export interface LegacyOnlineFact {
  orderItemId: string;
  orderId: string;
  locationId: string;
  itemId: string | null;
  sourceType: LegacyOnlineLine["sourceType"];
  quantity: string;
  netRial: string;
  occurredAt: string;
  costStatus: OnlineCostStatus;
  cogsRial: string;
  stockOutcome: OnlineStockOutcome;
  relievedQuantity: string;
}

export function planLegacyOnlineLines(lines: LegacyOnlineLine[]): LegacyOnlineFact[] {
  const byOrder = new Map<string, LegacyOnlineLine[]>();
  for (const line of lines) {
    const group = byOrder.get(line.orderId) ?? [];
    group.push(line);
    byOrder.set(line.orderId, group);
  }

  const out: LegacyOnlineFact[] = [];
  for (const group of byOrder.values()) {
    const orderCogs = BigInt(group[0].orderCogsRial || "0");
    const batchCogs = group.reduce((sum, l) => sum + (l.hasBatch ? BigInt(l.batchCostRial || "0") : 0n), 0n);
    const fungibleCogs = orderCogs - batchCogs;
    const fungible = group.filter((l) => !l.hasBatch && l.itemId && !l.isContainer);

    for (const line of group) {
      const base = {
        orderItemId: line.orderItemId,
        orderId: line.orderId,
        locationId: line.locationId,
        itemId: line.itemId,
        sourceType: line.sourceType,
        quantity: line.quantity,
        netRial: line.netRial,
        occurredAt: line.occurredAt,
      };
      if (line.hasBatch) {
        const cogs = BigInt(line.batchCostRial || "0");
        out.push({
          ...base,
          costStatus: cogs > 0n ? "known" : "missing",
          cogsRial: cogs.toString(),
          stockOutcome: "relieved",
          relievedQuantity: line.quantity,
        });
      } else if (!line.itemId || line.isContainer) {
        out.push({ ...base, costStatus: "not_applicable", cogsRial: "0", stockOutcome: "not_tracked", relievedQuantity: "0" });
      } else if (fungibleCogs <= 0n) {
        // The order posted no COGS for its fungible lines: the pre-0209 code
        // returned before the decrement, so nothing left the shelf either.
        out.push({ ...base, costStatus: "missing", cogsRial: "0", stockOutcome: "legacy", relievedQuantity: "0" });
      } else if (fungible.length === 1) {
        out.push({
          ...base,
          costStatus: "known",
          cogsRial: fungibleCogs.toString(),
          stockOutcome: "legacy",
          relievedQuantity: line.quantity,
        });
      } else {
        // Which of these lines actually left the shelf is not recoverable, so
        // none is counted as relieved: a refund then restocks nothing rather
        // than inventing stock (a count corrects the shelf either way).
        out.push({ ...base, costStatus: "unattributed", cogsRial: "0", stockOutcome: "legacy", relievedQuantity: "0" });
      }
    }
  }
  return out;
}
