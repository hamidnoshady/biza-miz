/**
 * Custom server (Phase 4): wraps Next.js's request handler with a plain
 * `http.Server` so we can also accept WebSocket upgrades on `/ws` for live
 * sync between the cashier, waiter app, KDS, and floor plan. `npm run build`
 * still uses plain `next build`; only `dev`/`start` go through this file.
 *
 * Other upgrade requests (e.g. Next's dev-mode HMR websocket) are handed off
 * to Next's own upgrade handler so `next dev` keeps working normally.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { createServer as createHttpsServer } from "https";
import fs from "fs";
import path from "path";
import type { Duplex } from "stream";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT) || 3000;
const dev = process.env.NODE_ENV !== "production";

if (!dev && !process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
  // `next build` positively selects the production config and writes it into
  // this traced manifest. Next's generated standalone server sets the same
  // variable before loading `next`; our WebSocket-aware custom server must do
  // likewise. Without it, Next tries to reload next.config.ts and its untraced
  // build-only webpack package, so a packaged desktop cannot start.
  const requiredFilesPath = path.join(process.cwd(), ".next", "required-server-files.json");
  const requiredFiles = JSON.parse(fs.readFileSync(requiredFilesPath, "utf8")) as { config?: unknown };
  if (!requiredFiles.config) throw new Error(`${requiredFilesPath} contains no standalone Next config`);
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(requiredFiles.config);
}

// `require`, not `import`: Next's own require-hook (which wires up the
// AsyncLocalStorage polyfill app-render needs) only runs on a CJS require of
// the package; importing it as an ESM module under tsx skips that hook and
// crashes on first render ("AsyncLocalStorage accessed in runtime where it
// is not available").
// A custom server does not execute Next's generated standalone/server.js,
// which normally injects this already-resolved config. Without it, Next tries
// to load its build-time webpack hook; that can appear to work in a source
// checkout by falling through to the parent development node_modules, then
// fail in the positively staged installer where that parent correctly does
// not exist. Read the generated runtime metadata before constructing Next.
if (process.env.NODE_ENV === "production" && !process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), ".next", "required-server-files.json"), "utf8"),
    ) as { config?: { output?: string } };
    if (metadata.config?.output === "standalone") {
      process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(metadata.config);
    }
  } catch {
    // Non-standalone/custom production deployments keep Next's normal config
    // discovery behavior and receive its normal error if configuration fails.
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const next = require("next") as typeof import("next").default;

const app = next({ dev });
const handle = app.getRequestHandler();

/** Parse an HTTP request target without Node's deprecated, non-standard url.parse(). */
function parseRequestUrl(value: string) {
  const url = new URL(value, "http://localhost");
  const query: Record<string, string | string[]> = {};
  for (const [key, item] of url.searchParams) {
    const existing = query[key];
    query[key] = existing === undefined ? item : Array.isArray(existing) ? [...existing, item] : [existing, item];
  }
  return {
    auth: null,
    hash: url.hash || null,
    host: null,
    hostname: null,
    href: value,
    path: `${url.pathname}${url.search}`,
    pathname: url.pathname,
    port: null,
    protocol: null,
    query,
    search: url.search || null,
    slashes: null,
  };
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

app.prepare().then(async () => {
  // Loaded dynamically, and only after prepare(): src/lib/auth.ts pulls in
  // next/server + next/headers, and importing those before Next's own
  // server bootstrap has run (inside prepare()) caches a broken internal
  // AsyncLocalStorage stub that then breaks every page render.
  const { SESSION_COOKIE, resolveSessionFromToken } = await import("./src/lib/auth");
  const { registerConnection } = await import("./src/lib/realtime");
  // Pure, dependency-free host parsing — safe to load here alongside the rest.
  const { websocketOriginAllowed } = await import("./src/lib/host");
  type HostEnv = import("./src/lib/host").HostEnv;
  const { runRollupSyncTick } = await import("./src/lib/rollup-service");
  const { ROLLUP_SYNC_INTERVAL_MS } = await import("./src/lib/rollup");
  const { runBackupTick } = await import("./src/lib/backup-service");
  const { BACKUP_TICK_INTERVAL_MS } = await import("./src/lib/backup");
  const {
    runServerSyncTick,
    SERVER_SYNC_INTERVAL_MS,
    runCentralSyncMaintenanceTick,
    CENTRAL_SYNC_MAINTENANCE_INTERVAL_MS,
  } = await import("./src/lib/server-sync");
  const { runCloudExceptionRelayTick, CLOUD_EXCEPTION_RELAY_INTERVAL_MS } = await import("./src/lib/cloud-exception-relay");
  const { assertRlsEffective, closeDatabasePool } = await import("./src/lib/db");
  const { deploymentRole, describeDeploymentRole } = await import("./src/lib/deployment-role");
  const { runWebsiteBillingTick, WEBSITE_BILLING_TICK_INTERVAL_MS } = await import("./src/lib/website/billing-service");
  const { runMediaBillingTick, runMediaTrashPurgeTick } = await import("./src/lib/media-service");
  const {
    runSubscriptionRenewalTick,
    SUBSCRIPTION_RENEWAL_TICK_INTERVAL_MS,
  } = await import("./src/lib/subscription-service");
  const { runAiProactiveTick, AI_PROACTIVE_TICK_INTERVAL_MS } = await import("./src/lib/ai-proactive-service");
  const {
    runPlatformCompanyBillingTick,
    runPlatformCompanyMaintenanceTick,
    PLATFORM_COMPANY_BILLING_TICK_MS,
    PLATFORM_COMPANY_MAINTENANCE_TICK_MS,
  } = await import("./src/lib/platform-company-billing");
  const { runWooCommerceSyncTick, WOO_SYNC_TICK_INTERVAL_MS } = await import("./src/lib/integrations/outbox-service");
  const { runWebsiteSyncTick, WEBSITE_SYNC_TICK_INTERVAL_MS } = await import("./src/lib/website/sync-service");
  const { runCrmScoringTick, CRM_SCORING_TICK_INTERVAL_MS } = await import(
    "./src/lib/crm-scoring-freshness"
  );
  const { runCmsControlTick } = await import("./src/lib/cms/platform-sync");
  const { inPlatformScope } = await import("./src/lib/cms/platform-control-service");
  const { runHolooSyncTick, HOLOO_SYNC_TICK_INTERVAL_MS } = await import("./src/lib/integrations/holoo/pull-service");
  const { runHolooPushTick, HOLOO_PUSH_TICK_INTERVAL_MS } = await import("./src/lib/integrations/holoo/push-service");
  const { runHolooReconciliationTick, HOLOO_RECONCILIATION_TICK_INTERVAL_MS } = await import("./src/lib/integrations/holoo/reconciliation-service");
  const { runNotificationTick, NOTIFICATION_TICK_INTERVAL_MS } = await import("./src/lib/notifications-service");
  const { runLowStockScanTick, LOW_STOCK_SCAN_INTERVAL_MS } = await import("./src/lib/notification-scans");
  // OpenObserve integration (docs/openobserve.md): taps console.* and
  // records errors/slow requests. No-op unless OPENOBSERVE_URL +
  // OPENOBSERVE_USER/PASSWORD are set — an install without a collector
  // boots exactly as before.
  const { installObservability, shipHttpEvent, flushObservability } = await import("./src/lib/observability");
  installObservability();

  // A dropped client connection must never take the POS down.
  //
  // `[Error: aborted] { code: 'ECONNRESET' }` is what Node emits when a
  // browser navigates away, a waiter's tablet leaves wifi, or the platform
  // edge recycles an idle keep-alive socket mid-response. Nothing in the
  // request pipeline owns that error — Next's handler has already returned —
  // so it lands on `uncaughtException`, where the default behaviour (and the
  // observability tap's flush-and-exit) killed the container. Production logs
  // showed the till going down at 23:23 for exactly this reason.
  //
  // Registering a listener here is also what stops Node's default fatal
  // handler from firing at all, so this must be installed unconditionally —
  // installObservability() above is a no-op when no collector is configured.
  const { isBenignNetworkError } = await import("./src/lib/network-errors");

  // Disconnects are normal transport lifecycle events (including managed-edge
  // health probes), not actionable application warnings. Handle them at the
  // stream/socket boundary but keep production logs for actual failures.

  process.on("uncaughtException", (error) => {
    if (isBenignNetworkError(error)) return;
    // Anything else is a real bug: print it and let the platform restart us
    // rather than serve from a process in an unknown state.
    console.error("> FATAL: uncaughtException:", error);
    void flushObservability().finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    if (isBenignNetworkError(reason)) return;
    console.error("> unhandledRejection:", reason);
  });

  const { assertSecurePosture } = await import("./src/lib/deployment-posture");
  assertSecurePosture(deploymentRole(), process.env.BIND_ADDR ?? "0.0.0.0", process.env.ALLOW_INSECURE_LAN === "1");

  // Phase 12: tenant isolation is enforced by Postgres row-level security,
  // which superusers and BYPASSRLS roles ignore outright — silently, with no
  // error to notice. Refuse to serve production traffic in that state; in
  // development this only warns (see assertRlsEffective).
  await assertRlsEffective();

  // Keep every scheduled job handle so a deploy can stop future work before
  // draining the HTTP server and database pool. The callbacks already catch
  // and log their own failures; this helper only owns their lifecycle.
  const backgroundTimers = new Set<NodeJS.Timeout>();
  const backgroundTasks = new Set<Promise<void>>();
  const runtimeRole = deploymentRole();
  const scheduleBackgroundTick = (
    tick: () => unknown | Promise<unknown>,
    intervalMs: number,
    initialDelayMs: number,
  ) => {
    const run = () => {
      const task: Promise<void> = Promise.resolve()
        .then(tick)
        .then(() => undefined)
        .catch((error) => console.error("unexpected background tick failure:", error))
        .finally(() => backgroundTasks.delete(task));
      backgroundTasks.add(task);
    };

    const interval = setInterval(run, intervalMs);
    interval.unref();
    backgroundTimers.add(interval);

    const initial = setTimeout(() => {
      backgroundTimers.delete(initial);
      run();
    }, initialDelayMs);
    initial.unref();
    backgroundTimers.add(initial);
  };
  const scheduleSiteTick = (tick: () => unknown | Promise<unknown>, intervalMs: number, initialDelayMs: number) => {
    if (runtimeRole === "site") scheduleBackgroundTick(tick, intervalMs, initialDelayMs);
  };
  const scheduleCentralTick = (tick: () => unknown | Promise<unknown>, intervalMs: number, initialDelayMs: number) => {
    if (runtimeRole === "central") scheduleBackgroundTick(tick, intervalMs, initialDelayMs);
  };

  // Phase 9: push this location's daily rollup to the configured central
  // server. A tick that can't reach central just records the error and the
  // next one retries the widened window — that's the offline catch-up story.
  const rollupTick = () =>
    runRollupSyncTick().catch((err) => console.error("rollup sync tick failed:", err));
  scheduleSiteTick(rollupTick, ROLLUP_SYNC_INTERVAL_MS, 30_000);

  // Phase 10: scheduled backups. The tick just checks whether a schedule
  // slot passed without a run (and re-nudges failed cloud uploads); failures
  // land in backup_runs and surface as the dashboard alert.
  const backupTick = () =>
    runBackupTick().catch((err) => console.error("backup tick failed:", err));
  scheduleBackgroundTick(backupTick, BACKUP_TICK_INTERVAL_MS, 45_000);

  // Migration 0132: the platform's own whole-database backup, on the schedule the
  // super-admin set in the console. Deliberately a second timer rather than a
  // step inside runBackupTick: the tenant loop is per-business and skips anything
  // whose own backup is disabled, and a deployment whose businesses all have
  // backups switched off must still be backed up — that install is exactly the
  // one where the operator's copy is the only copy.
  const { runPlatformBackupTick } = await import("./src/lib/platform-backup-service");
  const platformBackupTick = () =>
    runPlatformBackupTick().catch((err) => console.error("platform backup tick failed:", err));
  scheduleCentralTick(platformBackupTick, BACKUP_TICK_INTERVAL_MS, 60_000);

  // Phase 11: bidirectional server-to-server sync (café laptop ←→ VPS). Each
  // tick pushes locally-born sync_events to the configured remote and pulls
  // the remote's events back, replaying both through the same idempotent
  // applySyncEvent() engine the client offline-queue uses. A tick that can't
  // reach the remote just records the error; the next tick resumes from the
  // stored high-water mark. Disabled unless a business has configured a
  // server-sync target (settings key server_sync.config).
  //
  // Migration 0190: one single-flight runner (a slow tick and the next timer
  // can no longer overlap), which a committed local change (Postgres NOTIFY)
  // or a central-side change (long-poll) wakes early — see sync-wake-service.
  const { createSyncRunner } = await import("./src/lib/sync-wake");
  const syncRunner = createSyncRunner(
    async () => {
      // Tracked like every scheduled job, so shutdown drains a woken run too.
      const task = runServerSyncTick();
      backgroundTasks.add(task);
      try {
        await task;
      } finally {
        backgroundTasks.delete(task);
      }
    },
    (err) => console.error("server-sync tick failed:", err),
  );
  const serverSyncTick = () => syncRunner.run();
  scheduleSiteTick(serverSyncTick, SERVER_SYNC_INTERVAL_MS, 20_000);
  const syncWakeAbort = new AbortController();
  if (runtimeRole === "site") {
    const { startSyncWakeListeners } = await import("./src/lib/sync-wake-service");
    startSyncWakeListeners({ onWake: (delayMs) => syncRunner.kick(delayMs), signal: syncWakeAbort.signal });
  }

  // The receiving half of that link: retry site events the central deferred
  // for a missing prerequisite, and expire abandoned pairing sessions. Without
  // it a deferred event was only retried when the site re-sent it, which
  // stalled that site's whole push queue behind it.
  const centralSyncTick = () =>
    runCentralSyncMaintenanceTick().catch((err) =>
      console.error("central sync maintenance tick failed:", err),
    );
  scheduleCentralTick(centralSyncTick, CENTRAL_SYNC_MAINTENANCE_INTERVAL_MS, 25_000);

  // Local/Hybrid Support and Bug Report are durable even when nobody leaves a
  // dashboard open: this site-process worker leases and retries the exception
  // outbox independently of browser connection-status polling.
  const cloudExceptionTick = () =>
    runCloudExceptionRelayTick().catch((err) => console.error("cloud-exception relay tick failed:", err));
  scheduleSiteTick(cloudExceptionTick, CLOUD_EXCEPTION_RELAY_INTERVAL_MS, 10_000);

  // Phase J removed the Phase 18 AI subscription renewal tick: the legacy
  // credit-subscription system (ai_business_billing / ai_credit_ledger /
  // ai_subscription_plans) it fed was retired by Phase B's wallet cutover, and
  // its tables are dropped in migration 0164. AI spend now debits the canonical
  // business wallet directly (ai-wallet-billing.ts), so there is no monthly
  // credit grant to schedule.

  // Phase 18b Wave 4: opt-in proactive AI jobs. The service enumerates
  // businesses only under the documented platform bypass and then wraps each
  // tenant's facts, credit reservation and output rows in withTenant.
  const aiProactiveTick = () =>
    runAiProactiveTick().catch((err) => console.error("proactive AI tick failed:", err));
  scheduleCentralTick(aiProactiveTick, AI_PROACTIVE_TICK_INTERVAL_MS, 75_000);

  // Phase 23 (issue #118): drain the WooCommerce stock/price outbox. The tick
  // enumerates active connections under the documented platform bypass, then
  // wraps each business's diff/push work in withTenant — the same shape as
  // every other background tick here.
  const wooSyncTick = () =>
    runWooCommerceSyncTick().catch((err) => console.error("woocommerce sync tick failed:", err));
  scheduleCentralTick(wooSyncTick, WOO_SYNC_TICK_INTERVAL_MS, 90_000);

  // Phase 38 (issue #381): push product/stock/price changes to the business's
  // website through website_outbox — the WooCommerce tick's shape exactly
  // (bypass to enumerate, withTenant per business, one business's failure
  // never stops the next). A site that is down simply grows its queue.
  const websiteSyncTick = () =>
    runWebsiteSyncTick().catch((err) => console.error("website sync tick failed:", err));
  scheduleCentralTick(websiteSyncTick, WEBSITE_SYNC_TICK_INTERVAL_MS, 100_000);

  // Migration 0157: keep RFM scores fresh. RFM is a whole-population quintile
  // calculation, so it can never run on the checkout path — a busy Friday
  // would make the till wait on a full scan of every customer and every order,
  // and a failure in a reporting calculation would fail the sale itself.
  // Instead, checkout marks the business dirty (one row) and this tick does
  // the scanning. It also rescores daily regardless of activity, because
  // recency decays with the calendar: a shop closed for Nowruz must not return
  // to scores frozen at the moment it shut.
  const crmScoringTick = () =>
    runCrmScoringTick().catch((err) => console.error("CRM scoring tick failed:", err));
  scheduleBackgroundTick(crmScoringTick, CRM_SCORING_TICK_INTERVAL_MS, 120_000);

  // Migration 0138: a platform website's monthly fee. The service reads the
  // due list under the platform bypass and charges each business inside
  // `withTenant`; a wallet that cannot cover the renewal marks the
  // subscription past_due and leaves the site serving — cutting a shopfront
  // off from a cron is not this tick's decision to make.
  const websiteBillingTick = () =>
    runWebsiteBillingTick().catch((err) => console.error("website billing tick failed:", err));
  scheduleCentralTick(websiteBillingTick, WEBSITE_BILLING_TICK_INTERVAL_MS, 90_000);

  // Migration 0176 — the platform plan's own renewal. Same shape as the
  // website tick: the due list is read under the platform bypass, each
  // business's renewal runs inside withTenant, and idempotency is the
  // invoice's UNIQUE (business_id, reference) claim — a retried tick can
  // never bill the same period twice. Only auto-renew subscriptions are
  // touched; the migration backfilled every existing business with
  // auto_renew off, so nobody is charged who never opted in.
  const subscriptionRenewalTick = () =>
    runSubscriptionRenewalTick().catch((err) => console.error("subscription renewal tick failed:", err));
  scheduleCentralTick(subscriptionRenewalTick, SUBSCRIPTION_RENEWAL_TICK_INTERVAL_MS, 65_000);

  // Platform-company ledger bridge: source changes are already committed to a
  // transactional outbox; this worker only performs idempotent tenant-scoped
  // posting and leaves failures visible for authorized reconciliation/retry.
  const platformCompanyBillingTick = () =>
    runPlatformCompanyBillingTick().catch((err) => console.error("platform company billing tick failed:", err));
  scheduleCentralTick(platformCompanyBillingTick, PLATFORM_COMPANY_BILLING_TICK_MS, 70_000);

  // Housekeeping for the same feature: prune redeemed and long-expired company
  // handoff tokens. Central only, like the posting tick it sits beside — a site
  // or desktop process has no business deleting another realm's credentials,
  // and the audit trail of who opened what lives in platform_audit_log.
  const platformCompanyMaintenanceTick = () =>
    runPlatformCompanyMaintenanceTick().catch((err) =>
      console.error("platform company maintenance tick failed:", err),
    );
  scheduleCentralTick(platformCompanyMaintenanceTick, PLATFORM_COMPANY_MAINTENANCE_TICK_MS, 140_000);

  // Migration 0149: the media library's daily storage charge. The tick runs
  // hourly but the charge is claimed once per (business, local Tehran day) —
  // a UNIQUE row per day, ON CONFLICT DO NOTHING — so the hour it fires in
  // never matters and a restart never double-bills. A wallet that cannot
  // cover today rolls the claim back and is retried tomorrow; the library
  // keeps serving either way, the same "never cut off from a cron" rule as
  // the website tick above.
  const mediaBillingTick = () =>
    runMediaBillingTick().catch((err) => console.error("media billing tick failed:", err));
  scheduleCentralTick(mediaBillingTick, WEBSITE_BILLING_TICK_INTERVAL_MS, 95_000);

  // Phase 2 (media library trash): purge assets that have sat in the trash
  // longer than MEDIA_TRASH_RETENTION_DAYS. Runs on the same hourly cadence
  // as the billing tick — the exact hour never matters, only that a business
  // which soft-deleted something a month ago eventually has it, and its
  // stored bytes, actually removed.
  const mediaTrashPurgeTick = () =>
    runMediaTrashPurgeTick().catch((err) => console.error("media trash purge tick failed:", err));
  scheduleBackgroundTick(mediaTrashPurgeTick, WEBSITE_BILLING_TICK_INTERVAL_MS, 97_000);

  // Migration 0139: the website platform's control plane. Two jobs in one tick —
  // refresh the mirror of every site on eshobe-cms (on the operator's configured
  // interval, so the console's report answers from one local query and keeps
  // answering when the CMS is unreachable), and poll the CMS's own event feed into
  // OpenObserve so its site changes, orders, failed gateway self-tests and issued
  // keys are readable beside this deployment's own logs.
  //
  // Both halves are opt-in and default off (`mirror_enabled`,
  // `log_shipping_enabled`), so a deployment with no CMS makes no network call at
  // all: a migration must not turn a POS into an HTTP client for a service it has
  // never heard of. It runs under the platform bypass because there is no session
  // to derive a tenant from and none of the three tables is tenant data.
  const cmsControlTick = () =>
    inPlatformScope(() => runCmsControlTick()).catch((err) =>
      console.error("cms control tick failed:", err),
    );
  scheduleCentralTick(cmsControlTick, 5 * 60_000, 110_000);

  // Phase 26 (issue #125) Wave 7: mirror Holoo base data for companion-mode
  // businesses. Polling (Holoo cannot call back), gated on holoo_companion,
  // enumerating under the platform bypass and re-entering each business with
  // withTenant — the same shape as the WooCommerce tick above.
  const holooSyncTick = () =>
    runHolooSyncTick().catch((err) => console.error("holoo sync tick failed:", err));
  scheduleCentralTick(holooSyncTick, HOLOO_SYNC_TICK_INTERVAL_MS, 120_000);

  // Phase 26 Wave 8: drain the Holoo push outbox (sales/receipts/purchases)
  // with the same backoff/dead-letter policy, web_service preferred and the
  // guarded direct_sql fallback.
  const holooPushTick = () =>
    runHolooPushTick().catch((err) => console.error("holoo push tick failed:", err));
  scheduleCentralTick(holooPushTick, HOLOO_PUSH_TICK_INTERVAL_MS, 150_000);

  // Phase 26 Wave 9: nightly reconciliation of the shadow books against Holoo.
  const holooReconciliationTick = () =>
    runHolooReconciliationTick().catch((err) => console.error("holoo reconciliation tick failed:", err));
  scheduleCentralTick(holooReconciliationTick, HOLOO_RECONCILIATION_TICK_INTERVAL_MS, 180_000);

  // Phase 35: drain the notification outbox and push to each recipient's
  // devices. Producers only enqueue — a cashier closing their till must never
  // wait on a push service — so this tick is the only thing that sends. It
  // enumerates businesses with pending rows under the documented platform
  // bypass and wraps each one's fan-out in withTenant, like every tick above.
  // The shortest interval here on purpose: a notification that arrives ten
  // minutes late is one the person has already found out about another way.
  const notificationTick = () =>
    runNotificationTick().catch((err) => console.error("notification tick failed:", err));
  scheduleCentralTick(notificationTick, NOTIFICATION_TICK_INTERVAL_MS, 25_000);

  // Phase 35: the one notification producer that has to scan rather than be
  // told. Stock leaves an item through six different paths, so "is this item
  // below its reorder level" is a property of the level, not of any one of
  // them — see src/lib/notification-scans.ts. Much slower than the delivery
  // tick above because a reorder level is a "order more this week" signal.
  const lowStockScan = () =>
    runLowStockScanTick().catch((err) => console.error("low-stock scan failed:", err));
  scheduleBackgroundTick(lowStockScan, LOW_STOCK_SCAN_INTERVAL_MS, 120_000);

  // Phase 37: drain the SMS/email marketing outbox. Producers only enqueue —
  // an owner clicking "send" must never wait on (or fail because of) an SMTP or
  // Kavenegar round trip. This tick is the only thing that sends: it enumerates
  // businesses with ready rows under the documented platform bypass and wraps
  // each business's drain in withTenant, like every other tick here. It also
  // swallows its own errors (a provider outage must not take down a request).
  const { runMessagingTick, MESSAGE_TICK_INTERVAL_MS } = await import(
    "./src/lib/message-outbox-service"
  );
  const messagingTick = () =>
    runMessagingTick().catch((err) => console.error("messaging tick failed:", err));
  scheduleCentralTick(messagingTick, MESSAGE_TICK_INTERVAL_MS, 35_000);

  if (process.env.DEPLOYMENT_ROLE !== "site") {
    const { runCmsEntitlementOutboxTick } = await import("./src/lib/billing/entitlement/outbox-service");
    const cmsEntitlementTick = () =>
      runCmsEntitlementOutboxTick().catch((err) => console.error("cms entitlement tick failed:", err));
    scheduleCentralTick(cmsEntitlementTick, 60_000, 42_000);

    const { runCmsStoreOrderPollTick } = await import("./src/lib/cms/order-poll-service");
    const cmsStoreOrderPollTick = () =>
      runCmsStoreOrderPollTick().catch((err) => console.error("cms store order poll failed:", err));
    scheduleCentralTick(cmsStoreOrderPollTick, 60_000, 45_000);
  }

  // «ورود و خروج داده» — the platform data transfer engine (migration 0169).
  // Two ticks, for two genuinely different jobs.
  //
  // The import worker claims ONE queued job per tick (a conditional UPDATE, so
  // two app instances cannot take the same one) and performs it inside
  // withTenant. One at a time on purpose: an import can be minutes of work,
  // and a worker that drained the whole queue would starve every other
  // business behind whichever one uploaded fifty thousand rows. The queue is
  // also what keeps the UI non-blocking — the operator confirms and carries on
  // working while progress lands in the history.
  const { runImportQueueTick, IMPORT_TICK_INTERVAL_MS } = await import(
    "./src/lib/data-transfer/import-service"
  );
  const importQueueTick = () =>
    runImportQueueTick().catch((err) => console.error("data import tick failed:", err));
  scheduleBackgroundTick(importQueueTick, IMPORT_TICK_INTERVAL_MS, 40_000);

  // Scheduled exports («فروش روزانه»، «مشتریان هفتگی»، «حسابداری ماهانه») plus
  // the retention sweep that drops the stored bytes of expired exports. Five
  // minutes is fine granularity for an hourly schedule and cheap when nothing
  // is due — the claim query is one indexed read against a partial index.
  const { runScheduledExportsTick, SCHEDULED_EXPORT_TICK_INTERVAL_MS } = await import(
    "./src/lib/data-transfer/schedule-service"
  );
  const { pruneExpiredExports } = await import("./src/lib/data-transfer/export-service");
  const scheduledExportTick = async () => {
    await runScheduledExportsTick().catch((err) =>
      console.error("scheduled export tick failed:", err),
    );
    // The history row survives; only the copy of the business's data goes.
    // The service establishes its own documented bypass — see its header.
    await pruneExpiredExports().catch((err) =>
      console.error("export retention sweep failed:", err),
    );
  };
  scheduleCentralTick(scheduledExportTick, SCHEDULED_EXPORT_TICK_INTERVAL_MS, 55_000);

  const requestListener = (req: IncomingMessage, res: ServerResponse) => {
    const t0 = Date.now();
    const parsed = parseRequestUrl(req.url ?? "/");
    // Own the per-request error events too, so the common case never even
    // reaches the process-level handler above.
    req.on("error", (error: unknown) => {
      if (!isBenignNetworkError(error)) console.error("> request stream error:", error);
    });
    res.on("error", (error: unknown) => {
      if (!isBenignNetworkError(error)) console.error("> response stream error:", error);
    });
    res.on("finish", () => {
      // Only noteworthy requests get shipped: a status >= 400 (something
      // broke) or a response over a second slow (something is about to).
      // Every line of the app's own logging goes through the console tap
      // installed above, so shipping all request records would only pay
      // ingestion for noise between the two.
      const ms = Date.now() - t0;
      if (res.statusCode >= 400 || ms >= 1000) {
        shipHttpEvent({
          method: req.method ?? "GET",
          path: String(parsed.pathname ?? "/"),
          status: res.statusCode,
          durationMs: ms,
          host: req.headers.host ?? "",
        });
      }
    });
    handle(req, res, parsed);
  };

  const server =
    process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE
      ? createHttpsServer(
          {
            cert: fs.readFileSync(process.env.TLS_CERT_FILE),
            key: fs.readFileSync(process.env.TLS_KEY_FILE),
          },
          requestListener
        )
      : createHttpServer(requestListener);

  // `clientError` fires for malformed requests and for sockets that reset
  // during the header phase — before any request object exists.
  server.on("clientError", (error: NodeJS.ErrnoException, socket: Duplex) => {
    if (!isBenignNetworkError(error)) console.error("> client error:", error);
    if (!socket.destroyed && socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
    socket.destroy();
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (error) => {
    if (!isBenignNetworkError(error)) console.error("> WebSocket server error:", error);
  });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = parseRequestUrl(req.url ?? "/");

    // An upgrade socket is raw: without this, a tablet that drops mid-handshake
    // emits ECONNRESET with no listener and crashes the process.
    socket.on("error", (error: unknown) => {
      if (!isBenignNetworkError(error)) console.error("> upgrade socket error:", error);
    });

    if (pathname !== "/ws") {
      app.getUpgradeHandler()(req, socket, head);
      return;
    }

    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const session = token ? await resolveSessionFromToken(token) : null;
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Check Origin.
    //
    // The comparison has to be against the host the BROWSER used, not the one
    // in this request's `Host` header. Behind a managed platform edge
    // (Runflare, ParsPack and most PaaS/CDN edges — the TRUST_FORWARDED_HOST
    // case documented in .env.example) the edge routes by hostname itself and
    // hands this container an internal name like `web-1234.internal:3000`,
    // while the browser's real hostname rides in `X-Forwarded-Host`. Comparing
    // `Origin` to the raw `Host` there rejected EVERY upgrade with 403, so
    // `/ws` never connected, useRealtime() reconnect-looped forever, and every
    // screen that derives its status strip from that socket sat on "اتصال به
    // سرور قطع است" even though the app and database were perfectly healthy.
    //
    // resolveRequestHost() is the same helper middleware and the login family
    // use, so the socket's idea of "this request's host" cannot drift from
    // theirs. With TRUST_FORWARDED_HOST off it still returns `Host`, keeping
    // the strict same-origin behaviour behind Traefik and on the desktop app.
    const allowed = websocketOriginAllowed(
      req.headers.origin,
      req.headers.host,
      req.headers["x-forwarded-host"] as string | undefined,
      process.env as HostEnv,
    );
    if (!allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      registerConnection(ws, session);
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`> ${signal} received; draining POS server ...`);

    // No new scheduled work may start once the pool begins draining. Jobs
    // already in flight are tracked and allowed to finish below.
    for (const timer of backgroundTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    backgroundTimers.clear();
    syncWakeAbort.abort();
    syncRunner.cancel();

    // WebSockets are long-lived, so server.close() cannot make progress by
    // itself. 1012 tells browsers this is a service restart and invites the
    // existing reconnect loop to attach to the replacement container.
    for (const client of wss.clients) client.close(1012, "Service restart");

    const forceExit = setTimeout(() => {
      console.error("> Shutdown grace period expired; closing remaining connections.");
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections();
      process.exit(0);
    }, 25_000);

    const httpClosed = new Promise<void>((resolve) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          console.error("> HTTP shutdown error:", error);
        }
        resolve();
      });
    });
    const websocketsClosed = new Promise<void>((resolve) => {
      wss.close((error) => {
        if (error) console.error("> WebSocket shutdown error:", error);
        resolve();
      });
    });

    try {
      await Promise.all([
        httpClosed,
        websocketsClosed,
        Promise.allSettled([...backgroundTasks]),
      ]);
      await app.close();
      await closeDatabasePool();
      await flushObservability();
      clearTimeout(forceExit);
      console.log("> POS server stopped cleanly.");
      process.exit(0);
    } catch (error) {
      clearTimeout(forceExit);
      console.error("> Error while shutting down POS server:", error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Desktop: Windows does not kill children with their parent, so if the
  // Electron shell crashes or is killed this server would keep running hidden
  // and hold its port. Drain and exit once the shell is gone.
  const desktopParentPid = Number(process.env.DESKTOP_PARENT_PID);
  if (desktopParentPid > 0) {
    setInterval(() => {
      try {
        process.kill(desktopParentPid, 0);
      } catch {
        void shutdown("SIGTERM");
      }
    }, 2_000).unref();
  }

  const bindHost = process.env.BIND_ADDR ?? "0.0.0.0";
  server.listen(port, bindHost, () => {
    console.log(`> Ready on http://${bindHost}:${port} (WebSocket sync on /ws)`);
    console.log(`> Image: ${process.env.APP_IMAGE_SHA || "unknown"}`);
    // Phase 23 Wave 2: DEPLOYMENT_ROLE defaults by inference when unset, so
    // say out loud what the app decided — an operator otherwise has no way to
    // tell a central server from a site until the sync tab renders the wrong
    // form.
    console.log(describeDeploymentRole());

    // Phase 24: Warn if legacy token is configured but not allowed
    if (process.env.REMOTE_SYNC_TOKEN && process.env.ALLOW_LEGACY_SYNC_TOKEN !== "1") {
      console.warn("> WARN: REMOTE_SYNC_TOKEN is set but ALLOW_LEGACY_SYNC_TOKEN is not. Legacy sync token is denied by default.");
    }
  });
}).catch((error) => {
  // A rejected prepare/startup promise used to surface only as an unhandled
  // rejection, which is easy for a PaaS log viewer to separate from the boot
  // lines. Emit one unmistakable fatal line and exit non-zero so the deploy is
  // reported as failed rather than left in an indeterminate state.
  console.error("> FATAL: POS server failed to start:", error);
  process.exit(1);
});
