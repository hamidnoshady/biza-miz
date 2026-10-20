/**
 * Phase 38 — the store's taxonomy tree, mirrored.
 *
 * Categories, tags, attribute terms and whatever custom taxonomies a store's
 * theme or plugins registered, as rows keyed by *remote* id.
 *
 * Why a mirror and not a local category model: F&B has `menu_categories` and
 * retail has none at all, so "the category an item belongs to" is not a
 * question this product has one answer to. Inventing one for `items` to hold
 * a WooCommerce import would change what the retail modules show for every
 * business, connected or not — and it would silently lose the shape of a
 * taxonomy that is *not* a category (an attribute's terms are what
 * distinguishes one variation from another; a brand is metadata, not a
 * folder). So this table holds what the store says, and the only local write
 * is the explicit, opt-in `sync_categories` bridge into `menu_categories`.
 *
 * Issue #939 hardened the write path this mirror lives on:
 *
 *  - `replaceTerms` is ONE transaction (TAX-02): validate, dedupe, bulk
 *    upsert, delete only what a complete snapshot says is gone, and prune the
 *    product assignments that pointed at the deleted terms (TAX-07). A crash
 *    halfway can no longer leave an empty or half-written taxonomy behind,
 *    and an advisory lock serialises overlapping sync runs.
 *  - Every snapshot carries the remote moment it reflects (`snapshot_at`),
 *    and an older one is refused under the lock (TAX-15) — a replayed plugin
 *    queue row can no longer resurrect terms a newer snapshot deleted.
 *  - `syncTaxonomyTree` reports per-taxonomy outcomes instead of swallowing
 *    them (TAX-04), and keeps the canonical taxonomy `slug` as the mirror's
 *    identity while `rest_base` only ever routes the HTTP read (TAX-09).
 *  - `integration_woo_taxonomy_state` records what was discovered even when
 *    the read failed or the taxonomy is legitimately empty (TAX-14), so the
 *    manager screen can tell "empty" from "broken" from "never seen".
 */
import { isPinnedToTransaction, query, withTenantTransaction } from "../db";
import { writeIntegrationAudit } from "./audit";
import { localIdForRemote, upsertMapping } from "./mapping-service";
import {
  TaxonomySnapshotError,
  dedupeTermSnapshot,
  parseSnapshotTerm,
  type ChunkedTaxonomySnapshot,
} from "./woo-taxonomy-snapshot";
import type { WooTerm } from "./woocommerce-client";

export type WooTermSnapshot = WooTerm & { taxonomy?: string; menu_order?: number };

/** How many terms of one taxonomy a single sync will store. */
export const TERMS_PER_TAXONOMY_LIMIT = 5000;

/** Rows per multi-VALUES upsert — keeps the parameter count far under pg's 65535 limit. */
const TERM_INSERT_BATCH = 500;

export interface StoredTerm {
  taxonomy: string;
  remoteId: string;
  parentRemoteId: string | null;
  name: string;
  slug: string;
  description: string;
  remoteCount: number;
  menuOrder: number;
}

/** One taxonomy's read+write, as the caller reports it. */
export interface TaxonomySyncResult {
  taxonomy: string;
  /** The REST routing base when it differs from the canonical slug (TAX-09). */
  restBase: string | null;
  terms: number;
  status: "synced" | "truncated" | "failed";
  error?: string;
}

/** A discovery stage that failed before any taxonomy could be attempted. */
export interface TaxonomyDiscoveryError {
  stage: "attributes" | "taxonomies";
  error: string;
}

export interface TaxonomySyncOutcome {
  /** Taxonomies whose snapshot was applied (synced or truncated). */
  taxonomies: string[];
  terms: number;
  truncated: boolean;
  /** Taxonomies whose read or write failed; their previous mirror data is untouched. */
  failed: string[];
  /**
   * The truthful whole-run verdict (TAX-04). `complete` only when every
   * attempted taxonomy landed in full — a successful catalogue sync can no
   * longer conceal a failed or truncated taxonomy sync.
   */
  status: "complete" | "partial" | "failed";
  results: TaxonomySyncResult[];
  discoveryErrors: TaxonomyDiscoveryError[];
}

/** One row of `integration_woo_taxonomy_state` (TAX-14). */
export interface TaxonomyStateRow {
  taxonomy: string;
  restBase: string;
  status: "pending" | "synced" | "truncated" | "failed";
  termCount: number;
  lastError: string | null;
  lastSyncedAt: string | null;
  snapshotAt: string | null;
}

/** One row per group + the whole-connection totals, for honest UI numbers (TAX-08). */
export interface TaxonomyGroupStats {
  groups: { taxonomy: string; mappedProducts: number; assignments: number }[];
  totals: { mappedProducts: number; assignments: number };
}

/** One row per term, with its mapped-product count aggregated in ONE query (TAX-13). */
export interface TermRow {
  taxonomy: string;
  remoteId: string;
  parentRemoteId: string | null;
  name: string;
  slug: string;
  description: string;
  remoteCount: number;
  menuOrder: number;
  /** How many of this connection's mapped products carry the term. */
  mappedCount: number;
}

/** One taxonomy's terms, in the shape the table stores. */
function toStored(taxonomy: string, terms: WooTermSnapshot[]): StoredTerm[] {
  return terms.map((term) => ({
    taxonomy,
    remoteId: String(term.id),
    parentRemoteId: term.parent ? String(term.parent) : null,
    name: term.name ?? "",
    slug: term.slug ?? "",
    description: term.description ?? "",
    remoteCount: Math.max(0, Number(term.count ?? 0)),
    menuOrder: Number(term.menu_order ?? 0),
  }));
}

function normaliseSnapshotAt(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Validate a snapshot's terms before anything is written (TAX-02/TAX-03).
 *
 * Defence in depth: the ingest already parses plugin payloads through
 * `parseTaxonomySnapshotEvent`, but `replaceTerms` is the function whose
 * delete can empty a taxonomy, so it re-checks every entry itself — a REST
 * payload, a test fixture and a future caller all meet the same gate. One
 * unreadable term refuses the whole snapshot: applying the readable rest
 * would delete whatever the unreadable part carried.
 */
function validateSnapshot(taxonomy: string, terms: WooTerm[]): WooTermSnapshot[] {
  if (!Array.isArray(terms)) {
    throw new TaxonomySnapshotError(`malformed_taxonomy_snapshot:terms_not_array:${taxonomy}`);
  }
  return terms.map((term, index) => parseSnapshotTerm(term, index));
}

export interface ReplaceTermsOptions {
  /**
   * The remote moment this snapshot reflects — the plugin's `generated_at`,
   * or the read time for a REST pull. A snapshot older than the mirror's
   * current watermark is refused (TAX-15).
   */
  snapshotAt?: Date | string | null;
  /** The taxonomy's REST routing base, when it differs from its canonical slug (TAX-09). */
  restBase?: string | null;
}

export interface ReplaceTermsResult {
  /** Rows the mirror holds for this taxonomy afterwards (0 when refused as stale). */
  stored: number;
  /** The store sent more terms than the mirror keeps; only the first cap landed. */
  truncated: boolean;
  /** Duplicate ids collapsed out of the snapshot before writing. */
  duplicates: number;
  /** Terms deleted because the validated snapshot did not carry them. */
  removedTerms: number;
  /** Product assignments pruned because they pointed at deleted terms (TAX-07). */
  removedAssignments: number;
  /** True when the snapshot was refused: the mirror already reflects a newer one. */
  stale: boolean;
}

/**
 * Replace one taxonomy's terms for a connection — atomically.
 *
 * "Replace" rather than "merge", because a term deleted in the store must
 * stop appearing here — a merge leaves ghosts that an owner cannot remove
 * from either system. The delete is scoped to the one taxonomy, so a failed
 * read for a later taxonomy cannot empty an earlier one.
 *
 * Issue #939 TAX-02 made the replace a single transaction. It used to DELETE
 * every row and then INSERT one statement at a time in autocommit: a failure
 * — a dropped pool connection, a constraint, a restart mid-loop — left the
 * taxonomy empty or half-written, and the mirror's answer to "what does the
 * store sell?" became "less than it did before the sync". Now: validate and
 * dedupe first (nothing is written for a malformed snapshot), take an
 * advisory lock that serialises overlapping sync runs for the same taxonomy,
 * bulk-upsert the snapshot, delete only the terms a *complete validated*
 * snapshot does not carry, prune the assignments that pointed at them
 * (TAX-07), and stamp the taxonomy's state row — all under one BEGIN/COMMIT,
 * so any failure rolls the taxonomy back to exactly what it was.
 */
export async function replaceTerms(
  businessId: string,
  connectionId: string,
  taxonomy: string,
  terms: WooTerm[],
  options: ReplaceTermsOptions = {},
): Promise<ReplaceTermsResult> {
  const empty: ReplaceTermsResult = {
    stored: 0,
    truncated: false,
    duplicates: 0,
    removedTerms: 0,
    removedAssignments: 0,
    stale: false,
  };
  if (!taxonomy) return empty;

  // Validate + dedupe BEFORE the transaction: a malformed snapshot must
  // throw without ever having opened a write (TAX-03).
  const validated = validateSnapshot(taxonomy, terms);
  const deduped = dedupeTermSnapshot(validated);
  const truncated = deduped.terms.length > TERMS_PER_TAXONOMY_LIMIT;
  const stored = toStored(taxonomy, deduped.terms.slice(0, TERMS_PER_TAXONOMY_LIMIT));
  const remoteIds = stored.map((term) => term.remoteId);
  const snapshotAt = normaliseSnapshotAt(options.snapshotAt);
  const restBase = (options.restBase ?? "").trim();
  const status = truncated ? "truncated" : "synced";

  const apply = async (): Promise<ReplaceTermsResult> => {
    // One taxonomy at a time, per connection: two overlapping sync runs (a
    // scheduled pull racing a manual one, a retried event racing its original)
    // would otherwise interleave delete/upsert and the loser's deletes could
    // land after the winner's inserts. The lock is transaction-scoped, so a
    // crash releases it.
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `woo_taxonomy_replace:${connectionId}:${taxonomy}`,
    ]);

    // Refuse a snapshot older than the mirror's watermark (TAX-15), under the
    // lock so the check and the write cannot be separated by a concurrent run.
    if (snapshotAt) {
      const { rows } = await query<{ snapshot_at: string | null }>(
        `SELECT snapshot_at::text FROM integration_woo_taxonomy_state
          WHERE connection_id = $1 AND taxonomy = $2 FOR UPDATE`,
        [connectionId, taxonomy],
      );
      const existing = rows[0]?.snapshot_at ? new Date(rows[0].snapshot_at) : null;
      if (existing && snapshotAt.getTime() < existing.getTime()) {
        return { ...empty, stale: true };
      }
    }

    for (let offset = 0; offset < stored.length; offset += TERM_INSERT_BATCH) {
      const batch = stored.slice(offset, offset + TERM_INSERT_BATCH);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      batch.forEach((term, index) => {
        const base = index * 11;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}::jsonb)`,
        );
        values.push(
          businessId,
          connectionId,
          term.taxonomy,
          term.remoteId,
          term.parentRemoteId,
          term.name,
          term.slug,
          term.description,
          term.remoteCount,
          term.menuOrder,
          JSON.stringify(term),
        );
      });
      await query(
        `INSERT INTO integration_woo_terms
           (business_id, connection_id, taxonomy, remote_id, parent_remote_id,
            name, slug, description, remote_count, menu_order, payload)
         VALUES ${placeholders.join(", ")}
         ON CONFLICT (connection_id, taxonomy, remote_id)
         DO UPDATE SET parent_remote_id = EXCLUDED.parent_remote_id,
                       name = EXCLUDED.name,
                       slug = EXCLUDED.slug,
                       description = EXCLUDED.description,
                       remote_count = EXCLUDED.remote_count,
                       menu_order = EXCLUDED.menu_order,
                       payload = EXCLUDED.payload,
                       synced_at = now(),
                       updated_at = now()`,
        values,
      );
    }

    // Delete only what the validated, complete snapshot says is gone. An
    // empty array parameter deletes everything, which is the honest reading
    // of a valid empty snapshot — and unreachable for a malformed one, which
    // threw before the transaction opened.
    const removedTerms = await query(
      `DELETE FROM integration_woo_terms
        WHERE connection_id = $1 AND taxonomy = $2
          AND NOT (remote_id = ANY($3::text[]))`,
      [connectionId, taxonomy, remoteIds],
    );

    // TAX-07: a term the store deleted takes its product assignments with it.
    // They are remote-string identities with no FK to the terms table, so
    // without this the assignments outlived the term — blank labels in the
    // catalogue, stale counts here, and an orphan table that only grew.
    const removedAssignments = await query(
      `DELETE FROM integration_woo_product_terms
        WHERE connection_id = $1 AND taxonomy = $2
          AND NOT (term_remote_id = ANY($3::text[]))`,
      [connectionId, taxonomy, remoteIds],
    );

    // The state row is written by the same transaction: the terms and the
    // claim about them ("complete as of this moment") commit together.
    await query(
      `INSERT INTO integration_woo_taxonomy_state
         (business_id, connection_id, taxonomy, rest_base, status, term_count,
          last_error, last_synced_at, snapshot_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, now(), COALESCE($7::timestamptz, now()))
       ON CONFLICT (connection_id, taxonomy)
       DO UPDATE SET rest_base = CASE WHEN $4 <> '' THEN $4 ELSE integration_woo_taxonomy_state.rest_base END,
                     status = EXCLUDED.status,
                     term_count = EXCLUDED.term_count,
                     last_error = NULL,
                     last_synced_at = now(),
                     snapshot_at = GREATEST(
                       COALESCE(integration_woo_taxonomy_state.snapshot_at, COALESCE($7::timestamptz, now())),
                       COALESCE($7::timestamptz, now())
                     ),
                     updated_at = now()`,
      [businessId, connectionId, taxonomy, restBase, status, stored.length, snapshotAt?.toISOString() ?? null],
    );

    return {
      stored: stored.length,
      truncated,
      duplicates: deduped.duplicates,
      removedTerms: removedTerms.rowCount ?? 0,
      removedAssignments: removedAssignments.rowCount ?? 0,
      stale: false,
    };
  };

  // Join the caller's transaction when there is one (chunk assembly stages
  // and applies under a single lock); otherwise own one.
  return isPinnedToTransaction() ? apply() : withTenantTransaction(businessId, apply);
}

/**
 * Record a taxonomy whose read or write FAILED (TAX-04/TAX-14).
 *
 * The state row survives with its previous terms and `last_synced_at` — the
 * screen shows the group as failed with the error, over whatever mirror data
 * the last good sync left, rather than pretending the taxonomy does not exist.
 */
export async function markTaxonomyFailed(
  businessId: string,
  connectionId: string,
  taxonomy: string,
  error: string,
  restBase?: string | null,
): Promise<void> {
  if (!taxonomy) return;
  await query(
    `INSERT INTO integration_woo_taxonomy_state
       (business_id, connection_id, taxonomy, rest_base, status, last_error)
     VALUES ($1, $2, $3, $4, 'failed', $5)
     ON CONFLICT (connection_id, taxonomy)
     DO UPDATE SET status = 'failed',
                   last_error = $5,
                   rest_base = CASE WHEN $4 <> '' THEN $4 ELSE integration_woo_taxonomy_state.rest_base END,
                   updated_at = now()`,
    [businessId, connectionId, taxonomy, (restBase ?? "").trim(), error.slice(0, 2000)],
  );
}

/** Every taxonomy this connection has discovered, and what the mirror knows about it. */
export async function listTaxonomyStates(businessId: string, connectionId: string): Promise<TaxonomyStateRow[]> {
  const { rows } = await query<{
    taxonomy: string;
    rest_base: string;
    status: string;
    term_count: number;
    last_error: string | null;
    last_synced_at: string | null;
    snapshot_at: string | null;
  }>(
    `SELECT taxonomy, rest_base, status, term_count, last_error,
            last_synced_at::text, snapshot_at::text
       FROM integration_woo_taxonomy_state
      WHERE business_id = $1 AND connection_id = $2
      ORDER BY taxonomy`,
    [businessId, connectionId],
  );
  return rows.map((row) => ({
    taxonomy: row.taxonomy,
    restBase: row.rest_base,
    status: row.status as TaxonomyStateRow["status"],
    termCount: Number(row.term_count),
    lastError: row.last_error,
    lastSyncedAt: row.last_synced_at,
    snapshotAt: row.snapshot_at,
  }));
}

/**
 * Stage one chunk of a split plugin snapshot; apply the whole thing the
 * moment the set is complete (TAX-15).
 *
 * Chunks are inert until the last one lands — an incomplete set never touches
 * the mirror, so a transport that drops part of a snapshot cannot read as a
 * complete (and destructively empty) one. Assembly runs under the same
 * advisory lock and watermark check `replaceTerms` uses, and applying clears
 * every staged chunk for the taxonomy, including stragglers from superseded
 * snapshots.
 */
export interface ChunkStageResult {
  complete: boolean;
  /** The applied replace, when this chunk completed the set. */
  applied: ReplaceTermsResult | null;
  /** How many chunks of this snapshot are staged now. */
  stagedChunks: number;
  /** The snapshot was refused: the mirror already reflects a newer one. */
  stale: boolean;
}

export async function stageTaxonomySnapshotChunk(
  businessId: string,
  connectionId: string,
  chunk: ChunkedTaxonomySnapshot,
): Promise<ChunkStageResult> {
  const apply = async (): Promise<ChunkStageResult> => {
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `woo_taxonomy_replace:${connectionId}:${chunk.taxonomy}`,
    ]);

    // A chunk older than the mirror's watermark can never complete into an
    // applicable snapshot; drop the whole staged set instead of hoarding it.
    if (chunk.generatedAt) {
      const { rows } = await query<{ snapshot_at: string | null }>(
        `SELECT snapshot_at::text FROM integration_woo_taxonomy_state
          WHERE connection_id = $1 AND taxonomy = $2 FOR UPDATE`,
        [connectionId, chunk.taxonomy],
      );
      const existing = rows[0]?.snapshot_at ? new Date(rows[0].snapshot_at) : null;
      if (existing && chunk.generatedAt.getTime() < existing.getTime()) {
        await query(
          `DELETE FROM integration_woo_taxonomy_snapshot_chunks
            WHERE connection_id = $1 AND taxonomy = $2 AND snapshot_id = $3`,
          [connectionId, chunk.taxonomy, chunk.snapshotId],
        );
        return { complete: false, applied: null, stagedChunks: 0, stale: true };
      }
    }

    await query(
      `INSERT INTO integration_woo_taxonomy_snapshot_chunks
         (business_id, connection_id, taxonomy, snapshot_id, chunk_index, chunk_count, terms, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (connection_id, taxonomy, snapshot_id, chunk_index)
       DO UPDATE SET terms = EXCLUDED.terms,
                     chunk_count = EXCLUDED.chunk_count,
                     generated_at = EXCLUDED.generated_at`,
      [
        businessId,
        connectionId,
        chunk.taxonomy,
        chunk.snapshotId,
        chunk.chunkIndex,
        chunk.chunkCount,
        JSON.stringify(chunk.terms),
        chunk.generatedAt?.toISOString() ?? null,
      ],
    );

    const { rows } = await query<{ chunk_index: number; terms: unknown }>(
      `SELECT chunk_index, terms FROM integration_woo_taxonomy_snapshot_chunks
        WHERE connection_id = $1 AND taxonomy = $2 AND snapshot_id = $3
        ORDER BY chunk_index`,
      [connectionId, chunk.taxonomy, chunk.snapshotId],
    );
    if (rows.length < chunk.chunkCount) {
      return { complete: false, applied: null, stagedChunks: rows.length, stale: false };
    }

    // Complete: assemble in chunk order, re-validate (staged JSON is data at
    // rest — it meets the same gate as a fresh payload), and apply through
    // the ordinary transactional replace, which this transaction now hosts.
    const assembled: WooTermSnapshot[] = [];
    for (const row of rows) {
      const terms = Array.isArray(row.terms) ? row.terms : [];
      terms.forEach((term, index) => assembled.push(parseSnapshotTerm(term, index)));
    }
    const applied = await replaceTerms(businessId, connectionId, chunk.taxonomy, assembled, {
      snapshotAt: chunk.generatedAt,
    });
    // Clear the stage for this taxonomy: the applied snapshot's own chunks and
    // any partial set a superseded snapshot left behind.
    await query(
      `DELETE FROM integration_woo_taxonomy_snapshot_chunks
        WHERE connection_id = $1 AND taxonomy = $2`,
      [connectionId, chunk.taxonomy],
    );
    return { complete: true, applied, stagedChunks: 0, stale: false };
  };

  return isPinnedToTransaction() ? apply() : withTenantTransaction(businessId, apply);
}

/**
 * Sync the whole tree: core taxonomies, every global attribute's terms, and
 * every custom taxonomy the store publishes for products.
 *
 * One taxonomy failing does not abort the rest — a shop with a broken custom
 * taxonomy still gets its categories. What issue #939 changed is the
 * *reporting* (TAX-04): failures used to vanish into empty catch blocks and
 * the caller stamped the whole catalogue sync healthy. Now every taxonomy
 * produces a result (synced/truncated/failed with its error), every failure
 * is audited and stamped on the taxonomy's state row, and the run's overall
 * status is `complete` only when nothing failed and nothing truncated. The
 * per-taxonomy writes stay separate transactions — a rollback would take the
 * good ones with it — but each one is internally atomic (see replaceTerms).
 *
 * Identity vs routing (TAX-09): the canonical taxonomy `slug` keys the
 * mirror; a custom taxonomy's `rest_base` only ever builds the HTTP path. A
 * store whose `brand` taxonomy lists terms under `/wp-json/wp/v2/brands`
 * used to be mirrored as two taxonomies — `brands` here, `brand` everywhere a
 * product payload named it — splitting the group and its counts.
 */
export async function syncTaxonomyTree(
  businessId: string,
  connectionId: string,
  client: {
    listCategories(q?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
    listTags(q?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
    listAttributes(): Promise<{ id: number; slug: string; taxonomy?: string }[]>;
    listAttributeTerms(id: number): Promise<WooTerm[]>;
    listTaxonomies(): Promise<{ slug: string; rest_base?: string; types?: string[] }[]>;
    listTerms(taxonomy: string, q?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
  },
): Promise<TaxonomySyncOutcome> {
  // The read moment every snapshot of this run reflects. A plugin event
  // generated before this run landed must not overwrite what the run saw.
  const startedAt = new Date();
  const taxonomies: string[] = [];
  const results: TaxonomySyncResult[] = [];
  const failed: string[] = [];
  const discoveryErrors: TaxonomyDiscoveryError[] = [];
  let total = 0;
  let truncated = false;

  const attempt = async (taxonomy: string, read: () => Promise<WooTerm[]>, restBase: string | null = null) => {
    try {
      const result = await replaceTerms(businessId, connectionId, taxonomy, await read(), {
        snapshotAt: startedAt,
        restBase,
      });
      total += result.stored;
      if (result.truncated) truncated = true;
      taxonomies.push(taxonomy);
      results.push({ taxonomy, restBase, terms: result.stored, status: result.truncated ? "truncated" : "synced" });
    } catch (err) {
      const message = (err as Error).message;
      failed.push(taxonomy);
      results.push({ taxonomy, restBase, terms: 0, status: "failed", error: message });
      // The state row keeps the group visible with its error (TAX-14), and
      // the audit gives the queue screen something to retry from (TAX-04).
      await markTaxonomyFailed(businessId, connectionId, taxonomy, message, restBase).catch(() => undefined);
      await writeIntegrationAudit({
        businessId,
        connectionId,
        action: "taxonomy.sync_failed",
        payload: { taxonomy, restBase },
        error: message,
      });
    }
  };

  const discoveryFailed = async (stage: TaxonomyDiscoveryError["stage"], err: unknown) => {
    const message = (err as Error).message;
    discoveryErrors.push({ stage, error: message });
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "taxonomy.discovery_failed",
      payload: { stage },
      error: message,
    });
  };

  await attempt("product_cat", () => client.listCategories());
  await attempt("product_tag", () => client.listTags());

  // Attribute terms — `pa_colour` and friends. These are what make one
  // variation distinguishable from another, so they are the most useful
  // taxonomy in the whole tree for a store that sells variations.
  const attributeTaxonomies = new Set<string>();
  try {
    const attributes = await client.listAttributes();
    for (const attribute of attributes) {
      const taxonomy = attribute.taxonomy || (attribute.slug.startsWith("pa_") ? attribute.slug : `pa_${attribute.slug}`);
      attributeTaxonomies.add(taxonomy);
      await attempt(taxonomy, () => client.listAttributeTerms(attribute.id));
    }
  } catch (err) {
    // The endpoint being unreadable is now a reported partial sync, not a
    // silent "the store has no attributes" (TAX-04).
    await discoveryFailed("attributes", err);
  }

  // Custom taxonomies: a brand, a fabric, a region — anything a plugin
  // registered. wc/v3 never mentions them, which is why this goes to wp/v2.
  try {
    const discovered = await client.listTaxonomies();
    const known = new Set(["product_cat", "product_tag", ...attributeTaxonomies]);
    for (const taxonomy of discovered) {
      // Canonical identity: the slug. `rest_base` is routing only (TAX-09).
      const slug = (taxonomy.slug ?? "").trim();
      if (!slug || known.has(slug)) continue;
      if (slug.startsWith("pa_")) continue; // already read as an attribute
      if (!(taxonomy.types ?? []).includes("product")) continue;
      known.add(slug);
      const restBase = (taxonomy.rest_base ?? "").trim() || slug;
      await attempt(
        slug,
        async () => {
          const terms = await client.listTerms(restBase);
          // wp/v2 terms are stamped with the routing base by the client; the
          // mirror stores them under the canonical slug.
          return restBase === slug ? terms : terms.map((term) => ({ ...term, taxonomy: slug }));
        },
        restBase === slug ? null : restBase,
      );
    }
  } catch (err) {
    // wp/v2 may be blocked on a hardened store — or the WordPress application
    // password may be missing, which TAX-01 turned from a silent 401 into a
    // clear `wordpress_credentials_missing`. Either way: reported, not hidden.
    await discoveryFailed("taxonomies", err);
  }

  const incomplete = failed.length > 0 || discoveryErrors.length > 0 || truncated;
  const status: TaxonomySyncOutcome["status"] = !incomplete
    ? "complete"
    : taxonomies.length > 0
      ? "partial"
      : "failed";

  return { taxonomies, terms: total, truncated, failed, status, results, discoveryErrors };
}

/**
 * Record one term the store told us about *inline* with a product payload.
 *
 * The REST sync reads the whole tree from `products/categories` and the
 * attribute/tag endpoints, but in plugin mode the app never dials the store:
 * the only taxonomy facts that ever arrive are the `categories`/`tags`
 * arrays carried on each pushed product. Without this, a plugin-connected
 * store's taxonomy browser stayed empty forever and the «دسته‌بندی‌ها» column
 * on the catalogue was blank even though every product named its categories.
 *
 * Upsert (never delete) is the right semantics here: a term omitted from one
 * product's payload is not a term that stopped existing, and the full tree
 * replace stays the job of `replaceTerms`. The remote product count is left
 * as-is on conflict because a product payload only proves membership, not the
 * store's authoritative count.
 */
export async function upsertTermFromPayload(
  businessId: string,
  connectionId: string,
  taxonomy: string,
  term: { id: number | string; name?: string; slug?: string; parent?: number; description?: string; count?: number; menu_order?: number },
): Promise<void> {
  const remoteId = String(term.id ?? "");
  if (!taxonomy || !remoteId || remoteId === "0") return;
  const name = (term.name ?? "").trim();
  const slug = (term.slug ?? "").trim();
  if (!name && !slug) return;
  await query(
    `INSERT INTO integration_woo_terms
       (business_id, connection_id, taxonomy, remote_id, parent_remote_id, name, slug, description, remote_count, menu_order, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (connection_id, taxonomy, remote_id)
     DO UPDATE SET parent_remote_id = COALESCE($5, integration_woo_terms.parent_remote_id),
                   name = CASE WHEN $6 <> '' THEN $6 ELSE integration_woo_terms.name END,
                   slug = CASE WHEN $7 <> '' THEN $7 ELSE integration_woo_terms.slug END,
                   description = CASE WHEN $8 <> '' THEN $8 ELSE integration_woo_terms.description END,
                   remote_count = GREATEST(integration_woo_terms.remote_count, $9),
                   menu_order = CASE WHEN $10 <> 0 THEN $10 ELSE integration_woo_terms.menu_order END,
                   updated_at = now()`,
    [
      businessId,
      connectionId,
      taxonomy,
      remoteId,
      term.parent ? String(term.parent) : null,
      name,
      slug,
      (term.description ?? "").trim(),
      Math.max(0, Number(term.count ?? 0)),
      Number(term.menu_order ?? 0),
      JSON.stringify(term),
    ],
  );
}

/**
 * Mirror every category and tag a pushed product carries, then record the
 * product→term assignments. Called by the single product ingest path so REST
 * pulls, webhooks and plugin pushes all keep the taxonomy mirror populated.
 *
 * Variations inherit (TAX-06). A WooCommerce REST variation resource carries
 * no `categories`/`tags` at all — the taxonomies live on the variable parent
 * — so the pre-#939 code recorded every REST variation with an empty
 * assignment set, and *replaced* whatever it had with nothing on every sync.
 * The plugin had always read the parent's terms explicitly
 * (class-pos-sync.php: `product_payload`), so the same store showed
 * categorised variations in plugin mode and uncategorised ones in REST mode.
 * Now, for any taxonomy the variation's own payload says nothing about, the
 * parent's recorded assignments are inherited — and an empty payload can no
 * longer wipe an inherited association.
 */
export async function recordProductTermsFromPayload(
  businessId: string,
  connectionId: string,
  remoteProductId: string,
  product: {
    type?: string;
    parent_id?: number | null;
    categories?: { id: number; name?: string; slug?: string }[];
    tags?: { id: number; name?: string; slug?: string }[];
    terms?: Record<string, { id: number | string; name?: string; slug?: string; parent?: number; description?: string; count?: number; menu_order?: number }[]>;
  },
): Promise<void> {
  const assignments: { taxonomy: string; termRemoteId: string }[] = [];
  // Taxonomies this payload spoke for with at least one term. For a
  // variation, only these win over the parent's recorded set.
  const spoken = new Set<string>();
  for (const category of product.categories ?? []) {
    await upsertTermFromPayload(businessId, connectionId, "product_cat", category);
    assignments.push({ taxonomy: "product_cat", termRemoteId: String(category.id) });
    spoken.add("product_cat");
  }
  for (const tag of product.tags ?? []) {
    await upsertTermFromPayload(businessId, connectionId, "product_tag", tag);
    assignments.push({ taxonomy: "product_tag", termRemoteId: String(tag.id) });
    spoken.add("product_tag");
  }
  for (const [taxonomy, terms] of Object.entries(product.terms ?? {})) {
    if (!taxonomy || taxonomy === "product_cat" || taxonomy === "product_tag") continue;
    for (const term of terms ?? []) {
      await upsertTermFromPayload(businessId, connectionId, taxonomy, term);
      assignments.push({ taxonomy, termRemoteId: String(term.id) });
      spoken.add(taxonomy);
    }
  }

  const parentRemoteId = product.parent_id ? String(product.parent_id) : null;
  const isVariation = parentRemoteId !== null && parentRemoteId !== "0" && parentRemoteId !== remoteProductId;
  if (isVariation) {
    const { rows } = await query<{ taxonomy: string; term_remote_id: string }>(
      `SELECT taxonomy, term_remote_id FROM integration_woo_product_terms
        WHERE connection_id = $1 AND remote_id = $2`,
      [connectionId, parentRemoteId],
    );
    const seen = new Set(assignments.map((a) => `${a.taxonomy}:${a.termRemoteId}`));
    for (const row of rows) {
      if (spoken.has(row.taxonomy)) continue; // the payload spoke for it — the payload wins
      const key = `${row.taxonomy}:${row.term_remote_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      assignments.push({ taxonomy: row.taxonomy, termRemoteId: row.term_remote_id });
    }
  }

  await replaceProductTerms(businessId, connectionId, remoteProductId, assignments);
}

/** Which remote terms one remote product carries. */
export async function replaceProductTerms(
  businessId: string,
  connectionId: string,
  remoteId: string,
  assignments: { taxonomy: string; termRemoteId: string }[],
): Promise<void> {
  const seen = new Set<string>();
  const unique = assignments.filter((assignment) => {
    if (!assignment?.taxonomy || !assignment?.termRemoteId) return false;
    const key = `${assignment.taxonomy}:${assignment.termRemoteId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const apply = async () => {
    await query(`DELETE FROM integration_woo_product_terms WHERE connection_id = $1 AND remote_id = $2`, [
      connectionId,
      remoteId,
    ]);
    if (unique.length === 0) return;
    const values: unknown[] = [];
    const placeholders: string[] = [];
    unique.forEach((assignment, index) => {
      const base = index * 5;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      values.push(businessId, connectionId, remoteId, assignment.taxonomy, assignment.termRemoteId);
    });
    await query(
      `INSERT INTO integration_woo_product_terms (business_id, connection_id, remote_id, taxonomy, term_remote_id)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (connection_id, remote_id, taxonomy, term_remote_id) DO NOTHING`,
      values,
    );
  };
  if (isPinnedToTransaction()) return apply();
  await withTenantTransaction(businessId, apply);
}

/**
 * Drop assignments whose remote product no longer has a mapping (TAX-07).
 *
 * `integration_woo_product_terms` holds remote string identities with no FK
 * to anything, so a product deleted from the store — and unmapped here —
 * kept its term assignments forever: stale counts on every term it touched
 * and an orphan table that only grew. Run after a catalogue sync; a no-op
 * when nothing was deleted.
 */
export async function pruneOrphanProductTerms(businessId: string, connectionId: string): Promise<number> {
  const result = await query(
    `DELETE FROM integration_woo_product_terms pt
      WHERE pt.business_id = $1 AND pt.connection_id = $2
        AND NOT EXISTS (
              SELECT 1 FROM integration_mappings m
               WHERE m.connection_id = pt.connection_id
                 AND m.entity_type = 'product'
                 AND m.remote_id = pt.remote_id
            )`,
    [businessId, connectionId],
  );
  return result.rowCount ?? 0;
}

/**
 * Every mirrored term of a connection.
 *
 * TAX-13: the mapped count used to be a correlated `COUNT(DISTINCT …)`
 * subselect re-executed per term — 5,000 terms meant 5,000 scans of the
 * assignments table. The aggregate now runs once and joins back.
 */
export async function listTerms(
  businessId: string,
  connectionId: string,
  taxonomy?: string,
): Promise<TermRow[]> {
  const { rows } = await query<{
    taxonomy: string;
    remote_id: string;
    parent_remote_id: string | null;
    name: string;
    slug: string;
    description: string;
    remote_count: number;
    menu_order: number;
    mapped_count: string;
  }>(
    `SELECT t.taxonomy, t.remote_id, t.parent_remote_id, t.name, t.slug, t.description,
            t.remote_count, t.menu_order,
            COALESCE(mc.mapped_count, 0)::text AS mapped_count
       FROM integration_woo_terms t
       LEFT JOIN (
             SELECT pt.taxonomy, pt.term_remote_id, COUNT(DISTINCT pt.remote_id) AS mapped_count
               FROM integration_woo_product_terms pt
               JOIN integration_mappings m
                 ON m.connection_id = pt.connection_id
                AND m.entity_type = 'product'
                AND m.remote_id = pt.remote_id
              WHERE pt.business_id = $1 AND pt.connection_id = $2
                AND ($3::text IS NULL OR pt.taxonomy = $3)
              GROUP BY pt.taxonomy, pt.term_remote_id
            ) mc
         ON mc.taxonomy = t.taxonomy AND mc.term_remote_id = t.remote_id
      WHERE t.business_id = $1 AND t.connection_id = $2
        AND ($3::text IS NULL OR t.taxonomy = $3)
      ORDER BY t.taxonomy, t.menu_order, t.name`,
    [businessId, connectionId, taxonomy ?? null],
  );
  return rows.map((r) => ({
    taxonomy: r.taxonomy,
    remoteId: r.remote_id,
    parentRemoteId: r.parent_remote_id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    remoteCount: Number(r.remote_count),
    menuOrder: Number(r.menu_order),
    mappedCount: Number(r.mapped_count),
  }));
}

/**
 * Per-taxonomy and whole-connection assignment statistics (TAX-08).
 *
 * The group numbers the screen shows must not be the sum of per-term counts:
 * a product in three categories of one taxonomy is ONE synced product and
 * three assignments, and the old additive total happily reported it as three
 * products. `mappedProducts` is `COUNT(DISTINCT …)` over the group;
 * `assignments` is the membership-row count, labelled as such.
 */
export async function taxonomyGroupStats(
  businessId: string,
  connectionId: string,
): Promise<TaxonomyGroupStats> {
  const { rows } = await query<{ taxonomy: string; mapped_products: string; assignments: string }>(
    `SELECT pt.taxonomy,
            COUNT(DISTINCT pt.remote_id) FILTER (WHERE m.remote_id IS NOT NULL)::text AS mapped_products,
            COUNT(*)::text AS assignments
       FROM integration_woo_product_terms pt
       LEFT JOIN integration_mappings m
         ON m.connection_id = pt.connection_id
        AND m.entity_type = 'product'
        AND m.remote_id = pt.remote_id
      WHERE pt.business_id = $1 AND pt.connection_id = $2
      GROUP BY pt.taxonomy`,
    [businessId, connectionId],
  );
  const { rows: totals } = await query<{ mapped_products: string; assignments: string }>(
    `SELECT COUNT(DISTINCT pt.remote_id) FILTER (WHERE m.remote_id IS NOT NULL)::text AS mapped_products,
            COUNT(*)::text AS assignments
       FROM integration_woo_product_terms pt
       LEFT JOIN integration_mappings m
         ON m.connection_id = pt.connection_id
        AND m.entity_type = 'product'
        AND m.remote_id = pt.remote_id
      WHERE pt.business_id = $1 AND pt.connection_id = $2`,
    [businessId, connectionId],
  );
  return {
    groups: rows.map((row) => ({
      taxonomy: row.taxonomy,
      mappedProducts: Number(row.mapped_products),
      assignments: Number(row.assignments),
    })),
    totals: {
      mappedProducts: Number(totals[0]?.mapped_products ?? 0),
      assignments: Number(totals[0]?.assignments ?? 0),
    },
  };
}

/** Term names per remote product id — used to label a catalogue row. */
export async function termsByRemoteId(
  businessId: string,
  connectionId: string,
  remoteIds: string[],
  taxonomy = "product_cat",
): Promise<Map<string, { remoteId: string; name: string }[]>> {
  const out = new Map<string, { remoteId: string; name: string }[]>();
  if (remoteIds.length === 0) return out;
  const { rows } = await query<{ remote_id: string; term_remote_id: string; name: string }>(
    `SELECT pt.remote_id, pt.term_remote_id, COALESCE(t.name, '') AS name
       FROM integration_woo_product_terms pt
       LEFT JOIN integration_woo_terms t
         ON t.connection_id = pt.connection_id AND t.taxonomy = pt.taxonomy AND t.remote_id = pt.term_remote_id
      WHERE pt.business_id = $1 AND pt.connection_id = $2 AND pt.taxonomy = $3
        AND pt.remote_id = ANY($4::text[])
      ORDER BY pt.term_remote_id`,
    [businessId, connectionId, taxonomy, remoteIds],
  );
  for (const row of rows) {
    const list = out.get(row.remote_id) ?? [];
    list.push({ remoteId: row.term_remote_id, name: row.name });
    out.set(row.remote_id, list);
  }
  return out;
}

/**
 * The F&B bridge: make sure a `menu_categories` row exists for a WooCommerce
 * category, so an online menu's own navigation is not lost on the way into
 * the POS.
 *
 * Off unless the connection's `sync_categories` is set — copying a store's
 * categories into a menu an owner curated by hand is not a side effect an
 * upgrade is allowed to have.
 */
export async function ensureMenuCategory(
  businessId: string,
  connectionId: string,
  locationId: string,
  term: { remoteId: string; name: string; slug: string; menuOrder?: number },
): Promise<string | null> {
  if (!term.name.trim()) return null;
  const existing = await localIdForRemote(businessId, connectionId, "category", term.remoteId);
  if (existing) {
    await query(
      `UPDATE menu_categories SET name = $3, sort_order = $4
        WHERE id = $1 AND location_id = $2`,
      [existing, locationId, term.name.trim(), term.menuOrder ?? 0],
    );
    return existing;
  }
  // Name-keyed, not slug-keyed: `menu_categories` has no unique constraint
  // to conflict against, and a category the owner already created by that
  // name in the POS must be paired with rather than duplicated — two menu
  // categories called «پوشاک» is exactly the mess this bridge exists to
  // avoid.
  const { rows: byName } = await query<{ id: string }>(
    `SELECT id FROM menu_categories WHERE location_id = $1 AND name = $2 LIMIT 1`,
    [locationId, term.name.trim()],
  );
  const categoryId =
    byName[0]?.id ??
    (
      await query<{ id: string }>(
        `INSERT INTO menu_categories (location_id, name, sort_order)
         VALUES ($1, $2, $3) RETURNING id`,
        [locationId, term.name.trim(), term.menuOrder ?? 0],
      )
    ).rows[0]?.id;
  if (!categoryId) return null;
  await upsertMapping(businessId, connectionId, "category", term.remoteId, categoryId);
  return categoryId;
}
