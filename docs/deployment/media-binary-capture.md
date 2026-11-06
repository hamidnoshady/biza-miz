# Media binary capture in tenant backups (#903 §7, §8)

**Status: implemented.** A logical backup now carries the bytes behind
`media_assets` beside its payload, encrypted with the artifact's own custody
secret and listed in a signed manifest. `media.attachments` is `included` only
when every attachment was carried; otherwise the backup is `partial` and the
manifest says how many were skipped.

The design note that preceded this (superseded) argued for sidecars over the two
alternatives. That reasoning still holds and is kept below, because "why not
inline the bytes" is a question that will be asked again.

## The constraint that shapes everything

A tenant archive is **one file**: `tenant_archive_v1` is a typed JSON document of
`{ tables: [{ name, columns, rows }] }`, encrypted as a single stream, and the
manifest signs **one** payload (`payload.sha256`, `payload.sizeBytes`). Media
bytes do not live in the database at all — `media_assets.storage_key` points into
an S3-compatible bucket, with a local mirror cache that is a cache, not a source
of truth.

So "capture media" means moving bytes between two storage systems, and every
mechanism around backups is built on the assumption that an artifact is one file
of known size:

| Mechanism | Assumes | What sidecars had to change |
| --- | --- | --- |
| Verification | checksum + signature + archive parse of one object | payload verification is unchanged; sidecars are decrypted and hashed **in the same run**, so a sidecar download only happens at capture, verify-on-demand and restore — never on the lifecycle tick |
| Retention (`expireDueArtifacts`) | delete the row's object, then the row | `<artifact>.media/` is deleted with the artifact, locally and by prefix in the bucket |
| Billing (`backup.storage_byte_day`) | `stored_bytes` of the artifact | `stored_bytes` is payload **plus** sidecars |
| Reclaim (§1, Cloud) | one cloud object, one local twin | the sidecar set is part of the twin; pruning the payload deletes the set |
| Transport (`fetchCloudArtifact`) | fetch one key | unchanged: the payload is still one key, and restore stages the sidecars separately |
| Import (§6) | one payload + one signed manifest | unchanged: the manifest is the index, so a payload imported alone reports its media as not carried |
| Quotas | `MEDIA_MAX_BYTES` per asset | pre-upload caps below keep a backup from exceeding the plan |

## Why not the alternatives

### A. Inline in the archive (base64 per asset)

Media bytes become entries in the JSON archive, encrypted with it.

- **For:** one file stays one file; every existing mechanism keeps working.
- **Against:** base64 costs +33 %, and the archive is built and parsed in memory,
  so a business with 500 photos cannot take a backup at all. A cap small enough
  to keep it safe captures thumbnails and no videos — and video is in scope.
- **Why not chosen:** it cannot carry the media this epic promised, and the cap
  that makes it safe is the cap that makes it useless.

### B. Sidecar objects in the managed destination — **chosen**

Each captured asset is written next to the artifact under the same per-tenant
prefix, named deterministically from the artifact and the asset, and listed in a
versioned manifest (`manifestVersion: 2`).

- **For:** one payload stays one payload, so verification, transport and import
  keep their shape; media can be large, video included; a missing sidecar is a
  `HEAD`/`GET` per asset, not a re-parse of the archive.
- **Against:** an artifact is now N objects, so every place that counts or deletes
  "the artifact" needs the sidecar list — retention, reclaim, billing and the
  artifact's `stored_bytes`. All four were changed in the same PR (#1283).

### C. Re-reference only (no copy)

The manifest records the media object keys and their sha256; nothing is copied.

- **For:** nearly free; survives the common disaster (wrong data restored into a
  healthy bucket).
- **Against:** survives none of the disasters backups exist for — a deleted
  bucket, a cancelled account, a provider switch. It would let a backup be
  labelled "complete" while its media depends on the very bucket that is gone.
- **Why not chosen:** a backup that shares fate with its source is not a backup.

## What actually shipped

Code: `src/lib/tenant-backup-media.ts` (capture · verify · upload · restore ·
delete), `src/lib/backup-manifest.ts` (v2), `src/lib/backup-service.ts`,
`src/lib/tenant-backup-runner.ts`, `src/lib/tenant-backup-lifecycle.ts`,
`src/lib/tenant-restore-apply.ts`, `src/lib/platform-tenant-backup-ops.ts`.

**Layout.** `<artifact>` is the payload's name, and its media lives in
`<artifact>.media/<assetId>.enc` — same directory locally, same prefix in the
bucket. Each file is a POSBKP1 envelope (AES-256-GCM) keyed by the artifact's own
custody secret, so a sidecar opens only with the same key that opens the payload.
There is no index file: the manifest is the index, and it is signed.

**Manifest v2.**

```json
"media": {
  "assets": [{ "assetId": "…", "key": "media/…", "sha256": "…", "bytes": 2048,
               "mimeType": "image/png", "fileName": "photo.png",
               "sidecar": "….enc" }],
  "skipped": 0,
  "storedBytes": 2176,
  "clipped": false
}
```

`sha256` and `bytes` describe the **plaintext** asset, not the ciphertext: they
are the values that can be proved against `media_assets` after a restore. The
version bump is not cosmetic — a v1 manifest carrying `media` is rejected
(`manifest_media_requires_v2`), because the version is what promises the block
exists. Duplicate assets, a sidecar name that could escape its directory, and
non-integer sizes are refused at validation, so a hand-built artifact cannot get
past a peer's check either.

**Caps.** Over a cap is a skip, and a skip is `partial` — never a silently
smaller backup.

| Variable | Default | Over the cap |
| --- | --- | --- |
| `BACKUP_MEDIA_MAX_BYTES` | 2 GiB | asset skipped, `clipped: true` |
| `BACKUP_MEDIA_MAX_ASSET_BYTES` | 512 MiB | asset skipped (not truncated) |
| `BACKUP_MEDIA_MAX_ASSETS` | 300 | remaining attachments counted as `skipped` |

Assets are enumerated **smallest first**. When a budget stops a run, the business
keeps the images that make up most of a catalogue rather than one long video that
happened to be newest — and the manifest says the rest were not carried.

A `media_assets` row whose object is already gone is a **skip**, not a thrown
error: a backup has to survive a bucket that has already lost a file, and say so.

**`ready` means the bytes were proved.** After the payload verifies, every sidecar
is decrypted and hashed against the manifest in the same run. A mismatch records
`media_asset_checksum_mismatch` / `media_asset_size_mismatch` / `media_asset_missing`
on the row, so the console can say *why* rather than showing a generic failure.

**Cloud.** Sidecars upload under the artifact's own prefix after the payload. Any
sidecar failure fails the run (`media_sidecar_upload_failed`): a "complete" backup
that quietly lost its video is exactly the lie this epic exists to remove.

**Restore.** Binaries are written back **after the swap commits**, outside the
transaction — writing objects is network work and a bucket hiccup must not roll
back a database restore that already succeeded. Each step is journalled
(`media_restored` / `media_restore_failed`), so a half-restored business is
visible rather than assumed whole. An asset the restore replaces is copied to
`_restore-quarantine/<artifact>/<assetId>` first, so a restore stays a revert that
can itself be reverted. Assets absent from the manifest are left alone: the
manifest describes this backup, not "everything that should exist".

**Retention and destruction.** Expiry, the prune sweep, and the operator delete
path all remove `<artifact>.media/` with the artifact (#1041). A destroyed backup
whose media stayed in the bucket would be storage billed for bytes no restore can
reach, and — for the operator path — a business's media surviving a destroy it was
told had happened.

## The four owner decisions (answered 2026-11-05)

1. **Is captured media billed?** Yes. `stored_bytes` includes the sidecars, so a
   captured photo or video is not free storage in the byte-day meter.
2. **Cap and scope?** Video is in scope. Caps are pre-upload and per run (table
   above), and hitting one produces an honest `partial` rather than a silent trim.
3. **Restore semantics for an existing asset?** Overwrite, with the replaced
   object quarantined under `_restore-quarantine/`. Overwrite is the only
   behaviour that makes a restore a revert; the quarantine is what makes it safe.
4. **Does #1041 reach into backup sidecars?** Yes — in the same run that deletes
   the artifact.

## Not proved here

- **No live S3 round trip from this environment.** The bucket (ArvanCloud, path
  style → `s3-lite`) is unreachable from the build sandbox, so the adapter paths
  are covered by unit tests and the operator's drill, not by a real PUT/GET here.
- **No populated live drill.** The acceptance suite runs against a real database in
  CI, but a business with real images *and* video restored onto a real bucket is
  still the drill that closes #903.

## Operating it

Turn media capture off for one installation without a code change by setting the
byte budget to something small (e.g. `BACKUP_MEDIA_MAX_ASSETS=1`); the run stays
correct and the manifest reports the skips. After any change to a bucket policy,
the check that matters is unchanged: run a backup, then verify the artifact — a
row that says `ready` must still decrypt to bytes whose sha256 matches the
manifest.
