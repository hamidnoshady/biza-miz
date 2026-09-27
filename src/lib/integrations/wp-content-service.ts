/**
 * Phase 40 — the WordPress content mirror.
 *
 * The WP Manager app browses posts, pages and media of the connected site.
 * Two doors, one table:
 *
 *   - **plugin mode** — the app cannot reach WordPress at all. The plugin
 *     pushes `content.updated` events (the same signed event channel orders
 *     and products use), and answers a `content_export` outbox job with the
 *     whole site. Both land in `integration_wp_content` through here.
 *   - **REST mode** — the app holds consumer keys, which the WordPress core
 *     REST API (`wp/v2`) accepts for posts/pages/media reads and writes. The
 *     sync pulls the same rows directly over the existing client.
 *
 * Keyed on the remote id like every other integration table, so a re-send of
 * the same post updates one row instead of duplicating it.
 */
import { randomUUID } from "node:crypto";
import { query } from "../db";
import { writeIntegrationAudit } from "./audit";
import { enqueueExport } from "./woo-ops-service";
import type { ConnectionRow } from "./connections-service";
import { safeWpExternalUrl, type WpMediaKind } from "./wp-media";

export type WpContentType = "post" | "page" | "attachment" | string;

export interface WpContentPayload {
  id: number | string;
  type?: string;
  title?: string | { rendered?: string; raw?: string };
  name?: string;
  slug?: string;
  status?: string;
  link?: string;
  permalink?: string;
  author?: string | number;
  author_name?: string;
  date?: string;
  date_gmt?: string;
  date_modified?: string;
  modified?: string;
  modified_gmt?: string;
  content?: string | { rendered?: string; raw?: string };
  excerpt?: string | { rendered?: string; raw?: string };
  source_url?: string;
  media_type?: string;
  mime_type?: string;
  alt_text?: string;
  /** Media: the attachment URL in either of the shapes plugins send. */
  url?: string;
  /**
   * Media: the `_pos_operation_id` meta the plugin stamped on this
   * attachment when it was created — present only when this attachment
   * exists because the app pushed it (Media Library → WordPress), and only
   * on the `add_attachment` event that fires immediately after. Absent on
   * every attachment a site owner uploaded directly, and on every later
   * content sync of the same file.
   */
  operation_id?: string;
}

export interface WpContentRow {
  remoteId: string;
  wpType: string;
  title: string;
  slug: string;
  status: string;
  permalink: string;
  authorName: string;
  mediaUrl: string | null;
  mimeType: string | null;
  /**
   * The post's own HTML, when the mirror carries it — the plugin sends the
   * raw `post_content` and a `context: edit` REST pull would send
   * `content.raw`. Null when the payload never carried content (a
   * `context: view` REST pull exposes only `content.rendered`, which this
   * app deliberately does not round-trip: writing rendered HTML back would
   * re-wrap paragraphs and expand shortcodes on the live site).
   */
  content: string | null;
  altText: string;
  remoteUpdatedAt: string | null;
  syncedAt: string;
}

/** The raw editable fields are read only for one row, never every list row. */
export interface WpContentDetail extends WpContentRow {
  editorTitle: string;
  content: string | null;
  excerpt: string;
}

/**
 * The named HTML entities WordPress's `title.rendered` actually emits.
 *
 * WordPress runs titles through `wptexturize`, which turns straight quotes,
 * apostrophes, dashes and ellipses into their typographic entities — so a
 * post literally called «Café's “Menu”…» arrives as
 * `Café&#8217;s &#8220;Menu&#8221;&#8230;`. The old decoder handled only a
 * handful of these, so the WP Manager's content list showed raw `&#8217;`
 * and `&hellip;` sprinkled through every title. Numeric entities (decimal and
 * hex) are decoded generically below; this map is for the named ones that
 * have no numeric form in a WordPress title.
 */
const NAMED_HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&hellip;": "…",
  "&ndash;": "–",
  "&mdash;": "—",
  "&laquo;": "«",
  "&raquo;": "»",
  "&rsquo;": "\u2019",
  "&lsquo;": "\u2018",
  "&rdquo;": "\u201d",
  "&ldquo;": "\u201c",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&deg;": "°",
};

/**
 * Decode the HTML entities WordPress puts in a title, both numeric and named.
 *
 * `&amp;` is intentionally resolved last: a double-encoded string such as
 * `&amp;#8217;` must first become `&#8217;` and only then the apostrophe,
 * never `&` mid-way through, which would strand the rest of the entity.
 */
export function decodeWpEntities(text: string): string {
  return text
    // Decimal numeric entities: &#8217; → ’
    .replace(/&#(\d+);/g, (_m, code: string) => codePointToString(Number.parseInt(code, 10)))
    // Hex numeric entities: &#x2019; / &#X2019; → ’
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_m, code: string) => codePointToString(Number.parseInt(code, 16)))
    // Named entities, with &amp; kept for the very end.
    .replace(/&(?:apos|nbsp|hellip|ndash|mdash|laquo|raquo|rsquo|lsquo|rdquo|ldquo|copy|reg|trade|deg|quot|lt|gt);/g,
      (m) => NAMED_HTML_ENTITIES[m] ?? m)
    .replace(/&amp;/g, "&");
}

/** A code point → its string, leaving an out-of-range or invalid value untouched-but-safe. */
function codePointToString(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Strip the HTML WordPress's `title.rendered` carries and decode entities. */
export function plainTitle(raw: unknown): string {
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "rendered" in raw
        ? String((raw as { rendered?: string }).rendered ?? "")
        : "";
  return decodeWpEntities(text.replace(/<[^>]*>/g, "")).trim();
}

/**
 * Read an editable text field from either the plugin's raw string or wp/v2's
 * `{ raw, rendered }` shape. This is suitable for titles/excerpts; post body
 * content uses the stricter `mirroredContent` boundary below.
 */
export function editableWpField(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  const value = raw as { raw?: unknown; rendered?: unknown };
  if (typeof value.raw === "string") return value.raw;
  return typeof value.rendered === "string" ? value.rendered : "";
}

/**
 * Return only content that can be safely round-tripped to WordPress.
 * Rendered-only HTML has passed through filters such as shortcode expansion
 * and wpautop, so writing it back would silently rewrite the live post.
 */
export function mirroredContent(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof (raw as { raw?: unknown }).raw === "string") {
    return (raw as { raw: string }).raw;
  }
  return null;
}

/** Only absolute, credential-free HTTP(S) URLs may leave the API. */
export function safeWpUrl(raw: unknown): string {
  return safeWpExternalUrl(raw) ?? "";
}

/** WordPress post ids are positive decimal integers. */
function remoteContentId(raw: unknown): string {
  const value = typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "";
  return /^[1-9]\d*$/.test(value) ? value : "";
}

/** Never hand an invalid remote timestamp to PostgreSQL's timestamptz cast. */
function validRemoteDate(raw: unknown, assumeUtc = false): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = assumeUtc && !/(?:Z|[+-]\d\d:\d\d)$/i.test(raw.trim()) ? `${raw.trim()}Z` : raw.trim();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Normalise one pushed/REST content object and upsert the mirror row. */
export async function upsertWpContent(
  connection: ConnectionRow,
  payload: WpContentPayload,
): Promise<"created" | "updated"> {
  const remoteId = remoteContentId(payload.id);
  if (!remoteId) return "updated";
  const rawType = typeof payload.type === "string" ? payload.type.trim() : "";
  const wpType = rawType.slice(0, 100) || "post";
  const fallbackName = typeof payload.name === "string" ? payload.name : "";
  const title = plainTitle(payload.title) || fallbackName || `${wpType} #${remoteId}`;
  const mediaUrl = safeWpUrl(payload.source_url) || safeWpUrl(payload.url) || null;
  const rawMimeType =
    typeof payload.mime_type === "string"
      ? payload.mime_type
      : wpType === "attachment" && typeof payload.media_type === "string"
        ? payload.media_type
        : "";
  const mimeType = rawMimeType.trim().toLowerCase().slice(0, 200) || null;
  const permalink = safeWpUrl(payload.link) || safeWpUrl(payload.permalink);
  const remoteUpdated =
    validRemoteDate(payload.date_modified) ||
    validRemoteDate(payload.modified_gmt, true) ||
    validRemoteDate(payload.modified) ||
    validRemoteDate(payload.date_gmt, true) ||
    validRemoteDate(payload.date);
  const slug = typeof payload.slug === "string" ? payload.slug : "";
  const status = typeof payload.status === "string" ? payload.status : "publish";
  const authorName =
    typeof payload.author_name === "string"
      ? payload.author_name
      : typeof payload.author === "string"
        ? payload.author
        : "";

  const { rows } = await query<{ inserted: boolean }>(
    `INSERT INTO integration_wp_content
       (business_id, connection_id, wp_type, remote_id, title, slug, status, permalink,
        author_name, media_url, mime_type, payload, remote_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
             CASE WHEN $13::timestamptz IS NULL THEN NULL ELSE $13::timestamptz END)
     ON CONFLICT (connection_id, wp_type, remote_id) DO UPDATE
       SET title = EXCLUDED.title,
           slug = EXCLUDED.slug,
           status = EXCLUDED.status,
           permalink = EXCLUDED.permalink,
           author_name = EXCLUDED.author_name,
           media_url = COALESCE(EXCLUDED.media_url, integration_wp_content.media_url),
           mime_type = COALESCE(EXCLUDED.mime_type, integration_wp_content.mime_type),
           payload = EXCLUDED.payload,
           remote_updated_at = COALESCE(EXCLUDED.remote_updated_at, integration_wp_content.remote_updated_at),
           synced_at = now(),
           updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      connection.business_id,
      connection.id,
      wpType,
      remoteId,
      title.slice(0, 500),
      slug.slice(0, 200),
      status.slice(0, 40),
      permalink.slice(0, 1000),
      authorName.slice(0, 200),
      mediaUrl,
      mimeType,
      JSON.stringify(payload),
      remoteUpdated,
    ],
  );
  return rows[0]?.inserted ? "created" : "updated";
}

export interface WpContentListOptions {
  wpType?: string;
  search?: string;
  mediaKind?: Exclude<WpMediaKind, "all">;
  limit?: number;
  offset?: number;
}

/** Parameters shared by the list and count queries, so filters cannot drift. */
function contentFilterParams(
  businessId: string,
  connectionId: string,
  options: WpContentListOptions,
): [string, string, string | null, string | null, string | null] {
  return [
    businessId,
    connectionId,
    options.wpType ?? null,
    options.search?.trim() || null,
    options.mediaKind ?? null,
  ];
}

/**
 * The mirrored content for a connection, newest first, optionally filtered
 * and paged. Media uses this server-side paging so a site with more than one
 * hundred attachments does not silently hide the rest of its library.
 */
export async function listWpContent(
  businessId: string,
  connectionId: string,
  options: WpContentListOptions = {},
): Promise<WpContentRow[]> {
  const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 100;
  const requestedOffset = Number.isFinite(options.offset) ? Math.trunc(options.offset!) : 0;
  const limit = Math.min(200, Math.max(1, requestedLimit));
  const offset = Math.min(1_000_000, Math.max(0, requestedOffset));
  const { rows } = await query<{
    remote_id: string;
    wp_type: string;
    title: string;
    slug: string;
    status: string;
    permalink: string;
    author_name: string;
    media_url: string | null;
    mime_type: string | null;
    content: unknown;
    alt_text: string;
    remote_updated_at: string | null;
    synced_at: string;
  }>(
    `SELECT remote_id, wp_type, title, slug, status, permalink, author_name,
            media_url, mime_type, payload->'content' AS content,
            COALESCE(payload->>'alt_text', '') AS alt_text,
            remote_updated_at, synced_at
       FROM integration_wp_content
      WHERE business_id = $1 AND connection_id = $2
        AND ($3::text IS NULL OR wp_type = $3)
        AND (
          $4::text IS NULL
          OR title ILIKE '%' || $4 || '%'
          OR slug ILIKE '%' || $4 || '%'
          OR COALESCE(mime_type, '') ILIKE '%' || $4 || '%'
        )
        AND (
          $5::text IS NULL
          OR ($5 = 'image' AND lower(COALESCE(mime_type, '')) LIKE 'image/%')
          OR ($5 = 'video' AND lower(COALESCE(mime_type, '')) LIKE 'video/%')
          OR ($5 = 'audio' AND lower(COALESCE(mime_type, '')) LIKE 'audio/%')
          OR ($5 = 'document' AND lower(COALESCE(mime_type, '')) NOT LIKE 'image/%'
                              AND lower(COALESCE(mime_type, '')) NOT LIKE 'video/%'
                              AND lower(COALESCE(mime_type, '')) NOT LIKE 'audio/%')
        )
      ORDER BY remote_updated_at DESC NULLS LAST, synced_at DESC, remote_id DESC
      LIMIT $6 OFFSET $7`,
    [...contentFilterParams(businessId, connectionId, options), limit, offset],
  );
  return rows.map((r) => ({
    remoteId: r.remote_id,
    wpType: r.wp_type,
    title: r.title,
    slug: r.slug,
    status: r.status,
    permalink: safeWpExternalUrl(r.permalink) ?? "",
    authorName: r.author_name,
    // Sanitize again on read so rows mirrored before this boundary was added
    // cannot retain an executable external href forever.
    mediaUrl: safeWpExternalUrl(r.media_url),
    mimeType: r.mime_type,
    content: mirroredContent(r.content),
    altText: r.alt_text,
    remoteUpdatedAt: r.remote_updated_at,
    syncedAt: r.synced_at,
  }));
}

/** Total matching rows for paged manager screens. */
export async function countWpContent(
  businessId: string,
  connectionId: string,
  options: Omit<WpContentListOptions, "limit" | "offset"> = {},
): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM integration_wp_content
      WHERE business_id = $1 AND connection_id = $2
        AND ($3::text IS NULL OR wp_type = $3)
        AND (
          $4::text IS NULL
          OR title ILIKE '%' || $4 || '%'
          OR slug ILIKE '%' || $4 || '%'
          OR COALESCE(mime_type, '') ILIKE '%' || $4 || '%'
        )
        AND (
          $5::text IS NULL
          OR ($5 = 'image' AND lower(COALESCE(mime_type, '')) LIKE 'image/%')
          OR ($5 = 'video' AND lower(COALESCE(mime_type, '')) LIKE 'video/%')
          OR ($5 = 'audio' AND lower(COALESCE(mime_type, '')) LIKE 'audio/%')
          OR ($5 = 'document' AND lower(COALESCE(mime_type, '')) NOT LIKE 'image/%'
                              AND lower(COALESCE(mime_type, '')) NOT LIKE 'video/%'
                              AND lower(COALESCE(mime_type, '')) NOT LIKE 'audio/%')
        )`,
    contentFilterParams(businessId, connectionId, options),
  );
  return Number(rows[0]?.n ?? 0);
}

/** One mirrored post/page with the raw fields the editor must round-trip. */
export async function getWpContent(
  businessId: string,
  connectionId: string,
  wpType: "post" | "page",
  remoteId: string,
): Promise<WpContentDetail | null> {
  const { rows } = await query<{
    remote_id: string;
    wp_type: string;
    title: string;
    slug: string;
    status: string;
    permalink: string;
    author_name: string;
    media_url: string | null;
    mime_type: string | null;
    alt_text: string;
    remote_updated_at: string | null;
    synced_at: string;
    payload: WpContentPayload;
  }>(
    `SELECT remote_id, wp_type, title, slug, status, permalink, author_name,
            media_url, mime_type, COALESCE(payload->>'alt_text', '') AS alt_text,
            remote_updated_at, synced_at, payload
       FROM integration_wp_content
      WHERE business_id = $1 AND connection_id = $2 AND wp_type = $3 AND remote_id = $4
      LIMIT 1`,
    [businessId, connectionId, wpType, remoteId],
  );
  const row = rows[0];
  if (!row) return null;
  const payload = row.payload && typeof row.payload === "object" ? row.payload : ({} as WpContentPayload);
  return {
    remoteId: row.remote_id,
    wpType: row.wp_type,
    title: row.title,
    slug: row.slug,
    status: row.status,
    permalink: safeWpUrl(row.permalink),
    authorName: row.author_name,
    mediaUrl: safeWpUrl(row.media_url) || null,
    mimeType: row.mime_type,
    altText: row.alt_text,
    remoteUpdatedAt: row.remote_updated_at,
    syncedAt: row.synced_at,
    editorTitle: editableWpField(payload.title) || row.title,
    content: mirroredContent(payload.content),
    excerpt: editableWpField(payload.excerpt),
  };
}

/** Remove a post/page/media row after WordPress permanently deleted it. */
export async function deleteWpContent(
  businessId: string,
  connectionId: string,
  payload: Pick<WpContentPayload, "id" | "type">,
): Promise<boolean>;
export async function deleteWpContent(
  businessId: string,
  connectionId: string,
  wpType: string,
  remoteId: string,
): Promise<boolean>;
export async function deleteWpContent(
  businessId: string,
  connectionId: string,
  typeOrPayload: string | Pick<WpContentPayload, "id" | "type">,
  remoteId?: string,
): Promise<boolean> {
  const id = remoteContentId(typeof typeOrPayload === "string" ? remoteId : typeOrPayload.id);
  const rawType = typeof typeOrPayload === "string" ? typeOrPayload : typeOrPayload.type;
  const type = typeof rawType === "string" ? rawType.trim().slice(0, 100) : "";
  if (!id || !type) return false;
  const { rowCount } = await query(
    `DELETE FROM integration_wp_content
      WHERE business_id = $1 AND connection_id = $2 AND wp_type = $3 AND remote_id = $4`,
    [businessId, connectionId, type, id],
  );
  return (rowCount ?? 0) > 0;
}

export interface WpContentCounts {
  posts: number;
  pages: number;
  media: number;
}

/** Counts by the three types the manager shows. */
export async function wpContentCounts(
  businessId: string,
  connectionId: string,
): Promise<WpContentCounts> {
  const { rows } = await query<{ wp_type: string; n: string }>(
    `SELECT wp_type, count(*)::text AS n FROM integration_wp_content
      WHERE business_id = $1 AND connection_id = $2
      GROUP BY wp_type`,
    [businessId, connectionId],
  );
  const counts = { posts: 0, pages: 0, media: 0 };
  for (const row of rows) {
    if (row.wp_type === "post") counts.posts = Number(row.n);
    else if (row.wp_type === "page") counts.pages = Number(row.n);
    else if (row.wp_type === "attachment") counts.media = Number(row.n);
  }
  return counts;
}

/**
 * Ask for the whole content library.
 *
 * Plugin mode: a `content_export` outbox row the plugin leases on its next
 * pull and answers with `content.updated` events (the plugin's outbox apply
 * loop already applies unknown future job types safely; this version
 * understands this one).
 *
 * REST mode: the app reads wp/v2 itself — the caller routes by link mode.
 */
export async function enqueueContentExport(businessId: string, connectionId: string): Promise<void> {
  await enqueueExport(businessId, connectionId, "content_export");
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "content.export_queued",
  });
}

/** A stable delivery id for a pushed content event, mirroring order events. */
export function contentDeliveryId(connectionId: string, payload: WpContentPayload): string {
  return `content:${connectionId}:${payload.type ?? "post"}:${payload.id}:${randomUUID()}`;
}

/**
 * Pull posts/pages/media over the WordPress core REST API.
 *
 * Authenticated `context=edit` retains raw editor fields and includes the
 * site's non-public posts/pages. Hosts that omit `X-WP-TotalPages` are walked
 * until a short page instead of silently stopping after the first hundred
 * attachments.
 *
 * A completed pull is authoritative. Rows no longer present at WordPress are
 * pruned only after all three collections were fetched successfully, so a
 * timeout halfway through a sync can add fresh rows but can never erase the
 * last known-good mirror.
 */
export async function syncWpContentRest(
  connection: ConnectionRow,
  client: {
    wpListPage: (
      type: string,
      query: Record<string, string | number | boolean> & { page: number },
    ) => Promise<{ items: Record<string, unknown>[]; totalPages: number }>;
  },
): Promise<{ total: number; removed: number }> {
  let total = 0;
  let removed = 0;
  const collections = [
    { endpoint: "posts", wpType: "post", status: "publish,draft,pending,private,future,trash" },
    { endpoint: "pages", wpType: "page", status: "publish,draft,pending,private,future,trash" },
    { endpoint: "media", wpType: "attachment", status: "inherit" },
  ] as const;
  const seenByType = new Map<string, string[]>();

  for (const collection of collections) {
    const seen = new Set<string>();
    // Posts and pages are asked for with `context: edit` first: that is the
    // only context that carries `content.raw`, the round-trippable HTML the
    // manager's editor needs (a `view` pull exposes only `content.rendered`,
    // which must never be written back — see `mirroredContent`). A key whose
    // user cannot edit posts refuses the context, and the pull retries with
    // `view` so the mirror still arrives, minus the editable content. Media
    // needs no edit context — `source_url` is the same in both.
    let context: "edit" | "view" = collection.wpType === "attachment" ? "view" : "edit";
    let page = 1;
    for (;;) {
      let result: { items: Record<string, unknown>[]; totalPages: number };
      try {
        result = await client.wpListPage(collection.endpoint, {
          context,
          ...(context === "edit" ? { status: collection.status } : {}),
          per_page: 100,
          page,
        });
      } catch (err) {
        if (context === "edit" && page === 1) {
          // Some WooCommerce keys can read public wp/v2 rows but cannot use
          // edit context. Keep the mirror available while marking body content
          // non-editable rather than failing the whole synchronization.
          context = "view";
          result = await client.wpListPage(collection.endpoint, { context, per_page: 100, page });
        } else {
          throw err;
        }
      }
      const { items, totalPages } = result;
      const reportedPages = Number.isFinite(Number(totalPages)) ? Math.max(0, Number(totalPages)) : 0;

      for (const item of items) {
        const remoteId = remoteContentId(item.id);
        if (!remoteId) continue;
        await upsertWpContent(connection, {
          ...item,
          // Pin sparse/proxied responses to the collection being fetched.
          type: collection.wpType,
        } as unknown as WpContentPayload);
        seen.add(remoteId);
        total += 1;
      }

      if (items.length === 0) {
        if (reportedPages > 0 && page < reportedPages) throw new Error("wp_content_incomplete_page");
        break;
      }
      if (reportedPages > 0 ? page >= reportedPages : items.length < 100) break;
      if (page >= 500) throw new Error("wp_content_page_limit");
      page += 1;
    }
    // A view-context fallback omits drafts/private rows, so it is useful for
    // browsing but not an authoritative deletion snapshot. Media's view
    // collection is complete for its normal `inherit` status.
    if (context === "edit" || collection.wpType === "attachment") {
      seenByType.set(collection.wpType, [...seen]);
    }
  }

  // Prune only after every collection completed. A failure halfway through a
  // pull may add fresh rows but must never erase the last known-good snapshot.
  for (const [wpType, remoteIds] of seenByType) {
    const result = await query(
      `DELETE FROM integration_wp_content
        WHERE business_id = $1 AND connection_id = $2 AND wp_type = $3
          AND NOT (remote_id = ANY($4::text[]))`,
      [connection.business_id, connection.id, wpType, remoteIds],
    );
    removed += result.rowCount ?? 0;
  }

  await query(
    `UPDATE integration_connections SET last_content_sync_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [connection.business_id, connection.id],
  );
  await writeIntegrationAudit({
    businessId: connection.business_id,
    connectionId: connection.id,
    action: "content.synced",
    payload: { total, removed },
  });
  return { total, removed };
}
