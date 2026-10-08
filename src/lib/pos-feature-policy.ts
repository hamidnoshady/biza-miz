/**
 * POS choices derived from live business entitlements. Kept framework-free so
 * route/loading decisions and the order-type UI share one tested policy.
 */
export type PosOrderType = "dine_in" | "takeaway" | "delivery";

export interface PosApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
  aborted: boolean;
}

/** Load the shared POS menu, and ask for tables only when service is entitled. */
export function loadPosBaseData<TMenu, TTables>(
  request: <T>(path: string) => Promise<PosApiResult<T>>,
  allowTableService: boolean,
): Promise<[PosApiResult<TMenu>, PosApiResult<TTables> | null]> {
  const menu = request<TMenu>("/api/menu");
  const tables = allowTableService
    ? request<TTables>("/api/tables")
    : Promise.resolve(null);
  return Promise.all([menu, tables]);
}

export function tableServiceEnabled(
  businessInfoLoaded: boolean,
  features?: Record<string, boolean>,
): boolean {
  // Before the first response, don't render table service or fetch tables. If
  // an older server has no `features` field, retain the historical enabled
  // behavior once that response has arrived.
  return businessInfoLoaded && features?.reservations !== false;
}

export function orderTypeForEntitlements(
  current: PosOrderType,
  entitlements: { tableServiceEnabled: boolean; deliveryEnabled: boolean },
): PosOrderType {
  if (current === "dine_in" && !entitlements.tableServiceEnabled) return "takeaway";
  if (current === "delivery" && !entitlements.deliveryEnabled) return "takeaway";
  return current;
}

export function orderTypesForEntitlements(entitlements: {
  tableServiceEnabled: boolean;
  deliveryEnabled: boolean;
}): PosOrderType[] {
  return (["dine_in", "takeaway", "delivery"] as const).filter(
    (type) =>
      (type !== "dine_in" || entitlements.tableServiceEnabled) &&
      (type !== "delivery" || entitlements.deliveryEnabled),
  );
}
