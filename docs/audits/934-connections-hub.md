# Connections hub audit and hardening (#934)

Date: 2026-10-20. Source review plus the automated tests below; **not evidence of production exploitation**. Apply migrations `0233_connection_hub_lifecycle.sql` and `0234_validate_connection_location_business_fk.sql` before running the updated application.

## Authorization contract

| Surface | Server authority | Notes |
| --- | --- | --- |
| Public API key list/create/revoke | `api.manage` | Existing non-delegatable, owner-only permission; live membership/tenant evaluation, not JWT role or UI visibility |
| MCP list/history/create/edit/rotate/revoke/approve/reject | `mcp.manage` | Same owner rule; proposal execution also rechecks entitlement, originating grants and domain authority (#883) |
| Woo plugin-token rotation | `api.manage` | Owner-only, one-time no-store response; atomic actor audit; rotation interrupts the installation until the new token is installed |
| Operational integration configuration | `integrations.view/manage` | Intentionally remains operational/delegatable; does **not** grant machine-credential management |
| CMS masked state / configuration, both API families | `cms.view` / `cms.configure` | No alternative `integrations.manage` route around CMS configuration policy |
| Local gateway IPC | Live `owner` via fixed local backend | Main-window/top-frame/same-origin provenance; main-process cookie session; no renderer-supplied role or authorization URL; native firewall confirmation defaults to cancel |
| Holoo financial apply/rollback | Canonical #845 data transfer workflow | Legacy hub endpoint now returns `409 use_data_transfer`, with `/settings/transfer`; no second, weaker financial execution path |

The hub uses a **live** membership, including permission revocations. Admin intentionally gets the same operational tabs as manager, never desktop/device authority, API credentials or MCP credentials. The CMS tab follows CMS permissions. Explicitly delegated operational read grants also control tab discovery; owner-only tabs remain non-delegatable. Operational connection APIs check live branch reach in addition to tenant-scoped SQL/RLS; list APIs do not reveal inaccessible branches. Management/history lookup includes inactive branches under the same live membership/assignment policy, so deactivation cannot hide still-valid credentials from their owner or assigned manager. The normal switcher and new/reassigned connection destination still use active branches only. Null/business-wide legacy connections require access to all business branches, including inactive ones. PATCH reassignment follows create's stricter active-branch contract and cannot clear the branch to gain business-wide reach. A validated composite location/business FK protects non-HTTP writers as well. Migration 0234 completes validation; inconsistent historical rows block migration until an operator deliberately repairs the assignments (see deployment notes below).

## Lifecycle and retention

* DELETE of an integration connection means **disconnect/revoke**, not purge. One SQL statement pauses and tombstones the parent, clears Woo and Holoo credentials, disarms Holoo writes/companion activation, and appends the actor audit. Either the audit and revocation both persist, or neither does.
* Audit history, webhook inbox, outbox, mappings, migration runs and reconciliation history are retained. There is **no automatic retention expiry or purge** in this change. Whole-tenant erasure/factory reset remains an explicit separate administrative lifecycle.
* The audit FK no longer cascades on connection deletion. Audit rows are append-only outside explicit tenant erasure/factory reset. A tombstone cannot be reactivated by an old worker. Existing authenticated operations already in flight can finish; disconnect is not a distributed cancellation protocol.
* Operational lookups and managers exclude tombstones; plugin and Woo webhook authentication reject them. History endpoints still allow authorized branch-scoped inspection of tombstoned connections.
* REST Woo and Holoo probes record `last_test_at`, `last_successful_test_at` and `last_test_error`, independently of operational status and data-sync timestamps. Failed tests do not clear the last successful test or resume paused links. Plugin heartbeat remains a separate signal, not a data sync.
* Woo overview and panel both filter by provider. Woo-specific catalogue/store/taxonomy/inventory actions and client construction reject Holoo. Generic Holoo PATCH cannot attach Woo settings/credentials.
* Woo disconnect and token rotation have explicit consequence confirmations. One-time secrets stay visible if clipboard access fails. API credential creation defaults to 90 days when expiry is omitted (explicit null retains the documented unlimited option); MCP UI retains its existing finite default.
* CMS disconnect only announces success after an OK response and preserves its displayed connection on failure. Disconnect removes this application's stored key, **not the remote CMS site, content, or copies of that key held elsewhere**.

## Eshobe dual-path investigation

Both API families share `eshobe_cms_connections`, but they are not interchangeable response contracts:

* `/api/cms/website/*` provides managed website orchestration/provisioning and a small masked site summary.
* `/api/connections/website/*` provides the adapter-aware masked summary, currency, queue counts and POS-to-site sync settings. Production rejects the mock adapter.
* Both now use CMS-specific read/configuration authorization and the same disconnect implementation (including the in-memory development adapter cleanup). Both clients use the same outbound HTTP policy.
* Managed connect refreshes test health and explicitly selects the Payload adapter. A credential rotation for the same site retains existing sync/currency preferences. A destination change resets automatic stock/price pushing and branch/product selection to safe defaults. Neither response contains the encrypted or plaintext key.
* Keep the adapter/currency and provisioning responsibilities separate; do not replace one response DTO with the other. Existing product mappings and outbox history are business-scoped, not site-generation-scoped. Moving to a **different** remote site requires review/reconciliation of those mappings before re-enabling sync; generation-bound mapping/queue migration is follow-up work, not silently performed by credential rotation.

## Credentialed outbound HTTP

Woo and CMS validate stored URLs at use as well as setup. The shared server client:

* parses/canonicalizes URLs; rejects userinfo, setup query strings/fragments, localhost and non-public IP literals (including alternative IPv4 spellings and IPv4-mapped IPv6);
* requires HTTPS in production;
* checks all DNS answers **inside the socket lookup**, not a raceable lookup followed by an unrelated fetch; rejects mixed public/private answers and private/link-local/metadata/loopback destinations;
* refuses redirects rather than forwarding Basic/Bearer credentials to a new origin;
* uses a 10-second connection deadline and a 15-second whole-request/body abort deadline (CMS can impose its shorter existing deadline);
* reports typed/redacted network, provider and JSON parsing errors instead of reflecting upstream bodies or credential-bearing URLs.

For explicitly trusted local development only, `NODE_ENV=development` plus an exact comma-separated hostname in `CONNECTION_HTTP_DEV_HOSTS` permits HTTP/private destinations. The override is ignored in production. There is no default private-address exception. Holoo's intentional local SQL connectivity is governed by its separate #845 profile/authority contract, not the public website HTTP policy.

## Upstream coordination

* #883 (closed): reuse its `proposed -> processing` CAS, execution-time grant/authority checks, idempotency identity and stale-processing review. Strengthen the concurrent-approval integration test to count actual executor invocations; do not implement a competing approval engine. Crash-uncertain work is surfaced for review, never automatically replayed.
* #845 (closed): its preview-bound transfer API, scope/financial permissions, branch filtering and domain period controls are the only supported financial migration execution flow. Hub legacy write calls fail closed. Canonical rollback additionally requires live `ledger.approve` and `confirmRollback: true` following the existing impact warning.
* #766 (closed): preserve pairing/replication/recovery implementations. This patch adds the missing local-device IPC boundary, not a second gateway/sync protocol.
* #902 (open): preserve managed-service branding/workflows; this patch does not introduce provider administration or billing settings for tenants.

## Verification and limits

Regression coverage includes route permission matrices with forged delegated grants and disabled entitlements, admin visibility, mixed-provider API/component fixtures, branch reassignment/tenant FK denial, paused probe success/failure, durable revocation/audit and immutable history, copy failure and destructive confirmations, CMS disconnect failure/success and shared masked lifecycle, actual HTTP redirect refusal, malicious literal/DNS destinations, Electron provenance/live-authorization failure, and concurrent MCP approvals with an executor invocation count.

Validated in this sandbox: **753 unit/component tests across 69 files**, **110 PostgreSQL integration tests across 6 files**, TypeScript `--noEmit`, and ESLint on all changed JS/TS files. The first TypeScript attempt exceeded Node's default heap; the documented 3 GiB heap run passed.

Run:

```sh
npx vitest run src/lib/integrations src/lib/cms src/lib/website src/lib/mcp \
  src/lib/gateway-ipc-authorization.test.ts src/lib/connection-kinds.test.ts \
  src/lib/permissions.test.ts src/lib/permission-matrix.test.ts src/lib/authorize.test.ts \
  src/lib/client-bundle-boundary.test.ts src/lib/central-execution-paths.test.ts \
  src/app/api/connections/credential-authorization.test.ts \
  src/app/api/integrations/connections/hub-contract.test.ts \
  src/app/api/data/providers/holoo/rollback-authorization.test.ts \
  'src/app/(app)/settings/connections/cms-panel.test.tsx' \
  'src/app/(app)/websites/wp/woocommerce-connection-panel.test.tsx' --maxWorkers=1
DATABASE_URL=... npx vitest run --config vitest.db.config.ts \
  integration/woocommerce-integration.integration.test.ts \
  integration/mcp-connector.integration.test.ts integration/mcp-grants-hardening.integration.test.ts \
  integration/holoo.integration.test.ts integration/website-sync.integration.test.ts \
  integration/fiscal-periods.integration.test.ts
NODE_OPTIONS=--max-old-space-size=3072 npx tsc --noEmit
```

Still requires release verification: Windows/Electron packaged runtime, UAC/firewall/certificate operations, real Woo/CMS/TLS/DNS infrastructure, cloud/hybrid/local deployment smoke tests and interactive mobile/RTL/screen-reader review. The Linux tests do not establish any production exploit or certify provider availability. The repository requires Node 24+; this sandbox provides Node 22.22.3. No production credentials or provider network calls were used.

## Packaged restore regression (#1037) and deployment notes

The first packaged Windows run failed in **Execute tools from the actual packaged runtime**, after the production build, installer and database migrations succeeded. Its detailed log download was unavailable in this sandbox (EOF); this is a log-retrieval problem, not the application's error. Source inspection and a real PostgreSQL reproduction identified the schema incompatibility: 0233 left `integration_connections_location_business_fk` **NOT VALID**, while the actual `validateRestoredDb()` safety gate rejects every unvalidated foreign key with `restore_contains_unvalidated_foreign_keys`. A fresh migrated database reproduced that invalid constraint before the fix.

Forward migration **0234** validates the constraint; 0233 remains checksum-immutable. Restore validation is unchanged. The three new PostgreSQL regressions cover fresh-schema restore readiness, explicit reproduction of the old rejection followed by a successful upgrade using the actual restore validator, and rejection of inconsistent historical assignments **without deleting connections or audit history**. The seven-file integration rerun passed **113 tests**, with TypeScript and changed-file ESLint also passing. This exercises the real PostgreSQL validator, not Windows executables or a complete dump/swap; the new packaged Windows CI run remains the release gate.

Before deployment, an operator using the maintenance/owner database connection can identify historical assignments needing repair without exposing credentials:

```sql
SELECT c.id, c.business_id, c.location_id
FROM integration_connections c
LEFT JOIN locations l ON l.id = c.location_id AND l.business_id = c.business_id
WHERE c.location_id IS NOT NULL AND l.id IS NULL;
```

If any rows are returned, establish the intended branch within that connection's own business and repair explicitly under the existing change/audit process; never automatically move a connection to another business, clear its branch to broaden access, or purge history. Migration 0234 fails closed with a foreign-key violation until those rows are repaired, and the migration runner leaves it pending for retry. Do not deploy the application with 0234 pending or bypass the restore safety gate.

## Packaged payload size regression (#1037 follow-up)

Run **39408389092**, job **118579831423**, at commit `95181b9` passed the packaged PostgreSQL tools/full restore acceptance and both actual installed-app launches. It failed only **Final size report and budgets**: **676,835,715 bytes (645.481 MiB)** versus the unchanged **644 MiB (675,282,944 bytes)** unpacked budget. The installer was 165.6 MiB, below its unchanged 175 MiB budget. The remaining excess was **1,552,771 bytes**, not another restore defect.

The job's exact package diagnostics identified a **4,301,622-byte** pretty-printed `node_modules/next/dist/server/capsize-font-metrics.json` in the positively traced runtime. A narrowly allowlisted packaging pass now removes JSON whitespace outside strings from **only that asset**, after the final traced dependency overlay. It preserves every field, string escape and numeric literal, including literals beyond JavaScript's safe integer range; it neither deletes the font table nor changes Next's runtime code, credentials, provenance or any other JSON. This is not the broader server-code minification project mentioned in the workflow's size-policy history. The repository dependency files are not modified.

Measured locally against the pinned Next asset: **4,301,622 → 2,581,422 bytes**, a **1,720,200-byte** saving. Applied to the failing run's otherwise identical payload, this projects **675,115,515 bytes (643.840 MiB)**, **167,429 bytes below the existing gate**. This is deliberately a projection, not a new Windows package measurement; headroom remains narrow. Do not raise either budget on this evidence.

Validation: **54 desktop posture/size/network/Chromium tests** passed, including real-asset data equality, Node `require()` compatibility, exact numeric/string preservation, idempotence, malformed-input rejection, allowlist isolation and a minimum byte-saving regression. Changed-file ESLint and TypeScript `--noEmit` passed. Attempts to build the full Next production tree locally exhausted this sandbox's memory (heap limits/OS kill); the new Windows packaged run must provide the actual post-change installer, unpacked-size and launch acceptance results.

## Unit route-fixture regression (#1037 follow-up)

Run **39416608522**, unit-test job **118625923439**, completed with a real test failure; the early “logs will be available when it is complete” message was not the cause. The check annotation and local reproduction both identified `No "getConnection" export is defined` in the connection PATCH route test. The route now correctly authorizes its existing connection through `getAccessibleConnection()`, but the older sync-settings test mocked only the mutation functions and provided neither the connection lookup nor live branch-access fixtures.

The test now supplies `getConnection`, `accessibleLocationsFor` and active-location fixtures while executing the **real** connection-access helper. Production authorization and mutation code are unchanged. Route regressions also assert no mutation for inaccessible branches, business-wide links without access to every branch, missing/tenant-filtered records and permission denials, plus provider mismatch, branch-reassignment restrictions and the tenant/audit actor on disconnect. The targeted route/access-helper run passed **16 tests**. The subsequent full unit/component suite (`npm test -- --maxWorkers=2`, with normal repository-wide test discovery) passed **12,637 tests**, with **7 skipped**, across **965 passing files** and **1 skipped file** in 369 seconds on Linux. Changed-file ESLint and TypeScript `--noEmit --incremental` also passed. Windows unit CI still must confirm the pushed commit; these are not claims of a local Windows execution.

Separately, the preceding size fix is now confirmed by actual Windows execution: **39416608545 / 118607058386** passed packaged Windows end-to-end at `2e887c0`, including restore and installed-app acceptance. Its measured unpacked payload was **675,115,517 bytes (643.840 MiB)**, below the unchanged 644 MiB budget; the installer was 165.6 MiB. This replaces the earlier projection with measured acceptance evidence for that commit.

## Final issue/review acceptance pass

Merged `main` at `ab67ef7` into the existing PR branch without conflicts, retaining the current desktop version and menu/idempotency/catalogue changes. Both review findings are addressed:

* **Inactive branches:** connection management and retained history opt into inactive branches while reusing the existing live role/location-scope/assignment policy. No owner-role shortcut from the session token, no access to another tenant or an unassigned branch, and no change to active-branch selection for create/reassignment. A real PostgreSQL test covers switcher exclusion, owner visibility, assigned-manager access, immediate assignment revocation with a stale owner claim, pause, credential revocation and retained update/disconnect audit.
* **CMS clear operation:** `syncLocationId: null` reaches the existing tenant-scoped clear operation, even with no active branch. Omission leaves the setting unchanged; every non-null assignment still requires the resolved active authorized location. Route tests cover permissions, foreign/inactive IDs, no active branch and missing connection without false success.

Issue #934 cross-check:

| Requirement | Implementation/evidence |
| --- | --- |
| Owner-only direct API credentials, MCP consent/approval and Woo token rotation | Non-delegatable `api.manage` / `mcp.manage`; live membership/entitlement checks and denial matrices in `credential-authorization.test.ts`, authorization tests and MCP PostgreSQL suites |
| At-most-once MCP effects | Existing #883 CAS/grant/idempotency/recovery engine; concurrent real approval regression counts executor invocations |
| Provider isolation | Woo overview and defensive panel filtering, provider checks on action handlers/client creation, mixed-provider contract/component tests |
| Truthful health vs operational/sync state | Separate probe timestamps/errors; paused Woo/Holoo remains paused; real DB success/failure probe tests |
| Durable disconnect and history | Atomic credential-free tombstone plus actor audit, immutable retained history, no resurrection, explicit tenant-erasure exception; lifecycle/restore DB tests |
| Branch/tenant/feature boundaries | Active-only new assignments, validated composite FK, inactive-branch management under live grants; role/feature/branch matrix and DB tests |
| Holoo financial authority | Canonical #845 transfer preview/apply and period policy; weak hub mutation endpoints retired; explicit rollback acknowledgement plus `ledger.approve` |
| Credentialed HTTP and desktop IPC | Canonical HTTPS/public destination/socket-DNS/redirect/deadline/redaction policy; main-frame provenance plus live-owner IPC authorization and cancel-default firewall confirmation |
| Dual CMS contracts | Shared authorization, masked lifecycle/disconnect and destination-change safety; distinct adapter/currency DTOs preserved deliberately; explicit null clear supported |
| Hub UX and support | Permission-aware admin/delegated discovery, destructive confirmations, failed-copy retention, finite expiry defaults, truthful CMS failure notifications, component/visual regression coverage and the support notes below |

Post-merge validation: **12,719 unit/component tests passed, 7 skipped**, across **977 passing files and 1 skipped file** (`npm test -- --maxWorkers=2`); **136 PostgreSQL integration tests passed across 10 files**, including the three menu/catalogue suites brought in from main. TypeScript `--noEmit`, changed-file ESLint, coverage-matrix regeneration (1,064 routes, zero unclassified routes) and `git diff --check` passed. There are no new runtime stubs, placeholder implementations or TODO bypasses in the changed connection code; mock adapters/executors are explicit existing test/development seams, not production substitutes.

Windows packaged acceptance, production build/container, unit tests, visual regression and lint/type checks passed on the prior reviewed head `9b826ba`; fresh CI must certify the final merged/review-fixed head. Real credentialed provider infrastructure and physical UAC/firewall/accessibility interactions remain the explicitly documented release-environment verification boundaries, not tests we claim to have executed locally. Different-site CMS mappings/outbox reconciliation remains an intentional operator contract rather than an unfinished automatic migration in this PR.

## Tenant-facing support notes

* «آزمایش اتصال» checks reachability; it does not import data or resume a paused store. Check the separate last successful test, plugin heartbeat and last data-sync indicators.
* Token rotation immediately interrupts WordPress until the replacement is installed. Copy the one-time value before leaving; if clipboard access fails, copy it manually.
* Disconnect preserves local accounting/history and remote site content. It stops this application's future use of the stored credentials, not changes already running at the provider.
* Holoo import/apply/rollback belongs in «انتقال داده», with preview/approval and period controls, not in connection diagnostics.

## Latest CI regression, main synchronization and final branch-scope review

The failed aggregate in run **39471730103** correctly reflected the failure of **integration tests 2/6**, job **118822088492**. Its settled-since fixture expected three historical orders immediately after the live business day had reset; production correctly clamps the sales window to the current business-day boundary. A controlled PostgreSQL-boundary reproduction produced the same empty-order result. The fix is in the fixture, not in production reporting or the aggregate gate.

Merged current main **7d31bf30**, resolving both the generated MCP matrix and the overlapping shift-fixture correction. Main's **4cf2f60b** independently addressed this same midnight dependency. The merged fixture explicitly configures its business-day boundary from PostgreSQL's clock, exercises both Tehran and UTC, and checks exact-boundary inclusion and exclusion one millisecond before it. Split tender, cross-shift settlement, online orders, refunds and card/drill-down totals remain covered. No test timeout, accounting boundary or required-check condition was relaxed.

The final authorization cross-check also found that WordPress Manager reads/writes and the central Media Library's WordPress picker/push still used business-only connection lookups. These now execute the existing live branch-access helpers. The no-connection overview supplies an explicit WooCommerce connection allowlist to **every** aggregate query; an empty allowlist means zero data, not business-wide totals. Credential-free tombstones are excluded from content and queue counts too. The single-row retry endpoint now rejects paused connections consistently with the queue action endpoint. Arbitrary-URL media creation uses the dedicated `woocommerce.manage` permission rather than an owner/manager role shortcut. Other existing Woo read/manage/sync permission splits are preserved.

Regression evidence includes all ten WordPress Manager handlers denying inaccessible branches before data reads, remote client construction or queue writes, permission-gate short-circuiting, paused-write denials, aggregate scope narrowing, central-library branch filtering/push refusal, and real PostgreSQL allowlist/tenant/tombstone counts. Authorization helpers are real in these route tests; only their database/service boundaries are mocked.

Final validation on the merged source:

* **12,997 unit/component tests passed, 7 skipped**, across **1,002 passing files and one skipped file**, with normal full discovery and one worker.
* The complete previously failing **integration shard 2/6 passed: 528 tests across 43 files**. The earlier local memory-pressure run is not counted as passing evidence; this clean rerun did not run a typechecker concurrently or change timeouts.
* Focused real-PostgreSQL runs also passed **179 tests across 10 files**: shift orders, WordPress Manager, platform MCP, Woo lifecycle/authorization, tenant MCP approval/grants, Holoo, website/CMS sync, fiscal periods and restore readiness. These overlap the shard and are not claimed as additional unique tests.
* Repository TypeScript `--noEmit`, ESLint for all changed JavaScript/TypeScript files and `git diff --check` passed. TypeScript ran separately after the database suites; this 4 GiB sandbox needed a 3,400 MiB old-space cap and 4 MiB semi-space, with no compiler-policy changes.
* MCP matrix regenerated for **1,066 routes, zero unclassified routes**. Both existing review threads were rechecked as resolved.

The current main's desktop version, migrations and **646 MiB** unpacked / **175 MiB** installer budgets are inherited unchanged; this PR does not introduce a budget increase relative to that base. Historical 644 MiB measurements above describe the earlier commits, not a fresh package measurement of this merged source. Fresh Windows/build/aggregate CI must certify the pushed head. Real-provider infrastructure and physical desktop/accessibility verification retain the release-environment boundaries stated above.

### Subsequent taxonomy/main merge verification

Merged main **4ca03744** (taxonomy work and desktop v1.0.81) after the validation at `24050dc1` above. Conflict resolutions retain the upstream taxonomy state/statistics, sync action and dual-surface permissions, while applying live tenant/branch authorization to both GET and POST. Paged WordPress requests retain upstream namespace-specific application-password authentication alongside this PR's redirect refusal, timeout and outbound destination policy. The coverage matrix is regenerated from the combined source rather than selecting either conflicting document.

On this combined source, repository TypeScript `--noEmit` passed; **160 focused unit tests across 10 files** and **67 real PostgreSQL integration tests across two files** passed. These include the changed taxonomy/client/snapshot/payload/queue tests, authorization/outbound-policy regressions, Woo catalogue and WordPress Manager suites. Changed-file ESLint and diff checks passed. The larger full-suite/shard counts above remain evidence for `24050dc1`, not a claim that those entire suites were rerun after this subsequent merge. Fresh CI must certify this pushed merge's production build and packaged artifacts.
