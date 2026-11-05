# Media binary capture in tenant backups (#903 §7, §8)

**Status: proposal, not implemented.** Today media is disclosed, not captured:
`backup-manifest.ts` declares `media.metadata` as `included` (the rows) and
`media.attachments` as `excluded` with a row count, so a backup is marked
`partial` whenever a business owns any media. Nothing claims those bytes are
recoverable, and no restore touches them. This document is the decision the last
open item of #903 is waiting on.

## Why this is not a small change

A tenant archive is **one file**: `tenant_archive_v1` is a typed JSON document of
`{ tables: [{ name, columns, rows }] }`, encrypted as a single stream, and the
manifest signs **one** payload (`payload.sha256`, `payload.sizeBytes`). Media
bytes do not live in the database at all — `media_assets.storage_key` points into
an S3-compatible bucket that the media library writes to, with a local mirror
cache (`media-mirror.ts`) that is a cache, not a source of truth.

So "capture media" means moving bytes between two storage systems, and every
mechanism around backups is built on the assumption that an artifact is one file
of known size:

| Mechanism | Assumes | Breaks if media rides inside the payload |
| --- | --- | --- |
| Verification | checksum + signature + archive parse of one object | a 40 MB video turns every verify into a 40 MB download |
| Retention (`expireDueArtifacts`) | delete the row's object, then the row | bytes and rows diverge unless sidecars are tracked |
| Billing (`backup.storage_byte_day`) | `stored_bytes` of the artifact | media would be billed at zero unless counted |
| Reclaim (§1, Cloud) | one cloud object, one local twin | a directory of sidecars has no twin |
| Transport (`fetchCloudArtifact`) | fetch one key | needs a multi-object fetch and a partial-failure story |
| Import (§6) | one payload + one signed manifest | the Owner would have to keep N files |
| Quotas | `MEDIA_MAX_BYTES` per asset | a backup could exceed the plan's allowance |

None of these is unsolvable, but each has to be decided rather than discovered.

## The three options

### A. Inline in the archive (base64 per asset)

Media bytes become entries in the JSON archive, encrypted with it.

- **For:** one file stays one file; every existing mechanism keeps working
  untouched — verification, retention, billing, reclaim, transport, import.
- **Against:** base64 costs +33 %, and the archive is built and parsed in memory,
  so a business with 500 photos cannot take a backup at all. A 2 MB cap keeps it
  safe but makes it a toy: it would capture thumbnails and no videos.
- **Verdict:** acceptable only as a *bounded* first slice (`MEDIA_INLINE_MAX_BYTES`,
  say 1 MB, captured assets only), with everything above the cap still
  `excluded`. Honest, cheap, and it would not close the epic's §7 line.

### B. Sidecar objects in the managed destination (recommended)

Each captured asset is written next to the artifact under the same per-tenant
prefix, named deterministically from the artifact and the asset, and listed in a
**versioned manifest** (`manifestVersion: 2`, `assets: [{ key, bytes, sha256 }]`).
The manifest is signed, so the list itself is tamper-evident; each object is
encrypted with the same custody generation as the payload.

- **For:** one payload stays one payload, so verification, transport and import
  keep their shape; media can be large (video included); the read-back check for a
  missing sidecar is a HEAD per asset, not a download.
- **Against:** an artifact is now N objects, so every place that counts or deletes
  "the artifact" needs the sidecar list. Retention, reclaim, billing and the
  artifact's `stored_bytes` all change.
- **Cost of getting it wrong:** the §1 Cloud guarantee ("nothing persistent on the
  app server") and the retention floor both live in that bookkeeping.

### C. Re-reference only (no copy)

The manifest records the media object keys and their sha256; nothing is copied.
Restore re-links the tenant's rows to objects that are already there.

- **For:** nearly free; no duplication, no billing impact; survives the common
  disaster (wrong data restored into a healthy bucket).
- **Against:** survives none of the disasters backups exist for — a deleted
  bucket, a cancelled account, a provider switch. It would let a backup be
  labelled "complete" while its media depends on the very bucket that is gone.
- **Verdict:** worth having *as an additional check* (verify the referenced
  objects still exist, and label `unavailable` when they do not), never as the
  capture mechanism.

## Recommendation

**B, in three stages**, with `media.attachments` staying `excluded` until stage 3
finishes — the label must never run ahead of the behaviour.

1. **Reference check (small, no format change).** During capture, count the
   assets whose `storage_key` object still exists versus missing, and report the
   component honestly: `excluded` while nothing is captured, with the missing
   count surfaced through the existing diagnosis codes so the console can say
   "this business references media that is already gone". Bounded (HEAD per
   asset, capped per run) so a large library cannot turn a backup tick into a
   network crawl.
2. **Sidecars, Local and Hybrid.** Capture assets up to a documented cap into the
   artifact's own directory/prefix, add `manifestVersion: 2` with `assets[]`,
   teach `verifyStoredArtifact` to check the list, and make retention delete
   sidecars with the artifact. Billing counts their bytes into the artifact's
   `stored_bytes` so a captured photo is not free storage.
3. **Cloud, restore, and the remaining profiles.** Apply writes captured assets
   back through the media storage adapter (`buildMediaKey`, same validation as an
   upload), never overwriting an existing object without recording what it
   replaced; the Cloud reclaim path treats the sidecar set as the twin's
   counterpart; import keeps requiring the manifest, so a lone payload imports
   with media reported as `missing` rather than silently partial.

## Decisions only the owner can make

1. **Does captured media count against the plan's storage allowance and the
   byte-day meter?** Billing it is truthful (the platform is retaining it) but it
   makes a photo-heavy business's backup cost real money; not billing it hides
   cost in the margin report.
2. **Cap and scope:** images only, or video too? A per-run byte budget
   (say 500 MB) protects the scheduler but silently makes some backups partial —
   the label has to say which.
3. **Restore semantics for an existing asset:** overwrite, skip, or write beside
   with a new id? Overwrite is the only one that makes a restore a *revert*, and
   the only one that can destroy bytes that were newer than the backup.
4. **Interaction with #1041:** if a service is disabled and its media is purged,
   does that purge now reach into backup sidecars too?

Until these are answered, the honest state is what ships today: media rows are
captured, media bytes are `excluded`, the backup is labelled `partial`, and no
restore claims otherwise.
