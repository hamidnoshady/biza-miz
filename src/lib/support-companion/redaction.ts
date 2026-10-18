/**
 * Issue #984 — redaction for diagnostic evidence, before persistence.
 *
 * Regex secret-scrubbing (`redactSecrets`, shared with the desktop log
 * writer) is only the first layer. On top of it this module enforces the
 * epic's structural rules: blocklisted fields never persist, unattributed
 * installation-wide log lines never join a tenant upload, and every filter
 * pass reports what it removed so the UI can show exclusions honestly.
 */
import { redactSecrets } from "../error-report";

/** Field names that are never persisted into reports, AI evidence or receipts. */
const BLOCKED_FIELDS: ReadonlySet<string> = new Set(
  [
    "password",
    "passwd",
    "pin",
    "otp",
    "secret",
    "jwt",
    "token",
    "cookie",
    "cookies",
    "session",
    "connectionstring",
    "connection_string",
    "databaseurl",
    "database_url",
    "privatekey",
    "private_key",
    "masterkey",
    "master_key",
    "encryptionkey",
    "encryption_key",
    "apikey",
    "api_key",
    "clientsecret",
    "client_secret",
    "webhooksecret",
    "webhook_secret",
    "authorization",
    "set-cookie",
  ].map((name) => name.toLowerCase()),
);

const REDACTED = "[REDACTED]";

export interface RedactionSummary {
  /** Number of fields dropped by name. */
  blockedFields: number;
  /** Number of string values scrubbed by secret patterns. */
  scrubbedValues: number;
  /** Number of log lines excluded for missing business attribution. */
  unattributedLines: number;
}

export function emptyRedactionSummary(): RedactionSummary {
  return { blockedFields: 0, scrubbedValues: 0, unattributedLines: 0 };
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

/**
 * Deep-copies `value`, dropping blocklisted object keys and scrubbing every
 * string with the shared secret patterns. Arrays and nested objects are
 * traversed; the summary counts what was removed so callers can show
 * exclusions instead of silently dropping evidence.
 */
export function redactValue(value: unknown, summary: RedactionSummary = emptyRedactionSummary()): unknown {
  if (typeof value === "string") {
    const scrubbed = redactSecrets(value);
    if (scrubbed !== value) summary.scrubbedValues += 1;
    return scrubbed;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, summary));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (BLOCKED_FIELDS.has(normalizeKey(key))) {
        summary.blockedFields += 1;
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(entry, summary);
    }
    return out;
  }
  return value;
}

/**
 * Filters candidate log lines for a tenant upload. A line joins the tenant
 * package only when it carries trustworthy business attribution matching
 * `businessId`; installation-level lines without attribution are excluded
 * (counted in the summary), never attributed by guessing the selected tenant.
 */
export function filterAttributedLines(
  lines: { text: string; businessId?: string | null }[],
  businessId: string,
  summary: RedactionSummary = emptyRedactionSummary(),
): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    if (line.businessId !== businessId) {
      summary.unattributedLines += 1;
      continue;
    }
    kept.push(redactSecrets(line.text));
  }
  return kept;
}
