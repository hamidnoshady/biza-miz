/**
 * Issue #939 — what a `catalogue.taxonomy_terms` event is allowed to be.
 *
 * The event is a *destructive* instruction: applying it replaces a whole
 * taxonomy's mirror, and "replace" includes deleting every term the snapshot
 * does not carry. That makes the payload shape a data-integrity boundary, not
 * a parsing detail. Before this module existed, the ingest mapped a missing or
 * non-array `payload.terms` to `[]` and applied it — so one truncated push,
 * one proxy-mangled body, one plugin bug arriving as `terms: null` emptied a
 * store's entire category mirror and reported the event as processed (TAX-03).
 *
 * The rules here are pure (no database, no I/O) so the whole matrix — valid,
 * valid-empty, malformed, chunked, stale — is unit-tested rather than
 * discovered against a live store:
 *
 *  - `taxonomy` must be a non-empty string. It is the destructive scope; a
 *    missing one is refused rather than guessed.
 *  - `terms` must be an array. An *empty* array is a valid, honest snapshot —
 *    a taxonomy can legitimately have zero terms — and is applied as such.
 *    A missing/non-array `terms` is malformed and refused before any write.
 *  - Every term must carry a positive integer `id`. One unreadable term
 *    refuses the *whole* snapshot: dropping the bad entry and applying the
 *    rest would let a truncated payload masquerade as a complete one and
 *    delete whatever the truncation cut off.
 *  - `generated_at` is the snapshot's watermark (TAX-15). The mirror refuses
 *    a snapshot older than the one it already reflects, so a retried queue
 *    row can never resurrect terms a newer snapshot deleted.
 *  - `snapshot_id` + `chunk_index` + `chunk_count` mark one part of a
 *    snapshot the plugin split to stay under the push byte limit. Chunks are
 *    inert until the set is complete; an incomplete set is staged, never
 *    applied.
 */
import type { WooTermSnapshot } from "./woo-taxonomy-service";

/** Thrown for a payload that must not touch the mirror. The message is the failed event's diagnostic. */
export class TaxonomySnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxonomySnapshotError";
  }
}

/** A complete snapshot: everything one taxonomy's mirror should become. */
export interface FullTaxonomySnapshot {
  kind: "full";
  taxonomy: string;
  terms: WooTermSnapshot[];
  /** The remote moment this snapshot reflects; null when the sender is too old to stamp one. */
  generatedAt: Date | null;
}

/** One part of a snapshot the plugin had to split; assembled by the ingest. */
export interface ChunkedTaxonomySnapshot {
  kind: "chunk";
  taxonomy: string;
  terms: WooTermSnapshot[];
  generatedAt: Date | null;
  snapshotId: string;
  chunkIndex: number;
  chunkCount: number;
}

export type TaxonomySnapshotEvent = FullTaxonomySnapshot | ChunkedTaxonomySnapshot;

/** The taxonomy slug's own limit, mirrored from the table's CHECK. */
const MAX_TAXONOMY_LENGTH = 190;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTaxonomy(value: unknown): string {
  if (typeof value !== "string") throw new TaxonomySnapshotError("malformed_taxonomy_snapshot:taxonomy_missing");
  const taxonomy = value.trim();
  if (!taxonomy) throw new TaxonomySnapshotError("malformed_taxonomy_snapshot:taxonomy_empty");
  if (taxonomy.length > MAX_TAXONOMY_LENGTH) throw new TaxonomySnapshotError("malformed_taxonomy_snapshot:taxonomy_too_long");
  return taxonomy;
}

/** A positive integer from a number or a numeric string — plugin JSON varies. */
function positiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim()) && Number(value) > 0) return Number(value);
  return null;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return fallback;
}

/**
 * Validate one term entry.
 *
 * Deliberately strict about `id` and deliberately lenient about the rest: a
 * term without a usable id cannot be keyed, deduped or deleted-against, so it
 * poisons the snapshot's completeness claim; a missing name or count is just
 * a sparse payload the mirror can store honestly.
 */
export function parseSnapshotTerm(value: unknown, index: number): WooTermSnapshot {
  if (!isRecord(value)) {
    throw new TaxonomySnapshotError(`malformed_taxonomy_snapshot:term_${index}_not_object`);
  }
  const id = positiveInt(value.id);
  if (id === null) {
    throw new TaxonomySnapshotError(`malformed_taxonomy_snapshot:term_${index}_bad_id`);
  }
  const name = typeof value.name === "string" ? value.name : "";
  const slug = typeof value.slug === "string" ? value.slug : "";
  return {
    id,
    name,
    slug,
    parent: nonNegativeInt(value.parent, 0),
    description: typeof value.description === "string" ? value.description : "",
    count: nonNegativeInt(value.count, 0),
    menu_order: typeof value.menu_order === "number" && Number.isFinite(value.menu_order) ? value.menu_order : 0,
    ...(typeof value.taxonomy === "string" && value.taxonomy.trim() ? { taxonomy: value.taxonomy.trim() } : {}),
  };
}

function parseTerms(value: unknown): WooTermSnapshot[] {
  // The one shape that used to be coerced to `[]` and wipe a taxonomy:
  // anything that is not an array is a malformed payload, never an empty one.
  if (!Array.isArray(value)) {
    throw new TaxonomySnapshotError("malformed_taxonomy_snapshot:terms_not_array");
  }
  return value.map(parseSnapshotTerm);
}

function parseGeneratedAt(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/**
 * Parse and validate one `catalogue.taxonomy_terms` payload.
 *
 * Throws `TaxonomySnapshotError` — which the ingest records as the event's
 * failed status — for anything that must not reach `replaceTerms`.
 */
export function parseTaxonomySnapshotEvent(payload: unknown): TaxonomySnapshotEvent {
  if (!isRecord(payload)) throw new TaxonomySnapshotError("malformed_taxonomy_snapshot:payload_not_object");
  const taxonomy = parseTaxonomy(payload.taxonomy);
  const terms = parseTerms(payload.terms);
  const generatedAt = parseGeneratedAt(payload.generated_at);

  const snapshotId = payload.snapshot_id;
  const chunkIndex = payload.chunk_index;
  const chunkCount = payload.chunk_count;
  const hasChunkFields = snapshotId !== undefined || chunkIndex !== undefined || chunkCount !== undefined;
  if (!hasChunkFields) return { kind: "full", taxonomy, terms, generatedAt };

  // A chunked snapshot must be unambiguously chunked: half a chunk header is
  // a malformed payload, because guessing the missing half could apply a part
  // as if it were the whole.
  if (typeof snapshotId !== "string" || !snapshotId.trim() || snapshotId.length > 100) {
    throw new TaxonomySnapshotError("malformed_taxonomy_snapshot:bad_snapshot_id");
  }
  if (!Number.isInteger(chunkCount) || (chunkCount as number) < 2) {
    throw new TaxonomySnapshotError("malformed_taxonomy_snapshot:bad_chunk_count");
  }
  if (!Number.isInteger(chunkIndex) || (chunkIndex as number) < 0 || (chunkIndex as number) >= (chunkCount as number)) {
    throw new TaxonomySnapshotError("malformed_taxonomy_snapshot:bad_chunk_index");
  }
  return {
    kind: "chunk",
    taxonomy,
    terms,
    generatedAt,
    snapshotId: snapshotId.trim(),
    chunkIndex: chunkIndex as number,
    chunkCount: chunkCount as number,
  };
}

/**
 * Dedupe one validated snapshot by remote id, first entry winning.
 *
 * A duplicated id inside one payload is a sender bug, not a reason to fail
 * the sync — but left alone it becomes two rows fighting over one unique key
 * mid-transaction. Pure so the behaviour is tested, not assumed.
 */
export function dedupeTermSnapshot(terms: WooTermSnapshot[]): { terms: WooTermSnapshot[]; duplicates: number } {
  const seen = new Set<string>();
  const out: WooTermSnapshot[] = [];
  for (const term of terms) {
    const key = String(term.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return { terms: out, duplicates: terms.length - out.length };
}
