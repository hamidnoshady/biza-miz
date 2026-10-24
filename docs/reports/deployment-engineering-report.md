# Deployment-profile engineering report

## Result

The repository now has one explicit policy path for Cloud, Hybrid, and Local profiles while keeping runtime role and measured connectivity independent. Existing Electron/PostgreSQL, LAN, printing, backup, browser retry, server-sync, pairing, and deployment infrastructure were retained and strengthened rather than replaced.

## Subsystem disposition

| Disposition | Subsystems |
|---|---|
| KEEP | Electron embedded PostgreSQL/Next standalone runtime, dynamic port discovery, native printing, LAN gateway, backup engine, browser Dexie retry queue, existing site-sync transport and pairing protocol |
| REFACTOR | deployment mode/profile resolution, capability/API/navigation enforcement, connection status ownership, sync event producers/replay, settings UX |
| MERGE | duplicate dashboard connection probes into one shell provider; cloud/sync controls into one settings surface |
| MIGRATE | legacy `offline_mode` records to explicit `deployment.profile` through migration 0172; bidirectional exception relay persistence through migrations 0173–0174 |
| REMOVE | misleading browser-online-as-authority behavior and implicit site access to platform administration |
| ADD | ownership/execution registries, structured capability decisions, transactional operational outbox, Local exception relay, verified Hybrid media mirror, safe two-phase Local→Hybrid conversion |

## Authority and synchronization

Hybrid operational writes remain Local DB transaction → domain mutation plus durable outbox → Cloud replay. Network state does not choose authority. Event IDs and central receipts make retries idempotent. Financial/inventory handlers use immutable domain effects, append/reversal semantics, and explicit reconciliation rather than generic last-write-wins. Split-tender completion now carries every exact tender, tip, debt/credit difference and business date in a versioned event; replay reproduces payment rows, inventory consumption, loyalty and balanced journals atomically and suppresses ambiguous retries. Cloud-to-site bootstrap remains transactional and continuous sync requires deliberate activation.

The browser IndexedDB queue is still only a device-to-site transport and is not used for server synchronization. Printer configuration, backup paths, LAN/certificate/database paths and other machine state are explicitly `device_local/never_sync`.

## Local profile

Accounting, CRM core, POS, inventory, reporting, printing, LAN and backup remain available locally. All cloud applications are denied by the central capability resolver at navigation/page/API/command boundaries. A final sessionless/bearer audit also makes MCP/OAuth, public API, integration webhooks, peer backup, rollup and server-sync receiver surfaces central-execution-only. Support and Bug Report are the only exceptions. Their payloads commit atomically with a durable local relay envelope, are leased/retried in bounded batches, authenticate by opaque per-installation credentials stored centrally only as SHA-256 hashes, and deduplicate centrally without exposing provider failures or sensitive payloads. A site-process background tick delivers independently of an open browser, and the platform console includes a scoped Local-installation inbox with durable replies. Replies are delivered at least once, committed locally with a deduplication receipt, and acknowledged only afterward. Cloud provider/background workers are central-only; site sync discovery requires Hybrid, preventing stale Local configuration from contacting Cloud.

## Conversion and media

`deployment:convert-hybrid` performs matching-schema preflight, explicit collision refusal, device-local filtering, a mandatory transactional Cloud dry run, exact-ID bootstrap, disabled credential provisioning, operator review, then separate verified activation. It neither reinstalls nor resets Local data and never silently merges independent businesses. The operational runbook is `docs/deployment/local-to-hybrid-conversion.md`.

Hybrid media misses use a business-scoped site credential against the central media endpoint, validate declared length and SHA-256, and atomically populate a device-local mirror for later offline reads. Cloud object-storage credentials never reach the site or browser.

## Validation evidence

- Database migrations through 0174 applied successfully to PostgreSQL.
- Full database suite: 132 files; 1,507 passed, 1 skipped.
- Full non-database suite: 421 files; 5,817 passed.
- Full ESLint: passed with zero warnings.
- TypeScript no-emit check: passed (`NODE_OPTIONS=--max-old-space-size=3072`).
- Production Next.js build: passed with constrained worker memory.
- Desktop standalone runtime: staged successfully (167.6 MiB).
- Windows workflow builds, shape-checks, validates signature policy, installs as a standard user, and smoke-runs the packaged application.

The Linux workspace cannot execute a packaged Windows installer. Production deploy verification also intentionally requires a real health URL and expected Git SHA; it is not replaced by a local mock. Those environment-bound checks remain release gates in CI/deployment rather than being falsely reported as locally executed.
