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

`server-sync-service.ts` periodically:

1. Pushes eligible local rows from `sync_events` to
   `POST /api/server-sync/push`.
2. Pulls later location-scoped events from
   `GET /api/server-sync/pull?after=<id>`.
3. Applies supported events through `applySyncEvent()`.
4. Records transport attempts in `server_sync_log`. A pull failure may advance
   the cursor only after its original replay envelope is durably stored as a
   canonical `sync_event_dead_letters` row with `source='server_pull'`.

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

The active Hybrid outbox/inbox set currently covers order creation/item
changes, payment v2 and customer returns, manual-journal reversals, purchases,
supplier returns, transfers, waste, retail/standard stock counts, and
production/reversal events. Each is written in the local mutation transaction,
uses stable IDs and `client_event_id` idempotency, and is applied through the
versioned registry.

This is **not** full-database replication. The contract deliberately marks
customers, catalogue/menu, and staff access as `bootstrap_only`: pairing
copies the selected master data atomically, but subsequent master-data edits
do not yet continuously synchronize. Printer settings, paths, LAN/certificate
configuration, and the cloud-exception relay are device-local and never enter
operational sync. Local-only profiles likewise never initiate continuous cloud
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
- **Events stay queued:** inspect `server_sync_log` and canonical
  `sync_event_dead_letters`, then verify the event type is in the supported
  contract above.
- **Phone cannot connect:** use the HTTPS URL/QR from Local Devices, trust the
  generated root certificate, confirm the chosen adapter is Private, and
  verify the gateway—not the internal server—is listening on the LAN.
