/**
 * Non-sensitive downloadable report for any reconciliation run (issue #1118).
 *
 * Strips credentials, bearer/link tokens, query secrets, and raw unredacted
 * evidence blobs so an operator can download and audit conflicts, decisions,
 * counts and errors safely.
 */

import { toCsv } from "../data-transfer/csv";
import type { RunSummary, StagedItem } from "./service";
import type { FieldConflict } from "./types";

const SENSITIVE_KEY_RE = /(token|secret|password|consumer_key|consumer_secret|credential|auth|signature|cookie|cipher|hash|bidx|enc)/i;
const CREDENTIAL_URL_RE = /([a-z]+:\/\/)([^/\s:@]+):([^@\s]+)@/gi;
const QUERY_SECRET_RE = /([?&](?:token|secret|password|key|signature|consumer_key|consumer_secret)=)([^&\s]+)/gi;

export function sanitizeReportText(value: unknown): string {
  if (value == null) return "";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return raw
    .replace(CREDENTIAL_URL_RE, "$1[redacted]@")
    .replace(QUERY_SECRET_RE, "$1[redacted]");
}

function summarizeSnapshot(snapshot: unknown): { label: string; sku: string | null } {
  if (!snapshot || typeof snapshot !== "object") return { label: "", sku: null };
  const record = snapshot as Record<string, unknown>;
  const name =
    typeof record.name === "string"
      ? record.name
      : typeof record.title === "string"
        ? record.title
        : typeof record.externalId === "string"
          ? record.externalId
          : "";
  const sku = typeof record.sku === "string" ? record.sku : null;
  return { label: sanitizeReportText(name).slice(0, 200), sku: sku ? sanitizeReportText(sku).slice(0, 100) : null };
}

function summarizeConflicts(conflicts: readonly unknown[]): string {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return "";
  return conflicts
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const c = entry as Partial<FieldConflict>;
      if (!c.field || SENSITIVE_KEY_RE.test(c.field)) return c.field ? `${c.field}:[redacted]` : "";
      return `${c.field}(${c.fieldClass ?? "presentation"}:${c.action ?? "review"})`;
    })
    .filter(Boolean)
    .join(" | ");
}

export interface SafeReconciliationReportItem {
  id: number;
  externalType: string;
  externalKey: string;
  rowNumber: number | null;
  label: string;
  sku: string | null;
  outcome: string;
  status: string;
  effect: string | null;
  canonicalId: string | null;
  resolvedCanonicalId: string | null;
  reasons: string[];
  conflicts: string;
  error: string | null;
}

export interface SafeReconciliationReport {
  run: {
    id: string;
    domain: string;
    sourceKind: string;
    provider: string;
    sourceKey: string;
    importMode: string;
    status: string;
    cutoverAuthority: string | null;
    cutoverAt: string | null;
    crossChecked: boolean;
    createdByName: string;
    createdAt: string;
    stagedAt: string | null;
    appliedAt: string | null;
  };
  progress: RunSummary["progress"];
  counts: RunSummary["counts"];
  items: SafeReconciliationReportItem[];
}

export function buildReconciliationRunReport(
  summary: RunSummary,
  items: readonly StagedItem[],
): SafeReconciliationReport {
  const { run, counts, progress } = summary;
  return {
    run: {
      id: run.id,
      domain: run.domain,
      sourceKind: run.sourceKind,
      provider: run.provider,
      sourceKey: sanitizeReportText(run.sourceKey),
      importMode: run.importMode,
      status: run.status,
      cutoverAuthority: run.cutoverAuthority,
      cutoverAt: run.cutoverAt,
      crossChecked: run.crossChecked,
      createdByName: sanitizeReportText(run.createdByName),
      createdAt: run.createdAt,
      stagedAt: run.stagedAt,
      appliedAt: run.appliedAt,
    },
    progress,
    counts,
    items: items.map((item) => {
      const snap = summarizeSnapshot(item.snapshot);
      return {
        id: item.id,
        externalType: item.externalType,
        externalKey: sanitizeReportText(item.externalKey),
        rowNumber: item.rowNumber,
        label: snap.label,
        sku: snap.sku,
        outcome: item.outcome,
        status: item.status,
        effect: item.effect,
        canonicalId: item.canonicalId,
        resolvedCanonicalId: item.resolvedCanonicalId,
        reasons: [...item.reasons],
        conflicts: summarizeConflicts(item.conflicts),
        error: item.error ? sanitizeReportText(item.error).slice(0, 300) : null,
      };
    }),
  };
}

export function buildReconciliationReportCsv(
  summary: RunSummary,
  items: readonly StagedItem[],
): string {
  const report = buildReconciliationRunReport(summary, items);
  return toCsv(
    [
      "row_number",
      "external_type",
      "external_key",
      "label",
      "sku",
      "outcome",
      "status",
      "effect",
      "resolved_canonical_id",
      "reasons",
      "conflicts",
      "error",
    ],
    report.items.map((item) => [
      item.rowNumber,
      item.externalType,
      item.externalKey,
      item.label,
      item.sku,
      item.outcome,
      item.status,
      item.effect,
      item.resolvedCanonicalId ?? item.canonicalId,
      item.reasons.join(" | "),
      item.conflicts,
      item.error,
    ]),
  );
}
