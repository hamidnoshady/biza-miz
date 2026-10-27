/**
 * The app's half of the WordPress plugin link: authenticating the plugin,
 * accepting the events it pushes, and handing it the work it should apply.
 *
 * DB-touching, so no direct unit test per repo convention — the envelope
 * verification it rests on is pure and covered by `plugin-link.test.ts`, and
 * everything an event does downstream is the *same* code the REST/webhook path
 * already runs (`webhook-ingest-service.ts`). That reuse is the point: a store
 * connected by plugin and a store connected by consumer keys produce
 * byte-identical orders, payments and journal entries, because there is one
 * ingest path and this is only a second door into it.
 *
 * ## Direction of travel
 *
 * REST mode: the app calls the store (outbound), the store calls the app
 * (webhooks, inbound). Both directions need the store to be reachable from the
 * internet and the app to hold the store's master credentials.
 *
 * Plugin mode: the plugin calls the app, always — pushing events it saw, and
 * pulling jobs to apply. The app never dials out. A store behind a firewall,
 * on a host that blocks incoming webhooks, or with no fixed address works
 * unchanged, and the only credential in this database is a token that grants
 * exactly this.
 */
import { NextResponse } from "next/server";
import { query, withoutTenantScope, withTenant } from "../db";
import { isFeatureEnabled } from "../features";
import { writeIntegrationAudit } from "./audit";
import {
  CONNECTION_COLUMNS,
  linkTokenFor,
  type ConnectionRow,
} from "./connections-service";
import {
  PLUGIN_NONCE_HEADER,
  PLUGIN_SIGNATURE_HEADER,
  PLUGIN_TIMESTAMP_HEADER,
  PLUGIN_TIMESTAMP_SKEW_MS,
  hashPluginToken,
  verifyPluginEnvelope,
} from "./plugin-link";
import { pluginAdvertisedJobTypes, pluginSupportsJobType, pluginSupportsLeaseToken } from "./plugin-capabilities";
import { assertPluginJobSupported } from "./plugin-job-guard";
import { ingestPluginEvent, type PluginEventInput } from "./webhook-ingest-service";
import { isValidMediaUuid } from "../media";
import {
  failWordPressMediaSync,
  getMediaConfig,
  isMediaStorageReady,
  readMediaObjectDownloadUrl,
} from "../media-service";
import { acknowledgePushedEvent, claimableOutboxSql } from "./outbox-service";
import { PLUGIN_JOB_MAX_ATTEMPTS } from "./retry";
import { effectivePushSwitches, isNoopPush, STALE_PUSH_JOB_HOURS, type RemoteProductState } from "./outbox-policy";

/** How many jobs one pull may lease. Bounded so a WP-Cron run finishes inside PHP's time limit. */
const JOB_PULL_LIMIT = 25;
/** How long a leased job stays invisible to a second concurrent pull. */
const JOB_LEASE_MS = 5 * 60 * 1000;
/** Cap on one push, so a compromised or looping plugin cannot submit unbounded work in one request. */
const MAX_EVENTS_PER_PUSH = 100;

function supportedPluginJobTypes(connection: ConnectionRow): string[] {
  return pluginAdvertisedJobTypes(connection.plugin_capabilities);
}

/** Sent by the plugin on every signed request (class-pos-client.php). */
const PLUGIN_VERSION_HEADER = "x-pos-plugin";

/** A version string we are willing to store: dotted digits with an optional suffix, never free text. */
export function parsePluginVersionHeader(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  return /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(value) ? value : null;
}

/**
 * Does the site the plugin says it is match the one this connection was bound
 * to? `null` when it does (or when either side has nothing to compare), else
 * the two addresses. Shared by the handshake and the ping so «آزمایش اتصال»
 * reports exactly what the next real handshake would.
 */
export function pluginSiteMismatch(
  connection: Pick<ConnectionRow, "plugin_site_url">,
  reportedSiteUrl: string | null | undefined,
): { expectedSiteUrl: string; reportedSiteUrl: string } | null {
  const stored = normalizeSiteUrl(connection.plugin_site_url);
  const reported = normalizeSiteUrl(reportedSiteUrl);
  if (!stored || !reported || stored === reported) return null;
  return { expectedSiteUrl: connection.plugin_site_url as string, reportedSiteUrl: reportedSiteUrl as string };
}

/**
 * Resolve and verify one inbound plugin request.
 *
 * The token lookup runs inside the documented `woocommerce-plugin-auth`
 * bypass, because resolving a credential to its tenant is exactly what that
 * bypass is for — and the HMAC check runs inside it too, since the token the
 * signature is verified against is what the lookup returns. Everything after
 * authentication runs in the resolved business's own scope.
 *
 * The nonce is recorded *inside* the tenant scope and its insert is what
 * decides replay: `integration_plugin_nonces`' primary key makes a second use
 * of the same nonce a conflict rather than a race between a read and a write.
 */
export async function authenticatePlugin(
  headers: Headers,
  rawBody: string,
): Promise<{ ok: true; connection: ConnectionRow; nonce: string } | { ok: false; error: string; status: number; serverTime?: string }> {
  const authorization = headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  if (!token) return { ok: false, error: "missing_token", status: 401 };

  const connection = await withoutTenantScope("woocommerce-plugin-auth", async () => {
    const { rows } = await query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE link_token_hash = $1 AND deleted_at IS NULL AND provider = 'woocommerce'`,
      [hashPluginToken(token)],
    );
    return rows[0] ?? null;
  });
  // Deliberately the same answer as a bad signature would give: an
  // unauthenticated caller learns whether their credential works, never
  // whether a given token exists but is misconfigured.
  if (!connection || connection.link_mode !== "plugin") {
    return { ok: false, error: "unauthorized", status: 401 };
  }

  // The stored token, decrypted — not the one the caller presented. Verifying
  // the HMAC against the caller's own copy would make the signature prove
  // nothing at all.
  const secret = linkTokenFor(connection);
  if (!secret) return { ok: false, error: "unauthorized", status: 401 };

  const verified = verifyPluginEnvelope(
    secret,
    {
      signature: headers.get(PLUGIN_SIGNATURE_HEADER),
      timestamp: headers.get(PLUGIN_TIMESTAMP_HEADER),
      nonce: headers.get(PLUGIN_NONCE_HEADER),
    },
    rawBody,
    Date.now(),
  );
  if (!verified.ok) {
    // A clock that is out is the one failure the caller can fix, and only if it
    // is told by how much — the plugin's «آزمایش اتصال» prints the skew from
    // this. It reveals nothing a stranger could not read off any HTTP Date header.
    return {
      ok: false,
      error: verified.error,
      status: 401,
      ...(verified.error === "stale_timestamp" ? { serverTime: new Date().toISOString() } : {}),
    };
  }
  const reportedVersion = parsePluginVersionHeader(headers.get(PLUGIN_VERSION_HEADER));

  return withTenant(connection.business_id, async () => {
    if (!(await isFeatureEnabled(connection.business_id, "integrations"))) {
      return { ok: false as const, error: "feature_disabled", status: 403 };
    }

    const { rowCount } = await query(
      `INSERT INTO integration_plugin_nonces (business_id, connection_id, nonce)
       VALUES ($1, $2, $3)
       ON CONFLICT (connection_id, nonce) DO NOTHING`,
      [connection.business_id, connection.id, verified.envelope.nonce],
    );
    if ((rowCount ?? 0) === 0) return { ok: false as const, error: "replayed_nonce", status: 401 };

    // Opportunistic sweep: a nonce older than the freshness window can never
    // authenticate again, so keeping it protects nothing. Cheap because
    // `seen_at` is indexed, and doing it here rather than on a timer means the
    // table is bounded by traffic that actually happens.
    await query(
      `DELETE FROM integration_plugin_nonces
        WHERE connection_id = $1 AND seen_at < now() - ($2 || ' milliseconds')::interval`,
      [connection.id, PLUGIN_TIMESTAMP_SKEW_MS * 2],
    );

    // The version rides on every signed call, so «plugin_version» is what is
    // installed now — not what it was at the last handshake, which a store
    // that upgraded and has not run its cron yet would still be reporting.
    await query(
      `UPDATE integration_connections
          SET last_plugin_seen_at = now(),
              plugin_version = COALESCE($3, plugin_version)
        WHERE id = $1 AND business_id = $2`,
      [connection.id, connection.business_id, reportedVersion],
    );

    return { ok: true as const, connection, nonce: verified.envelope.nonce };
  });
}

/**
 * Everything the plugin needs to configure itself, and everything the app
 * knows about the plugin — exchanged on every handshake so neither side has to
 * be told twice when a setting changes.
 */
export interface PluginHandshakeInput {
  siteUrl?: string;
  pluginVersion?: string;
  protocolVersion?: number;
  capabilities?: {
    eventTypes?: string[];
    jobTypes?: string[];
  };
  telemetry?: Record<string, unknown>;
}

function normalizeSiteUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.trim().replace(/\/+$/, "").toLowerCase() || null;
  }
}

function sanitizeStringArray(value: unknown, limit = 80): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().slice(0, 120))
    .slice(0, limit);
}

/**
 * The plugin's per-event local-queue problem list (issue #942, F12), reduced
 * to a bounded, known shape before it is stored in `plugin_health`: at most
 * ten entries, only the operator-relevant fields, strings capped. The rest of
 * the telemetry is scalars; this is the one unbounded array a heartbeat
 * carries, so it is the one thing that must not be able to bloat the row.
 */
function sanitizeLocalQueueRecent(value: unknown): Array<{
  topic: string;
  remoteId: string;
  status: "pending" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string | null;
}> {
  if (!Array.isArray(value)) return [];
  const out: ReturnType<typeof sanitizeLocalQueueRecent> = [];
  const str = (v: unknown, cap: number) => (typeof v === "string" ? v.slice(0, cap) : "");
  for (const item of value.slice(0, 10)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const topic = str(record.topic, 80);
    if (!topic) continue;
    out.push({
      topic,
      remoteId: str(record.remoteId, 80),
      status: record.status === "failed" ? "failed" : "pending",
      attempts: Number.isFinite(Number(record.attempts)) ? Math.max(0, Math.floor(Number(record.attempts))) : 0,
      lastError: typeof record.lastError === "string" && record.lastError ? record.lastError.slice(0, 240) : null,
      createdAt: typeof record.createdAt === "string" && record.createdAt ? record.createdAt.slice(0, 40) : null,
    });
  }
  return out;
}

function pluginCapabilities(input: PluginHandshakeInput): Record<string, unknown> {
  return {
    protocolVersion: Number.isFinite(input.protocolVersion) ? Math.max(1, Math.floor(input.protocolVersion ?? 1)) : 1,
    eventTypes: sanitizeStringArray(input.capabilities?.eventTypes),
    jobTypes: sanitizeStringArray(input.capabilities?.jobTypes),
  };
}

export async function pluginHandshake(
  connection: ConnectionRow,
  input: PluginHandshakeInput,
): Promise<NextResponse> {
  return withTenant(connection.business_id, async () => {
    const siteUrl = input.siteUrl?.trim().slice(0, 500) || null;
    const version = input.pluginVersion?.trim().slice(0, 40) || null;
    const capabilities = pluginCapabilities(input);
    const telemetry = input.telemetry && typeof input.telemetry === "object" ? { ...input.telemetry } : {};
    // Older plugins omit localQueueRecent entirely; keep it absent (rather
    // than storing an empty list) so the UI can tell "queue is healthy" from
    // "this plugin predates per-event reporting".
    if (Array.isArray(telemetry.localQueueRecent)) {
      telemetry.localQueueRecent = sanitizeLocalQueueRecent(telemetry.localQueueRecent);
    } else {
      delete telemetry.localQueueRecent;
    }
    if (pluginSiteMismatch(connection, siteUrl)) {
      await query(
        `UPDATE integration_connections
            SET pending_plugin_site_url = $3,
                plugin_site_mismatch_at = now(),
                last_error = 'site_mismatch',
                plugin_health = jsonb_build_object('state', 'site_mismatch', 'reportedSiteUrl', $3, 'expectedSiteUrl', plugin_site_url),
                updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [connection.id, connection.business_id, siteUrl],
      );
      await writeIntegrationAudit({
        businessId: connection.business_id,
        connectionId: connection.id,
        action: "plugin.site_mismatch",
        payload: { expected: connection.plugin_site_url, reported: siteUrl },
        error: "site_mismatch",
      });
      return NextResponse.json({ ok: false, error: "site_mismatch", expectedSiteUrl: connection.plugin_site_url, reportedSiteUrl: siteUrl }, { status: 409 });
    }
    // `connection` is the row loaded before authenticatePlugin writes the
    // liveness timestamp, so it is the only reliable first-contact signal.
    // Reading after auth would see the timestamp auth just set and would never
    // queue the initial full exports.
    const firstContact = !connection.last_plugin_seen_at;
    const { rows: handshakeRows } = await query<{ sync_orders: boolean; sync_products: boolean; sync_customers: boolean }>(
      `UPDATE integration_connections
          SET plugin_site_url = COALESCE($3, plugin_site_url),
              plugin_version = COALESCE($4, plugin_version),
              plugin_capabilities = $5::jsonb,
              plugin_health = $6::jsonb,
              pending_plugin_site_url = NULL,
              plugin_site_mismatch_at = NULL,
              status = CASE WHEN status = 'error' THEN 'active' ELSE status END,
              last_error = NULL,
              last_plugin_seen_at = now(),
              updated_at = now()
        WHERE id = $1 AND business_id = $2
        RETURNING sync_orders, sync_products, sync_customers`,
      [
        connection.id,
        connection.business_id,
        siteUrl,
        version,
        JSON.stringify(capabilities),
        JSON.stringify({ ...telemetry, protocolVersion: capabilities.protocolVersion, receivedAt: new Date().toISOString() }),
      ],
    );

    // First-contact bootstrap. The plugin only sends what it observes from
    // this moment on; nothing in the plugin link ever asked it for the
    // *historical* catalogue, customer book or order book on its own. So a
    // store with six hundred customers connected and, three days later, the
    // app held only the ~20 accounts created after connect — the rest arrived
    // by no path at all (the orders sweep covered orders; products had a
    // hourly sweep; customers had neither a sweep nor an initial request).
    // On the very first handshake queue every historical mirror, including
    // WordPress content/media. Each is upserted on a unique key, so a later
    // manual request only refreshes the one outstanding export row.
    if (firstContact) {
      // Only the exports this plugin can actually apply. The lease query
      // filters by supported type, so an export queued past an older
      // plugin's capability set would never be leased — a row sitting
      // «pending» forever on the queue screen with nothing wrong to fix.
      const exports = ["catalogue_export", "customer_export", "orders_export", "content_export"] as const;
      for (const exportType of exports) {
        if (!pluginSupportsJobType(capabilities, exportType)) continue;
        await enqueuePluginExport(connection.business_id, connection.id, exportType);
      }
      await writeIntegrationAudit({
        businessId: connection.business_id,
        connectionId: connection.id,
        action: "plugin.bootstrap_exports_queued",
        payload: {
          products: handshakeRows[0]?.sync_products ?? true,
          customers: handshakeRows[0]?.sync_customers ?? true,
          orders: handshakeRows[0]?.sync_orders ?? true,
          content: true,
        },
      });
    }

    await writeIntegrationAudit({
      businessId: connection.business_id,
      connectionId: connection.id,
      action: "plugin.handshake",
      payload: { siteUrl, version, firstContact },
    });

    return NextResponse.json({
      ok: true,
      connection: {
        id: connection.id,
        name: connection.name,
        currencyUnit: connection.currency_unit,
        // The plugin mirrors these switches so it does not push events the app
        // would only discard, and does not apply jobs the owner turned off.
        syncOrders: connection.sync_orders,
        syncProducts: connection.sync_products,
        syncCustomers: connection.sync_customers,
        // The effective switches: a store that is the source of truth is told
        // not to apply this app's stock and prices, whatever the raw toggles say.
        pushStock: effectivePushSwitches(connection).pushStock,
        pushPrices: effectivePushSwitches(connection).pushPrices,
        sourceOfTruth: connection.source_of_truth ?? "two_way",
        status: connection.status,
        serverMessage: connection.status === "paused" ? "همگام‌سازی از سمت پنل متوقف شده است" : null,
      },
      serverStatus: connection.status === "paused" ? "paused" : "active",
      // Everything time-sensitive about the protocol, so the plugin never has
      // to hardcode a constant this side owns.
      protocol: {
        version: 1,
        timestampSkewMs: PLUGIN_TIMESTAMP_SKEW_MS,
        jobPullLimit: JOB_PULL_LIMIT,
        // Issue #942 (F01/F10): jobs leased to a protocol ≥ 3 plugin carry a
        // `leaseToken` the ack must echo, and a job the plugin deliberately
        // did not apply (its local policy switch is off) is acked `skipped`,
        // never `done`. Older plugins simply never send either.
        leaseTokenAck: true,
        skippedAck: true,
        // Phase 38: operations as well as numbers. A plugin that predates
        // these acks unknown types as done, so advertising them is safe; a
        // plugin that does understand them can stop guessing whether the
        // server will ever send one.
        jobTypes: [
          "stock",
          "price",
          "product_update",
          "order_status",
          "refund_create",
          "catalogue_export",
          "customer_export",
          "orders_export",
          // Phase 40 — the WordPress manager: content export + content
          // operations an older plugin acks as unknown-and-done.
          "content_export",
          "post_upsert",
          "media_create",
          // Issue #939 — re-send only the taxonomy tree. Producers gate it on
          // the plugin's advertised set; an older plugin gets the full
          // `catalogue_export` (which carries taxonomy snapshots) instead.
          "taxonomy_export",
        ],
      },
    });
  });
}

export interface PluginEventsInput {
  events?: PluginEventInput[];
}

/**
 * Accept a batch of events the plugin observed in WordPress.
 *
 * Each is dedup'd and applied by the shared ingest path, so a plugin that
 * re-sends after a timeout — the normal case, since WP-Cron cannot know
 * whether a request that died mid-flight was applied — costs nothing.
 * Per-event results come back individually: one malformed order must not
 * force the plugin to re-send a batch of ninety-nine good ones.
 */
export async function pluginPushEvents(
  connection: ConnectionRow,
  input: PluginEventsInput,
): Promise<NextResponse> {
  const events = Array.isArray(input.events) ? input.events.slice(0, MAX_EVENTS_PER_PUSH) : [];
  if (events.length === 0) return NextResponse.json({ ok: true, results: [] });

  return withTenant(connection.business_id, async () => {
    const results: { deliveryId: string; status: string; error?: string }[] = [];
    for (const event of events) {
      const result = await ingestPluginEvent(connection, event);
      results.push(result);
    }
    // Real inbound sync activity: the plugin delivered a batch. Domain-specific
    // completion watermarks are advanced only by explicit *.sync_completed
    // markers, not by ordinary row activity.
    await query(
      `UPDATE integration_connections
          SET last_sync_at = now(), updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [connection.id, connection.business_id],
    );
    return NextResponse.json({ ok: true, results });
  });
}

export interface PluginJob {
  id: string;
  type: string;
  remoteId: string;
  /**
   * The variation's parent product id, when this job targets one.
   *
   * A variation is not `products/{id}`. Without the parent the plugin can
   * only guess, and the guess is a 404 — so it is sent alongside the job
   * rather than left for the plugin to work out from a product it may never
   * have seen. Absent on every job that targets a plain product.
   */
  parentRemoteId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  /**
   * This lease's generation token (issue #942, F01). The plugin echoes it
   * back in every ack for this job, and the ack only lands while the row
   * still carries this exact token — a worker whose lease expired and whose
   * job was re-leased (possibly with a newer payload) cannot ack the newer
   * attempt. Null for plugins that predate lease tokens; their acks fall
   * back to the status guard alone.
   */
  leaseToken: string | null;
}

/** How many queued stock/price jobs one pull inspects for redundancy. */
const REDUNDANT_PUSH_SCAN_LIMIT = 200;

/**
 * Before leasing, close the stock/price jobs that would only do harm (issue
 * #1149, C2):
 *
 *  - **stale** — computed more than STALE_PUSH_JOB_HOURS ago. A plugin that was
 *    down for a weekend must not come back and write a Thursday figure over the
 *    store. The row is closed as `stale_job`, and the next tick re-arms it with
 *    the *current* value (see the re-arm clause in `upsertOutbox`), so nothing
 *    is lost — the old number is.
 *  - **equal to the store** — the store's last report (the product mirror) is
 *    exactly this value, so applying it changes nothing but costs a round trip
 *    and a write that can race a store-side edit. Closed as `equal_to_remote`
 *    and recorded as acknowledged, so the diff does not queue it again.
 *
 * Only `pending`/`failed` rows are touched: a leased job is mid-delivery, and
 * `dead`/`needs_review` are a human's decision.
 */
async function dropRedundantPushJobs(connection: ConnectionRow): Promise<void> {
  await query(
    `UPDATE integration_outbox_events
        SET status = 'skipped', last_error = 'stale_job',
            leased_until = NULL, lease_token = NULL, updated_at = now()
      WHERE connection_id = $1 AND entity_type IN ('stock', 'price')
        AND status IN ('pending', 'failed')
        AND updated_at < now() - ($2 || ' hours')::interval`,
    [connection.id, String(STALE_PUSH_JOB_HOURS)],
  );

  const { rows } = await query<{
    id: string;
    entity_type: string;
    remote_id: string;
    payload: Record<string, unknown>;
    remote: RemoteProductState | null;
  }>(
    `SELECT o.id, o.entity_type, o.remote_id, o.payload, m.last_pushed_payload AS remote
       FROM integration_outbox_events o
       JOIN integration_mappings m
         ON m.connection_id = o.connection_id AND m.entity_type = 'product' AND m.remote_id = o.remote_id
      WHERE o.connection_id = $1 AND o.entity_type IN ('stock', 'price')
        AND o.status IN ('pending', 'failed') AND o.next_attempt_at <= now()
      ORDER BY o.next_attempt_at
      LIMIT ${REDUNDANT_PUSH_SCAN_LIMIT}`,
    [connection.id],
  );
  for (const row of rows) {
    if (!row.remote || !isNoopPush(row.entity_type, row.payload, row.remote, connection.currency_unit)) continue;
    const { rowCount } = await query(
      `UPDATE integration_outbox_events
          SET status = 'skipped', last_error = 'equal_to_remote',
              leased_until = NULL, lease_token = NULL, updated_at = now()
        WHERE id = $1 AND connection_id = $2 AND status IN ('pending', 'failed')`,
      [row.id, connection.id],
    );
    if ((rowCount ?? 0) > 0) await acknowledgePushedEvent(connection, row);
  }
}

/**
 * Lease the jobs this plugin should apply next.
 *
 * These are `integration_outbox_events` rows — the same queue, with the same
 * retry and dead-letter state, that the REST path drains by calling the store.
 * The only difference is who does the calling. Leasing (rather than simply
 * reading) is what keeps two overlapping WP-Cron runs from both applying the
 * same stock update; an un-acked lease expires and the job comes back, so a
 * plugin that dies mid-run loses nothing.
 */
export async function pluginPullJobs(connection: ConnectionRow): Promise<NextResponse> {
  return withTenant(connection.business_id, async () => {
    if (connection.status === "paused") {
      return NextResponse.json({ ok: true, jobs: [], paused: true, message: "همگام‌سازی از سمت پنل متوقف شده است" });
    }
    await dropRedundantPushJobs(connection);
    const supportedTypes = supportedPluginJobTypes(connection);
    const withLeaseToken = pluginSupportsLeaseToken(connection.plugin_capabilities);
    // A non-idempotent job without an operation id can never be verified
    // against the store, so it goes to a human instead of being leased. The
    // expired-`processing` arm covers the ambiguous case (issue #942, F11):
    // the previous holder may or may not have applied it before vanishing,
    // and without an operation id there is nothing to check — re-leasing it
    // could create a second refund/post/attachment.
    await query(
      `UPDATE integration_outbox_events
          SET status = 'needs_review',
              last_error = CASE
                WHEN entity_type = 'refund_create' THEN 'operation_id_missing_for_non_idempotent_refund'
                WHEN entity_type = 'media_create' THEN 'operation_id_missing_for_non_idempotent_media_create'
                ELSE 'operation_id_missing_for_non_idempotent_post_create'
              END,
              leased_until = NULL,
              lease_token = NULL,
              updated_at = now()
        WHERE connection_id = $1
          AND (
            status IN ('pending', 'failed')
            OR (status = 'processing' AND leased_until IS NOT NULL AND leased_until < now())
            OR (status = 'processing' AND leased_until IS NULL
                AND updated_at < now() - ($2 || ' milliseconds')::interval)
          )
          AND operation_id IS NULL
          AND (
            entity_type IN ('refund_create', 'media_create')
            OR (entity_type = 'post_upsert' AND NOT (payload ? 'id'))
          )`,
      [connection.id, JOB_LEASE_MS],
    );
    const { rows } = await query<{
      id: string;
      entity_type: string;
      remote_id: string;
      payload: Record<string, unknown>;
      attempts: number;
      lease_token: string | null;
      parent_remote_id: string | null;
    }>(
      `UPDATE integration_outbox_events o
          SET status = 'processing',
              leased_until = now() + ($3 || ' milliseconds')::interval,
              lease_token = CASE WHEN $5 THEN gen_random_uuid() ELSE NULL END,
              updated_at = now()
        WHERE id IN (
          SELECT id FROM integration_outbox_events
           WHERE connection_id = $1
             AND entity_type = ANY($4::text[])
             AND ${claimableOutboxSql("$3")}
           ORDER BY next_attempt_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING o.id, o.entity_type, o.remote_id, o.payload, o.attempts, o.lease_token::text,
                  COALESCE(
                    o.payload->>'__parentRemoteId',
                    (SELECT m.last_pushed_payload->>'remoteParentId'
                       FROM integration_mappings m
                      WHERE m.connection_id = o.connection_id
                        AND m.entity_type = 'product'
                        AND m.remote_id = o.remote_id
                      LIMIT 1)
                  ) AS parent_remote_id`,
      [connection.id, JOB_PULL_LIMIT, JOB_LEASE_MS, supportedTypes, withLeaseToken],
    );

    const hasMediaJobs = rows.some((row) => row.entity_type === "media_create");
    const mediaConfig = hasMediaJobs
      ? await withoutTenantScope("platform", () => getMediaConfig())
      : null;

    const jobs: PluginJob[] = [];
    for (const row of rows) {
      if (row.entity_type === "media_create") {
        const mediaAssetId =
          typeof row.payload?.__mediaAssetId === "string" && isValidMediaUuid(row.payload.__mediaAssetId)
            ? row.payload.__mediaAssetId
            : isValidMediaUuid(row.remote_id)
              ? row.remote_id
              : null;

        if (mediaAssetId) {
          if (!mediaConfig || !isMediaStorageReady(mediaConfig)) {
            await query(
              `UPDATE integration_outbox_events
                  SET status = 'pending',
                      leased_until = NULL,
                      lease_token = NULL,
                      last_error = 'storage_not_configured',
                      next_attempt_at = now() + interval '5 minutes',
                      updated_at = now()
                WHERE id = $1 AND connection_id = $2`,
              [row.id, connection.id],
            );
            continue;
          }

          // Mint a brand-new short-lived presigned URL at lease time rather than
          // relying on a URL baked at enqueue time that expires if WP-Cron lags.
          const resolved = await readMediaObjectDownloadUrl(
            connection.business_id,
            mediaAssetId,
            mediaConfig,
            15 * 60,
          );
          if (!resolved) {
            await query(
              `UPDATE integration_outbox_events
                  SET status = 'dead',
                      leased_until = NULL,
                      lease_token = NULL,
                      last_error = 'media_asset_deleted',
                      updated_at = now()
                WHERE id = $1 AND connection_id = $2`,
              [row.id, connection.id],
            );
            const operationId = row.payload?.__operationId;
            if (typeof operationId === "string" && operationId) {
              await failWordPressMediaSync(operationId, "media_asset_deleted");
            }
            continue;
          }

          jobs.push({
            id: row.id,
            type: row.entity_type,
            remoteId: row.remote_id,
            parentRemoteId: row.parent_remote_id ?? null,
            payload: {
              ...row.payload,
              __mediaAssetId: resolved.asset.id,
              url: resolved.url,
            },
            attempts: row.attempts,
            leaseToken: row.lease_token ?? null,
          });
          continue;
        }
      }

      jobs.push({
        id: row.id,
        type: row.entity_type,
        remoteId: row.remote_id,
        parentRemoteId: row.parent_remote_id ?? null,
        payload: row.payload,
        attempts: row.attempts,
        leaseToken: row.lease_token ?? null,
      });
    }
    return NextResponse.json({ ok: true, jobs });
  });
}

export interface PluginJobAck {
  id: string;
  /**
   * `done` — applied to WooCommerce. `failed` — attempted, with an error.
   * `skipped` — deliberately not applied because the plugin's local policy
   * switch (apply_stock / apply_prices) is off (issue #942, F10): nothing
   * was written remotely, so it must never be recorded as delivered.
   */
  status: "done" | "failed" | "skipped";
  error?: string;
  /** The lease generation this job was pulled under — see PluginJob.leaseToken. */
  leaseToken?: string;
}

/** Exponential, capped — same shape as `retry.ts`'s backoff, expressed in the SQL below. */
const JOB_BASE_BACKOFF_MS = 30_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ack fence (issue #942, F01), as a SQL fragment over `$N` = the acked
 * lease token (or NULL).
 *
 * A token-leased row only moves for the holder of that exact token while it
 * is `processing`: an expired worker acking a re-leased job — possibly one
 * whose payload has since been replaced by a newer value — matches nothing.
 * A legacy row (leased before tokens, `lease_token IS NULL`) keeps working
 * for plugins that predate them, but even there an ack can no longer touch
 * a terminal row: `sent`, `dead`, `needs_review` and `skipped` are final
 * unless an operator reopens them.
 */
function ackFenceSql(tokenParam: string): string {
  return `(
    (lease_token IS NOT NULL AND lease_token = ${tokenParam} AND status = 'processing')
    OR (lease_token IS NULL AND status IN ('pending', 'processing', 'failed'))
  )`;
}

export async function pluginAckJobs(
  connection: ConnectionRow,
  results: PluginJobAck[],
): Promise<NextResponse> {
  return withTenant(connection.business_id, async () => {
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let stale = 0;
    for (const result of Array.isArray(results) ? results.slice(0, JOB_PULL_LIMIT) : []) {
      if (!result?.id) continue;
      // A malformed token must fail closed, not throw a uuid cast error:
      // NULL never equals a stored token, so the strict arm simply misses.
      const leaseToken = result.leaseToken && UUID_RE.test(result.leaseToken) ? result.leaseToken : null;

      if (result.status === "done") {
        const { rows } = await query<{ entity_type: string; remote_id: string; payload: Record<string, unknown> }>(
          `UPDATE integration_outbox_events
              SET status = 'sent', sent_at = now(), last_error = NULL,
                  leased_until = NULL, lease_token = NULL, updated_at = now()
            WHERE id = $1 AND connection_id = $2 AND ${ackFenceSql("$3")}
          RETURNING entity_type, remote_id, payload`,
          [result.id, connection.id, leaseToken],
        );
        if (rows.length === 0) {
          stale += await auditStaleAck(connection, result);
          continue;
        }
        done += 1;
        // Issue #942 (F03): record what this delivery proved on the product
        // mapping, from the acknowledged row's own payload — the same
        // bookkeeping the REST drain does (`acknowledgePushedEvent`, the one
        // helper both delivery paths land in; PR #1054). Without this,
        // `refreshOutboxForConnection` compared desired state against a
        // last-pushed value the plugin path never wrote and requeued the
        // same stock/price every tick. Merging (not replacing) preserves
        // the other half and a variation's `remoteParentId`; using the
        // acked payload (not current local state) means a value changed
        // mid-flight is not falsely recorded as delivered.
        await acknowledgePushedEvent(connection, rows[0]);
        continue;
      }

      if (result.status === "skipped") {
        // Not applied, on purpose (the plugin's policy switch is off). The
        // row closes as `skipped` — visible on the queue screen, excluded
        // from "delivered", and crucially NOT merged into the mapping's
        // last-pushed value: the store still holds the old number.
        const reason = (result.error ?? "skipped_by_plugin_policy").slice(0, 500);
        const { rows } = await query<{ entity_type: string; remote_id: string }>(
          `UPDATE integration_outbox_events
              SET status = 'skipped', last_error = $4,
                  leased_until = NULL, lease_token = NULL, updated_at = now()
            WHERE id = $1 AND connection_id = $2 AND ${ackFenceSql("$3")}
          RETURNING entity_type, remote_id`,
          [result.id, connection.id, leaseToken, reason],
        );
        if (rows.length === 0) {
          stale += await auditStaleAck(connection, result);
          continue;
        }
        skipped += 1;
        await writeIntegrationAudit({
          businessId: connection.business_id,
          connectionId: connection.id,
          action: "outbox.skipped",
          entityType: rows[0].entity_type,
          remoteId: rows[0].remote_id,
          error: reason,
        });
        continue;
      }

      const message = (result.error ?? "plugin_failed").slice(0, 500);
      const { rows } = await query<{ attempts: number; status: string; entity_type: string; payload: Record<string, unknown> }>(
        `UPDATE integration_outbox_events
            SET attempts = attempts + 1,
                last_error = $4,
                leased_until = NULL,
                lease_token = NULL,
                status = CASE WHEN attempts + 1 >= $5 THEN 'dead' ELSE 'failed' END,
                next_attempt_at = now() + (LEAST(POWER(2, attempts) * $6, 3600000) || ' milliseconds')::interval,
                updated_at = now()
          WHERE id = $1 AND connection_id = $2 AND ${ackFenceSql("$3")}
        RETURNING attempts, status, entity_type, payload`,
        [result.id, connection.id, leaseToken, message, PLUGIN_JOB_MAX_ATTEMPTS, JOB_BASE_BACKOFF_MS],
      );
      if (rows.length === 0) {
        stale += await auditStaleAck(connection, result);
        continue;
      }
      failed += 1;
      if (rows[0]?.status === "dead") {
        await writeIntegrationAudit({
          businessId: connection.business_id,
          connectionId: connection.id,
          action: "outbox.dead_lettered",
          error: message,
        });
        // A media_create job that ran out of retries is never coming back
        // as a content.updated event (nothing sideloaded, so nothing was
        // ever tagged with the operation id) — the mapping row must not sit
        // "pending" forever with no event left that could ever resolve it.
        if (rows[0].entity_type === "media_create") {
          const operationId = rows[0].payload?.__operationId;
          if (typeof operationId === "string" && operationId) {
            await failWordPressMediaSync(operationId, message);
          }
        }
      }
    }
    // Outbound sync happened: the plugin reported on at least one leased
    // job, so mark the connection as having synced (see pluginPushEvents).
    if (done + failed + skipped > 0) {
      await query(
        `UPDATE integration_connections SET last_sync_at = now(), updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [connection.id, connection.business_id],
      );
    }
    return NextResponse.json({ ok: true, done, failed, skipped, stale });
  });
}

/**
 * An ack that matched no row: either the job is not this connection's
 * (ignore silently — the ack learns nothing about other tenants) or the
 * lease moved on without it. The second case is worth an audit line: it is
 * exactly the stale-worker race the fence exists to stop, and seeing it in
 * the trail is how an operator learns a store has overlapping cron runs.
 * Returns 1 when the row exists here (a genuine stale ack), else 0.
 */
async function auditStaleAck(connection: ConnectionRow, result: PluginJobAck): Promise<number> {
  const { rows } = await query<{ status: string; entity_type: string; remote_id: string }>(
    `SELECT status, entity_type, remote_id FROM integration_outbox_events
      WHERE id = $1 AND connection_id = $2`,
    [result.id, connection.id],
  );
  if (rows.length === 0) return 0;
  await writeIntegrationAudit({
    businessId: connection.business_id,
    connectionId: connection.id,
    action: "plugin.ack_stale",
    entityType: rows[0].entity_type,
    remoteId: rows[0].remote_id,
    payload: { ackedStatus: result.status, currentStatus: rows[0].status },
    error: "stale_lease_ack_ignored",
  });
  return 1;
}

/**
 * Ask the plugin, next time it pulls, to send everything of one kind.
 *
 * This is how "sync products now" works in plugin mode: the app cannot read
 * the store, so the button enqueues a job and the catalogue arrives as ordinary
 * events. Upserted on `(connection_id, entity_type, remote_id)` — pressing the
 * button twice before the plugin next runs refreshes one job rather than
 * queueing two full exports.
 */
export async function enqueuePluginExport(
  businessId: string,
  connectionId: string,
  entityType: "catalogue_export" | "customer_export" | "orders_export" | "content_export" | "taxonomy_export",
): Promise<{ jobId: string | null }> {
  // A job type the plugin never advertised would sit `pending` forever (the
  // lease filters by capability), so every producer is refused here, not just
  // the routes that remembered to check (#944 / OVR-08).
  await assertPluginJobSupported(businessId, connectionId, entityType);
  // Returns the outbox row's id so the caller can hand it back as the job the
  // member is now waiting on (#944 / OVR-04).
  const { rows } = await query<{ id: string }>(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
     VALUES ($1, $2, $3, 'all', '{}'::jsonb)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET status = 'pending', attempts = 0, next_attempt_at = now(),
                   last_error = NULL, leased_until = NULL, lease_token = NULL, updated_at = now()
     RETURNING id`,
    [businessId, connectionId, entityType],
  );
  return { jobId: rows[0]?.id ?? null };
}
