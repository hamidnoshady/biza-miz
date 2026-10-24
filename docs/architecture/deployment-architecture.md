# Deployment architecture

This document describes the implemented runtime as of migration 0174. Code is authoritative: `src/lib/deployment-mode.ts`, `capabilities.ts`, `data-ownership.ts`, `connection-state.ts`, and the existing server-sync modules.

## Product profile vs process role

`DeploymentProfile` is `cloud | hybrid | local` and is stored per business in `settings['deployment.profile']` for site installations. `RuntimeRole` remains `central | site` and is process configuration. Network reachability is runtime state and does not change either value.

Pre-0172 `{mode:'local'|'connected'}` records are adapted in one compatibility boundary. `connected` maps to Hybrid on a site and Cloud on a central runtime. New code never writes the old key.

## Availability and execution

The capability registry is the common policy for pages and API route families. Accounting and CRM are supported in all profiles. Growth, Website Management, AI, central multi-location and cloud integrations execute in cloud and require Cloud or Hybrid. A Local denial returns `REQUIRES_CLOUD_CONNECTION`; a missing entitlement returns `FEATURE_NOT_IN_PLAN`; these are intentionally distinct.

Hybrid operational writes stay local-first. Internet reachability controls cloud work and synchronization, not the database used by POS, accounting or inventory.

Process workers follow the same execution targets: AI, website, WooCommerce, messaging, CMS, push delivery, Holoo/provider, billing and scheduled cloud-export ticks are central-only. A site process starts only local maintenance and site durability workers; server-sync and rollup discovery additionally requires an explicit Hybrid profile, so stale configuration cannot make a fully Local business contact Cloud.

## Ownership

`data-ownership.ts` is the required registry for synchronized domains. Orders, payments, journals and inventory movement are site-authoritative and immutable/append/reverse based. Customer and product/menu records are shared with domain-specific reconciliation. Billing is cloud-authoritative. Printers, local backup paths and LAN gateway configuration are device-local and never synchronize.

## Synchronization and device queue

`sync_events` remains the versioned inbox/outbox transport to avoid a destructive table rename. `sync_domain_effects` records idempotent domain application; deferred and dead-letter tables retain diagnosis and replay state. `appendSyncOutboxEvent` can only accept the `PoolClient` owning a domain transaction, preventing an after-commit outbox write.

Normal site mutations for orders, purchases/receipts/returns, transfers, waste, F&B and retail stock counts, production, customer returns, and manual-journal reversals insert their local-origin outbox event in the owning transaction. Created entities retain stable UUIDs on both peers. Event application runs on the central role and the producer itself suppresses bounce events.

Support and Bug Report are the only Local cloud exceptions. They use `cloud_exception_outbox`, not operational sync: the local row and relay envelope commit atomically, a leased worker retries with bounded backoff, and the central receiver deduplicates `(installation_id,event_id)`. Support replies return through `cloud_exception_responses`; Local atomically commits the admin message plus a tenant-scoped receipt before acknowledging Cloud, so a lost response or ACK is safely replayed without duplicating the conversation. The bearer secret is server-only. Standalone installation identities are deliberately stored outside Cloud tenant foreign keys, so asking for help cannot silently provision or merge operational data.

The Dexie queue remains a bounded device-to-local-server queue. It is not site-to-cloud synchronization. Service workers cache shell/fallback assets, not financial POST results.

Media metadata is bootstrapped with stable ids. A Hybrid site fetches missing bytes through `/api/server-sync/media/[id]` using its scoped site credential, verifies the recorded byte length and SHA-256, and atomically stores a device-local mirror. Later reads therefore survive an Internet outage; cloud bucket credentials never reach the site or browser.

## Connection state

The shared model separately reports local server, LAN gateway, Internet, cloud, synchronization and external services. A Hybrid cloud failure therefore reads as local active / sync paused, never as total system offline. `/api/connection/status` exposes only classified state and counters, never credentials or raw upstream errors.

## Pairing and activation

Cloud-to-site pairing creates an independent revocable site identity, applies bootstrap in one transaction and writes profile `hybrid`. Continuous synchronization stays disabled until explicitly activated. Local installations write profile `local` and expose **Settings → Cloud & Sync**. Existing Local production data converts through `npm run deployment:convert-hybrid`: matching-schema preflight, device-local filtering, mandatory transactional Cloud dry run, no-existing-business/no-merge guard, exact-id bootstrap, operator verification, then a separate `--activate` invocation that re-verifies the site credential before atomically enabling sync and writing Hybrid. See `docs/deployment/local-to-hybrid-conversion.md`.

## Backups, printing and LAN

Local backup success is independent from optional cloud upload. Filesystem paths are device-local. Electron native/raw/network printing remains separate from the browser cloud connector. The explicit HTTPS LAN gateway is independent from cloud reachability.
