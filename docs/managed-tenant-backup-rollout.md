# Managed tenant backups (#903): rollout boundary

## Required deployment policy

| Trusted profile | Persistent destinations | Backup scope |
| --- | --- | --- |
| Cloud | Platform-managed encrypted cloud copies only | RLS-scoped business snapshot |
| Hybrid | Installation-local + platform-managed encrypted cloud copies | Typed site-physical or central-logical; never interchangeable |
| Local | Installation-local only; no cloud upload or cloud storage charge | Single-business physical backup |

Process role and business deployment profile are different. Resolve both server-side;
never trust a destination, role or business ID supplied by a tenant. Preserve #807:
central tenant operations must never invoke physical whole-database replacement.
Platform disaster recovery is a different subsystem, not tenant inventory.

## Implemented boundary

`/api/backup/config` now returns an explicit tenant schedule DTO, not a masked
supplier configuration. PUT accepts only `enabled`, `intervalHours`, `anchorTime`;
unknown fields (including credentials, destination paths, encryption controls and
retention) are rejected, not silently ignored. Historic stored encryption and
connection settings remain unchanged. Old clients submitting a full config must
refresh. No key migration occurs in this change.

Tenant settings UI contains no connection form or encryption configuration.
`/api/backup/status` no longer serializes artifact paths/object keys or underlying
provider/database errors; internal diagnostics remain in the existing operator
records. Config and status responses are non-cacheable. Historical SQL/XLSX
exports are explicitly not advertised as automatically restorable backups.

## Not a production managed-backup rollout

This security foundation does **not** meet the full epic's definition of done.
Do not advertise managed encryption, portable disaster recovery, managed-only
cloud persistence, or central logical restore as available based on this patch.
Existing storage behavior, billing and restore artifact APIs still require work.
The existing central physical-restore refusal remains mandatory.

Remaining dependent delivery gates:

1. Operator-only tenant-service configuration/capabilities and approved policy
   limits, separate from platform-wide DR. Audit every response (including legacy
   restore inventory/errors), not just config/status, for infrastructure disclosure.
2. Signed/versioned typed manifests, scoped inventory + RLS, encrypted staging,
   managed storage adapters, bounded resumable upload/download/verification and
   cleanup; explicit legacy import/backfill rather than reclassification of SQL.
3. Versioned envelope keys, isolated recovery custody, rotation and portable
   exports; preserve decryptability of historic passphrase artifacts. Never
   invent a DB-only master key or silently fall back to plaintext.
4. Central tenant-only typed-data restore with preview, reauthentication,
   checkpoint, durable journal/lock, target-only write pause, atomic replacement,
   accounting verification and rollback. Never execute uploaded arbitrary SQL.
5. Hybrid durable upload reconciliation, truthful offline availability and sync
   generation fencing; Local must have no outbound cloud path.
6. Existing wallet/catalog integration: successful-only fair settlement,
   idempotent byte-time metering and allowance/retention enforcement. Current
   pre-work manual charging remains an explicitly unresolved gate.
7. Scoped Superadmin `/platform/businesses/[id]/backups` page and APIs with
   separate read/export/restore capabilities, audit and canonical billing links.
8. Component coverage manifest for media and external website state, with honest
   partial/unavailable labels; isolated multi-tenant recovery drills and the full
   cloud/hybrid/local fault-injection and billing matrix before rollout.

## Validation of this slice

- 81 focused contract, architecture, encryption stream and backup tests pass.
- Changed TypeScript/TSX files pass ESLint.
- `tsc --noEmit` passes with a 4 GiB heap (default heap exhausted).
- Full build, database integration and disaster-recovery drills were not run.
- Sandbox Node is 22; the repository requires Node >=24. Production validation
  must use the supported runtime.
