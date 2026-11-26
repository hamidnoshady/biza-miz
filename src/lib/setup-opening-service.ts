/**
 * The opening step's read model (issue #1583).
 *
 * One query set answers everything the final wizard step needs: the real
 * persisted chart (with the server-decided postable flag), the business's
 * financial accounts, the opening journal that already exists, the fiscal
 * opening sets, and the industry inventory count. The route stays thin and the
 * screen stops assembling a second, weaker version of the same facts.
 *
 * The state resolution lives in `setup-opening.ts` (pure and unit-tested); this
 * module only supplies it with the persisted rows.
 */
import { query } from "./db";
import type { SessionPayload } from "./auth";
import { memberAccessFor } from "./member-access";
import { PERMISSIONS } from "./permissions";
import { getSetting, SETTING_KEYS } from "./settings";
import { normalizeSelectedApps } from "./setup-apps";
import { isAppAvailable } from "./app-availability-service";
import { getBusinessCurrencyConfig } from "./multicurrency-service";
import {
  listFinancialAccounts,
  type FinancialAccountRecord,
} from "./financial-accounts-service";
import { maskSensitiveFinancialDetails } from "./financial-accounts";
import { accessibleLocationsFor, costingLocked, resolveActiveLocation } from "./setup-state";
import {
  eligibleOpeningAccounts,
  resolveSetupOpeningState,
  SETUP_OPENING_STATE_MESSAGES,
  type SetupOpeningAccountFacts,
  type SetupOpeningDataState,
} from "./setup-opening";

/** One chart row as the opening step reads it. */
export interface SetupOpeningAccountRow extends SetupOpeningAccountFacts {
  name: string;
  parentCode: string | null;
  currencyCode: string | null;
  /** The money container that posts to this GL leaf, when one is linked. */
  financialAccount: { id: string; name: string; kind: string } | null;
}

export interface SetupOpeningSetSummary {
  id: string;
  fiscalYearLabel: string;
  effectiveDate: string;
  status: string;
  source: string;
  totalDebit: string;
  totalCredit: string;
}

export interface SetupOpeningData {
  state: SetupOpeningDataState;
  message: string;
  accountingEnabled: boolean;
  chartAccountCount: number;
  accounts: SetupOpeningAccountRow[];
  /** The postable leaves the opening form may offer, decided on the server. */
  eligibleAccounts: SetupOpeningAccountRow[];
  capabilities: {
    canManageChart: boolean;
    canManageFinancialAccounts: boolean;
    canViewSensitive: boolean;
  };
  openingEntry: { id: string; entryDate: string; total: string } | null;
  openingSets: SetupOpeningSetSummary[];
  inventoryItems: { id: string; name: string; unit: string; quantity: string }[];
  costingLocked: boolean;
  financialAccounts: FinancialAccountRecord[];
  financialTotalsByKind: Record<string, string>;
  /** True when the money-container read failed; the rest of the step still works. */
  financialAccountsUnavailable: boolean;
  locations: { id: string; name: string }[];
  baseCurrencyCode: string;
  enabledCurrencies: string[];
}

/**
 * Is the Accounting app actually in force for this business?
 *
 * Two independent facts, both required:
 *  - the owner's saved selection includes `accounting` (an explicit selection
 *    without it means the wizard's accounting steps were skipped), and
 *  - the platform/business availability state says the app is usable.
 *
 * A `null` selection is the legacy state before the app gallery existed; those
 * businesses are treated as accounting-enabled, exactly as the step list does.
 */
export async function accountingSetupEnabled(businessId: string): Promise<boolean> {
  const saved = await getSetting<unknown>(businessId, SETTING_KEYS.setupSelectedApps);
  const selected = saved == null ? null : normalizeSelectedApps(saved);
  if (selected !== null && !selected.includes("accounting")) return false;
  return isAppAvailable(businessId, "accounting");
}

/** The persisted chart, whether or not Accounting is enabled (the count matters). */
async function loadChartRows(businessId: string): Promise<SetupOpeningAccountRow[]> {
  const { rows } = await query<{
    id: string;
    code: string;
    name: string;
    type: string;
    parent_id: string | null;
    parent_code: string | null;
    is_active: boolean;
    currency_code: string | null;
    has_children: boolean;
    financial_account_id: string | null;
    financial_account_name: string | null;
    financial_account_kind: string | null;
  }>(
    `SELECT a.id, a.code, a.name, a.type::text AS type, a.parent_id, p.code AS parent_code,
            a.is_active, a.currency_code,
            EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id) AS has_children,
            fa.id AS financial_account_id, fa.name AS financial_account_name, fa.kind AS financial_account_kind
       FROM accounts a
       LEFT JOIN accounts p ON p.id = a.parent_id
       LEFT JOIN financial_accounts fa ON fa.gl_account_id = a.id AND fa.is_active
      WHERE a.business_id = $1
      ORDER BY a.code`,
    [businessId],
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    parentCode: row.parent_code,
    isActive: row.is_active,
    hasChildren: row.has_children,
    currencyCode: row.currency_code,
    financialAccount:
      row.financial_account_id && row.financial_account_name && row.financial_account_kind
        ? {
            id: row.financial_account_id,
            name: row.financial_account_name,
            kind: row.financial_account_kind,
          }
        : null,
  }));
}

/** Every read the step needs, in one call. */
export async function loadSetupOpeningData(params: {
  session: SessionPayload;
  /** The permission check already ran in the route; this only shapes the payload. */
  access?: { permissions: ReadonlySet<string> } | null;
}): Promise<SetupOpeningData> {
  const { session } = params;
  const businessId = session.businessId;

  const access = params.access ?? (await memberAccessFor(session));
  const permissions = access?.permissions ?? new Set<string>();

  const [accountingEnabled, accounts, openingEntry, openingSets, inventory, costing, financial, currency, locations] =
    await Promise.all([
      accountingSetupEnabled(businessId),
      loadChartRows(businessId),
      query<{ id: string; entry_date: string; total: string }>(
        `SELECT je.id, je.entry_date::text AS entry_date,
                (SELECT COALESCE(SUM(debit), 0) FROM journal_lines WHERE entry_id = je.id)::text AS total
           FROM journal_entries je
          WHERE je.business_id = $1 AND je.source_type = 'opening'
          ORDER BY je.entry_date, je.posted_at
          LIMIT 1`,
        [businessId],
      ),
      query<{
        id: string;
        fiscal_year_label: string;
        effective_date: string;
        status: string;
        source: string;
        total_debit: string;
        total_credit: string;
      }>(
        `SELECT id, fiscal_year_label, effective_date::text AS effective_date, status::text AS status,
                source::text AS source, total_debit::text AS total_debit, total_credit::text AS total_credit
           FROM opening_balance_sets
          WHERE business_id = $1
          ORDER BY fiscal_year_label DESC, created_at DESC
          LIMIT 20`,
        [businessId],
      ),
      loadInventoryCount(session),
      costingLocked(businessId),
      listFinancialAccounts(businessId, { status: "active" }).catch(() => null),
      getBusinessCurrencyConfig(businessId).catch(() => null),
      accessibleLocationsFor(session).catch(() => ({ locations: [], canSwitch: false, businessLocationCount: 0 })),
    ]);

  const canViewSensitive = permissions.has(PERMISSIONS.financeAccountsManage);
  const state = resolveSetupOpeningState({
    accountingEnabled,
    chartAccountCount: accounts.length,
    accounts,
  });

  return {
    state,
    message: SETUP_OPENING_STATE_MESSAGES[state],
    accountingEnabled,
    chartAccountCount: accounts.length,
    accounts,
    eligibleAccounts: eligibleOpeningAccounts(accounts),
    capabilities: {
      canManageChart: permissions.has(PERMISSIONS.accountsEdit),
      canManageFinancialAccounts: permissions.has(PERMISSIONS.financeAccountsManage),
      canViewSensitive,
    },
    openingEntry: openingEntry.rows[0]
      ? {
          id: openingEntry.rows[0].id,
          entryDate: openingEntry.rows[0].entry_date,
          total: openingEntry.rows[0].total,
        }
      : null,
    openingSets: openingSets.rows.map((row) => ({
      id: row.id,
      fiscalYearLabel: row.fiscal_year_label,
      effectiveDate: row.effective_date,
      status: row.status,
      source: row.source,
      totalDebit: row.total_debit,
      totalCredit: row.total_credit,
    })),
    inventoryItems: inventory,
    costingLocked: costing,
    financialAccounts: (financial?.accounts ?? []).map((account) =>
      maskSensitiveFinancialDetails(account, { canViewSensitive }),
    ),
    financialTotalsByKind: financial?.totalsByKind ?? {},
    financialAccountsUnavailable: financial === null,
    locations: locations.locations.map((location) => ({ id: location.id, name: location.name })),
    baseCurrencyCode: currency?.baseCurrencyCode ?? "IRR",
    enabledCurrencies: enabledCurrencyCodes(currency),
  };
}

/** The base currency plus every transaction currency this business switched on. */
function enabledCurrencyCodes(
  config: Awaited<ReturnType<typeof getBusinessCurrencyConfig>> | null,
): string[] {
  if (!config) return ["IRR"];
  const allowed = config.transactionCurrencies
    .filter((currency) => currency.allowed)
    .map((currency) => currency.code);
  return allowed.includes(config.baseCurrencyCode)
    ? allowed
    : [config.baseCurrencyCode, ...allowed];
}

/** The F&B opening count at the caller's active branch (the only stock model the step writes). */
async function loadInventoryCount(
  session: SessionPayload,
): Promise<{ id: string; name: string; unit: string; quantity: string }[]> {
  const location = await resolveActiveLocation(session);
  if (!location) return [];
  const { rows } = await query<{ id: string; name: string; unit: string; quantity: string }>(
    `SELECT ii.id, ii.name, ii.unit,
            COALESCE((SELECT SUM(quantity) FROM stock_movements sm
                       WHERE sm.inventory_item_id = ii.id), 0)::text AS quantity
       FROM inventory_items ii WHERE ii.location_id = $1 ORDER BY ii.name`,
    [location.id],
  );
  return rows;
}
