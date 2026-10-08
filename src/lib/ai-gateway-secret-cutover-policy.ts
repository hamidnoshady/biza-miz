/**
 * The AI gateway secret cutover's *policy*, in one place.
 *
 * Issue #748 / migrations 0183 and 0209 split two things apart: "stop writing
 * plaintext AI credentials" and "drop the legacy plaintext columns". Everything
 * that has to agree about that split lives here:
 *
 *   • `scripts/migrate.ts` — the runner that defers, blocks or applies 0209;
 *   • `src/lib/migration-status-service.ts` — the health reporter that has to
 *     describe, in the same words, why 0209 is still pending;
 *   • the console UI, which turns those words into operator guidance.
 *
 * The module is deliberately pure: no `node:` builtins, no `pg`, no
 * `src/lib/db.ts`. It is imported by a CLI entrypoint *and* by server-only
 * reporting code, so anything it pulled in would travel to both, and a client
 * component must never reach it through a value import
 * (`src/lib/client-bundle-boundary.test.ts` enforces that).
 *
 * What this module is NOT: a claim that the cutover is safe. The database guard
 * in 0209 and the decrypt-verification in `scripts/encrypt-ai-gateway-secrets.ts`
 * are the actual proofs; the flags below are only an operator's explicit
 * confirmation that those proofs were carried out on every deployment.
 */

/** The gated migration: drops `platform_ai_gateway.master_key` and `ai_business_gateway.virtual_key`. */
export const AI_GATEWAY_SECRET_CUTOVER_MIGRATION = "0209_ai_gateway_secret_cutover.sql";

/** Operator switch: never apply 0209 on this run, even on a fresh database. */
export const AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV = "AI_GATEWAY_SECRET_CUTOVER_DEFER";

/**
 * Operator confirmation: "I verified ciphertext-backed production reads on
 * every deployment/instance". It authorises the one-time migration; it is not,
 * and must never be read as, evidence that verification happened.
 */
export const AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV = "AI_GATEWAY_SECRET_CUTOVER_VERIFIED";

/**
 * A later migration naming either legacy column depends on 0209's order, so it
 * cannot jump a deferred 0209. `_ciphertext` and `_keys_enabled` are excluded
 * because `_` is a word character, so there is no boundary after `master_key`.
 */
export const AI_GATEWAY_LEGACY_SECRET_COLUMN = /\b(?:master_key|virtual_key)\b/;

/** Migration filenames the runner and the reporter both accept. */
export const MIGRATION_FILENAME = /^\d{4}_.+\.sql$/;

/** Whether `filename` is the gated secret-cutover migration. */
export function isSecretCutoverMigration(filename: string): boolean {
  return filename === AI_GATEWAY_SECRET_CUTOVER_MIGRATION;
}

/** Whether a migration's SQL still reads a legacy plaintext AI secret column. */
export function migrationDependsOnLegacySecretColumn(sql: string): boolean {
  return AI_GATEWAY_LEGACY_SECRET_COLUMN.test(sql);
}

/**
 * The information_schema probe that finds which of the four AI gateway secret
 * columns exist, shared verbatim by the runner (`scripts/migrate.ts`, which
 * decides whether to defer) and the reporter
 * (`src/lib/migration-status-service.ts`, which has to describe the same
 * decision). If these two ever disagreed about which columns exist, the health
 * surface would report a gate the runner does not have — so the text lives here
 * once. It selects column *names* only, never values.
 */
export const AI_GATEWAY_SECRET_COLUMN_PROBE_SQL = `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'platform_ai_gateway' AND column_name IN ('master_key', 'master_key_ciphertext'))
            OR (table_name = 'ai_business_gateway' AND column_name IN ('virtual_key', 'virtual_key_ciphertext')))`;

/** One row of {@link AI_GATEWAY_SECRET_COLUMN_PROBE_SQL}. */
export interface AiGatewaySecretColumn extends Record<string, unknown> {
  table_name: string;
  column_name: string;
}

export interface CutoverFlags {
  /** `AI_GATEWAY_SECRET_CUTOVER_DEFER=true`. */
  defer: boolean;
  /** `AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true`. */
  verified: boolean;
  /** Both set at once — the runner refuses to start rather than guess. */
  conflict: boolean;
}

/**
 * Read the two switches from an environment map. Only the exact string `"true"`
 * counts, matching the runner: a stray `AI_GATEWAY_SECRET_CUTOVER_VERIFIED=1`
 * must not read as a confirmation.
 */
export function readCutoverFlags(
  env: Record<string, string | undefined> = process.env,
): CutoverFlags {
  const defer = env[AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV] === "true";
  const verified = env[AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV] === "true";
  return { defer, verified, conflict: defer && verified };
}

/**
 * Stable reason codes for the cutover's state. Reported verbatim by the health
 * service and mapped to Persian guidance by the console, so an operator and a
 * log line describe the same situation with the same word.
 */
export type CutoverReasonCode =
  /** 0209 is recorded in `schema_migrations`; the legacy columns are gone. */
  | "ai_gateway_secret_cutover_applied"
  /** No credential is stored, so 0209 needs no confirmation and simply applies. */
  | "ai_gateway_secret_cutover_applicable"
  /** A credential is still stored and verification has not been confirmed. */
  | "ai_gateway_secret_cutover_awaiting_verification"
  /** `AI_GATEWAY_SECRET_CUTOVER_DEFER=true` is withholding the migration. */
  | "ai_gateway_secret_cutover_deferred_by_flag"
  /** Both switches are set; the runner refuses to run until one is removed. */
  | "ai_gateway_secret_cutover_flags_conflict"
  /** A stored credential could not be determined (schema or query failure). */
  | "ai_gateway_secret_cutover_state_unknown";

export interface CutoverStateInput {
  defer: boolean;
  verified: boolean;
  /**
   * Whether any AI gateway credential (plaintext or ciphertext) is still
   * stored. `null` when the database could not answer — which is reported as
   * unknown rather than assumed to be "no credentials".
   */
  secretsStored: boolean | null;
}

/**
 * Why the cutover migration is in the state it is in. Pure, so the runner and
 * the health reporter cannot drift apart.
 */
export function cutoverReasonCode(input: CutoverStateInput): CutoverReasonCode {
  if (input.defer && input.verified) return "ai_gateway_secret_cutover_flags_conflict";
  if (input.defer) return "ai_gateway_secret_cutover_deferred_by_flag";
  if (input.verified) return "ai_gateway_secret_cutover_applicable";
  if (input.secretsStored === null) return "ai_gateway_secret_cutover_state_unknown";
  return input.secretsStored
    ? "ai_gateway_secret_cutover_awaiting_verification"
    : "ai_gateway_secret_cutover_applicable";
}

/**
 * Whether the migration runner must defer 0209 on this run.
 *
 * This is the runner's own rule, expressed once: defer when the operator asked
 * for it, or when a credential is still stored and nobody has confirmed that
 * ciphertext-backed reads were verified. The runner additionally refuses to
 * start at all when the two flags conflict (see `readCutoverFlags`), so that
 * combination never reaches this function in the CLI.
 */
export function mustDeferSecretCutover(input: {
  defer: boolean;
  verified: boolean;
  secretsStored: boolean;
}): boolean {
  return input.defer || (!input.verified && input.secretsStored);
}
