/**
 * ESH-147 (#1305) — table QR identity, pure half.
 *
 * A printed table QR carries one opaque token. It is not the table's uuid, it
 * is not derivable from it, and it can be rotated without touching the table.
 * Everything here is framework- and DB-free so the route, the service and the
 * tests share one definition of "a valid token" — the same split as
 * `rate-limit.ts` and `table-sessions.ts`.
 *
 * The token is a bearer value in the weak sense that matters: it is printed on
 * a table in public, so it never authenticates a person. It names a physical
 * table the way a table number does. What it must be is *unguessable* (so an
 * attacker cannot enumerate other businesses' tables from the public resolve
 * endpoint) and *rotatable* (so a lost or photographed print can be replaced).
 * 192 bits of randomness is far beyond enumeration; the lookup is by SHA-256
 * hash, so the raw value is never compared — or stored — in the database.
 */
import { createHash, randomBytes } from "node:crypto";

/** Marks the value as a table QR token rather than an arbitrary opaque string. */
export const TABLE_QR_TOKEN_PREFIX = "tqr_";

/** 24 bytes = 192 bits, base64url = 32 characters. */
const TOKEN_BYTES = 24;
const TOKEN_BODY_LENGTH = 32;

const TOKEN_PATTERN = new RegExp(`^tqr_[A-Za-z0-9_-]{${TOKEN_BODY_LENGTH}}$`);

/** A fresh token. Only the hash is persisted for lookup; the value is encrypted for re-printing. */
export function generateTableQrToken(): string {
  return `${TABLE_QR_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/**
 * The canonical token, or null when the value is not one.
 *
 * Accepts a bare token as well as a URL that carries it in `tableToken` /
 * `t` — the CMS hands back whatever the customer's page had, and normalising
 * here keeps every caller from re-inventing the parsing. Case is significant
 * (base64url), so nothing is lower-cased.
 */
export function normalizeTableQrToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (TOKEN_PATTERN.test(value)) return value;
  // A QR payload may be a URL. Extract only a well-formed token, never echo
  // the input back, so a malformed value cannot smuggle anything downstream.
  const candidate = extractTokenFromUrl(value);
  return candidate && TOKEN_PATTERN.test(candidate) ? candidate : null;
}

function extractTokenFromUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const fromQuery = url.searchParams.get("tableToken") ?? url.searchParams.get("t");
    if (fromQuery) return fromQuery.trim();
    // `/t/<token>` style paths are accepted too, but only when the last
    // segment is the whole value after the marker.
    const marker = "/t/";
    const index = url.pathname.lastIndexOf(marker);
    if (index >= 0) return url.pathname.slice(index + marker.length);
    return null;
  } catch {
    return null;
  }
}

/** SHA-256 hex — the database lookup key. Deterministic, so no salt can be per-row. */
export function hashTableQrToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The short, non-secret label staff see: `tqr_` plus the first six characters.
 * Enough to distinguish two prints; not enough to reconstruct the token.
 */
export function tableQrTokenPrefix(token: string): string {
  const normalized = normalizeTableQrToken(token);
  if (!normalized) throw new Error("invalid_table_qr_token");
  return normalized.slice(0, TABLE_QR_TOKEN_PREFIX.length + 6);
}

/** Where the café menu lives on the connected site (ESH-149). Overridable per deployment. */
export const TABLE_QR_MENU_PATH = "/menu";

export interface TableQrLink {
  /** What the QR image encodes: the site's menu URL plus the token. */
  url: string;
  /** The token on its own, for the CMS's `order.submitted` payload. */
  token: string;
}

/**
 * Build the printed link. The token is the only identifier in it — the site
 * origin comes from the connection, never from a request body, and no
 * business/location/table uuid is ever placed in the QR.
 */
export function tableQrLink(input: {
  token: string;
  siteDomain: string | null;
  menuPath?: string | null;
}): TableQrLink | null {
  const token = normalizeTableQrToken(input.token);
  if (!token) return null;
  const host = sanitizeHost(input.siteDomain);
  if (!host) return null;
  const path = sanitizeMenuPath(input.menuPath ?? TABLE_QR_MENU_PATH);
  return { url: `https://${host}${path}?tableToken=${token}`, token };
}

function sanitizeHost(value: string | null | undefined): string | null {
  const host = (value ?? "").trim().toLowerCase();
  if (!host || host.length > 255) return null;
  if (!/^[a-z0-9.-]+(:\d{2,5})?$/.test(host)) return null;
  return host;
}

function sanitizeMenuPath(value: string): string {
  const path = value.trim();
  if (!path.startsWith("/") || path.length > 200 || path.includes("..")) return TABLE_QR_MENU_PATH;
  return path;
}

// ---------------------------------------------------------------------------
// Resolution outcomes
// ---------------------------------------------------------------------------

/**
 * Why a scan or an order was refused. Deliberately coarse on the public
 * endpoint (rotated/revoked/unknown are all "this print is no longer valid")
 * while the staff-facing and intake paths get the precise reason so the inbox
 * can say what to do about it.
 */
export type TableQrRejectionReason =
  | "invalid_token"
  | "unknown_token"
  | "token_rotated"
  | "token_revoked"
  | "table_archived"
  | "table_unavailable"
  | "location_inactive"
  | "business_inactive"
  | "site_mismatch"
  | "service_disabled";

export interface TableQrRejection {
  ok: false;
  reason: TableQrRejectionReason;
  status: number;
}

/** HTTP status for each refusal: unknown/foreign prints are indistinguishable 404s. */
export const TABLE_QR_REJECTION_STATUS: Record<TableQrRejectionReason, number> = {
  invalid_token: 404,
  unknown_token: 404,
  token_rotated: 410,
  token_revoked: 410,
  table_archived: 410,
  table_unavailable: 409,
  location_inactive: 404,
  business_inactive: 404,
  site_mismatch: 404,
  service_disabled: 403,
};

export function tableQrRejection(reason: TableQrRejectionReason): TableQrRejection {
  return { ok: false, reason, status: TABLE_QR_REJECTION_STATUS[reason] };
}

/** A table can take a QR order unless it is being cleaned, is out of service, or was archived. */
export function tableStatusAcceptsQrOrders(
  status: string,
  isActive: boolean,
): boolean {
  if (!isActive) return false;
  return status !== "cleaning" && status !== "out_of_service";
}

/**
 * What the public resolve endpoint may say about a table.
 *
 * No uuids, no ids at all beyond the CMS `siteId` the caller already knows —
 * the point of the endpoint is to let the CMS confirm the print belongs to
 * this site and show the table's name, not to hand out the tenant's keys.
 */
export interface PublicTableQrResolution {
  ok: true;
  /** The CMS site the token's business is connected to, so the caller can verify it asked the right tenant. */
  siteId: string | null;
  table: { name: string; capacity: number };
  location: { name: string };
  serviceMode: "dine_in";
  /** True when a visit is already open, so the next order joins it. */
  sessionOpen: boolean;
}
