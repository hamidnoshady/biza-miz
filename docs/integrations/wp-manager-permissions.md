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

## Queue classification

`summarizeQueueCounts` in `wp-manager-service.ts` is the single mapping from
outbox/inbox statuses to the overview tiles and the Queue page summary:

- in flight: outbound `pending` + `processing`, inbound `pending` + `deferred`;
- attention: outbound `failed` + `needs_review` + `dead`, inbound `failed`;
- done: outbound `sent`, inbound `processed`.
