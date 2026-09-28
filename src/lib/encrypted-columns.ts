/**
 * Phase 24 Wave 3 — the registry of encrypted columns.
 *
 * One place that says which column is protected, under which scheme, and by
 * which physical columns. `integration/field-encryption.integration.test.ts`
 * asserts it against `information_schema.columns` — the same mechanism
 * `tenant-isolation.integration.test.ts` uses against `pg_policy`, and the
 * thing that stops a future migration quietly adding a plaintext PII column
 * or dropping an `_enc` column out from under the services.
 *
 * The rule this registry encodes, from the phase doc: **encrypt a column only
 * if it is never used in a `WHERE` range, an `ORDER BY`, a `GROUP BY`, or an
 * aggregate. Equality-only lookup is permitted via a blind index. Everything
 * else stays plaintext.** Every money `bigint`, every timestamp, every foreign
 * key, `orders.*`, the journal, roles, statuses and `users.full_name` are Tier
 * C — never encrypted, because encrypting any of them breaks the ledger and
 * the reports.
 */

export type EncryptionTier = "Tier A" | "Tier B";

export interface EncryptedColumn {
  /** The plaintext column, still present during the transition window. */
  column: string;
  /** The `bytea` twin holding the POSFLD1 envelope. */
  encColumn: string;
  /** Present only where equality lookup has to keep working. */
  bidxColumn?: string;
  /**
   * Present only on `parties.phone`: the last four digits, plaintext and
   * indexed, so that the one partial search people actually perform at a till
   * survives step 3. The decision and its cost are argued in
   * `migrations/0125_field_encryption_columns.sql`.
   */
  last4Column?: string;
  /**
   * Present only on `parties.phone`: mobile / landline / unknown, so that
   * "is this number SMS-reachable" can still be asked of a column nobody can
   * read. Also argued in the 0125 migration header.
   */
  kindColumn?: string;
  tier: EncryptionTier;
  /** Why this column is encrypted / what the blind index costs. */
  note: string;
}

export interface EncryptedTable {
  /** Which key the envelope is under. */
  scope: "business";
  columns: EncryptedColumn[];
}

export const ENCRYPTED_TABLES: Record<string, EncryptedTable> = {
  // `parties` — `customers` until migration 0137 renamed the table when the record grew
  // suppliers and personnel beside its customers. The encrypted columns are the
  // same three and the scope is still the business's DEK.
  parties: {
    scope: "business",
    columns: [
      {
        column: "phone",
        encColumn: "phone_enc",
        bidxColumn: "phone_bidx",
        last4Column: "phone_last4",
        kindColumn: "phone_kind",
        tier: "Tier B",
        note:
          "Backs lookup at the till. The blind index keeps exact match working and phone_last4 " +
          "keeps last-four search working; arbitrary substring and prefix search against the " +
          "phone are the accepted, deliberate loss once the plaintext column is dropped.",
      },
      {
        column: "address",
        encColumn: "address_enc",
        tier: "Tier B",
        note: "Delivery address. Displayed on a single party, never filtered, sorted or grouped.",
      },
      {
        column: "notes",
        encColumn: "notes_enc",
        tier: "Tier B",
        note: "Free text about a person. Never queried — the highest-sensitivity, lowest-cost column here.",
      },
      // Migration 0137 — the party record grew the national identity number, and
      // it is the most identifying thing in the row. The blind index exists so
      // "do we already have this person?" can be asked of a ciphertext, which is
      // the same argument 0125 makes for the phone, one column over.
      {
        column: "national_id",
        encColumn: "national_id_enc",
        bidxColumn: "national_id_bidx",
        tier: "Tier A",
        note:
          "Iranian national identity number. Blind-indexed so duplicate detection works without " +
          "decryption; no DB-level unique index, because an install holding the same number twice " +
          "must still be able to migrate (see the 0137 note).",
      },
      {
        column: "economic_code",
        encColumn: "economic_code_enc",
        tier: "Tier A",
        note: "A party's economic code. Displayed on the ledger's party file, never filtered.",
      },
    ],
  },
  reservations: {
    scope: "business",
    columns: [
      {
        column: "customer_phone",
        encColumn: "customer_phone_enc",
        bidxColumn: "customer_phone_bidx",
        tier: "Tier B",
        note: "The walk-in's callback number. Blind-indexed so 'find this caller's booking' still works.",
      },
    ],
  },
};

/**
 * Tier A — pure secrets, zero query impact, listed here because the phase doc
 * calls them the highest value-to-cost ratio in the wave and the next person
 * should not have to re-derive the list from the prose.
 *
 * Not yet materialised, and the integration test therefore does not assert
 * them. Three of the original entries no longer exist as written:
 * `platform_ai_config` was dropped by `0124_ai_litellm_only.sql` (its key
 * lived on as `platform_ai_gateway.master_key`), the Kavenegar key arrived
 * already encrypted — `platform_sms_config.api_key_enc`, Wave 2 — and the
 * LiteLLM master key and per-business/branch virtual keys are now done too:
 * migration 0183 (issue #748) added `platform_ai_gateway.master_key_ciphertext`
 * and `ai_business_gateway.virtual_key_ciphertext`, AES-256-GCM under
 * `src/lib/integrations/secrets.ts` — the same scheme as
 * `platform_cms_config.api_key_ciphertext` (0139) — rather than a business DEK,
 * since both are platform/tenant-administrative credentials, not customer PII.
 * `ai-gateway-service.ts` writes only the ciphertext column; the legacy
 * plaintext columns stay as a read fallback until `npm run
 * db:encrypt-ai-secrets` has backfilled every deployment and a follow-up
 * migration drops them.
 */
// Migration 0187 removed the inactive platform_update_config singleton and
// its plaintext S3 secret rather than carrying an unused credential forward.
export const TIER_A_PENDING: { table: string; column: string; note: string }[] = [];

/**
 * Back-compatible shape: `table → column → tier`. Kept because it reads well
 * at a glance and because the original Wave 3 stub exported it.
 */
export const ENCRYPTED_COLUMNS: Record<string, Record<string, EncryptionTier>> = Object.fromEntries(
  Object.entries(ENCRYPTED_TABLES).map(([table, spec]) => [
    table,
    Object.fromEntries(spec.columns.map((c) => [c.column, c.tier])),
  ]),
);

/** Every physical column this wave adds, for the schema assertion. */
export function encryptedPhysicalColumns(): { table: string; column: string; dataType: string }[] {
  const out: { table: string; column: string; dataType: string }[] = [];
  for (const [table, spec] of Object.entries(ENCRYPTED_TABLES)) {
    for (const col of spec.columns) {
      out.push({ table, column: col.encColumn, dataType: "bytea" });
      if (col.bidxColumn) out.push({ table, column: col.bidxColumn, dataType: "text" });
      if (col.last4Column) out.push({ table, column: col.last4Column, dataType: "text" });
      if (col.kindColumn) out.push({ table, column: col.kindColumn, dataType: "text" });
    }
  }
  return out;
}

export function encryptedColumnsFor(table: string): EncryptedColumn[] {
  return ENCRYPTED_TABLES[table]?.columns ?? [];
}

export function isEncryptedColumn(table: string, column: string): boolean {
  return encryptedColumnsFor(table).some((c) => c.column === column);
}
