import { createHash } from "node:crypto";
import type { Client } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";

export interface ReviewEvidence {
  snapshotSha256?: string;
  encryptedBackupEvidenceSha256?: string;
  testedRestoreEvidenceSha256?: string;
  clientAndQueueEvidenceSha256?: string;
  ownerMappingEvidenceSha256?: string;
  pendingSettlementEvidenceSha256?: string;
}

interface ReadinessFacts {
  snapshotSha256: string;
  registeredAccounts: number;
  invalidAccountLinks: number;
  missingTerminalBanks: number;
  unattributedPayments: number;
  missingPaymentMethods: number;
  pooledBalances: string[];
  unbalancedEntries: number;
  openReconciliations: number;
  pendingRefundsAndReversals: number;
  queuedSyncEvents: number;
  failedSyncEvents: number;
  unknownClientVersions: number;
  linkedDesktopDevices: number;
  registeredUnsettledBalances: string[];
}

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export function preflightDatabase(connectionString?: string) {
  let url: URL | undefined;
  try { url = new URL(connectionString ?? ""); } catch { /* sanitized error below */ }
  if (!url || !["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.username || url.search || url.hash || !/^\/esh154_preflight_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error("Use an explicit loopback PostgreSQL database named esh154_preflight_*.");
  }
  return url.pathname.slice(1);
}

export function assessReadiness(facts: ReadinessFacts, evidence: ReviewEvidence = {}) {
  const blockers: string[] = [];
  const ownerMapping: string[] = [];
  const evidenced = (digest?: string) => typeof digest === "string" && SHA256.test(digest);
  if (!evidenced(evidence.encryptedBackupEvidenceSha256)) blockers.push("encrypted_backup_not_verified");
  if (!evidenced(evidence.testedRestoreEvidenceSha256)) blockers.push("restore_not_tested");
  if (!evidenced(evidence.clientAndQueueEvidenceSha256)) blockers.push("client_compatibility_or_device_queues_not_verified");
  if (evidence.snapshotSha256 && evidence.snapshotSha256 !== facts.snapshotSha256) blockers.push("evidence_does_not_match_snapshot");
  if (!evidence.snapshotSha256 && Object.values(evidence).some(evidenced)) blockers.push("evidence_does_not_match_snapshot");
  if (facts.unbalancedEntries) blockers.push("unbalanced_journal_entries");
  if (facts.openReconciliations) blockers.push("open_reconciliations");
  if (facts.pendingRefundsAndReversals) blockers.push("pending_refunds_or_reversals");
  if (facts.queuedSyncEvents) blockers.push("queued_sync_events");
  if (facts.failedSyncEvents) blockers.push("failed_sync_events");
  if (facts.unknownClientVersions) blockers.push("unknown_active_client_versions");
  if (facts.linkedDesktopDevices) blockers.push("hybrid_payment_routing_not_supported");
  if (facts.registeredUnsettledBalances.some((amount) => BigInt(amount) !== 0n) &&
      !evidenced(evidence.pendingSettlementEvidenceSha256)) blockers.push("registered_psp_balance_not_verified");
  if (!facts.registeredAccounts) ownerMapping.push("no_active_financial_accounts");
  if (facts.invalidAccountLinks) ownerMapping.push("invalid_or_shared_financial_account_gl_links");
  if (facts.missingTerminalBanks) ownerMapping.push("terminals_without_eligible_settlement_bank");
  if (!evidenced(evidence.ownerMappingEvidenceSha256)) {
    ownerMapping.push("account_mappings_not_verified_by_owner");
    if (facts.pooledBalances.some((amount) => BigInt(amount) !== 0n)) ownerMapping.push("pooled_bank_or_clearing_balance");
    if (facts.unattributedPayments) ownerMapping.push("unattributed_historical_payments");
    if (facts.missingPaymentMethods) ownerMapping.push("historical_payments_without_named_method");
  }
  return { classification: blockers.length ? "BLOCKED" : ownerMapping.length ? "NEEDS OWNER MAPPING" : "READY", blockers, ownerMapping };
}

type Row = Record<string, string | number | boolean | null>;
const count = (rows: Row[], key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
const balances = (rows: Row[]) => rows.map((row) => String(row.balance));

// Identifiers below are fixed code, never CLI input. Hash selected accounting
// fields in stable ID order without loading a tenant's documents into memory.
const fingerprints = {
  orders: ["orders d JOIN locations l ON l.id = d.location_id", "l.business_id", "d.id", "uuid", "d.location_id, d.status"],
  payments: ["payments d JOIN locations l ON l.id = d.location_id", "l.business_id", "d.id", "uuid", "d.location_id, d.order_id, d.method, d.payment_method_id, d.amount, d.received_at"],
  arReceipts: ["ar_receipts d", "d.business_id", "d.id", "uuid", "d.location_id, d.amount, d.method, d.receipt_date, d.cash_account_id, d.reversal_entry_id"],
  apPayments: ["ap_payments d", "d.business_id", "d.id", "uuid", "d.location_id, d.amount, d.method, d.payment_date, d.cash_account_id, d.reversal_entry_id"],
  expenses: ["expenses d", "d.business_id", "d.id", "uuid", "d.location_id, d.amount, d.account_id, d.payment_account_id, d.expense_date"],
  customerReturns: ["customer_returns d", "d.business_id", "d.id", "uuid", "d.location_id, d.order_id, d.refund_method, d.refund_amount_rial"],
  financialAccounts: ["financial_accounts d", "d.business_id", "d.id", "uuid", "d.location_id, d.kind, d.gl_account_id, d.currency_code, d.is_active, d.is_default, d.settlement_account_id, d.settlement_delay_days, d.updated_at"],
  financialTransfers: ["financial_transfers d", "d.business_id", "d.id", "uuid", "d.location_id, d.source_account_id, d.destination_account_id, d.amount, d.fee_amount, d.currency_code, d.transfer_date, d.status, d.journal_entry_id, d.reversal_entry_id"],
  journalEntries: ["journal_entries d", "d.business_id", "d.id", "uuid", "d.location_id, d.entry_date, d.source_type, d.source_id, d.posting_kind, d.currency_code, d.base_currency_code, d.exchange_rate_id, d.exchange_rate, d.rounding_version, d.rounding_delta, d.posted_at"],
  journalLines: ["journal_lines d JOIN journal_entries j ON j.id = d.entry_id", "j.business_id", "d.id", "bigint", "d.entry_id, d.account_id, d.debit, d.credit, d.foreign_debit, d.foreign_credit"],
} as const;

async function fingerprint(client: Client, tenantId: string, spec: typeof fingerprints[keyof typeof fingerprints], extraField = "") {
  const [from, tenant, id, idType, fields] = spec;
  const digest = createHash("sha256");
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const page: { rows: { cursor: string; payload: string }[] } = await client.query(
      `SELECT ${id}::text AS cursor, jsonb_build_array(${id}, ${fields}${extraField})::text AS payload
         FROM ${from} WHERE ${tenant} = $1 AND ($2::${idType} IS NULL OR ${id} > $2::${idType})
         ORDER BY ${id} LIMIT 1000`, [tenantId, after],
    );
    for (const row of page.rows) digest.update(row.payload).update("\n");
    total += page.rows.length;
    if (page.rows.length < 1000) break;
    after = page.rows[page.rows.length - 1].cursor;
  }
  return { count: total, sha256: digest.digest("hex") };
}

export async function collectPreflight(client: Client, database: string, tenantId: string, evidence?: ReviewEvidence) {
  if (!UUID.test(tenantId)) throw new Error("A tenant UUID is required.");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const identity = await client.query<{ name: string; ro: string; privileged: boolean }>(`
      SELECT current_database() AS name, current_setting('transaction_read_only') AS ro,
             rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname = current_user`);
    if (identity.rows[0]?.name !== database || identity.rows[0]?.ro !== "on" || identity.rows[0]?.privileged !== false) {
      throw new Error("Use a read-only role without RLS bypass on the local preflight copy.");
    }
    await client.query(`SELECT set_config('app.business_id', $1, true), set_config('app.rls_bypass', 'off', true),
                              set_config('search_path', 'pg_catalog,public', true),
                              set_config('TimeZone', 'UTC', true), set_config('statement_timeout', '60s', true)`, [tenantId]);
    const rows = async (sql: string) => (await client.query<Row>(sql, [tenantId])).rows;
    const tenant = (await rows("SELECT base_currency_code AS currency FROM businesses WHERE id = $1"))[0];
    if (!tenant) throw new Error("Tenant was not found or is not visible to the reader.");
    const { rows: [schema] } = await client.query<{ source_column: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.payments'::regclass AND attname = 'financial_account_id' AND NOT attisdropped) AS source_column`);
    const sourceColumn = schema.source_column;
    const branches = await rows("SELECT id AS branch, is_active AS active FROM locations WHERE business_id = $1 ORDER BY id");
    const accounts = await rows(`
      WITH links AS (
        SELECT f.id, f.location_id, f.gl_account_id, f.kind, f.is_active, f.currency_code, f.settlement_account_id,
                     a.id IS NOT NULL AND a.is_active AND a.type = 'asset'
                     AND NOT EXISTS (SELECT 1 FROM accounts child WHERE child.business_id = $1 AND child.parent_id = a.id)
                     AND count(*) OVER (PARTITION BY f.gl_account_id) = 1 AS eligible
        FROM financial_accounts f LEFT JOIN accounts a ON a.id = f.gl_account_id AND a.business_id = $1
        WHERE f.business_id = $1
      )
      SELECT f.location_id AS branch, f.kind, count(*) AS registered,
             count(*) FILTER (WHERE f.is_active) AS active,
             count(DISTINCT f.gl_account_id) FILTER (WHERE f.eligible) AS postable_assets,
             count(*) FILTER (WHERE f.is_active AND NOT f.eligible) AS invalid_links,
             count(*) FILTER (WHERE f.is_active AND f.kind = 'pos_psp' AND NOT EXISTS (
               SELECT 1 FROM links b WHERE b.id = f.settlement_account_id AND b.kind = 'bank' AND b.is_active AND b.eligible
                 AND b.currency_code = f.currency_code AND (b.location_id IS NULL OR b.location_id = f.location_id)
             )) AS terminals_without_bank
        FROM links f GROUP BY f.location_id, f.kind ORDER BY f.location_id NULLS FIRST, f.kind`);
    const accountTotals = ["bank", "cash", "petty_cash", "pos_psp"].map((kind) => {
      const kindRows = accounts.filter((row) => row.kind === kind);
      return { kind, registered: count(kindRows, "registered"), active: count(kindRows, "active"),
        postableAssets: count(kindRows, "postable_assets") };
    });
    const branchTrialBalance = await rows(`
      SELECT a.id AS gl, a.code, j.location_id AS branch, count(*) AS lines,
             sum(l.debit)::text AS debit, sum(l.credit)::text AS credit, sum(l.debit::numeric-l.credit)::text AS balance
        FROM journal_entries j JOIN journal_lines l ON l.entry_id = j.id
        LEFT JOIN accounts a ON a.id = l.account_id AND a.business_id = $1
       WHERE j.business_id = $1 GROUP BY a.id, a.code, j.location_id ORDER BY a.id NULLS FIRST, j.location_id NULLS FIRST`);
    const perGl = new Map<Row["gl"], { gl: Row["gl"]; code: Row["code"]; debit: bigint; credit: bigint }>();
    for (const row of branchTrialBalance) {
      const total = perGl.get(row.gl) ?? { gl: row.gl, code: row.code, debit: 0n, credit: 0n };
      total.debit += BigInt(String(row.debit));
      total.credit += BigInt(String(row.credit));
      perGl.set(row.gl, total);
    }
    const trialBalance = Array.from(perGl.values(), ({ gl, code, debit, credit }) => ({
      gl, code, debit: String(debit), credit: String(credit), balance: String(debit - credit),
    }));
    const controls = (await rows(`
      SELECT count(*) FILTER (WHERE debit IS DISTINCT FROM credit OR debit IS NULL) AS unbalanced_entries
        FROM (SELECT sum(l.debit) AS debit, sum(l.credit) AS credit FROM journal_entries j
              LEFT JOIN journal_lines l ON l.entry_id = j.id WHERE j.business_id = $1 GROUP BY j.id) totals`))[0];
    const pooledBankAndClearing = branchTrialBalance.filter((r) => r.code === WELL_KNOWN_CODES.bank || r.code === WELL_KNOWN_CODES.bankClearing);
    const unsettledTakings = await rows(`
      SELECT f.id AS terminal, f.location_id AS branch, f.gl_account_id AS gl,
             COALESCE(sum(l.debit::numeric-l.credit) FILTER (WHERE j.id IS NOT NULL),0)::text AS balance
        FROM financial_accounts f LEFT JOIN journal_lines l ON l.account_id = f.gl_account_id
        LEFT JOIN journal_entries j ON j.id = l.entry_id AND j.business_id = $1
       WHERE f.business_id = $1 AND f.kind = 'pos_psp'
       GROUP BY f.id, f.location_id, f.gl_account_id ORDER BY f.id`);
    const paymentMethods = await rows(`
      SELECT p.location_id AS branch, p.method, m.id AS payment_method, count(*) AS payments,
             count(*) FILTER (WHERE m.id IS NULL) AS missing_named_method,
             count(*) FILTER (WHERE f.id IS NULL) AS missing_financial_source,
             count(*) FILTER (WHERE p.amount < 0 AND f.id IS NULL) AS unattributed_refunds
        FROM payments p JOIN locations l ON l.id = p.location_id AND l.business_id = $1
        LEFT JOIN payment_methods m ON m.id = p.payment_method_id AND m.business_id = $1
        LEFT JOIN financial_accounts f ON f.id = ${sourceColumn ? "p.financial_account_id" : "NULL::uuid"} AND f.business_id = $1
          AND (f.location_id IS NULL OR f.location_id = p.location_id)
       GROUP BY p.location_id, p.method, m.id ORDER BY p.location_id, p.method, m.id NULLS FIRST`);
    const reconciliations = await rows(`
      SELECT r.account_id AS gl, r.status, count(*) AS reconciliations FROM bank_reconciliations r
       WHERE r.business_id = $1 GROUP BY r.account_id, r.status ORDER BY r.account_id, r.status`);
    const refundAndReversalBacklog = await rows(`
      SELECT location_id AS branch, 'receipt_reversal_missing_journal' AS category, count(*) AS pending
        FROM ar_receipts WHERE business_id = $1 AND reversed_at IS NOT NULL AND reversal_entry_id IS NULL GROUP BY location_id
      UNION ALL SELECT location_id, 'supplier_reversal_missing_journal', count(*)
        FROM ap_payments WHERE business_id = $1 AND reversed_at IS NOT NULL AND reversal_entry_id IS NULL GROUP BY location_id
      UNION ALL SELECT d.location_id, 'customer_return_missing_refund_journal', count(*)
        FROM customer_returns d WHERE d.business_id = $1 AND d.refund_amount_rial > 0 AND NOT EXISTS (
          SELECT 1 FROM journal_entries j WHERE j.business_id = $1 AND j.source_type = 'customer_return'
            AND j.source_id = d.id AND j.posting_kind = 'customer_refund') GROUP BY d.location_id
      ORDER BY branch NULLS FIRST, category`);
    const sync = await rows(`
      SELECT s.location_id AS branch, count(*) FILTER (WHERE s.error IS NOT NULL OR s.dead_lettered_at IS NOT NULL) AS failed,
             count(*) FILTER (WHERE s.error IS NULL AND s.dead_lettered_at IS NULL AND (
               s.applied_at IS NULL OR (s.origin = 'local' AND s.pushed_at IS NULL)
             )) AS queued
        FROM sync_events s LEFT JOIN locations l ON l.id = s.location_id
       WHERE (s.scope = 'location' AND l.business_id = $1) OR (s.scope = 'business' AND s.business_id = $1)
       GROUP BY s.location_id ORDER BY s.location_id NULLS FIRST`);
    const installedClients = await rows(`
      SELECT d.location_id AS branch,
             CASE WHEN r.app_version ~ '^[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]{1,40})?$' THEN r.app_version END AS version,
             r.schema_version AS schema, d.status, count(*) AS devices
        FROM site_devices d LEFT JOIN site_device_runtime_status r ON r.site_device_id = d.id AND r.business_id = $1
       WHERE d.business_id = $1 AND d.status IN ('active', 'pending') AND d.revoked_at IS NULL
       GROUP BY d.location_id, version, r.schema_version, d.status
       ORDER BY d.location_id, version NULLS FIRST, r.schema_version NULLS FIRST, d.status`);

    const documents: Record<string, Awaited<ReturnType<typeof fingerprint>>> = {};
    for (const [name, spec] of Object.entries(fingerprints)) {
      documents[name] = await fingerprint(client, tenantId, spec, name === "payments" && sourceColumn ? ", d.financial_account_id" : "");
    }
    const beforeSnapshot = { tenantId, currency: tenant.currency, branches, accounts, accountTotals, trialBalance, branchTrialBalance, pooledBankAndClearing,
      unsettledTakings, paymentMethods, reconciliations, refundAndReversalBacklog, sync, installedClients, documents };
    const snapshotSha256 = hash(JSON.stringify(beforeSnapshot));
    const readiness = assessReadiness({
      snapshotSha256,
      registeredAccounts: count(accounts, "active"), invalidAccountLinks: count(accounts, "invalid_links"),
      missingTerminalBanks: count(accounts, "terminals_without_bank"),
      unattributedPayments: count(paymentMethods, "missing_financial_source"), missingPaymentMethods: count(paymentMethods, "missing_named_method"),
      pooledBalances: balances(pooledBankAndClearing), registeredUnsettledBalances: balances(unsettledTakings),
      unbalancedEntries: Number(controls.unbalanced_entries) + trialBalance.filter((r) => r.gl === null).length,
      openReconciliations: count(reconciliations.filter((r) => r.status === "in_progress"), "reconciliations"),
      pendingRefundsAndReversals: count(refundAndReversalBacklog, "pending"),
      queuedSyncEvents: count(sync, "queued"), failedSyncEvents: count(sync, "failed"),
      unknownClientVersions: count(installedClients.filter((r) => r.status === "active" && (!r.version || !r.schema)), "devices"),
      linkedDesktopDevices: count(installedClients, "devices"),
    }, evidence);
    return { reportVersion: 1, snapshotSha256, ...readiness, controls, beforeSnapshot };
  } finally {
    await client.query("ROLLBACK");
  }
}
