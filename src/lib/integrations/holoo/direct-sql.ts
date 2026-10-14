/**
 * Phase 26 (issue #125) Wave 8 — the pure half of the guarded direct-SQL
 * write path.
 *
 * Direct SQL bypasses Holoo's own validation and Holoo's table structure
 * differs between versions, so a wrong write corrupts a customer's legal
 * books. The decision (recorded in the phase doc) is that this path exists but
 * only behind rails, and none of them is optional. This module holds the pure
 * rails — arming confirmation, profile pinning, and the dry-run that renders
 * the exact statements that will execute — unit-tested. The DB/network half
 * (one MSSQL transaction per document, a `holoo.write` audit row per statement)
 * lives in push-service.ts.
 */

/** The typed confirmation phrase that arms direct-SQL writes (the same typed-
 *  phrase pattern as `businessDestructivePhrase` in the platform danger zone). */
export const HOLOO_DIRECT_SQL_CONFIRMATION_PHRASE = "holoo-direct-sql";

export type ArmDirectSqlResult = { ok: true } | { ok: false; error: "confirmation_mismatch" };

/** Arm direct-SQL only on the exact typed phrase. */
export function armDirectSql(confirmation: string): ArmDirectSqlResult {
  if (confirmation !== HOLOO_DIRECT_SQL_CONFIRMATION_PHRASE) return { ok: false, error: "confirmation_mismatch" };
  return { ok: true };
}

/**
 * A direct-SQL write is allowed only when the probed structure matches a known,
 * *pinned* profile. An unknown or unpinned profile is refused outright.
 */
export function isPinnedProfile(probedProfileKey: string | null | undefined, pinnedProfileKey: string | null | undefined): boolean {
  if (!probedProfileKey || !pinnedProfileKey) return false;
  return probedProfileKey === pinnedProfileKey;
}

export interface HolooDocument {
  /** Stable source-document id from this app (the idempotency key). */
  sourceId: string;
  /** 'sale' | 'receipt' | 'purchase' — which Holoo table the document targets. */
  kind: "sale" | "receipt" | "purchase";
  /** The values to write, in profile column order for direct-SQL fallback. */
  values: (string | number | null)[];
  /** Structured document body for the official web service / bridge. */
  payload?: Record<string, unknown>;
}

export interface DirectSqlPreview {
  /** The exact statements the dry-run would execute, in order. */
  statements: string[];
}

/**
 * The mandatory dry-run: render the exact parameterised statements that
 * `apply` will run. Nothing is executed here — the caller shows these to the
 * operator and requires an explicit, separately-armed apply.
 */
export function buildDirectSqlPreview(documents: readonly HolooDocument[], tableFor: (kind: HolooDocument["kind"]) => string): DirectSqlPreview {
  const statements = documents.map((doc) => {
    const table = tableFor(doc.kind);
    const values = doc.values.map((v) => (v === null ? "NULL" : typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v))).join(", ");
    return `INSERT INTO [${table}] VALUES (${values}); -- source_id=${doc.sourceId}`;
  });
  return { statements };
}
