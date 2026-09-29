# Site-to-cloud synchronization

The Windows desktop deployment is an offline-capable site server for the full
Business Suite (Accounting, CRM, Growth/Marketing, Website Management, POS and
supporting modules). It runs the application and PostgreSQL locally and can
exchange explicitly supported domain events with a hosted deployment.

This is **not full-database replication**. The current event catalog is listed
under [Supported event scope](#supported-event-scope).

## Production architecture

```text
 Phone/tablet ── HTTPS / WSS ──> Desktop LAN gateway
                                     │ loopback HTTP / WS
 Electron BrowserWindow ───────────> Next.js server (127.0.0.1 only)
                                     │
                                     ├── PostgreSQL (127.0.0.1 only)
                                     └── print connector (127.0.0.1:9123)

 Next.js server ── HTTPS (when Internet is available) ──> Hosted deployment
```

The desktop installer includes Electron, the positively staged Next.js runtime
and one Windows embedded-PostgreSQL payload. Ordinary install and startup do
not require Docker, Node.js, a system PostgreSQL installation, or elevation.
Application data, credentials, local certificates, instance identity and logs
live under Electron `userData`, outside the installation directory.

The application server and Electron window remain on loopback. Phones never
connect to the application, PostgreSQL, or print connector ports directly.
Owner-controlled LAN access uses the desktop HTTPS reverse proxy, including
WebSocket proxying. The Local Devices settings panel provides the QR URL and
local root certificate onboarding. Optional Private-profile firewall setup is
the only operation that may request elevation.

## Pairing and credentials

A platform owner pairs a site by selecting the exact business location and
issuing a short-lived, one-use code. Redemption creates a distinct
`site_devices` identity and a hash-only `site_sync_credentials` row. The site
stores the one-time plaintext bearer credential in its encrypted local sync
configuration.

Each incoming sync request resolves to:

- `businessId`
- `locationId`
- `siteDeviceId`

Push and pull are constrained to that location. Inactive or revoked devices
are rejected. Legacy per-business and global tokens exist only for migration;
global fallback is off unless `ALLOW_LEGACY_SYNC_TOKEN=1` is explicitly set.
New installations must use site credentials.

## Event transport

On the site, `runServerSyncTick()` (`src/lib/server-sync.ts`, every 30 s):

1. Pushes local rows from `sync_events` that are applied and not yet
   delivered (`pushed_at IS NULL`, migration 0189) to
   `POST /api/server-sync/push`. Delivery is tracked **per row**, not by a
   high-water mark. A mark skipped any row whose transaction committed after
   a higher id, and any locally deferred row applied later. A row counts as
   delivered once the central durably holds it: applied, conflict, dead
   letter or **deferred**. One failed row does not hold back the rows after
   it; only that row is re-sent.
2. Pulls later location-scoped events from
   `GET /api/server-sync/pull?after=<id>`. The `id` cursor is a JSON number;
   the site also accepts the numeric string an older central sends.
3. Applies supported events through `applySyncEvent()`.
4. Records transport attempts that moved data or failed in `server_sync_log`
   (idle ticks are not logged). A pull failure may advance the cursor only
   after its original replay envelope is durably stored as a canonical
   `sync_event_dead_letters` row with `source='server_pull'`.

Transport details (migration 0190): the pull cursor is `(txid, id)` and only
rows whose writing transaction has finished are handed out, so a late commit
can never be skipped; each direction backs off exponentially (30 s → 15 min)
after failures, and a refused row backs off on its own; a committed local
change (`pg_notify`) or a central-side change (long-poll) wakes the tick
within seconds. The desktop's sync panel shows **health** (backlog and its
age, refused rows, dead letters, master conflicts) and the hourly **drift
check**: settled bills, sales and payments per business day compared with the
central server's for the last seven days.

On the central, `runCentralSyncMaintenanceTick()` (every 60 s) retries each
business's dependency-deferred inbox rows and expires abandoned pairing
sessions. Before this existed, the central only retried a deferred event when
the site re-sent it, which stalled that site's whole push queue behind it.

The desktop's runtime report (`POST /api/server-sync/runtime-status`) and the
older `GET /api/server-sync/update-check` authenticate with the site bearer
credential, so middleware lets them through without a session, like push and
pull. The route checks the credential itself.

The schema records event origin, source site device, schema version and
idempotency metadata. Duplicate `client_event_id` values are rejected by a
location-scoped unique constraint. Deferred domain events, conflicts and
canonical dead letters are intentionally distinct operator outcomes. A
canonical pull row can replay its stored envelope; an operator may retry it or
explicitly discard it with resolver/note audit data. The old
`server_sync_dead_letters` table is retired by migration 0185.

Internet failures do not stop local use. The desktop continues to serve the
LAN, queued local mutations remain in IndexedDB or `sync_events` as
appropriate, and synchronization retries after cloud reachability returns.
The UI distinguishes local-server reachability from Internet/cloud status.

## Supported event scope

`src/lib/data-ownership.ts` is the versioned, machine-readable replication
contract. It is the authority for domain ownership, stable identity,
conflict/tombstone policy, bootstrap boundary, retry semantics, deployment
availability, and exact `type@schemaVersion` event pairs. Pairing capability
disclosure and its tests consume this same contract.

The active Hybrid outbox/inbox set covers order creation, **the whole open
bill after every change** (`order.state.synced`: added lines, voids,
quantities, discount, customer, table, kitchen status — and once more inside
the payment transaction), payment v2 and customer returns, **closed-order
amendments** (`order.amendment.posted`), manual-journal reversals, purchases,
supplier returns, transfers, waste, retail/standard stock counts, and
production/reversal events. Each is written in the local mutation transaction,
uses stable IDs and `client_event_id` idempotency, and is applied through the
versioned registry. Since contract v2 the **central server records the same
events for a branch that has an active paired desktop**, so a bill, purchase
or journal the owner records in the cloud for that branch reaches it; the
desktop stays the operational authority and a cloud event it cannot apply
becomes a dead letter the owner sees. Replays keep the sale's own instant
(`opened_at`, `closed_at`, `received_at`) and the paying side's journal date.

**Master data** — customers (`parties`, `party_categories`), payment ways, and
the branch's menu, modifiers, recipes, stock items and tables — synchronises
continuously in both directions through the master-data feed
(`/api/server-sync/master`, `master-sync-service.ts`, migration 0190). A
trigger records a hybrid-logical clock per edited field on every write path;
the receiver merges field by field (the later edit of each field wins; edits to
different fields both survive). Values each side derives for itself never
merge: stock average cost and carrying value, table occupancy, CRM scores and
ciphertext (the plaintext crosses and is re-encrypted under the receiver's
key). A change that cannot merge — two rows created independently with the
same unique name, a delete the other side's history blocks — is recorded as a
master conflict and listed on the sync panel.

This is still **not** full-database replication. Staff access follows its own
IAM control plane; retail invoices and the retail catalogue are not part of
hybrid sync (pairing never copies them); website and imported sales are
settled on the central server and stay there. Printer settings, paths,
LAN/certificate configuration, and the cloud-exception relay are device-local
and never enter operational sync. Local-only profiles likewise never initiate continuous cloud
synchronization.

## Configuration and operations

1. Install and launch the signed Windows installer.
2. Complete first-run owner setup, or choose a location in the pairing UI and
   redeem its code on the desktop.
3. In **Settings → Connections**, configure the hosted URL and enable sync.
   Pairing supplies the site credential; operators must not paste a shared
   global token into new deployments.
4. In **Settings → Local Devices**, select the Private LAN adapter, enable the
   HTTPS gateway, install the displayed root certificate on each trusted
   phone/tablet, and scan the QR code.
5. If Windows Firewall blocks the selected port, use the scoped optional
   Private-profile firewall action. It must not open PostgreSQL or port 9123.

The owner connection page shows last attempts/successes, transport errors and
recent dead letters. Manual diagnostic calls should use the HTTPS gateway or
loopback on the desktop, never expose the internal HTTP port on the LAN.

## Updates

Desktop update installation is manual in this release. The dashboard can show
remote version information, but the application does not mint registry
credentials, download Docker images, or execute an unsigned/unverified update.
A future automatic Electron update path requires code signing, integrity
verification, pre-migration backup and rollback.

## Troubleshooting

- **Local app unavailable:** inspect desktop logs and the identity-aware
  `/api/health` response; this is separate from cloud reachability.
- **Cloud unreachable:** verify Internet/DNS/TLS and the hosted URL. Local POS
  and Business Suite use should continue.
- **401 from sync endpoint:** pair again only after checking that the site
  device is active; a revoked credential is intentionally unusable.
- **Events stay queued:** undelivered rows are
  `sync_events WHERE origin='local' AND applied_at IS NOT NULL AND error IS NULL AND pushed_at IS NULL`.
  Inspect `server_sync_log` for the push error, and canonical
  `sync_event_dead_letters` / `sync_domain_effects` (status `deferred`) on
  the central. Then verify the event type is in the supported contract above.
- **A customer or menu edit did not arrive:** check the panel's master
  conflicts (a unique-name clash is recorded, not retried) and
  `server_sync.master_state` for the feed cursors and last error. A row
  waiting on a parent that has not arrived is retried ten times, then
  recorded as a conflict.
- **The drift check reports a day:** the two sides settled different bills
  or totals for that business day. Compare that day's bills on both sides;
  a bill missing on one side usually has a dead letter explaining why.
- **Phone cannot connect:** use the HTTPS URL/QR from Local Devices, trust the
  generated root certificate, confirm the chosen adapter is Private, and
  verify the gateway—not the internal server—is listening on the LAN.
