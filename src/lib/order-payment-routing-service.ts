import type { PoolClient } from "pg";
import { classifyAccounts, type ClassifiableAccount } from "./account-classification";
import { deploymentRole } from "./deployment-role";
import type { FinancialAccountKind } from "./financial-accounts";
import { paymentSourceKindForSettlement } from "./order-payment-routing";
import type { ResolvedTender } from "./payment-methods";
import type { PaymentSettlement } from "./payment-methods";
import { isUuid } from "./uuid";

export const ORDER_PAYMENT_ROUTING_SETTING = "ledger.order_payment_routing.v1";

export class OrderPaymentRoutingError extends Error {
  readonly status = 409;
  constructor(readonly code: string) {
    super(code);
  }
}

type QueryClient = Pick<PoolClient, "query">;

interface SourceRow {
  id: string;
  name: string;
  kind: FinancialAccountKind;
  gl_account_id: string;
}

export async function readOrderPaymentRouting(
  client: QueryClient, businessId: string, locationId: string, lockBranch = false, explicitSource = false,
): Promise<"disabled" | "enabled" | "peer_unsupported"> {
  if (lockBranch) {
    await client.query("SELECT id FROM locations WHERE business_id = $1 AND id = $2 FOR SHARE", [businessId, locationId]);
  }
  const { rows: [row] } = await client.query<{ enabled: boolean; paired: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM settings WHERE business_id = $1 AND location_id = $2 AND key = $3
         AND value->'enabled' = 'true'::jsonb
     ) AS enabled, (EXISTS (
       SELECT 1 FROM site_devices WHERE business_id = $1 AND location_id = $2
         AND status IN ('pending','active') AND revoked_at IS NULL
     ) OR EXISTS (
       SELECT 1 FROM server_sync_tokens WHERE business_id = $1
     )) AS paired`,
    [businessId, locationId, ORDER_PAYMENT_ROUTING_SETTING],
  );
  if (!row?.enabled && !explicitSource) return "disabled";
  if (deploymentRole() === "site" || row?.paired) return "peer_unsupported";
  return row?.enabled ? "enabled" : "disabled";
}

export async function orderPaymentSources(
  client: QueryClient, businessId: string, locationId: string, ids?: readonly string[],
): Promise<SourceRow[]> {
  const { rows } = await client.query<SourceRow>(
    `SELECT f.id, f.name, f.kind, f.gl_account_id
       FROM financial_accounts f
       JOIN businesses b ON b.id = f.business_id
       JOIN accounts a ON a.business_id = f.business_id AND a.id = f.gl_account_id
      WHERE f.business_id = $1 AND (f.location_id IS NULL OR f.location_id = $2)
        AND f.is_active AND f.currency_code = b.base_currency_code
        AND a.is_active AND a.type = 'asset'
        AND (a.currency_code IS NULL OR a.currency_code = f.currency_code)
        AND NOT EXISTS (SELECT 1 FROM accounts child WHERE child.business_id = f.business_id AND child.parent_id = a.id)
        AND f.kind IN ('cash', 'bank', 'pos_psp')
        AND ($3::uuid[] IS NULL OR f.id = ANY($3))
        AND (f.kind <> 'pos_psp' OR (
          NULLIF(btrim(f.psp_provider), '') IS NOT NULL AND NULLIF(btrim(f.terminal_number), '') IS NOT NULL
          AND NULLIF(btrim(f.merchant_number), '') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM financial_accounts bank
             WHERE bank.id = f.settlement_account_id AND bank.business_id = f.business_id AND bank.kind = 'bank'
               AND bank.is_active AND bank.currency_code = f.currency_code
               AND (bank.location_id IS NULL OR bank.location_id = $2)
          )
        ))
      ORDER BY f.id FOR SHARE OF f, a`,
    [businessId, locationId, ids ?? null],
  );
  if (rows.length === 0) return [];
  const { rows: chart } = await client.query<ClassifiableAccount>(
    'SELECT id, code, parent_id AS "parentId", type FROM accounts WHERE business_id = $1',
    [businessId],
  );
  const roles = classifyAccounts(chart);
  return rows.filter((row) => roles.get(row.gl_account_id) === (row.kind === "pos_psp" ? "payment_clearing" : row.kind));
}

export type RoutedOrderTender = ResolvedTender & { financialAccountGlId?: string };

export interface OrderPaymentSourceSnapshot {
  financialAccountId: string;
  financialAccountGlId: string;
}

export type WebsitePaymentRoute = {
  connectionId: string;
  provider: "cms" | "woocommerce";
  gateway: string;
  settlement: "online" | "card_to_card" | "cash";
  financialAccountId: string;
};

export async function routeWebsitePayment(
  client: QueryClient, businessId: string, locationId: string,
  provider: WebsitePaymentRoute["provider"], connectionId: string, gateway: string,
): Promise<(OrderPaymentSourceSnapshot & { settlement: WebsitePaymentRoute["settlement"] }) | null> {
  const mode = await readOrderPaymentRouting(client, businessId, locationId, true);
  if (mode === "disabled") return null;
  if (mode === "peer_unsupported") throw new OrderPaymentRoutingError("payment_routing_peer_unsupported");
  const { rows: [row] } = await client.query<{ routes: WebsitePaymentRoute[] | null }>(
    "SELECT value->'websiteRoutes' AS routes FROM settings WHERE business_id = $1 AND location_id = $2 AND key = $3",
    [businessId, locationId, ORDER_PAYMENT_ROUTING_SETTING],
  );
  const route = Array.isArray(row?.routes) ? row.routes.find((item) =>
    item.provider === provider && item.connectionId === connectionId && item.gateway === gateway) : undefined;
  if (!route) throw new OrderPaymentRoutingError("website_payment_source_required");
  return {
    ...await resolveExplicitOrderSource(client, businessId, locationId, route.settlement, route.financialAccountId),
    settlement: route.settlement,
  };
}

export async function resolveExplicitOrderSource(
  client: QueryClient, businessId: string, locationId: string,
  settlement: PaymentSettlement, financialAccountId: string,
): Promise<OrderPaymentSourceSnapshot> {
  if (!isUuid(financialAccountId)) throw new OrderPaymentRoutingError("invalid_payment_source");
  const [source] = await orderPaymentSources(client, businessId, locationId, [financialAccountId]);
  if (!source || source.kind !== paymentSourceKindForSettlement(settlement)) {
    throw new OrderPaymentRoutingError("invalid_payment_source");
  }
  return { financialAccountId: source.id, financialAccountGlId: source.gl_account_id };
}

export async function routeOrderTenders(
  client: QueryClient, businessId: string, locationId: string, tenders: readonly ResolvedTender[],
): Promise<RoutedOrderTender[]> {
  const mode = await readOrderPaymentRouting(client, businessId, locationId, true);
  if (mode === "peer_unsupported") throw new OrderPaymentRoutingError("payment_routing_peer_unsupported");
  const ids = tenders.flatMap((tender) => tender.financialAccountId ? [tender.financialAccountId] : []);
  if (mode === "disabled") {
    if (ids.length) throw new OrderPaymentRoutingError("payment_routing_disabled");
    return [...tenders];
  }
  if (ids.some((id) => !isUuid(id))) throw new OrderPaymentRoutingError("invalid_payment_source");
  const sources = new Map((ids.length ? await orderPaymentSources(client, businessId, locationId, ids) : [])
    .map((source) => [source.id, source]));
  return tenders.map((tender) => {
    const kind = paymentSourceKindForSettlement(tender.settlement);
    if (!kind && !tender.financialAccountId) return tender;
    if (kind && !tender.financialAccountId) throw new OrderPaymentRoutingError("payment_source_required");
    const source = sources.get(tender.financialAccountId ?? "");
    if (!source || source.kind !== kind) throw new OrderPaymentRoutingError("invalid_payment_source");
    return { ...tender, financialAccountGlId: source.gl_account_id };
  });
}
