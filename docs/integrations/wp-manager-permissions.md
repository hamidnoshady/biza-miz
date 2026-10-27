# WordPress & WooCommerce manager — permission matrix

Issue #944 / OVR-01. The one matrix the WP manager's pages, sidebar, store list,
overview buttons and API routes stand behind. Source of truth:
[`src/lib/wp-access.ts`](../../src/lib/wp-access.ts); the tests in
`src/lib/wp-access.test.ts` read the route handlers and assert they agree.

| Ability | Grants (any one) | What it covers |
| --- | --- | --- |
| `view` | `woocommerce.view` | Open `/websites/wp/*`; read mirrored products, orders, customers, terms, content, media; overview counts; the WP-scoped store list `GET /api/integrations/wp-manager/connections`; the queue page (read). |
| `sync` | `woocommerce.sync`, `integrations.manage` | «همگام‌سازی اکنون» for products, orders, customers and content (`POST /api/integrations/connections/{id}/sync/*`, `POST /api/integrations/wp-manager/content`); queue retry / retry-all / flush. |
| `content_manage` | `woocommerce.manage` | Create/edit/delete posts, pages and media through the manager. |
| `store_manage` | `woocommerce.manage` | Product, order and term writes through the manager. |
| `configure` | `woocommerce.configure`, `integrations.manage` | Change a connection's flags, pause/resume. Creating or deleting a connection stays in the technical hub (`integrations.manage`). |

Rules:

- `woocommerce.view` is never widened into `integrations.manage`. A viewer who
  should run syncs is granted `woocommerce.sync` (which already implies
  `woocommerce.view` through `permission-dependencies.ts`).
- `integrations.manage` keeps the sync access it had before the matrix
  existed, so no member loses access the day it ships.
- `GET /api/website/managers` (the Website app's sidebar snapshot) is open to
  exactly the keys that open the app: `website.view`, `cms.view`,
  `woocommerce.view` — otherwise a member who can open the app gets an empty
  sidebar.
- The shared technical list `GET /api/integrations/connections` keeps
  `integrations.view`; the WP manager no longer depends on it.
- The manager-specific store list calls `listAccessibleConnections(session)`
  before provider filtering, so `woocommerce.view` never reveals stores tied to
  branches or locations the member cannot access.
- Tenant scope (`withTenantScope`), the `integrations` feature entitlement and
  the `provider === "woocommerce"` check are unchanged and apply on top of every
  row above. The API is authoritative; the client's `can()` only decides what to
  disable (with a reason) before the click.

## Sync responses

Every sync route answers with a `result` so the UI never guesses:

| `result` | Meaning |
| --- | --- |
| `completed` | REST mode; the pull finished; counts (`created`/`updated`/…) accompany it. |
| `queued` | Plugin mode; a job was enqueued and the plugin applies it on its next pull. The overview polls the store's watermark and reports when it moves. `jobIds` carries the enqueued outbox row ids (so the client can name the job on the Queue page); `skippedSteps` lists substeps the plugin cannot apply (e.g. an older plugin without `content_export`). |
| `partial` | REST mode; the named operation succeeded but a substep failed — `failedSteps: [{ step, error }]` (today only `content`, after a products sync). Shown as «ناقص», with the failed sync offered on its own. |
| HTTP 409 | `sync_*_disabled`, `connection_paused` or `plugin_job_unsupported` — the control is already disabled in the UI for the same reasons. |

## Plugin job support (OVR-08)

A plugin only leases the job types it advertised in its handshake
(`plugin_capabilities.jobTypes`); a plugin that never reported any gets the
legacy set (`LEGACY_PLUGIN_JOB_TYPES`). A row of any other type would sit
`pending` forever, so the check lives in the two generic producers —
`enqueuePluginExport` and `enqueueExport` — through `assertPluginJobSupported`
(`src/lib/integrations/plugin-job-guard.ts`), not only in the routes. A refused
job throws `PluginJobUnsupportedError` (`plugin_job_unsupported`); the sync and
taxonomy routes answer it with a 409 and the autopilot executors with a failed
result. The routes still pre-check from the connection row they already hold,
so the common refusal costs no extra read. `POST …/sync/inventory` is granted by
`woocommerce.sync` (or `integrations.manage`) like the other sync actions.

## Queued-sync freshness (OVR-06)

After a plugin-mode sync is queued, the overview re-reads the store until its
watermark moves. The look is aimed at the plugin's next expected pull — last
heartbeat plus the pull interval (`queuedPollPlan` in `wp-sync-status.ts`) —
instead of a fixed 60 s timer, and waiting ends after three missed pulls. The
interval is the fast lane's five minutes
(`POS_Connector_Health::FAST_INTERVAL_SECONDS`) unless the plugin advertises
`capabilities.pullIntervalSeconds` (clamped to 1–60 minutes); today's plugin
does not, so a store on a slower system cron is still polled at the fast-lane
rate until a plugin release reports its real cadence. A store whose transport is
not healthy (stale, never connected, site mismatch, paused, error) is polled once
per interval: the overview already says why nothing will move.

## Queue classification

`summarizeQueueCounts` in `wp-manager-service.ts` is the single mapping from
outbox/inbox statuses to the overview tiles and the Queue page summary:

- in flight: outbound `pending` + `processing`, inbound `pending` + `deferred`;
- attention: outbound `failed` + `needs_review` + `dead`, inbound `failed`;
- done: outbound `sent`, inbound `processed`.
