/**
 * Issue #894 Wave 1 — the database half of the Torob foundation.
 *
 * `eligibility.ts` decides *which* managed website may become a Torob shop; this
 * file reads the two website registries to feed it, and writes the two things
 * only this feature owns: the shop row and its credential.
 *
 * The rules it keeps, each of which is a way a channel integration goes wrong:
 *
 *   1. **A connection id from a request is a claim, not a fact.** Every write
 *      re-reads the website from the caller's own registry under the tenant
 *      scope and refuses unless the row is there, active, and catalogue-capable.
 *      That single rule is what makes "unmanaged URLs cannot register" true even
 *      though the table stores a *soft* reference to two different registries.
 *   2. **Connecting is idempotent.** The unique key is
 *      `(business_id, website_kind, source_connection_id)`, so a double-click, a
 *      retried request or a second tab cannot mint a second shop — and, in Wave 2,
 *      cannot register a second shop with Torob.
 *   3. **A credential is written once and read never.** The merchant's token is
 *      encrypted at rest; the read paths return a hint and nothing else, and
 *      revocation deletes the ciphertext rather than leaving a secret in a row
 *      whose state says nobody uses it.
 *   4. **Disconnecting is a switch, not a delete.** Turning the channel off, or
 *      revoking authorization, never removes the row: the Torob shop keeps
 *      existing on their side, and the issue is explicit that recovery must be
 *      idempotent and must not secretly delete a merchant's registration.
 *
 * Everything runs inside the caller's tenant scope; the tables carry FORCE RLS.
 */
import { query } from "../db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../integrations/secrets";
import {
  normaliseHost,
  resolveTorobWebsites,
  enrollable,
  type ExistingTorobShop,
  type ManagedWebsiteCandidate,
  type TorobWebsiteKind,
  type TorobWebsiteRow,
} from "./eligibility";

export type TorobShopState = "not_authorized" | "pending_approval" | "authorized" | "revoked";
export type TorobAuthMode = "partner" | "manual_token";

export interface TorobShop {
  id: string;
  businessId: string;
  kind: TorobWebsiteKind;
  connectionId: string;
  domain: string;
  authorizationState: TorobShopState;
  authMode: TorobAuthMode;
  /** Last four characters of the merchant's token, or null. Never the token. */
  tokenHint: string | null;
  providerShopId: string | null;
  publicationRule: "all" | "selected";
  enabled: boolean;
  health: "unknown" | "healthy" | "attention";
  healthReason: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

export class TorobShopError extends Error {
  constructor(
    public code:
      | "website_not_found"
      | "website_inactive"
      | "catalogue_unavailable"
      | "shop_exists"
      | "shop_not_found"
      | "not_authorizable"
      | "token_required"
      | "token_invalid",
  ) {
    super(code);
    this.name = "TorobShopError";
  }
}

const SELECT_COLUMNS = `id, business_id, website_kind, source_connection_id, domain,
            authorization_state, auth_mode, token_hint, provider_shop_id,
            publication_rule, enabled, health, health_reason, last_checked_at, created_at`;

function toShop(row: Record<string, unknown>): TorobShop {
  const iso = (value: unknown) =>
    value instanceof Date ? value.toISOString() : value ? new Date(String(value)).toISOString() : null;
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    kind: row.website_kind as TorobWebsiteKind,
    connectionId: String(row.source_connection_id),
    domain: String(row.domain),
    authorizationState: row.authorization_state as TorobShopState,
    authMode: row.auth_mode as TorobAuthMode,
    tokenHint: (row.token_hint as string | null) ?? null,
    providerShopId: (row.provider_shop_id as string | null) ?? null,
    publicationRule: row.publication_rule as "all" | "selected",
    enabled: Boolean(row.enabled),
    health: row.health as TorobShop["health"],
    healthReason: (row.health_reason as string | null) ?? null,
    lastCheckedAt: iso(row.last_checked_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * The websites this business could publish to Torob, from the platform's own
 * registries — never from anything the client sent.
 *
 * Both reads are tenant-scoped. The WordPress half reads
 * `integration_connections` (the row `connections-service` owns) and the CMS half
 * `eshobe_cms_connections`; neither is filtered to "Torob-ready" here, because
 * the *reason* a site cannot enroll is what the screen has to show.
 */
export async function listManagedWebsites(businessId: string): Promise<ManagedWebsiteCandidate[]> {
  const { rows: wooRows } = await query<{
    id: string;
    name: string;
    base_url: string;
    status: string;
    sync_products: boolean;
    deleted_at: Date | null;
    last_error: string | null;
  }>(
    `SELECT id, name, base_url, status, sync_products, deleted_at, last_error
       FROM integration_connections
      WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL
      ORDER BY created_at`,
    [businessId],
  );

  const { rows: cmsRows } = await query<{
    id: string;
    site_domain: string;
    base_url: string;
    status: string;
    last_error: string | null;
  }>(
    `SELECT id, site_domain, base_url, status, last_error
       FROM eshobe_cms_connections
      WHERE business_id = $1
      ORDER BY created_at`,
    [businessId],
  );

  const websites: ManagedWebsiteCandidate[] = [];

  for (const row of wooRows) {
    const domain = normaliseHost(row.base_url);
    // A connection whose address cannot be resolved to a public host is not a
    // website Torob can reach, so it is not offered at all rather than offered
    // and refused later.
    if (!domain) continue;
    const active = row.status === "active";
    websites.push({
      kind: "woocommerce",
      connectionId: row.id,
      domain,
      label: row.name,
      connection: {
        active,
        // Wave 1's reading of "can serve a catalogue": the site is active and its
        // product sync is switched on. Wave 2's feed is the real proof, and a
        // failing feed will move the site to `needs_attention` from there.
        catalogueReady: active && row.sync_products,
        disabledReason: active
          ? row.sync_products
            ? null
            : "product_sync_disabled"
          : (row.last_error ?? `connection_${row.status}`),
      },
    });
  }

  for (const row of cmsRows) {
    const domain = normaliseHost(row.site_domain);
    if (!domain) continue;
    const active = row.status === "active";
    websites.push({
      kind: "eshobe_cms",
      connectionId: row.id,
      domain,
      label: row.site_domain,
      connection: {
        active,
        catalogueReady: active,
        disabledReason: active ? null : (row.last_error ?? `connection_${row.status}`),
      },
    });
  }

  return websites;
}

/** The shops this business already has, as the eligibility resolver wants them. */
export async function listShops(businessId: string): Promise<TorobShop[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM torob_shops WHERE business_id = $1 ORDER BY created_at`,
    [businessId],
  );
  return rows.map(toShop);
}

/**
 * The Growth screen's one read: every managed website with its Torob state.
 *
 * Sites and shops are read separately and joined here rather than in SQL, because
 * the two sides live in different registries and a join would hard-code the soft
 * reference into a query that could then drift from `eligibility.ts`.
 */
export async function torobWebsiteOverview(businessId: string): Promise<TorobWebsiteRow[]> {
  const [websites, shops] = await Promise.all([listManagedWebsites(businessId), listShops(businessId)]);
  const existing: ExistingTorobShop[] = shops.map((shop) => ({
    id: shop.id,
    kind: shop.kind,
    connectionId: shop.connectionId,
    domain: shop.domain,
    authorizationState: shop.authorizationState,
    enabled: shop.enabled,
  }));
  return resolveTorobWebsites({ websites, shops: existing });
}

/** Re-read one website from the tenant's own registry, or refuse. */
async function requireWebsite(businessId: string, kind: TorobWebsiteKind, connectionId: string) {
  const websites = await listManagedWebsites(businessId);
  const website = websites.find((candidate) => candidate.kind === kind && candidate.connectionId === connectionId);
  if (!website) throw new TorobShopError("website_not_found");
  if (!website.connection.active) throw new TorobShopError("website_inactive");
  if (!website.connection.catalogueReady) throw new TorobShopError("catalogue_unavailable");
  return website;
}

/**
 * Create (or return) the shop for one managed website.
 *
 * Partner mode is the default: the row exists in `not_authorized` and the
 * merchant is sent to Torob's Shop Generator approval, which Wave 3 completes.
 * Manual-token mode is Torob's documented fallback and authorizes immediately,
 * because a merchant who pasted a working token should not be told to wait for an
 * approval that is not part of that flow.
 */
export async function connectTorobShop(input: {
  businessId: string;
  kind: TorobWebsiteKind;
  connectionId: string;
  authMode?: TorobAuthMode;
  manualToken?: string | null;
  publicationRule?: "all" | "selected";
  createdBy?: string | null;
}): Promise<{ shop: TorobShop; created: boolean }> {
  const website = await requireWebsite(input.businessId, input.kind, input.connectionId);
  const mode: TorobAuthMode = input.authMode ?? "partner";
  const token = (input.manualToken ?? "").trim();

  if (mode === "manual_token" && !token) throw new TorobShopError("token_required");
  if (token && !isPlausibleTorobToken(token)) throw new TorobShopError("token_invalid");

  const { rows: existing } = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM torob_shops
      WHERE business_id = $1 AND website_kind = $2 AND source_connection_id = $3`,
    [input.businessId, input.kind, input.connectionId],
  );
  if (existing[0]) {
    // Idempotent: the same website asked twice is the same shop. A token offered
    // for an existing row is still applied, because "reconnect with my own token"
    // is the documented recovery from a revoked authorization.
    if (mode === "manual_token" && token) {
      return { shop: await authorizeTorobShopWithToken({ businessId: input.businessId, shopId: String(existing[0].id), token }), created: false };
    }
    return { shop: toShop(existing[0]), created: false };
  }

  const key = resolveEncryptionKey(process.env);
  const ciphertext = mode === "manual_token" ? encryptSecret(token, key) : null;
  const hint = mode === "manual_token" ? token.slice(-4) : null;

  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO torob_shops
       (business_id, website_kind, source_connection_id, domain, authorization_state,
        auth_mode, token_ciphertext, token_hint, publication_rule, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (business_id, website_kind, source_connection_id) DO NOTHING
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.businessId,
      input.kind,
      input.connectionId,
      website.domain,
      // A manual token that got this far is a token Torob will be asked to accept
      // on the first call; until then the shop is authorized *locally*, which is
      // exactly what the state means. Wave 2's first refresh is what can prove it.
      mode === "manual_token" ? "authorized" : "not_authorized",
      mode,
      ciphertext,
      hint,
      input.publicationRule ?? "all",
      input.createdBy ?? null,
    ],
  );

  if (rows[0]) return { shop: toShop(rows[0]), created: true };

  // Lost a race with another request in the same millisecond: read the winner.
  const { rows: winner } = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM torob_shops
      WHERE business_id = $1 AND website_kind = $2 AND source_connection_id = $3`,
    [input.businessId, input.kind, input.connectionId],
  );
  if (!winner[0]) throw new TorobShopError("shop_not_found");
  return { shop: toShop(winner[0]), created: false };
}

/**
 * Apply the merchant's own Shop API token to a shop.
 *
 * Used both for the first authorization and for recovery after a revocation. The
 * token is validated for *shape* only — Torob is the authority on whether it
 * works, and claiming otherwise here would be the fabricated success the issue
 * warns about.
 */
export async function authorizeTorobShopWithToken(input: {
  businessId: string;
  shopId: string;
  token: string;
}): Promise<TorobShop> {
  const token = input.token.trim();
  if (!token) throw new TorobShopError("token_required");
  if (!isPlausibleTorobToken(token)) throw new TorobShopError("token_invalid");

  const key = resolveEncryptionKey(process.env);
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE torob_shops
        SET auth_mode = 'manual_token',
            authorization_state = 'authorized',
            token_ciphertext = $3,
            token_hint = $4,
            updated_at = now()
      WHERE id = $1 AND business_id = $2
      RETURNING ${SELECT_COLUMNS}`,
    [input.shopId, input.businessId, encryptSecret(token, key), token.slice(-4)],
  );
  if (!rows[0]) throw new TorobShopError("shop_not_found");
  return toShop(rows[0]);
}

/**
 * Record that a partner authorization is waiting on Torob's approval.
 *
 * The row is deliberately not "authorized" until the callback arrives: the issue
 * is explicit that an accepted request is not an approved shop, and a state that
 * lies here is what makes a merchant chase a feed that was never authorized.
 */
export async function markTorobShopPendingApproval(input: {
  businessId: string;
  shopId: string;
}): Promise<TorobShop> {
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE torob_shops
        SET authorization_state = 'pending_approval',
            auth_mode = 'partner',
            token_ciphertext = NULL,
            token_hint = NULL,
            updated_at = now()
      WHERE id = $1 AND business_id = $2 AND authorization_state <> 'authorized'
      RETURNING ${SELECT_COLUMNS}`,
    [input.shopId, input.businessId],
  );
  if (!rows[0]) throw new TorobShopError("not_authorizable");
  return toShop(rows[0]);
}

/**
 * Revoke the authorization and drop the credential.
 *
 * The row survives — Torob's shop still exists and the merchant may come back —
 * but nothing in the platform can use it until they reconnect. `enabled` goes off
 * with it: running managed background operations for a shop whose credential we
 * just deleted is the failure this function exists to prevent.
 */
export async function revokeTorobShop(input: { businessId: string; shopId: string }): Promise<TorobShop> {
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE torob_shops
        SET authorization_state = 'revoked',
            token_ciphertext = NULL,
            token_hint = NULL,
            enabled = false,
            updated_at = now()
      WHERE id = $1 AND business_id = $2
      RETURNING ${SELECT_COLUMNS}`,
    [input.shopId, input.businessId],
  );
  if (!rows[0]) throw new TorobShopError("shop_not_found");
  return toShop(rows[0]);
}

/**
 * The channel switch.
 *
 * Refuses to enable a shop that is not authorized: an "on" channel with no
 * credential is a queue that fills and never drains, and the merchant would see a
 * healthy screen over a feed that cannot work.
 */
export async function setTorobShopEnabled(input: {
  businessId: string;
  shopId: string;
  enabled: boolean;
}): Promise<TorobShop> {
  const { rows: current } = await query<{ authorization_state: string }>(
    `SELECT authorization_state FROM torob_shops WHERE id = $1 AND business_id = $2`,
    [input.shopId, input.businessId],
  );
  if (!current[0]) throw new TorobShopError("shop_not_found");
  if (input.enabled && current[0].authorization_state !== "authorized") {
    throw new TorobShopError("not_authorizable");
  }

  const { rows } = await query<Record<string, unknown>>(
    `UPDATE torob_shops SET enabled = $3, updated_at = now()
      WHERE id = $1 AND business_id = $2
      RETURNING ${SELECT_COLUMNS}`,
    [input.shopId, input.businessId, input.enabled],
  );
  return toShop(rows[0]!);
}

/**
 * The merchant's token, decrypted — the only function that ever returns it.
 *
 * Deliberately narrow: Wave 2's client calls this at the moment it needs to sign a
 * request, and every caller is server-side. Nothing in the API layer may call it
 * for a read.
 */
export async function readTorobShopToken(input: {
  businessId: string;
  shopId: string;
}): Promise<{ token: string; providerShopId: string | null } | null> {
  const { rows } = await query<{ token_ciphertext: string | null; provider_shop_id: string | null }>(
    `SELECT token_ciphertext, provider_shop_id FROM torob_shops
      WHERE id = $1 AND business_id = $2 AND authorization_state = 'authorized'`,
    [input.shopId, input.businessId],
  );
  const row = rows[0];
  if (!row?.token_ciphertext) {
    return row ? { token: "", providerShopId: row.provider_shop_id } : null;
  }
  try {
    return {
      token: decryptSecret(row.token_ciphertext, resolveEncryptionKey(process.env)),
      providerShopId: row.provider_shop_id,
    };
  } catch {
    // Fail closed: a ciphertext this deployment cannot read is not a token, and
    // guessing would send an unauthenticated request to Torob under our name.
    return null;
  }
}

/**
 * What a Shop API token may look like, as a sanity check — never a judgement.
 *
 * Torob's documented merchant tokens are opaque strings; this only rejects the
 * things that are certainly not one (a pasted URL, a blank, a 3-word sentence).
 * A stricter rule here would refuse a legitimate token the day Torob changes its
 * format, and the real check is Torob's own 401.
 */
export function isPlausibleTorobToken(token: string): boolean {
  const value = token.trim();
  if (value.length < 16 || value.length > 2048) return false;
  if (/\s/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  return /^[A-Za-z0-9._~+/=-]+$/.test(value);
}

/** The shops a merchant may currently publish from — Wave 2's input. */
export async function enabledTorobShops(businessId: string): Promise<TorobShop[]> {
  const shops = await listShops(businessId);
  return shops.filter((shop) => shop.enabled && shop.authorizationState === "authorized");
}

/** Re-exported so the route can answer "what is enrollable" without re-deriving it. */
export { enrollable };
