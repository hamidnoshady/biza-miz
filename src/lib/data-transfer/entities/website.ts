/**
 * Website adapters — the product sync map, WordPress pages and media content.
 *
 * Only the sync map is writable, and only in the one way that makes sense to
 * bulk-edit: which local products push to the site, and which remote id each
 * one is mapped to. The page catalogue is a mirror of the connected WordPress
 * site (`integration_wp_content`) and the media library is the platform's own
 * storage — both are exports, because writing a row into a mirror does not
 * change the thing being mirrored, it only makes the mirror lie.
 */

import { query } from "../../db";
import { postgresDateToIso } from "../../jalali";
import { registerAdapter, RowRejection, type EntityAdapter } from "../adapters";

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return postgresDateToIso(value);
  return String(value).slice(0, 10);
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

const productsAdapter: EntityAdapter = {
  entity: "website.products",
  async read(context, options) {
    const where = ["m.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`m.id = ANY($${params.length}::uuid[])`);
    }
    if (options.filters.syncEnabledOnly === true) where.push("m.sync_enabled");
    if (typeof options.filters.connectionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.filters.connectionId)) {
      params.push(options.filters.connectionId);
      where.push(`m.connection_id = $${params.length}::uuid`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT m.id, m.connection_id AS "connectionId", c.site_domain AS "siteDomain",
              m.local_kind AS "localKind", m.remote_id AS "remoteId",
              m.sync_enabled AS "syncEnabled",
              m.last_pushed_price_rial AS "lastPushedPriceRial",
              m.last_pushed_stock AS "lastPushedStock",
              m.last_pushed_at AS "lastPushedAt",
              coalesce(mi.name, it.name) AS "localName"
         FROM website_product_map m
         LEFT JOIN menu_items mi ON m.local_kind = 'menu_item' AND mi.id = m.local_id
         LEFT JOIN items it ON m.local_kind = 'item' AND it.id = m.local_id
         LEFT JOIN eshobe_cms_connections c ON c.id = m.connection_id AND c.business_id = m.business_id
        WHERE ${where.join(" AND ")}
        ORDER BY coalesce(mi.name, it.name)
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      lastPushedPriceRial:
        row.lastPushedPriceRial === null ? null : Number(row.lastPushedPriceRial),
      lastPushedStock: row.lastPushedStock === null ? null : Number(row.lastPushedStock),
      lastPushedAt: isoDate(row.lastPushedAt),
    }));
  },
  async write(context, values, options) {
    const remoteId = text(values.remoteId);
    if (!remoteId) throw new RowRejection("شناسهٔ سایت الزامی است.");
    const requestedConnection = text(values.connectionId);
    if (requestedConnection && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedConnection)) {
      throw new RowRejection("شناسهٔ اتصال سایت معتبر نیست.");
    }
    const connections = await query<{ id: string }>(
      `SELECT id FROM eshobe_cms_connections
        WHERE business_id = $1 AND ($2::uuid IS NULL OR id = $2)
        ORDER BY created_at, id`,
      [context.businessId, requestedConnection ?? null],
    );
    if (requestedConnection && connections.rows.length !== 1) {
      throw new RowRejection("اتصال سایت یافت نشد.");
    }
    if (!requestedConnection && connections.rows.length !== 1) {
      return { status: "skipped", reason: "برای چند سایت، شناسهٔ اتصال را در ردیف وارد کنید." };
    }
    const connectionId = connections.rows[0]?.id;
    if (!connectionId) return { status: "skipped", reason: "اتصال سایت یافت نشد." };
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM website_product_map
        WHERE business_id = $1 AND connection_id = $2 AND remote_id = $3 LIMIT 1`,
      [context.businessId, connectionId, remoteId],
    );
    const existing = rows[0];
    if (!existing) {
      // A map row needs a local product to point at, and this importer has no
      // way to invent one: the operator maps an existing catalogue item to an
      // existing site product from the website screen.
      return {
        status: "skipped",
        reason: `کالایی با شناسهٔ سایت «${remoteId}» در نگاشت وجود ندارد.`,
      };
    }
    if (options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: "این نگاشت از پیش وجود دارد." };
    }
    await query(
      `UPDATE website_product_map
          SET sync_enabled = coalesce($3, sync_enabled), updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [context.businessId, existing.id, values.syncEnabled ?? null],
    );
    return { status: "updated", id: existing.id };
  },
};

const pagesAdapter: EntityAdapter = {
  entity: "website.pages",
  async read(context, options) {
    const where = ["c.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`c.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.wpType === "string" && options.filters.wpType) {
      params.push(options.filters.wpType);
      where.push(`c.wp_type = $${params.length}`);
    }
    if (typeof options.filters.status === "string" && options.filters.status) {
      params.push(options.filters.status);
      where.push(`c.status = $${params.length}`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT c.id, c.title, c.slug, c.wp_type AS "wpType", c.status,
              c.author_name AS "authorName", c.permalink,
              c.remote_updated_at AS "remoteUpdatedAt"
         FROM integration_wp_content c
        WHERE ${where.join(" AND ")}
        ORDER BY c.remote_updated_at DESC NULLS LAST, c.title
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({ ...row, remoteUpdatedAt: isoDate(row.remoteUpdatedAt) }));
  },
};

const contentAdapter: EntityAdapter = {
  entity: "website.content",
  async read(context, options) {
    const where = ["a.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`a.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.folderId === "string" && options.filters.folderId) {
      params.push(options.filters.folderId);
      where.push(`a.folder_id = $${params.length}::uuid`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT a.id, a.file_name AS "fileName", a.file_name AS title,
              f.name AS "folderName", a.mime_type AS "mimeType",
              a.byte_size AS "sizeBytes", a.created_at AS "createdAt"
         FROM media_assets a
         LEFT JOIN media_folders f ON f.id = a.folder_id
        WHERE ${where.join(" AND ")}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      sizeBytes: Number(row.sizeBytes ?? 0),
      createdAt: isoDate(row.createdAt),
    }));
  },
};

export function registerWebsiteAdapters(): void {
  registerAdapter(productsAdapter);
  registerAdapter(pagesAdapter);
  registerAdapter(contentAdapter);
}
