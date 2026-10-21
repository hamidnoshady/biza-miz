# #941 — WordPress Media reliability work / rollout gate

Status: **partial implementation; draft, not acceptance-complete**. Keep #941 open
until the remaining work and live evidence below are complete. `/media` remains
the only canonical file store. No new library, queue, or schema is introduced.

## Implemented

- Shared REST `requestPage` now uses the same namespace-sensitive authentication
  as `request`. Media collection regressions cover view/edit contexts, missing
  WP credentials, HTTP 401/403, and unchanged Woo authentication. This is the
  single shared-client fix also required by #940; do not add a second media
  client or cherry-pick a competing implementation.
- Plugin queues a fresh attachment payload **after** stamping operation meta.
  This bypasses the hook's `already_seen` guard. Retrying an already tagged
  attachment re-enqueues its confirmation; inability to queue confirmation
  fails the job so the normal retry path can recover. Operation lookup includes
  private/trashed attachments rather than creating a copy after status changes.
- Canonical pushes lock the canonical asset row (including the first push,
  when no mapping exists) and coalesce pending, failed/ambiguous, and synced
  mappings. Outbox insert, mapping write, and audit commit in one tenant
  transaction. Queue retries keep the original operation; clicking again does
  not create an unrelated operation. After a confirmed remote deletion a new
  push can create a new attachment. Intentional replace/create-copy is **not**
  implemented or advertised.
- Mapping confirmations explicitly require the delivering business and
  connection, reject a different remote ID once established, and cannot revive
  a known deletion. Late failure ACKs cannot downgrade a confirmed mapping.
- Remote delete invalidates the matching connection's mapping, clears its
  public URL, and retains its remote ID/error. Trash invalidates without deleting
  the file; a later active update restores a trashed mapping. Canonical storage
  is never deleted. The inbox/outbox and integration audit retain event/job
  history; a later intentional push overwrites the current mapping identity.
- Current image-only importer contract is explicit: JPEG, PNG, GIF, WebP.
  Canonical API and drawer reject/hide other MIME types; URL producer rejects
  unsupported filename extensions before queuing. These are preflight rules,
  not proof of file content; WordPress still validates the actual file.
- URL creation uses `woocommerce.manage`, rather than an owner/manager role
  shortcut. Canonical push requires both `media.manage` and
  `woocommerce.manage`; mapping reads require both view permissions. Read-only
  users are not offered enabled push/sync actions, and paused stores cannot
  use the WP page's creation/sync actions. External mapping links pass through
  `safeWpExternalUrl` before rendering.
- WP Media links to the existing canonical upload/library and existing Queue;
  queue links preserve the selected destination. This is navigation reuse,
  **not** the requested embedded select/upload workflow.

## Evidence actually obtained (2026-10-20)

Environment: Node 22.22.3 (repository requests >=24), npm 10.9.8. `npm ci
--ignore-scripts` installed dependencies; npm reported 18 dependency
vulnerabilities (6 moderate, 9 high, 3 critical). Dependencies were not upgraded
as part of this audit repair.

```
npx vitest run 'src/app/(app)/websites/wp' \
  src/lib/integrations/wp-media.test.ts \
  src/lib/integrations/woocommerce-client.test.ts \
  src/lib/wordpress-media-lifecycle.test.ts src/lib/media-service.test.ts \
  src/app/api/integrations/wp-manager src/app/api/media \
  src/app/dashboard/media/media-manager.test.tsx
# Test Files 20 passed (20); Tests 217 passed (217)

NODE_OPTIONS=--max-old-space-size=3100 npx tsc --noEmit
# exit 0, no diagnostics

npm run test:design
# Test Files 5 passed (5); Tests 38 passed (38)

# eslint on changed TypeScript/TSX files: exit 0, no diagnostics
# git diff --check: exit 0
```

Some existing DOM tests print React `act` environment warnings. The first
TypeScript attempt hit the default Node heap limit; the bounded larger-heap
rerun passed. The route transaction test uses a mocked transaction callback;
it does **not** prove PostgreSQL concurrency or rollback semantics.

### Tests provided but NOT run here

- Database lifecycle regression added to
  `integration/media-library.integration.test.ts`, including wrong-connection
  confirmation, trash/restore, deletion, delayed confirmation, and canonical
  asset survival. Requires the disposable PostgreSQL integration environment:
  `npm run test:db -- integration/media-library.integration.test.ts`.
- `wordpress-plugin/tests/media-create-test.php` exercises real WordPress core
  `media_sideload_image` and `add_attachment` timing, the real plugin queue,
  loss of queued confirmation, and a retry after clearing request state:

  ```
  WP_TESTS_DIR=/path/to/wordpress-tests-lib \
    phpunit --bootstrap wordpress-plugin/tests/bootstrap.php \
    wordpress-plugin/tests/media-create-test.php
  ```

  Provision a **disposable** WP core PHPUnit database/test suite and the matching
  PHPUnit/polyfills first. PHP, PHPUnit, WordPress core, and that database are
  not installed in this sandbox. This is supplied coverage, not live evidence.
- No PHP syntax check, live WordPress, browser E2E, visual/mobile/RTL interaction
  run, migration run, or CI success is claimed.

## Remaining acceptance gates

1. **#926 dependency:** queued payloads still contain enqueue-time 900-second
   presigned URLs. Adopt the shared asset-identity + authorized lease-time URL
   implementation; verify delayed/paused/retried jobs and queue/log redaction.
   Do not ship this draft as fixing the 15+ minute delay requirement.
2. Complete authoritative plugin snapshot protocol with generation IDs,
   delivery completeness and concurrency safety; current completion markers
   must not be used to prune partial exports. Stable mirror pagination,
   thumbnail metadata/fallback and remote-mirror tombstones remain outstanding.
3. Deletion before the *first* identity confirmation is not fully reconciled.
   Older active updates after trash can still restore trash without event
   ordering/version checks. REST pruning also needs mapping reconciliation.
4. Concurrent/expired plugin leases and a process crash between importer
   creation and operation-meta stamping still need an atomic plugin-side
   creation/idempotency protocol. The change here repairs the confirmed
   **post-stamp hook ordering** problem; it does not eliminate that crash window.
5. Canonical delete/restore/replacement/rename semantics and durable mapping
   history/usage consequences remain to be designed and tested.
6. WordPress-boundary hardening remains: explicit host/IP/redirect/DNS-rebinding
   policy, size limits, timeouts, mismatch/404/oversized tests, scoped rate limits
   and URL redaction. Existing core importer validation is not claimed as a
   complete policy. No audio/video/PDF/SVG upload support is advertised.
7. Embedded canonical selector and local multi-file upload/push with progress,
   cancellation/retry/dedupe; intentional remote import/link; destination and
   mapping status within the gallery remain outstanding.
8. Attachment detail, confirmed metadata editing, usage-aware delete/restore,
   replacement, bounded bulk actions and reliable per-item failures remain
   outstanding. Do not repurpose `media_create` as a metadata edit operation.
9. Complete permission/entitlement/custom-role/stale-handshake matrix and
   tenant-isolation integration tests; real concurrent double clicks/users,
   partial DB writes, S3 failure, multiple stores, 1,000+ attachments and
   15+ minute queue delays.
10. Run and attach real WP, browser E2E, PHP and full CI evidence on supported
    Node >=24; complete RTL/mobile/a11y and visual review before ready-for-review.

## Rollout / rollback

No migration or data backfill is required. Deploy server and plugin together
only after the above acceptance gates are satisfied. Until then keep this PR
in draft; existing queued/failed operations must be retried with the same
operation ID (not recreated). Existing unconfirmed mappings are not
retroactively guessed or automatically copied.

Rollback: revert this code/plugin deployment together. No schema rollback is
needed. Mapping states reuse the existing pending/synced/failed CHECK; the new
remote-deletion/trash error codes remain readable by older code. Do not delete
outbox/inbox rows or canonical objects as a rollback step. Older plugin code
reintroduces the confirmation timing defect, so pause pushes while rolling
back and retain affected operation IDs for reconciliation.

## Continuation (2026-10-21; supersedes the implementation list above)

The follow-up on the same PR integrates main/#1034 (#926) rather than forking
its shared lease resolver. Canonical jobs now contain only `__mediaAssetId`,
operation identity and title. Added tests advance time by 20 and 40 minutes
and check fresh lease URLs, paused stores, deleted assets and storage failure.

Added migration `0235_wp_media_lifecycle.sql`: tenant-scoped attachment revision
watermarks/tombstones, per-generation export manifests and members, a cursor
index, and the capability-negotiated `media_update` queue operation. Plugin
exports use ID keysets with a captured upper bound, unique generation keys,
contiguous member ordinals and a counted completion marker. Server pruning is
transactional and only runs after every member arrived; newer live revisions
and rows updated after snapshot receipt survive. Gallery cursor paging now
uses immutable `(created_at,id)` positions with a fixed upper timestamp and
filter/connection binding. Thumbnails come from validated WP thumbnail metadata.

Plugin creation now requires InnoDB for posts, postmeta, options and queue,
serializes concurrent operation attempts with a connection-scoped advisory
lock, and commits attachment/meta/confirmation together. Rollback cleans up
files on caught failures; a hard process kill can leave unreferenced files on
WordPress disk, but no committed untagged attachment row. Added a real-core
PHPUnit rollback fault injection at the import-to-meta boundary.

New attachment event handler serializes mirror and mapping reconciliation,
rejects old revisions (including same-second edits), and preserves permanent
deletion tombstones. A late first confirmation identifies a pending mapping
against an already-known tombstone. REST media fallback views no longer prune
private/trash rows; authoritative removals invalidate remote mappings.

URL importing is now a WordPress-boundary bounded cURL implementation: public
DNS/IP validation, per-hop redirects, DNS address pinning, no proxies or user
credentials, default ports only, no HTTPS downgrade, TLS verification, bounded
redirects/time/bytes, actual image MIME/header matching, safe filenames and
temporary-file cleanup. Creation/edit job quotas use a tenant advisory lock
inside the enqueue transaction; audit records omit download URLs.

The page embeds the existing canonical picker/uploader (including its upload
progress/cancellation/retry/hash dedupe) and bounded multi-asset push, resets
selection on site switches, and polls the existing Queue in-page. Added an
accessible detail dialog with preview, metadata, file identity, mapping, usage
inspection, confirmed metadata edits, remote-only trash/restore, and per-job
results. Bulk inspect/trash/restore is bounded to 20. WordPress rechecks product
featured/gallery and post/page/product content references at execution time;
custom plugin/external references are explicitly not claimed to be exhaustive.
Trash must be enabled on WordPress; zero-day/disabled trash never falls back to
permanent deletion. Unsupported replacement/rename/permanent-delete operations
are not advertised as available.

Evidence obtained during this continuation:
- PostgreSQL integration: 54/54 tests passed against PostgreSQL 16.14, including
  complete/out-of-order vs partial snapshots, newer concurrent mutations,
  tombstones before confirmation, trash ordering, immutable cursor positions
  and cross-tenant isolation.
- Focused Vitest: 230 tests / 22 files passed before adding the new command
  route's 11 passing tests. Lease-time regressions passed.
- Design suite: 38/38 checks passed after adopting shared loading skeletons.
- TypeScript and changed-file ESLint: passed during implementation.
- PHP 8.5.10 WASM CLI: syntax checks passed on changed PHP files and 14
  deterministic URL/IP/DNS policy assertions passed. This is PHP execution,
  not a claim that native MySQL WordPress PHPUnit has run locally.
- Added `.github/workflows/wp-media-phpunit.yml` to provision actual WordPress
  6.8.3, native PHP 8.3, PHPUnit 9.6 and disposable MySQL 8.0, and upload JUnit
  evidence. Its result must be obtained and reviewed before removing draft.

Remaining rollout gates: actual WP PHPUnit result; browser evidence for the new
WP flows (not merely existing canonical media E2E); concurrent/kill/restart
stress beyond the fault-injection test; URL redirect/size/timeout integration
fixtures; and review of migration/rollback and the new workflows. Retain draft
until those checks are satisfied. This document records progress, not an
assertion that every original #941 acceptance criterion is complete.
