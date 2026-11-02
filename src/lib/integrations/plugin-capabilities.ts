/**
 * Capability negotiation with the WordPress plugin.
 *
 * The handshake (plugin-service.ts) stores the capability set the plugin
 * reported in `integration_connections.plugin_capabilities`; these helpers
 * are the one place that reads it back. Kept in their own module — not
 * plugin-link.ts — because that file needs `node:crypto` and this rule is
 * also what the manager's client components use to decide which operations
 * to offer at all (a store whose plugin cannot apply `media_create` must
 * never be shown a button that claims it can).
 */

/**
 * What a plugin that predates capability reporting can apply. A connection
 * whose handshake never advertised `jobTypes` is offered exactly this set —
 * sending it a newer operation would strand the job: the lease query filters
 * by supported type, so the row would sit `pending` forever with nothing
 * ever picking it up.
 */
export const LEGACY_PLUGIN_JOB_TYPES = [
  "stock",
  "price",
  "catalogue_export",
  "customer_export",
  "orders_export",
] as const;

/**
 * The job types a connection's plugin actually understands, from the
 * capability set its last handshake reported. Pure — the capabilities blob
 * is `integration_connections.plugin_capabilities` as stored — so the rule
 * ("advertised list wins, legacy fallback otherwise, junk is ignored") is
 * unit-testable and shareable with the browser.
 */
export function pluginAdvertisedJobTypes(capabilities: Record<string, unknown> | null | undefined): string[] {
  const raw = capabilities?.jobTypes;
  const advertised = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
  return advertised.length > 0 ? advertised : [...LEGACY_PLUGIN_JOB_TYPES];
}

/**
 * Whether this connection's plugin can apply one specific operation. The
 * gate every producer of a plugin-only outbox row must pass before
 * enqueueing — a job the plugin never leases is worse than an honest
 * "update the plugin first" answer.
 */
export function pluginSupportsJobType(
  capabilities: Record<string, unknown> | null | undefined,
  jobType: string,
): boolean {
  return pluginAdvertisedJobTypes(capabilities).includes(jobType);
}

/** The protocol version that introduced per-lease ack tokens (issue #942, F01). */
export const LEASE_TOKEN_PROTOCOL_VERSION = 3;

/**
 * Whether this connection's plugin echoes the lease token it was handed when
 * it acks a job. Protocol ≥ 3 plugins get a fresh `lease_token` on every
 * pull, and their acks are fenced on it — a worker whose lease expired
 * cannot ack a newer attempt. Older plugins never see a token (their leases
 * store NULL) and keep the status-guarded legacy ack, so deploying the
 * fencing cannot strand a store that has not updated its plugin yet.
 */
export function pluginSupportsLeaseToken(
  capabilities: Record<string, unknown> | null | undefined,
): boolean {
  const version = capabilities?.protocolVersion;
  return typeof version === "number" && version >= LEASE_TOKEN_PROTOCOL_VERSION;
}

/**
 * A WooCommerce order status as the *store* names it.
 *
 * `slug` is the registered key with WooCommerce's `wc-` prefix stripped (the
 * app's canonical spelling: `processing`, `shipped`, …); `label` is the
 * display name the owner sees in WooCommerce — the store's own words for a
 * custom status, not a prettified slug the dashboard guessed.
 */
export interface RegisteredOrderStatus {
  slug: string;
  label: string;
}

/** What a WooCommerce status slug may look like once `wc-` is stripped. */
const ORDER_STATUS_SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A cap on registry size — a store with dozens of statuses is unusual, hundreds is a broken payload. */
const MAX_REGISTERED_STATUSES = 60;

/**
 * The store's registered order-status registry, from the capability set its
 * plugin reported (`wc_get_order_statuses()` on the WordPress side).
 *
 * Issue #1215 / P1‑3. Before this the dashboard had only its own seven Persian
 * labels plus a slug made readable, so a store's custom status («ارسال شد»)
 * appeared as `shipped` and a status it had registered but never used could
 * not be chosen at all. The plugin is the only truthful source of the display
 * names, so a store whose plugin predates reporting simply returns `[]` — the
 * screen then shows the canonical labels and a clearly marked raw slug, never a
 * made-up name.
 *
 * Both the handshake sanitizer (server) and the manager (browser) read the
 * registry through this one function, so what is stored and what is displayed
 * cannot drift. Junk is dropped, not trusted: slugs are normalized and pattern
 * checked, labels are trimmed and bounded, duplicates keep their first entry.
 */
export function registeredOrderStatuses(
  capabilities: Record<string, unknown> | null | undefined,
): RegisteredOrderStatus[] {
  const raw = capabilities?.orderStatuses;
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? // Tolerate the associative shape (`{ processing: "در حال پردازش" }`) an
        // older or hand-built payload may send.
        Object.entries(raw as Record<string, unknown>).map(([slug, label]) => ({ slug, label }))
      : [];

  const seen = new Set<string>();
  const out: RegisteredOrderStatus[] = [];
  for (const entry of entries) {
    if (out.length >= MAX_REGISTERED_STATUSES) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const slug = normalizeOrderStatusSlug(record.slug);
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 80) : "";
    if (!slug || !label || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, label });
  }
  return out;
}

/**
 * `wc-processing` →  `processing`. WooCommerce hands the dashboard both forms
 * (its REST payloads use `processing`, `wc_get_order_statuses()` keys use
 * `wc-processing`), so every comparison in this app normalizes the same way.
 */
export function normalizeOrderStatusSlug(value: unknown): string {
  if (typeof value !== "string") return "";
  const slug = value.trim().toLowerCase().replace(/^wc-/, "");
  return ORDER_STATUS_SLUG.test(slug) ? slug : "";
}
