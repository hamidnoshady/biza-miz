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
