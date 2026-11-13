/**
 * ESH-147 (#1305) — table QR identity, DB-touching half.
 *
 * One printed token → one business/location/table, resolved server-side. The
 * purity split is `table-qr.ts` (format, hashing, rejection vocabulary); this
 * module owns the rows and the tenant boundary.
 *
 * Boundaries kept here:
 *   - **The staff surface never returns the raw token in JSON.** It renders
 *     an image instead (the token is inside the PNG/SVG), so a screenshot of
 *     the dashboard or a copied API response cannot be used to place orders.
 *   - **The public resolve endpoint never returns a uuid.** It answers the
 *     table's display name, the branch name and the CMS `siteId` the caller
 *     already knows — nothing that could be replayed as another identity.
 *   - **A token names its own tenant.** The order path takes `businessId` from
 *     the verified CMS connection and refuses a token whose row belongs to a
 *     different business; the customer's request never supplies a table id.
 *   - **Rotation is a state, not a delete.** The old print stops resolving
 *     (`token_rotated`) and the row that recorded it stays.
 */
import type { PoolClient } from "pg";
import { getPool, query, withTenant, withoutTenantScope } from "./db";
import { isFeatureEnabled } from "./features";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./integrations/secrets";
import {
  generateTableQrToken,
  hashTableQrToken,
  normalizeTableQrToken,
  tableQrLink,
  tableQrRejection,
  tableQrTokenPrefix,
  tableStatusAcceptsQrOrders,
  type PublicTableQrResolution,
  type TableQrLink,
  type TableQrRejection,
} from "./table-qr";
import { createOrder, type CreateOrderInput, type CreateOrderOutput } from "./order-mutations";
import { getWebsiteConnectionRow } from "./website/connection-service";
import type { CartItemInput } from "./order-cart";
import type { DiscountInput } from "./orders";

export const TABLE_QR_FEATURE = "dine_in";

/** Thrown only for programmer errors (a table id that is not the caller's). */
export class TableQrError extends Error {
  constructor(
    readonly reason: string,
    readonly status: number,
  ) {
    super(reason);
  }
}

function encryptionKeyOrNull(): Buffer | null {
  try {
    return resolveEncryptionKey(process.env);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Staff surface
// ---------------------------------------------------------------------------

/**
 * What staff may see in JSON: a masked label and where a scan lands — never
 * the token. The token exists only inside the rendered image, so copying this
 * response (or a screenshot of the panel) cannot be used to place an order.
 */
export interface TableQrTokenState {
  /** Masked label (`tqr_ab12cd`), never the token itself. */
  prefix: string;
  /** True when an active CMS site gives the QR a menu URL to open. */
  siteConnected: boolean;
  /** The scan target without its token (`https://site/menu`), or null. */
  menuUrl: string | null;
  createdAt: string;
  createdBy: string | null;
  /** Present when the row was rotated by a previous rotation (history pointer). */
  rotatedFromPrefix: string | null;
}

function stateFrom(
  row: TableQrTokenState | { prefix: string; createdAt: string; createdBy: string | null },
  link: TableQrLink | null,
  rotatedFromPrefix: string | null,
): TableQrTokenState {
  return {
    prefix: row.prefix,
    siteConnected: link !== null,
    menuUrl: link ? link.url.split("?")[0] : null,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    rotatedFromPrefix,
  };
}

interface TokenRow {
  [key: string]: unknown;
  id: string;
  token_ciphertext: string;
  token_prefix: string;
  created_at: Date;
  created_by: string | null;
  rotated_from: string | null;
}

const TOKEN_COLUMNS = `id, token_ciphertext, token_prefix, created_at, created_by, rotated_from`;

async function activeToken(
  client: PoolClient | null,
  locationId: string,
  tableId: string,
): Promise<TokenRow | null> {
  const sql = `SELECT ${TOKEN_COLUMNS} FROM table_qr_tokens
                WHERE location_id = $1 AND table_id = $2 AND status = 'active'
                LIMIT 1`;
  const params = [locationId, tableId];
  const res = client
    ? await client.query<TokenRow>(sql, params)
    : await query<TokenRow>(sql, params);
  return res.rows[0] ?? null;
}

function decryptTokenOrNull(row: TokenRow): string | null {
  const key = encryptionKeyOrNull();
  if (!key) return null;
  try {
    return decryptSecret(row.token_ciphertext, key);
  } catch {
    return null;
  }
}

async function linkFor(businessId: string, token: string): Promise<TableQrLink | null> {
  const connection = await getWebsiteConnectionRow(businessId);
  if (!connection || connection.status !== "active") {
    // No site connected: the token is still valid for the CMS when it later
    // attaches, but there is no public menu URL to print yet.
    return null;
  }
  return tableQrLink({
    token,
    siteDomain: connection.site_domain,
    menuPath: process.env.ESHOBE_TABLE_QR_MENU_PATH ?? null,
  });
}

/**
 * The active token's masked state for a table, or null when the table has
 * never been printed. Used by the staff GET and by the panel's initial load.
 */
export async function getTableQrState(
  businessId: string,
  locationId: string,
  tableId: string,
): Promise<TableQrTokenState | null> {
  return withTenant(businessId, async () => {
    const row = await activeToken(null, locationId, tableId);
    if (!row) return null;
    const token = decryptTokenOrNull(row);
    const link = token ? await linkFor(businessId, token) : null;
    return stateFrom(
      { prefix: row.token_prefix, createdAt: row.created_at.toISOString(), createdBy: row.created_by },
      link,
      null,
    );
  });
}

/**
 * Generate the table's token, or return the existing one.
 *
 * The `dining_tables` row is locked `FOR UPDATE` first, so two staff taps —
 * or two tabs — serialize: the second sees the first's active row and returns
 * it instead of racing the partial unique index into a 500. The same lock
 * makes rotation atomic against a concurrent generate.
 */
export async function ensureTableQrToken(input: {
  businessId: string;
  locationId: string;
  tableId: string;
  userId: string | null;
}): Promise<{ created: boolean; state: TableQrTokenState }> {
  return withTenant(input.businessId, async () => {
    const client = await getPool().connect();
    let created = false;
    let row!: TokenRow;
    let plaintext!: string;
    try {
      await client.query("BEGIN");
      const table = await lockTable(client, input.locationId, input.tableId);

      const existing = await activeToken(client, input.locationId, input.tableId);
      if (existing) {
        const token = decryptTokenOrNull(existing);
        if (!token) throw new TableQrError("token_unreadable", 409);
        await client.query("COMMIT");
        row = existing;
        plaintext = token;
      } else {
        const key = encryptionKeyOrNull();
        if (!key) throw new TableQrError("encryption_unavailable", 503);
        const token = generateTableQrToken();
        const inserted = await client.query<{ id: string; created_at: Date; token_prefix: string }>(
          `INSERT INTO table_qr_tokens
             (business_id, location_id, table_id, token_hash, token_ciphertext, token_prefix, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, created_at, token_prefix`,
          [
            input.businessId,
            table.locationId,
            table.id,
            hashTableQrToken(token),
            encryptSecret(token, key),
            tableQrTokenPrefix(token),
            input.userId,
          ],
        );
        await client.query("COMMIT");
        created = true;
        plaintext = token;
        row = {
          id: inserted.rows[0].id,
          token_ciphertext: "",
          token_prefix: inserted.rows[0].token_prefix,
          created_at: inserted.rows[0].created_at,
          created_by: input.userId,
          rotated_from: null,
        };
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return {
      created,
      state: stateFrom(
        { prefix: row.token_prefix, createdAt: row.created_at.toISOString(), createdBy: row.created_by },
        await linkFor(input.businessId, plaintext),
        row.rotated_from ? await prefixFor(input.businessId, row.rotated_from) : null,
      ),
    };
  });
}

async function prefixFor(businessId: string, tokenId: string): Promise<string | null> {
  const { rows } = await query<{ token_prefix: string }>(
    "SELECT token_prefix FROM table_qr_tokens WHERE business_id = $1 AND id = $2",
    [businessId, tokenId],
  );
  return rows[0]?.token_prefix ?? null;
}

/**
 * Replace the print. The old row becomes `rotated` in the same transaction as
 * the new one is inserted, so there is never a moment with two live tokens (or
 * none) for a table.
 */
export async function rotateTableQrToken(input: {
  businessId: string;
  locationId: string;
  tableId: string;
  userId: string | null;
}): Promise<TableQrTokenState> {
  return withTenant(input.businessId, async () => {
    const client = await getPool().connect();
    let plaintext!: string;
    let createdAt!: Date;
    let prefix!: string;
    let previousPrefix: string | null = null;
    try {
      await client.query("BEGIN");
      const table = await lockTable(client, input.locationId, input.tableId);
      const previous = await activeToken(client, input.locationId, input.tableId);
      if (previous) {
        previousPrefix = previous.token_prefix;
        await client.query(
          `UPDATE table_qr_tokens
              SET status = 'rotated', rotated_at = now(), rotated_by = $2
            WHERE id = $1 AND status = 'active'`,
          [previous.id, input.userId],
        );
      }
      const key = encryptionKeyOrNull();
      if (!key) throw new TableQrError("encryption_unavailable", 503);
      const token = generateTableQrToken();
      const inserted = await client.query<{ created_at: Date; token_prefix: string }>(
        `INSERT INTO table_qr_tokens
           (business_id, location_id, table_id, token_hash, token_ciphertext, token_prefix,
            created_by, rotated_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING created_at, token_prefix`,
        [
          input.businessId,
          table.locationId,
          table.id,
          hashTableQrToken(token),
          encryptSecret(token, key),
          tableQrTokenPrefix(token),
          input.userId,
          previous?.id ?? null,
        ],
      );
      await client.query("COMMIT");
      plaintext = token;
      createdAt = inserted.rows[0].created_at;
      prefix = inserted.rows[0].token_prefix;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return stateFrom(
      { prefix, createdAt: createdAt.toISOString(), createdBy: input.userId },
      await linkFor(input.businessId, plaintext),
      previousPrefix,
    );
  });
}

/** Revoke the live print; false when the table had none. */
export async function revokeTableQrToken(input: {
  businessId: string;
  locationId: string;
  tableId: string;
  userId: string | null;
}): Promise<boolean> {
  return withTenant(input.businessId, async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await lockTable(client, input.locationId, input.tableId);
      const { rowCount } = await client.query(
        `UPDATE table_qr_tokens
            SET status = 'revoked', revoked_at = now(), revoked_by = $3
          WHERE location_id = $1 AND table_id = $2 AND status = 'active'`,
        [input.locationId, input.tableId, input.userId],
      );
      await client.query("COMMIT");
      return (rowCount ?? 0) > 0;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

async function lockTable(
  client: PoolClient,
  locationId: string,
  tableId: string,
): Promise<{ id: string; locationId: string }> {
  const { rows } = await client.query<{ id: string; location_id: string; is_active: boolean }>(
    "SELECT id, location_id, is_active FROM dining_tables WHERE id = $1 AND location_id = $2 FOR UPDATE",
    [tableId, locationId],
  );
  const row = rows[0];
  if (!row) throw new TableQrError("table_not_found", 404);
  if (!row.is_active) throw new TableQrError("table_not_found", 404);
  return { id: row.id, locationId: row.location_id };
}

/**
 * The raw token, for the print/download route only.
 *
 * Deliberately not exported through any JSON response: the route turns this
 * into a PNG or SVG immediately. A stored ciphertext that cannot be decrypted
 * (key rotated) is reported as `token_unreadable` so staff rotate and reprint
 * rather than keep handing out a QR that no longer resolves.
 */
export async function tableQrPrintPayload(input: {
  businessId: string;
  locationId: string;
  tableId: string;
}): Promise<{ token: string; link: TableQrLink | null; prefix: string } | null> {
  return withTenant(input.businessId, async () => {
    const row = await activeToken(null, input.locationId, input.tableId);
    if (!row) return null;
    const token = decryptTokenOrNull(row);
    if (!token) throw new TableQrError("token_unreadable", 409);
    return {
      token,
      link: await linkFor(input.businessId, token),
      prefix: row.token_prefix,
    };
  });
}

// ---------------------------------------------------------------------------
// Public resolution
// ---------------------------------------------------------------------------

interface ResolvedTokenRow {
  [key: string]: unknown;
  id: string;
  business_id: string;
  location_id: string;
  table_id: string;
  status: "active" | "rotated" | "revoked";
}

/**
 * Resolve a scanned token to one table, or say why it no longer works.
 *
 * The token hash lookup is the one unscoped read (`withoutTenantScope`,
 * documented in db.ts as `table-qr-resolution`): the token is *how* the tenant
 * is selected, exactly like a CMS site id or an API key, so there is nothing
 * to scope to until it returns. It reads ONE row from ONE table and names no
 * request-supplied business id; every later statement runs under
 * `withTenant(row.business_id)`.
 *
 * `siteId` is the CMS site the caller is asking on behalf of. When present it
 * must match the token's business connection, so a token photographed at one
 * site cannot be submitted to another tenant's checkout.
 */
export async function resolveTableQrToken(
  rawToken: unknown,
  options: { siteId?: string | null } = {},
): Promise<PublicTableQrResolution | TableQrRejection> {
  const token = normalizeTableQrToken(rawToken);
  if (!token) return tableQrRejection("invalid_token");

  const row = await withoutTenantScope("table-qr-resolution", async () => {
    const { rows } = await query<ResolvedTokenRow>(
      `SELECT id, business_id, location_id, table_id, status
         FROM table_qr_tokens
        WHERE token_hash = $1
        LIMIT 1`,
      [hashTableQrToken(token)],
    );
    return rows[0] ?? null;
  });
  if (!row) return tableQrRejection("unknown_token");
  if (row.status === "rotated") return tableQrRejection("token_rotated");
  if (row.status === "revoked") return tableQrRejection("token_revoked");

  return withTenant(row.business_id, async () => {
    const { rows } = await query<{
      table_name: string;
      capacity: number;
      table_status: string;
      table_active: boolean;
      location_name: string;
      location_active: boolean;
      business_status: string;
    }>(
      `SELECT t.name AS table_name, t.capacity, t.status::text AS table_status,
              t.is_active AS table_active,
              l.name AS location_name, l.is_active AS location_active,
              b.status::text AS business_status
         FROM dining_tables t
         JOIN locations l ON l.id = t.location_id
         JOIN businesses b ON b.id = l.business_id
        WHERE t.id = $1 AND t.location_id = $2 AND l.business_id = $3`,
      [row.table_id, row.location_id, row.business_id],
    );
    const table = rows[0];
    // The table was hard-deleted between the token read and this one; the
    // token is gone with it a moment later. Answer as unknown, never 500.
    if (!table) return tableQrRejection("unknown_token");
    if (table.business_status !== "active") return tableQrRejection("business_inactive");
    if (!table.location_active) return tableQrRejection("location_inactive");
    if (!table.table_active) return tableQrRejection("table_archived");
    if (!tableStatusAcceptsQrOrders(table.table_status, table.table_active)) {
      return tableQrRejection("table_unavailable");
    }

    // Table service is the dine-in entitlement, not the reservations flag: a
    // café that never takes bookings still serves the tables it printed.
    if (!(await isFeatureEnabled(row.business_id, TABLE_QR_FEATURE))) {
      return tableQrRejection("service_disabled");
    }

    const { rows: connections } = await query<{ site_id: string }>(
      `SELECT site_id FROM eshobe_cms_connections
        WHERE business_id = $1 AND status = 'active'
        ORDER BY created_at, id LIMIT 1`,
      [row.business_id],
    );
    const siteId = connections[0]?.site_id ?? null;
    const requestedSite = (options.siteId ?? "").trim();
    if (requestedSite && requestedSite !== siteId) {
      return tableQrRejection("site_mismatch");
    }

    const open = await query<{ id: string }>(
      `SELECT ts.id
         FROM table_sessions ts
         JOIN table_session_tables tst ON tst.session_id = ts.id
        WHERE ts.location_id = $1 AND tst.table_id = $2
          AND ts.status = 'open' AND tst.released_at IS NULL
        LIMIT 1`,
      [row.location_id, row.table_id],
    );

    return {
      ok: true as const,
      siteId,
      table: { name: table.table_name, capacity: table.capacity },
      location: { name: table.location_name },
      serviceMode: "dine_in" as const,
      sessionOpen: open.rows.length > 0,
    };
  });
}

export interface ResolvedTableQrIntake {
  businessId: string;
  locationId: string;
  tableId: string;
  /** Provenance for `orders.table_qr_token_id`. */
  tokenId: string;
  siteId: string | null;
  tableName: string;
  sessionOpen: boolean;
}

/**
 * The intake seam ESH-146 / ESH-150 call: a token + the verified business (and
 * optionally the CMS site) become real ids, or a refusal with a reason.
 *
 * Never accepts a location/table id from the caller — the token is the only
 * source — so a crafted body cannot point an order at another business's table.
 */
export async function resolveTableQrTokenForOrder(input: {
  token: unknown;
  businessId: string;
  siteId?: string | null;
}): Promise<{ ok: true; resolved: ResolvedTableQrIntake } | TableQrRejection> {
  const token = normalizeTableQrToken(input.token);
  if (!token) return tableQrRejection("invalid_token");

  const row = await withTenant(input.businessId, async () => {
    const { rows } = await query<ResolvedTokenRow>(
      `SELECT id, business_id, location_id, table_id, status
         FROM table_qr_tokens
        WHERE token_hash = $1 AND business_id = $2
        LIMIT 1`,
      [hashTableQrToken(token), input.businessId],
    );
    return rows[0] ?? null;
  });
  // Unknown here includes "belongs to another business": a token is never a
  // way to write into a tenant its owner did not print for.
  if (!row) return tableQrRejection("unknown_token");
  if (row.status === "rotated") return tableQrRejection("token_rotated");
  if (row.status === "revoked") return tableQrRejection("token_revoked");

  const resolved = await resolveTableQrToken(token, { siteId: input.siteId });
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    resolved: {
      businessId: row.business_id,
      locationId: row.location_id,
      tableId: row.table_id,
      tokenId: row.id,
      siteId: resolved.siteId,
      tableName: resolved.table.name,
      sessionOpen: resolved.sessionOpen,
    },
  };
}

export interface TableQrOrderInput {
  /** The scanned/stored token. The only source of location and table. */
  token: unknown;
  /** Verified from the signed CMS connection (or the authenticated tenant). */
  businessId: string;
  siteId?: string | null;
  items: CartItemInput[];
  discount?: DiscountInput;
  customerId?: string | null;
  guestCount?: number | null;
  note?: string | null;
  openedBy?: string | null;
  clientRequestId?: string | null;
  /**
   * Present only so a caller that echoes a `tableId` can be told it is
   * ignored. It is never forwarded to `createOrder()`.
   */
  ignoredTableId?: string | null;
}

/**
 * Create the dine-in order a QR describes, through the shared mutation.
 *
 * Everything the ticket asks for lands here rather than in a second order
 * writer: `createOrder()` validates the table, joins or opens the visit session
 * (`ensureSessionForTable`), prices the lines, snapshots stock and enqueues the
 * existing outbox/kitchen paths. This function's whole job is to resolve the
 * token first and to pass ids the customer could not choose.
 */
export async function createDineInOrderFromTableQr(
  input: TableQrOrderInput,
): Promise<
  | { ok: true; order: CreateOrderOutput; resolved: ResolvedTableQrIntake }
  | TableQrRejection
  | { ok: false; error: string; status: number; details?: unknown }
> {
  const resolved = await resolveTableQrTokenForOrder({
    token: input.token,
    businessId: input.businessId,
    siteId: input.siteId ?? null,
  });
  if (!resolved.ok) return resolved;

  const order: CreateOrderInput = {
    locationId: resolved.resolved.locationId,
    type: "dine_in",
    // From the token, never from the body. `ignoredTableId` is intentionally
    // dropped here; the acceptance criterion is that a customer cannot choose
    // a table, not that a mismatched id is honoured.
    tableId: resolved.resolved.tableId,
    tableQrTokenId: resolved.resolved.tokenId,
    customerId: input.customerId ?? null,
    guestCount: input.guestCount ?? null,
    note: input.note ?? null,
    discount: input.discount ?? { type: null, value: 0 },
    items: input.items,
    openedBy: input.openedBy ?? null,
    clientRequestId: input.clientRequestId ?? null,
  };

  const result = await createOrder(order);
  if (!result.ok) return result;
  return { ok: true, order: result.data, resolved: resolved.resolved };
}
