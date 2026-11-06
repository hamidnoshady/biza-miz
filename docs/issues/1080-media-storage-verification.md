# #1080 — media storage follow-up

## Delivered

- A saved `forcePathStyle` flag (default **true**, matching all historical media
  requests) drives both SigV4 request signatures and presigned reads. False uses
  `bucket.endpoint`; endpoint, region, prefix, bucket and credentials are unchanged.
- Both the platform health probe and tenant uploads read the same saved setting.
  The console exposes the flag and tells operators to save before testing.
- Migration snapshots and rollback preserve addressing. The old unused
  `previous_force_path_style` column defaulted to false even though historical
  media writes were path-style. A separate nullable snapshot column avoids
  reinterpreting or rewriting those old records; NULL means legacy path-style.
- Object writes occur before BEGIN. Only tenant-scoped duplicate resolution and
  metadata insertion occur inside the transaction. Failed INSERT/COMMIT and
  duplicate races compensate the newly staged object.
- Uploads hold a shared session advisory lock against migration/rollback's
  exclusive lock. They reread configuration after acquiring it, preventing a
  stale request from writing to a source that already cut over. Failed unlocks
  evict the session. No migration or rollback was executed during development.
- An aborted tenant upload removes its staged object before committing metadata.
  Already completed uploads are not undone by a later client disconnect.
- The tenant UI displays a localized failure stage separately from the safe
  error message/support reference.

## Local verification

The HTTP fixture in `src/lib/media-virtual-host.integration.test.ts` rejects
path-style addressing, independently verifies SigV4 against received Host/URI/
payload bytes, and accepts virtual-host requests. It runs the real seven-step
health probe, including temporary disk spooling and cleanup, then buffered and
streamed tenant-shaped writes/reads/deletes at 1 MiB minus one byte, 1 MiB plus
one byte and 4 MiB. This is **not** a live-provider staging result.

Media unit/API/UI/consumer regressions can be run with:

```sh
npx vitest run media src/lib/s3-lite.test.ts src/lib/s3-lite-upload.test.ts --maxWorkers=2
npm run lint
```

The full-repository TypeScript check exceeds the 4 GB sandbox memory budget.
Scoped checking of changed media modules, tests and their imported dependencies
passes. The production build was killed with exit 137 during webpack compilation
in the same sandbox. Provider/database/browser E2E verification and a CI build
remain deployment gates.

## Required staging gate (not performed here)

1. Use an isolated staging deployment with the production application build and
   existing provider configuration. Do not paste credentials into logs or chat.
   Do not run migration, rollback, orphan deletion or provider-switch workflows.
2. Deploy the additive schema through the normal reviewed deployment process.
   The development session did **not** execute SQL migrations or rewrite data.
3. Capture the failing POST's support reference and structured server stage/code/
   status before attributing the production symptom to addressing. Virtual-host
   support fixes the demonstrated compatibility gap, not a confirmed incident.
4. Without changing endpoint/bucket/region/prefix/credentials, have the operator
   explicitly choose addressing only if the provider requires it. Save, then run
   the console health probe. Verify every step including cleanup succeeds.
5. Upload representative PNG/JPEG and a permitted larger file, around both sides
   of the 1 MiB threshold. Verify the new tenant row, library listing, preview,
   download, content hash, folder assignment, duplicate behavior and cancellation.
6. Run the existing Media E2E suite only against disposable staging fixtures.
   It requires a running seeded server/PostgreSQL and modifies test records.
   Database integration suites create databases and run migrations; they were
   deliberately not executed under this issue's no-migration instruction.
7. Reconfirm tenant A/B isolation and shared-consumer flows (Accounting, CRM,
   Workspace, AI and WordPress); coordinate independent WordPress/WooCommerce
   work with #941/#951 rather than adding another media storage implementation.

No production access or configured-provider staging access was used. Acceptance
criteria requiring those environments must remain unchecked until evidence is
attached. As with the existing implementation, an indeterminate COMMIT outcome
or a failed compensating DELETE needs operational reconciliation; database and
S3 cannot provide a single atomic transaction.
