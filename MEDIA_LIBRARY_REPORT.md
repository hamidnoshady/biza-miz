# Media Library — Session Report

**Branch:** `arena/01a0d95b-cafe-restaurant-pos`
**Base:** `81c29c4` (`main`)
**Scope of the originating request:** a complete, platform-wide, end-to-end Media
architecture rebuild (audit → schema → services → folders/collections/tags →
search/filters → upload/picker/lightbox → AI editing/generation → OCR/document
intelligence → migration of every app-specific media path → permissions → dead-code
removal → full test pyramid → CI → two audits → final report).

## A. Executive summary — read this first

**This is not the ground-up platform rebuild the original prompt describes**, and this
report does not claim it is. What shipped across this multi-session effort is a real,
test-covered, materially-more-consolidated Media Library than the one this branch
started from — with specific, named gaps that are listed honestly in Section V rather
than folded into vague "limitations" language.

What actually changed, in the order it was built:

1. **Bug-fix and consolidation pass** (first session, commit `6e37921`): fixed the named
   permission bug (cashier/waiter/kitchen images breaking), the pagination ceiling, added
   tenant-scoped SHA-256 duplicate detection, usage-aware safe delete, cycle-guarded
   folder moves, a wallet preflight in front of the paid AI enhance call, and rewrote the
   media manager and the universal picker around a shared debounce/cancel/pagination
   pattern.
2. **Phase 2 schema + features** (migration `0174`): trash/soft-delete with a retention
   purge tick, collections as a first-class concept distinct from folders and tags, and a
   `wordpress_media_mapping` table recording which canonical asset corresponds to which
   connection's remote WordPress attachment. All three are wired end-to-end at the
   service layer and in the manager UI — the WordPress mapping table's producer route,
   plugin-side confirmation loop and drawer UI were built in a later follow-up session
   (item 7 below; Section K).
3. **Deterministic transforms** (migration `0175`, this session): crop/rotate/resize as a
   free, local, non-AI tier (`sharp`), producing new `transformed` derived assets with
   `source_asset_id` provenance and `transform_ops` history, wired into
   `POST /api/media/[id]/transform` and into the manager UI — rotate, resize, and (added
   later this session, see Section L) a drag-to-select crop rectangle over the drawer's
   preview image.
4. **Storage orphan reconciliation** (this session): `scripts/media-reconcile-orphans.ts`,
   a real, runnable, tested maintenance script — not a placeholder — that finds bucket
   objects no row claims (the two documented crash windows in
   `storeMediaAsset`/`deleteMediaAsset` that can produce one) and objects a row claims
   that no longer exist, without ever deleting a database row.
5. **MIME/byte-signature centralization audit** (this session): found and removed two
   real instances of duplicated byte-signature-check logic (`business-logo.ts`,
   `website/content-service.ts`) by delegating to the canonical
   `hasMatchingMediaSignature` in `src/lib/media.ts`; found and fixed one genuine,
   previously-unguarded trust-boundary gap — a CRM party's profile image had **zero**
   server-side format/signature validation before this session (client-side `file.type`
   checks only, trivially bypassable) — see Section O.2.
6. **Central uploader** (follow-up session): `src/lib/media-uploader.ts`, a
   bounded-concurrency/retry/cancel engine both the manager and the universal picker now
   call for `POST /api/media` instead of each running its own bare sequential `fetch`
   loop — closing the single largest concretely-scoped gap this report had previously
   named. Found and fixed a real bug while wiring it in: the manager's upload failure
   summary was being silently erased by its own subsequent `reload()` call (Section J).
7. **WordPress push** (follow-up session): the producer the mapping table was missing.
   `POST /api/media/[id]/wordpress` pushes a canonical asset to a connected plugin-mode
   WooCommerce store via a short-lived presigned bucket URL (`presignS3Get`, new); the
   plugin (v1.6.4) echoes the push's operation id back on the resulting attachment event,
   closing the loop to `confirmWordPressMediaSync`/`failWordPressMediaSync`; the asset
   drawer shows per-connection push status. See Section K.
8. **Section H correction + a coverage gap it exposed** (follow-up session): found and
   retracted a false claim in an earlier draft of this report — the AI-tagging
   `pending_review`/`confirmed`/`rejected` review-workflow was *already implemented and
   correct*, not "never implemented" as previously (and wrongly) stated. That audit
   surfaced a real gap the false claim had masked: the route that persists the
   confirm/reject decision had zero tests. Added
   `src/app/api/media/[id]/route.test.ts` (19 tests). See Section H, Section U item 14.
9. **Visual folder explorer, mobile drawer, active-filter chips** (follow-up session):
   `FolderTreeExplorer` renders the whole folder hierarchy at once (not one level at a
   time), reused inline (desktop) and inside the app's existing `Sheet` drawer (mobile),
   against the CRUD endpoints that already had cycle/depth/cross-tenant safety. A
   removable active-filter-chip row was added over the existing dropdown filters. See
   Sections F, I, Section U item 15.
10. **AI editing expansion: background removal, upscale, variations** (this session,
    migration `0176`): three new derived-asset AI operations beyond crop/rotate/resize
    and the existing "enhance" call, following the exact wallet-preflight-before-cost
    pattern the enhance route already used. `POST /api/media/[id]/bg-remove` and
    `POST /api/media/[id]/upscale` are single-asset, same-price-as-enhance flows
    producing one new `bg_removed`/`upscaled` asset each; `POST /api/media/[id]/variations`
    produces up to `MEDIA_VARIATIONS_COUNT = 3` new `variation` assets in one call,
    all sharing `source_asset_id`, charged per image the provider actually returned
    (never per the count requested, in case a provider returns fewer than asked). All
    three are wired into the asset drawer next to the existing enhance button, gated to
    `variant === "original"` assets only (consistent with the existing enhance button's
    own restriction, so a derived asset is not offered a second uncontrolled round of AI
    edits from this drawer). See Sections D, L, Q, T, U item 16.
11. **OCR/document intelligence: receipt photo → expense** (this session, migrations
    `0177`, `0178`): the first genuine "centralized OCR consumed by an app" instance —
    Accounting's expense form can now upload a receipt photo, which is extracted by a
    metered AI call, stored as a deduplicated Media Library asset
    (`source: "ocr_receipt"`), and durably linked from the expense it produces
    (`receipt_asset_id`), reusing the existing usage-reference safe-delete/permission
  pattern menu/inventory items already had rather than inventing a parallel one. See
  Sections D, M, N, O.1, Q, T, U item 17.
12. **Invoice-OCR test-coverage gap closed** (this session, no schema/behaviour change):
    `ai-invoice-ocr-service.ts` and `POST /api/ai/invoice-ocr` had zero tests despite
    being a real, in-use purchases-flow route (only their pure prompt/parser half was
    covered). Added 17 tests across two new files following this codebase's existing
    `vi.mock("./db", () => ({ query: vi.fn() }))` convention, closing the gap ahead of
    the storage migration in the very next step. See Sections M, T, U item 18.
13. **Invoice-OCR migrated onto canonical Media storage** (this session, migrations
    `0179`, `0180`, immediately after item 12): the second genuine
    "centralized OCR consumed by an app" instance, mirroring item 11's receipt-photo
    pattern exactly rather than inventing a second design. `POST /api/ai/invoice-ocr`
    now persists the scanned invoice photo as a deduplicated Media Library asset
    (`source: "ocr_invoice"`) and returns it in the response; the draft purchase it
    produces keeps a durable, safe-delete-aware pointer to it
    (`purchases.invoice_asset_id`), reusing `inventory.view` — the same permission an
    inventory item's own photo already required — for the matching exception on
    `GET /api/media/[id]/file`, rather than inventing a new permission. This closes the
    "invoice-OCR still ephemeral by design" gap this report previously listed under
    Section V as open. See Sections D, M, N, O.1, Q, T, U item 19.
14. **CRM party avatar migrated onto canonical Media storage** (this session, migration
    `0181`, immediately after item 13): the fourth per-flow migration this session, and
    the one this report's own Section V had listed as open the longest. A new avatar
    upload in the party form now goes through the same `MediaImageField`/
    `MediaPickerDialog` every catalogue item's photo already used, becoming a real,
    tenant-scoped, deduplicated Media Library asset (`parties.profile_image_asset_id`)
    instead of a second base64 store living inside the `parties` row; the pre-existing
    `profile_image` text column (a `data:`/`https://` value, migration `0137`) is kept
    for backward compatibility and genuine external links, made mutually exclusive with
    the new column at the write layer rather than dropped. `GET /api/media/[id]/file`
    gained the matching `parties.view` usage exception. This closes the "CRM party
    avatars ... still independent" gap this report previously listed under Section V as
    open. See Sections D, N, O.1, O.2, T, U item 20.
15. **Workspace audited for the first time this session; one real UI bug found and fixed**
    (Section N, T, U item 21): grepped every Workspace entity (documents, contracts,
    tasks, comments, approvals, calendar, templates) for a media reference — only
    `workspace_documents.media_asset_id` has one, and it already pointed at a real Media
    Library asset from a pre-existing migration (`0149`), so there was no storage
    duplication left to migrate. What the audit did find: `documents-section.tsx` stored
    and displayed a document's `mediaAssetId`/file name correctly but never offered a way
    to actually open the file — the register's whole point (a title, a version, a review
    state, *and the file itself*) was one click short of usable. Fixed with a direct
    `mediaFileUrl(id)` link in both the document row and its edit dialog, six new RTL
    tests pinning the fix (and that the row's link opens the file without also triggering
    the row's own edit-dialog handler). No schema or permission change: a workspace
    document's file is `kind='document'` in the ordinary case, and Section O.1's
    always-require-`media.view`-for-documents rule already covers it by design.
16. **Version-history (lineage) UI — closed** (this session, no schema/migration
    change: `source_asset_id` already existed on every derived asset since migration
    `0174`, this item only reads it): every AI or deterministic edit (`enhance`,
    `bg_removed`, `upscaled`, `variation`, `transformed`) has recorded its parent since
    the moment it was created, but nothing surfaced that chain. Added
    `getMediaAssetLineage` (`src/lib/media-service.ts`, walks `source_asset_id` upward to
    the root and separately finds every direct child), `GET /api/media/[id]/lineage`
    (same `withTenantScope`/`media.view`/404-via-`getMediaAsset` shape as the existing
    `usage` route), and a "سابقهٔ نسخه" panel in the asset drawer — lazily fetched the
    same way the existing "usage" panel already is, rendering only when an asset actually
    has ancestors or descendants, linking every ancestor and descendant to its own file.
    This closes the "no version-history UI" gap Section L (background
    removal/upscale/variations) and Section L's deterministic-transforms subsection had
    both explicitly disclosed as not built. See Sections L, T, U.
17. **Real CI checked for the first time this session — found red, partially fixed**
    (Section U item 23, Section V): every prior session's "full suite green" claim was
    true of this sandbox's own Linux run, never of the real Windows CI `gh run list`
    shows this branch's pushes actually gate on. It had been failing since commit
    `6778b46`, 12 pushes back, for two unrelated reasons: a `execFile("npx", ...)` call
    in `media-reconcile-orphans.integration.test.ts` that cannot launch on Windows
    (`npx.cmd`, not `npx.exe`) — fixed this session with the same `shell: isBatch`
    pattern `src/lib/pg-tools.ts` already used; and a genuinely stale, but honestly
    describable, `accounting-expenses` visual baseline predating item 11's receipt-upload
    control — left open because re-recording it needs a headless Chromium and a
    `workflow_dispatch` trigger this sandbox/session has neither the network access nor
    the GitHub permission to produce, not because it was deprioritized.

It did **not** touch: the canonical-asset-schema redesign beyond the additive columns in
`0174`–`0181`, a full naming-system rebuild, CRM business-card scanning or Workspace
contract extraction (neither feature exists yet to migrate onto the now-twice-proven
OCR-to-canonical-storage pattern), a shared "document-intelligence" abstraction above the
two independently-built `runReceiptOcr`/`runInvoiceOcr` services, dead-route removal, or
E2E/mobile/accessibility/performance tests/CI changes. Section V lists these as genuine
open work.

Why the scope stopped where it did: the requested scope is a multi-week, multi-team
program. Given the choice between (a) shipping a shallow, unverified pass across the
entire list and calling it complete, or (b) shipping a narrower set of real,
deeply-verified fixes and stating the rest honestly as not done, this effort took (b) —
consistently, across every session — per the standing instruction that *"the final
report must be an honest accounting — not a claim of literal 100% completion if genuine
constraints prevented it."*

## B. Audit findings acted on (all sessions)

1. **Permission bug (the prompt's named bug):** `GET /api/media/[id]/file` unconditionally
   required `media.view`. Cashier/waiter/kitchen roles hold `menu.view`/`inventory.view`
   but not `media.view`, so a menu/inventory item's own photo failed to load for them.
   Fixed by making the route usage-aware (Section O.1).
2. **Pagination ceiling:** `GET /api/media` had no `limit`/`sort` exposed and the manager
   never advanced past page one — the library was effectively capped at ~60 rows.
3. **No duplicate detection:** every upload created a new row and object, even for
   byte-identical re-uploads in the same tenant.
4. **Unsafe delete:** assets referenced by a live menu/inventory item could be deleted,
   silently breaking their images app-wide.
5. **Unsafe folder move:** nothing guarded against moving a folder into its own
   descendant or itself.
6. **AI enhance had no wallet preflight:** the paid provider was called before checking
   the wallet could cover it.
7. **`detect` route dropped its own result:** AI label detection persisted but the
   response never returned the refreshed asset.
8. **Universal picker had no debounce/cancel/pagination** and could not detect
   duplicates, unlike the manager.
9. **No soft-delete tier:** every delete was a hard delete with no recovery window
   (fixed by `0174`'s trash).
10. **No grouping concept distinct from folders/tags:** the original audit's own
    "این‌ها همه برای کمپین تابستانه‌اند" example — an ad hoc cross-cutting set with no tree
    position — had no home (fixed by `0174`'s collections).
11. **No lightweight image editing at all:** the only image transformation in the whole
    codebase was the paid AI "enhance" call — no free crop/rotate/resize existed (fixed
    by `0175`'s deterministic transforms).
12. **No storage orphan detection:** `deleteMediaAsset` deletes the row **then**
    `s3Delete`s the object and explicitly swallows that second call's failure (by
    design, documented at its call site: "the row is gone... a stranded object costs
    storage, never data exposure") — meaning a transient S3 error already, silently,
    strands an object. `storeMediaAsset` similarly `s3Put`s **before** its `INSERT`, so a
    crash between those two lines strands an object with no row at all. Nothing found
    these. Fixed by `scripts/media-reconcile-orphans.ts`.
13. **Duplicated byte-signature logic:** the exact PNG/JPEG/WebP magic-byte checks were
    hand-copied into three files (`media.ts`, `business-logo.ts`,
    `website/content-service.ts`) — `media.ts`'s own comment already said "extends
    business-logo.ts's rule," acknowledging it. A future hardening change (e.g. closing
    an SVG vector) would have had to be applied three times by hand, or would silently
    diverge. Fixed by de-duplication (Section O.2 / this section, item 14).
14. **Missing server-side validation on a CRM field that reaches `<img src>`:** a party's
    `profileImage` was validated client-side only (`file.type`, spoofable) and had
    **zero** format or byte-signature check on the write path
    (`normalizePartyWrite` in `parties-service.ts` just did `textOf(...)`, no shape or
    signature check) despite the shared pure validator (`isProfileImageValue`) already
    existing in `src/lib/parties.ts` for the client form. A hand-crafted API request
    could store `profileImage: "javascript:alert(1)"` (harmless in a modern browser's
    `<img src>`, but the DB-level "this is a validated image" invariant was simply
    false) or a byte stream that does not match its claimed image type at all. Fixed —
    see Section O.2.

## C. Architecture

The canonical `media_assets`/`media_folders` schema from `migrations/0149` and
`0161_media_asset_provenance.sql` was extended, not redesigned, by two additive
migrations this program produced:

- **`0174_media_library_phase2.sql`** — `media_assets.deleted_at` (trash), two new
  tables (`media_collections`, `media_collection_items`), and a new table
  (`wordpress_media_mapping`). All three are additive: no existing column changed type,
  every new column is nullable or defaulted, and every list/read path was updated in the
  service layer to filter `deleted_at IS NULL` by default so nothing that existed before
  this migration silently changed meaning.
- **`0175_media_deterministic_transforms.sql`** — widens the `media_assets_variant_check`
  CHECK constraint (`original`/`enhanced` → `+ 'transformed'`) and adds
  `media_assets.transform_ops jsonb NOT NULL DEFAULT '[]'::jsonb`.

No table was dropped, renamed, or had a column's meaning changed. Every asset ID that
existed before this program still resolves to the same row with the same data.

## D. Database changes

Three new migration files, all applied and verified against a real local Postgres
(`npx tsx scripts/migrate.ts` on a fresh database, plus the standard
`migrations.integration.test.ts` forward-apply and upgrade-from-a-stale-snapshot paths):

| Migration | Adds |
|---|---|
| `0174_media_library_phase2.sql` | `media_assets.deleted_at`; `media_collections`; `media_collection_items`; `wordpress_media_mapping`; two partial indexes for trash/non-trash listing |
| `0175_media_deterministic_transforms.sql` | Widens `media_assets_variant_check` to include `'transformed'`; adds `media_assets.transform_ops jsonb NOT NULL DEFAULT '[]'` |
| `0176_media_ai_edit_variants.sql` | Widens `media_assets_variant_check` again to include `'bg_removed'`, `'upscaled'`, `'variation'` — no new columns, no new table |
| `0177_expense_receipt_asset.sql` **(new, this session)** | `expenses.receipt_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL` (nullable, additive) + partial index `idx_expenses_receipt_asset`; closes the "invoices/receipts... OCR inputs should live in the canonical library" gap for the one flow that now actually persists a receipt photo (Section M) |
| `0178_media_source_ocr_receipt.sql` **(new, this session)** | Widens `media_assets_source_check` (from `0161`) to also allow `'ocr_receipt'` — the same drop-and-recreate-the-CHECK shape `0175`/`0176` already used for `variant`, applied to `source` instead. Gives a receipt photo its own honest provenance value distinct from `ai_attachment` (a chat-dropped photo) — no chat turn is involved in the receipt-OCR flow at all |
| `0179_purchase_invoice_asset.sql` **(new, this session)** | `purchases.invoice_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL` (nullable, additive) + partial index `idx_purchases_invoice_asset`; the exact same shape as `0177`, one migration cycle later, for the parallel invoice-OCR flow — closes the storage half of what Section M/V previously listed as "invoice-OCR still ephemeral by original design" |
| `0180_media_source_ocr_invoice.sql` **(new, this session)** | Widens `media_assets_source_check` again to also allow `'ocr_invoice'` — the same shape as `0178`, distinguishing a purchaser's scanned invoice photo from an accountant's receipt photo (both `ocr_*`, neither `ai_attachment`) |
| `0181_party_profile_image_asset.sql` **(new, this session)** | `parties.profile_image_asset_id uuid REFERENCES media_assets(id) ON DELETE SET NULL` (nullable, additive) plus partial index `idx_parties_profile_image_asset`; no `source` widening needed since a manually uploaded avatar is `source='upload'`, same as any other picked-from-library photo. Closes the storage half of the CRM avatar gap Section V previously listed as open |

`0177` and `0178` were applied and verified against a real local `embedded-postgres`
instance this session: a full 219-migration forward-apply from empty (fresh
`npm run db:dev:start` + `npx tsx scripts/migrate.ts`), `information_schema`/
`pg_indexes`/`pg_constraint` queried directly to confirm — for `0177` — the column is
`uuid`/nullable, the partial index exists exactly as written, and the FK's delete action
is `SET NULL` (`confdeltype = 'n'`, not `CASCADE`, which would have let purging a photo
silently delete a posted financial record), and — for `0178` — `pg_get_constraintdef`
on `media_assets_source_check` reads exactly
`CHECK ((source = ANY (ARRAY['upload'::text, 'ai_attachment'::text, 'ai_generated'::text, 'ocr_receipt'::text])))`.
Both `migrations.integration.test.ts` paths (clean forward-apply and upgrade-from-`0011`,
7/7) and the complete `test:db` suite (133 files / 1561 tests, 1 pre-existing unrelated
skip) were run against a database with both migrations applied and are unaffected
(Section U). Neither needs an RLS policy of its own — `expenses` and `media_assets` are
already `tenant_isolation`-protected, and both changes are additive column/constraint
edits on already-protected tables.

`0179` and `0180` were applied and verified the same way, one migration cycle later this
same session: a full 221-migration forward-apply from empty, `information_schema`/
`pg_indexes`/`pg_constraint` queried directly confirming — for `0179` — `purchases.
invoice_asset_id` is `uuid`/nullable with the partial index present and the FK's delete
action `SET NULL` (`confdeltype = 'n'`, identical reasoning to `0177`: a purged photo must
never cascade into losing a purchase's stock/financial effects), and — for `0180` —
`pg_get_constraintdef` on `media_assets_source_check` reads exactly
`CHECK ((source = ANY (ARRAY['upload'::text, 'ai_attachment'::text, 'ai_generated'::text, 'ocr_receipt'::text, 'ocr_invoice'::text])))`.
`migrations.integration.test.ts` and the complete `test:db` suite (134 files / 1567 tests,
1 pre-existing unrelated skip) were re-run against a database with all four
`0177`–`0180` migrations applied and are unaffected (Section U item 19). `purchases` is
already `tenant_isolation`-protected; no RLS policy change was needed for either.

`0181` was applied and verified the same way, one more migration cycle later this same
session: a full 222-migration forward-apply from empty (fresh `npm run db:dev:start` +
`npx tsx scripts/migrate.ts`), `information_schema`/`pg_indexes`/`pg_constraint` queried
directly confirming `parties.profile_image_asset_id` is `uuid`/nullable, the partial index
`idx_parties_profile_image_asset` exists exactly as written, and the FK
`parties_profile_image_asset_id_fkey` has `confdeltype = 'n'` (`ON DELETE SET NULL` — a
purged photo must never cascade into losing a CRM contact record). The complete `test:db`
suite (134 files / 1576 tests + 1 pre-existing unrelated skip) was re-run against a
database with all five `0177`–`0181` migrations applied and is unaffected (Section U item
20). `parties` is already `tenant_isolation`-protected; no RLS policy change was needed.

`0176` was verified this session (local `embedded-postgres` instance, no Docker/system
package required — `npm run db:dev:start` then `DATABASE_URL=... npx tsx scripts/migrate.ts`
against a database at `0011`): the migration applied cleanly on top of `0175`, the resulting
`pg_get_constraintdef` on `media_assets_variant_check` reads exactly
`variant = ANY (ARRAY['original','enhanced','transformed','bg_removed','upscaled','variation'])`,
and both the full 217-migration forward-apply from empty and the `migrations.integration.test.ts`
upgrade-from-`0011` path (7 tests) pass. The complete `test:db` suite (133 files / 1557 tests,
1 pre-existing unrelated skip) was also run in full against the same instance and is unaffected.

All three are RLS-protected with the standard `tenant_isolation` policy pattern
(`app_rls_bypass() OR business_id = app_current_business()`), `FORCE ROW LEVEL SECURITY`,
matching every other tenant-scoped table in the schema — `0176` touches no RLS policy since
it only widens a `CHECK` constraint on an already-protected table.

## E. Naming system

Not rebuilt as a formal system this program. The existing
`original_file_name`/`display_name`/`normalized_name`/safe-storage-key logic in
`src/lib/media.ts` is unchanged in shape; `normalizeSearchTerm` (search-time Arabic/
Persian character folding, added in the first session) is a related but distinct helper
— it never rewrites a stored name, only how a search term is matched against one.

## F. Folders

`PATCH /api/media/folders/[id]` accepts an optional `parentId` in addition to `name`, and
rejects a move with `circular_move` (self-parent or move-into-own-descendant) or
`too_deep` (exceeds the max-depth constant) before any row is written, backed by two
pure, unit-tested helpers: `folderDepthOf` and `folderMoveCreatesCycle` (including a
guard against infinite-looping on an already-corrupt cycle in the input data). A visual
tree explorer and a mobile drawer were added in a follow-up session
(`FolderTreeExplorer`, `src/app/dashboard/media/media-manager.tsx`): the whole hierarchy
renders at once — not one level at a time — with expand/collapse per node, reused
inline (desktop) and inside the app's `Sheet` drawer primitive (mobile), against these
same CRUD endpoints; see Section U item 15, Section V.

## G. Collections — distinct from folders and tags

`migrations/0174` added `media_collections`/`media_collection_items`: a named, ad hoc,
renamable set an asset can belong to any number of (or none), with no tree position of
its own — deliberately distinct from a folder (a tree position an asset holds exactly
one of) and from a tag (a free-text label with no first-class identity). Full CRUD is
wired: `GET/POST /api/media/collections`, `PATCH/DELETE /api/media/collections/[id]`,
`POST/DELETE /api/media/collections/[id]/items[/[assetId]]`, `GET /api/media/[id]/collections`
(which collections one asset belongs to). The manager UI lets an operator filter the
library by collection, create/rename/delete a collection, and add/remove the current
selection to/from one via the bulk-action bar. Membership counts follow non-trashed
assets only (verified by an integration test). Tenant-scoped uniqueness on
`(business_id, name)` means two businesses can each have their own "کمپین تابستانه"
without collision.

## H. Tags / auto-tagging

**Correction to earlier drafts of this report**: the `pending_review`/`confirmed`/
`rejected` review-workflow this section previously (and Section A/V) claimed was "never
implemented" already existed in full, correctly, before this whole Media program began —
that earlier claim was simply wrong and is retracted here rather than repeated. Verified
by reading the actual code, not by re-trusting the earlier text: `media_assets.ai_status`
(`none`/`pending_review`/`confirmed`/`rejected`, migration `0149`, base commit `81c29c4`
— i.e. genuinely pre-existing, not built by any session of this program) is set to
`'pending_review'` by `POST /api/media/[id]/detect` alongside the proposal in `ai_labels`,
and nothing else ever touches `category`/`tags` at that point — the human gate is real,
not cosmetic. `PATCH /api/media/[id]`'s `aiDecision` is the only way out of
`pending_review`: `"confirm"` merges the proposed category/tags into the real columns
(an explicit category/tags in the same request wins over the proposal — the operator
edited before confirming) and sets `ai_status = 'confirmed'`; `"reject"` sets
`ai_status = 'rejected'` and touches neither column. The drawer surfaces this correctly
too: a `pending_review` asset shows an amber "پیشنهاد هوش مصنوعی (در انتظار تأیید شما)"
panel with تأیید/رد buttons; nothing renders as applied until one of them is pressed.

**What this session actually found and fixed**: the workflow itself needed no code
change, but it had **zero test coverage anywhere in the repo** — a real, previously
undetected gap, closed this session with
`src/app/api/media/[id]/route.test.ts` **(new file, 19 tests)**: `confirm`'s merge (both
with and without an explicit override), `reject`'s isolation from category/tags, the
`aiDecision` value validator, plus full coverage of the same route's rename/move/
validation branches and `DELETE`'s force/usage/trash/purge three-way branch, none of
which had a test before either.

## I. Search / filters / sort

`GET /api/media` supports `sort` (`MEDIA_SORTS`/`mediaSortOrderBy`), `source`
(`upload`/`ai_attachment`/`ai_generated`), `trashed`, and `collectionId`, all validated
server-side against literal allow-lists. Search-term handling is centralized in
`normalizeSearchTerm` (trim/collapse whitespace/cap at 120 chars/fold Arabic ي‌ك to
Persian ی‌ک) and `mediaSearchExpression` (the matching `translate(...)` SQL wrapper, so
the folding is consistent at the database level, not just in application code). Filtering
is still a set of dropdowns/toggles for *choosing* a value (unchanged, low-risk to leave
as-is), but a follow-up session added a removable active-filter-chip row summarizing
every one currently applied (kind/category/tag/source/pending-only/search/collection),
each independently clearable plus a clear-all action — see Section U item 15, Section V.

## J. Upload

`POST /api/media` computes a SHA-256 of the uploaded bytes and looks up
`findMediaAssetByHash` scoped to the caller's tenant before creating a new asset; a match
returns the existing asset with `duplicate: true` and HTTP 200 (an `allowDuplicate` form
field forces a genuine second copy). Both the manager and the universal picker surface
this with a Persian toast.

**Central uploader — closed in a follow-up session.** `src/lib/media-uploader.ts` is now
the one client-side engine both call sites use for `POST /api/media`: a worker-pool
running at most `concurrency` uploads at once (default 3), retrying a transient failure
(network error, or 408/429/5xx) with exponential backoff but never a validation
rejection (a 422 gets one attempt, not a delay-then-repeat of the same rejection), and a
single `cancel()` that both stops every not-yet-started file and aborts every in-flight
request via a shared `AbortController`. It never throws — every file resolves to exactly
one terminal `UploadProgressEvent`, the same "never rejects, `ok:false` instead" contract
`dashboard/ui.tsx`'s `api()` already uses elsewhere in this app.
- The library manager (`media-manager.tsx`) drives it for multi-file batches and renders
  a per-file progress panel (queued/uploading/retrying/موفق/ناموفق/لغو‌شد) plus a "لغو
  بارگذاری" button while a batch is running.
- The universal picker (`media-picker.tsx`)'s one-file "upload a new image" path now
  goes through the same engine too — a picker upload is a one-file batch, but it gets
  the same retry-on-transient-failure a bare `fetch` there never had.
- Real bug found and fixed while wiring this in: the manager's `upload()` is the *only*
  mutating action in this screen that must call `reload()` even after a **partial**
  failure (the files that did succeed still belong in the grid) — every other action
  (`createFolder`, `renameFolder`, `restoreAsset`, …) only calls `reload()` on its own
  success path, so it never collides with a freshly-set `error`. But `reload()`'s
  underlying `load()` unconditionally clears the shared `error` state on every
  successful library refresh — so a failed-upload message set right before `reload()`
  was silently wiped before the operator ever saw it, every time. Fixed by routing the
  upload batch's summary (including the failed count) through `notice`, which `load()`
  never touches; the per-file "ناموفق" row in the progress panel is unaffected either way
  and already carried the visual weight of the failure. Caught by, and regression-tested
  in, `media-manager.test.tsx`.
- Tests: `src/lib/media-uploader.test.ts` (8 tests, pure Node — bounded concurrency
  measured directly via a shared in-flight counter, retry backoff timing, no-retry on a
  422, give-up after `maxRetries`, cancel of not-yet-started files, cancel aborting an
  in-flight request through the shared signal) and three new cases in
  `media-manager.test.tsx` (progress panel shows fresh-store vs. reused-duplicate
  distinctly; a rejected file's server message survives to the toast, not just the
  per-file row — the bug above; "لغو بارگذاری" settles a batch where 3 of 5 files were
  already in flight and 2 were still queued, with exactly 3 network calls made).
- Not done: no persisted client-side upload queue (a page reload mid-batch still loses
  in-flight progress — this was never a stated requirement, just noting the boundary),
  and the picker's single-file path has no dedicated test of its own (it is a thin,
  low-risk call into the now-tested engine, not a second implementation).

## K. WordPress

WordPress media is now a **view over the canonical Media Library** for the one path that
was missing: pushing an asset the operator already has in the library out to a connected
site. `migrations/0174`'s `wordpress_media_mapping` (canonical asset ↔ one connection's
remote attachment, unique per `(connection_id, media_asset_id)`) and its five service
functions existed with no caller before this session; this session built the producer,
the confirmation loop, and the UI around them, so the whole lifecycle now runs end to end:

- **Producer** — `POST /api/media/[id]/wordpress` (new route). Plugin-mode WooCommerce
  connections advertising the `media_create` capability only (REST mode is refused with
  `media_rest_unsupported` for the same SSRF reason the existing arbitrary-URL producer
  at `/api/integrations/wp-manager/media` refuses it); scoped to `image`/`video` assets.
  It cannot reuse `/api/media/[id]/file` to hand the plugin bytes — that route requires
  this app's own session cookie, which a WordPress server calling `media_sideload_image()`
  has no way to send — so it mints a **presigned S3 GET URL** straight to the object
  (`presignS3Get`, new in `s3-lite.ts`: the SigV4 query-string presigning variant,
  `X-Amz-Expires=900`, cross-checked byte-for-byte against boto3's
  `generate_presigned_url("get_object", ...)` under a fixed clock), enqueues a
  `media_create` outbox job carrying that URL, and calls `recordWordPressMediaPush`.
  `GET /api/media/[id]/wordpress` lists the business's WooCommerce connections with each
  one's push eligibility and current mapping, for the drawer.
- **Confirmation loop — the gap that made the mapping table theoretical.** The plugin's
  job ack (`pluginAckJobs`) only ever reported "the job ran without throwing", never the
  resulting attachment's WordPress id — so nothing could call `confirmWordPressMediaSync`
  with real data. Closed on both sides: the plugin (`class-pos-sync.php`,
  `apply_media_create()`, pre-existing) already stamps the new attachment with
  `_pos_operation_id`; `content_payload()` now echoes that meta back as `operation_id` on
  the `add_attachment` event the plugin fires immediately after (**plugin v1.6.4**). The
  app's ingestion path (`webhook-ingest-service.ts`) recognizes an `attachment` event
  carrying an `operation_id` and calls `confirmWordPressMediaSync` with the real
  `wp_media_id`/`wp_url` — the *only* signal that correlates a push to this specific
  mapping row, since every other attachment event (a site owner's own upload, a later
  edit) carries no operation id and is correctly left untouched. Symmetrically, a
  `media_create` job that exhausts its retries and dead-letters now calls
  `failWordPressMediaSync` (`pluginAckJobs`) instead of leaving the mapping `pending`
  forever with no event left that could ever resolve it.
- **UI** — the asset drawer's new "ارسال به وردپرس" panel (image/video assets only, and
  only rendered once the business has at least one WooCommerce connection): one row per
  connection with its push button (disabled with a tooltip when the connection cannot
  receive media), and a status badge — در حال ارسال / همگام‌شده (with a live link to the
  file on the site) / ناموفق — driven by the mapping, re-pushable at any point.
- **What is still a separate, unrelated system, on purpose**: `integration_wp_content`
  (the general bidirectional post/page/media *content mirror* the wp-manager screens
  already showed, keyed on `connection_id, wp_type, remote_id`) and the pre-existing
  arbitrary-URL producer at `/api/integrations/wp-manager/media` are both untouched — the
  former is a different feature (browsing what a store already has), the latter a
  different one (adding a URL that never was a canonical asset). Neither claims to be
  "the view over central Media"; this mapping table is.
- **A disclosed, inherent limitation, not a bug**: the presigned URL only works when the
  Media bucket is reachable from the public internet. A tenant whose storage endpoint is
  a LAN-only MinIO (a case `s3-lite.ts` explicitly supports for backups) cannot use this
  feature — an external WordPress site has no path to fetch from a private network. This
  is a deployment-topology constraint on the operator, not something a URL-signing
  mechanism can fix.

Tests: `presignS3Get` pinned against boto3 plus edge cases (`s3-lite.test.ts`, 5 new
tests); `readMediaObjectDownloadUrl`'s real fetch-through-the-mock-bucket round-trip and
tenant isolation (`media-library.integration.test.ts`, 3 new tests); the route's full
permission/capability/kind gating and its outbox-insert/mapping/audit side effects, mocked
(`src/app/api/media/[id]/wordpress/route.test.ts`, 13 new tests); the operation-id
correlation, the "ordinary sync never touches an unrelated mapping" negative case, and
both branches of the ack-driven dead-letter → fail wiring, against a real database
(`wp-manager.integration.test.ts`, 4 new tests); the plugin source change
(`wp-plugin-admin-source.test.ts`, 1 new test asserting the meta is read only inside the
attachment branch); the drawer panel's visibility, disabled state, status badges and push
flow (`media-manager.test.tsx`, 4 new tests). 30 new tests total, all passing.

## L. AI media (editing / generation)

- **AI-provider operations** (`enhance`): unchanged beyond the earlier wallet-preflight
  and `detect`-response fixes.
- **Background removal, upscale, variations** — new this session, migration `0176`.
  Three more single-provider-call operations on the same "one call → one new derived
  asset, source untouched, wallet charged only after the provider actually returns
  usable bytes" shape `enhance` already established, deliberately **not** a new editor —
  no masking UI, no manual retouching, no resolution picker:
  - `POST /api/media/[id]/bg-remove` and `POST /api/media/[id]/upscale` each call
    `runMediaBackgroundRemoval`/`runMediaUpscale` (thin wrappers around the same generic
    `runMediaImageEdit` `enhance` already used, posting multipart to `/images/edits` with
    a different system prompt — `MEDIA_BG_REMOVE_PROMPT` asks for a transparent
    background, `MEDIA_UPSCALE_PROMPT` asks for higher resolution/sharpening), charge
    `mediaConfig.enhancePriceRial` under feature keys `media_bg_remove`/`media_upscale`,
    and store one new `bg_removed`/`upscaled` asset with `source_asset_id` pointing at
    the original.
  - `POST /api/media/[id]/variations` calls `runMediaVariations`, which posts to a
    **different** provider endpoint, `/images/variations` (no prompt, no edit
    instructions — this is the OpenAI-compatible "give me alternates of this image"
    call, not an edit), requesting `MEDIA_VARIATIONS_COUNT = 3` images. The wallet
    preflight checks the **full requested-batch price**
    (`enhancePriceRial × 3`) before the provider is ever called (never charge-first,
    ask-never pattern this program has held to throughout); after a successful call the
    route charges `enhancePriceRial × result.images.length` — the actual count the
    provider returned, which the code deliberately does not assume equals the requested
    count — and stores one `variation` asset per returned image, all sharing the same
    `source_asset_id`.
  - **Honesty note on "upscale"**: this is a `gpt-image-1`-style generative
    resharpen/upsample through the same provider used for `enhance`, not a dedicated
    super-resolution model. It is offered and labeled as a lightweight quality pass
    ("بزرگ‌نمایی"), consistent with the "not Photoshop" constraint — it should not be
    read as guaranteeing a specific resolution multiplier or true optical-quality
    up-sampling.
  - **UI reach**: three new buttons in the asset drawer next to the existing "تصویر
    استاندارد محصول" (enhance) button — "حذف پس‌زمینه" (remove background), "بزرگ‌نمایی"
    (upscale), "ساخت ۳ تنوع از تصویر" (make 3 variations) — each showing its Rial cost
    when `enhancePriceRial > 0`, each gated to `asset.variant === "original"` (the same
    restriction `enhance` already applied, so a derived asset from any of the four
    provider operations is not offered a second uncontrolled round from this drawer),
    and each new variant gets its own drawer badge (بدون پس‌زمینه / بزرگ‌نمایی‌شده /
    تنوع), matching the existing "استاندارد" badge for `enhanced`. A "ویرایش‌شده" badge
    was also added for the pre-existing `transformed` variant, which previously had no
    badge at all — a small pre-existing gap this pass happened to notice and close while
    touching the same badge block.
  - **Version-history UI — closed this session** (previously disclosed as "not built"
    in an earlier draft of this report): every derived asset — `enhanced`, `bg_removed`,
    `upscaled`, `variation`, and the deterministic `transformed` kind below — already
    recorded `source_asset_id` from the moment it was created, but nothing walked or
    surfaced that chain anywhere in the UI. `getMediaAssetLineage(businessId, assetId)`
    (`src/lib/media-service.ts`) now walks `source_asset_id` upward to the root original
    (returning the full ancestor chain, root-first) and separately looks up every asset
    whose `source_asset_id` is the given id (its direct descendants) — tenant-scoped like
    every other Media query, so an id from a foreign business resolves to an empty
    lineage rather than leaking cross-tenant structure. `GET /api/media/[id]/lineage`
    (mirrors the existing `usage` route exactly: `withTenantScope` → `requirePermission
    (media.view)` → 404 via `getMediaAsset` → `{ lineage: { ancestors, descendants } }`)
    exposes it. The asset drawer lazily fetches it the same way it already lazily
    fetches `usage`, and — only when the asset actually has ancestors or descendants —
    renders a "سابقهٔ نسخه" (version history) panel: the ancestor chain root-first ending
    on the currently-open asset (each ancestor a link to its own file, the open asset
    itself named but not linked since it is already open in the same drawer) and a
    "نسخه‌های ساخته‌شده از این فایل" (versions made from this file) list of direct
    descendants, each linked to its own file, each labeled with the same Persian variant
    words the grid badges already use. A plain, never-derived upload renders no panel at
    all — nothing to disclose. **Still not built, deliberately**: no UI to pick which of
    several variation results to "keep" vs. discard beyond deleting unwanted ones from
    the grid like any other asset — the lineage panel is read-only disclosure of
    structure that already existed, not a new curation workflow, consistent with the
    "not Photoshop" constraint.
- **Deterministic (non-AI) operations** — migration `0175`:
  `POST /api/media/[id]/transform` accepts `{operation: "crop"|"rotate"|"resize", ...}`,
  validated by `parseMediaTransformInput` (crop: integer x/y/width/height, 1..4000px;
  rotate: finite non-zero degrees, ±360; resize: at least one of width/height, 1..4000px,
  `fit` ∈ cover/contain/inside/fill, default `inside`), executed by
  `applyMediaTransform` (`sharp`, always emits PNG bytes, throws `MediaTransformError`
  with a `code` the route maps to 422/400/500), and stored as a new `variant:
  "transformed"` asset with `source_asset_id` pointing at the original (which is never
  modified) and `transform_ops` recording exactly which operation produced it — the
  same non-destructive parent/child shape as `enhance`. No wallet cost: this is local
  CPU work, not a provider call, and the route does not touch the wallet at all.
  **UI reach**: the manager's asset drawer has a "چرخش ۹۰° راست/چپ" (rotate) pair of
  buttons, a width field with "تغییر اندازه به این عرض" (resize), and — added later this
  session — "برش تصویر" (crop): a drag-to-select rectangle drawn with native Pointer
  Events directly over the drawer's preview `<img>`, converted from displayed CSS-pixel
  coordinates to the image's `naturalWidth`/`naturalHeight` (the exact space
  `applyMediaTransform`'s `sharp(...).rotate()` auto-orient measures server-side, so the
  mapping is exact rather than approximate) before calling `transform("crop", ...)`; a
  minimum drag size (12 CSS px) keeps an accidental click from arming "اعمال برش", and
  "انصراف" discards the rectangle without a request. Covered by
  `src/app/dashboard/media/media-manager.test.tsx` (button hidden for non-image assets,
  sub-minimum drag stays disabled, a real drag produces the exact expected natural-pixel
  request body, cancel never calls the API). Its lineage (parent it was cropped/rotated/
  resized from, and any further asset derived from it in turn) is now disclosed by the
  same version-history panel described above, since `getMediaAssetLineage` walks
  `source_asset_id` regardless of which operation set it.
- **AI generation**: unchanged — `ai_generated` provenance already existed before this
  program and is unaffected.

## M. OCR / document intelligence

**Partially closed across this session** — the receipt-OCR-for-Accounting slice and the
invoice-OCR-for-Inventory/purchases slice of this section's mandate were both built
end-to-end onto canonical Media storage; business-card/CRM scanning and Workspace
contract extraction were not (neither feature exists yet at all, so there is nothing to
migrate onto a shared pipeline — new scope, not a gap in what already exists).

- `src/lib/ai-receipt-service.ts` **(new)**: a standalone, metered receipt-OCR service
  (`runReceiptOcr`) — deliberately *not* a further branch inside `ai-service.ts`'s
  chat-tool dispatch, because this is a direct, no-chat-turn extraction Accounting calls
  synchronously from a form, not a tool an AI conversation invokes. It reuses
  `ai-receipt.ts`'s existing prompt/parser (no prompt duplicated), so the one-shot
  AI-Chat-tool receipt flow and this new direct-upload flow read a receipt image
  identically; only what happens to the photo afterward differs.
- `POST /api/ai/receipt-ocr` **(new route)**: the previous design's own stated
  reason for never persisting a receipt photo (Section M, prior text) was retention
  policy, not a technical constraint — the guard chain here resolves that instead of
  overriding it silently: `withTenantScope` → `financeExpensesManage` permission →
  storage-configured check → body/byte-signature validation → **tenant-scoped SHA-256
  dedup against the canonical library exactly like every other upload**
  (`findMediaAssetByHash`/`storeMediaAsset`, so re-uploading the same photo twice never
  creates two assets) → AI-config/wallet preflight → `runReceiptOcr` → meter the turn
  only after a successful extraction. The photo is now a first-class Media asset from the
  moment it is uploaded, independent of whether the resulting expense is ever actually
  saved — stored with its own honest provenance value, `source: "ocr_receipt"`
  (**migration 0178**, widening the `source` CHECK `0161` first added, the same
  drop-and-recreate shape `0175`/`0176` already used for `variant`), so the library never
  misreports it as `ai_attachment` (a photo dropped into a chat turn) when no chat turn
  was involved at all. The manager's source filter, drawer badge, and `MediaAssetSource`
  type (`media.ts`) all recognise the new value.
- **Migration 0177** (Section D) gives the *consuming* record — the expense itself — a
  durable, safe-delete-aware pointer back to that asset (`receipt_asset_id`), reusing the
  exact `getMediaAssetUsage`/`mediaAssetUsageIsEmpty` platform pattern `menu_items`/
  `inventory_items` already used, now extended to a third category, `expenses` (Section
  O.1 covers the matching permission-exception change).
- `src/app/(app)/accounting/expense-section.tsx`: a receipt-photo upload control (file
  input → data URL → the new route → prefill vendor/date/amount/memo/category, never
  overwriting a field the person had already typed → `receiptAssetId` carried through to
  `POST /api/ledger/expenses` on submit). A failed or unavailable extraction degrades to
  plain manual entry — it reports why and never blocks the form.
- **Invoice-OCR test-coverage gap closed first (Section T)**: `ai-invoice-ocr-service.ts`
  (`callVision`, `loadInventoryCandidates`/`matchSupplier` against `./db`,
  `collapseCandidates`, exported `runInvoiceOcr`/`InvoiceOcrError`) and
  `POST /api/ai/invoice-ocr` had **zero tests** despite being a real, currently-used
  purchases-flow route; only their pure prompt/parser half (`ai-invoice-ocr.ts`) was
  covered. Added `src/lib/ai-invoice-ocr-service.test.ts` (9 tests) — following the
  codebase's existing `vi.mock("./db", () => ({ query: vi.fn() }))` convention already
  used by `purchase-lines.test.ts`, no new DB-mocking pattern invented — pinning the
  extraction/matching logic (barcode-first vs. fuzzy-name catalogue matching, unmatched
  lines never inventing a link, the 0.72 fuzzy-name supplier-match threshold,
  `extraction_failed` on an unparseable reply, error-code mapping, candidate
  de-duplication) before its storage behaviour was touched at all.
- **Invoice-OCR then migrated onto canonical Media storage (migrations 0179/0180)**: the
  same session immediately closed the storage gap the test-coverage pass had just
  documented as still open. `POST /api/ai/invoice-ocr` now follows the exact order
  `/api/ai/receipt-ocr` already used: `withTenantScope` → `requireManager` → **storage-
  ready check** → body/byte-signature validation → an active location → AI-config/wallet
  preflight → `runInvoiceOcr` → settle only on success → **tenant-scoped SHA-256 dedup
  and persist as a real Media asset** (`findMediaAssetByHash`/`storeMediaAsset`, so
  re-scanning the same photo never writes a second copy), stored with its own honest
  provenance value `source: "ocr_invoice"` (migration 0180, widening the same `source`
  CHECK `0178` widened for `ocr_receipt`) — distinct from both `ai_attachment` (no chat
  turn is involved) and `ocr_receipt` (this is a purchaser's invoice, not an
  accountant's receipt). The route's own response now includes the stored `asset`.
- **Migration 0179** gives the *consuming* record — the draft purchase itself — a
  durable, safe-delete-aware pointer back to that asset (`invoice_asset_id`), the same
  shape `0177` gave `expenses.receipt_asset_id`. `purchase-service.ts`'s
  `createDraftPurchase`/`createDraftPurchaseInTransaction` re-validate the id against
  the caller's `businessId` before writing it (`invoice_asset_not_found` on a stale or
  cross-tenant id — `expense-service.recordExpense`'s `receipt_asset_not_found` pattern,
  reused rather than reinvented) and `getMediaAssetUsage`/`mediaAssetUsageIsEmpty` gained
  a fourth category, `purchases`, exposed through `/api/media/[id]/file`'s usage-based
  permission exception under the same `inventory.view` permission an inventory item's
  own photo already used (Section O.1) — no new permission was added for this.
- `src/app/dashboard/inventory/invoice-ocr-panel.tsx` /
  `src/app/dashboard/inventory/purchases-section.tsx`: the OCR panel now carries the
  scan route's stored `asset.id` through `InvoiceOcrApplyPayload.invoiceAssetId`; the
  purchases form holds it in state from "apply" through to `POST
  /api/inventory/purchases`, clearing it only after a successful submit (mirroring how
  `expense-section.tsx` carries `receiptAssetId` through to `POST
  /api/ledger/expenses`).
- `src/app/(app)/accounting/expense-section.tsx`: unchanged this pass — its own
  receipt-photo flow (Section M above) was already migrated in an earlier step of this
  session.
- **Genuinely still open, disclosed rather than hidden**: No CRM business-card-scanning
  entry point exists anywhere in the app (there is no UI to scan a card into a Party at
  all, so there is nothing to migrate onto a "centralized OCR + document intelligence"
  pipeline yet — this is new scope, not a migration). No Workspace contract-extraction
  feature exists either, for the same reason. "Centralized OCR consumed by
  Accounting/CRM/Workspace" is now true for both Accounting (receipts) and Inventory
  (invoices); CRM and Workspace do not yet have any OCR feature to point at it. No shared
  "document-intelligence" abstraction layer exists above the two now-parallel
  `runReceiptOcr`/`runInvoiceOcr` services — a future business-card/contract extractor
  would still be written as its own service, not a plugin into a common one, because the
  two existing examples were built independently rather than factored together (each
  reuses its own pure prompt/parser module, but the metered-call/persist/settle shell
  around each is duplicated by hand, not shared).

## N. Per-app migration status

| App | Uses canonical Media Library? |
|---|---|
| Menu items (`menu-manager.tsx`) | **Yes** — `MediaImageField`/`MediaPickerDialog`; benefits from the permission fix (B.1) |
| Inventory items (`items-section.tsx`) | **Yes** — same components, same permission-fix benefit |
| Product | No separate module — "Product" in this app's dashboard is a view over menu/inventory items, both already covered above |
| AI Chat attachments | **Yes** (pre-existing) — `source='ai_attachment'` via `ai-media-persist.ts` → `storeMediaAsset` |
| AI-generated images | **Yes** (pre-existing) — `source='ai_generated'` |
| WordPress/CMS media mirror | **Partial** — pushing a canonical asset out to a connected site is now a view over the Media Library via `wordpress_media_mapping` (Section K); the separate, pre-existing `integration_wp_content` mirror (browsing what a store already has, independent of this app's storage) is untouched by design, not a gap in this row |
| Website builder (`website/content-service.ts`, distinct first-party CMS, not WordPress) | **No** — pushes bytes to an external headless-CMS adapter by design (not this app's own storage); its byte-signature check now delegates to the canonical one (Section O.2), but its upload target is genuinely external, not a duplicate of local storage |
| Accounting — expense receipt OCR | **Yes, this session** — `POST /api/ai/receipt-ocr` persists the photo via `storeMediaAsset` (tenant-scoped SHA-256 dedup, `source='ocr_receipt'`, migration 0178); the resulting expense links back to it via `expenses.receipt_asset_id` (migration 0177); `expense-section.tsx`'s upload control benefits from the same usage-based permission model B.1 describes (`ledger.view` can render a receipt photo without `media.view`, Section O.1) |
| Inventory — supplier invoice OCR (`ai-invoice-ocr*`, purchases) | **Yes, this session** — test-coverage gap closed first (`ai-invoice-ocr-service.test.ts` + `invoice-ocr/route.test.ts`, 17 tests, Section M/T/U item 18), then `POST /api/ai/invoice-ocr` migrated onto canonical storage the same session (`storeMediaAsset`, tenant-scoped SHA-256 dedup, `source='ocr_invoice'`, migration 0180); the resulting draft purchase links back via `purchases.invoice_asset_id` (migration 0179); the purchases form's invoice-scan panel benefits from the same usage-based permission model B.1 describes (`inventory.view` can render a purchase's own invoice photo without `media.view`, Section O.1) |
| CRM (party profile image) | **Yes, this session** — `parties.profile_image_asset_id uuid REFERENCES media_assets(id)` (migration 0181) alongside the pre-existing `profile_image` text column, mutually exclusive on one row (`normalizePartyWrite` always nulls the other when one is set); `party-form.tsx`'s avatar control now uses the same `MediaImageField`/`MediaPickerDialog` every catalogue item's photo uses for a *new* upload, with the legacy `data:`/`https://` value (migration 0137) still rendered as-is for a party that already had one and an explicit "replace with a library photo" action rather than a forced migration; the file-download route benefits from the same usage-based permission model B.1/O.1 describe (`parties.view` can render a party's own avatar without `media.view`) |
| CRM — business-card scanning | **N/A, not a migration** — no such feature/entry point exists anywhere in the app yet (Section M); nothing to migrate onto the canonical library until it is built |
| Workspace — contract extraction | **N/A, not a migration** — no such feature exists yet either (Section M) |
| Workspace (documents register) | **Already migrated, pre-existing (migration 0149), audited this session** — `workspace_documents.media_asset_id uuid REFERENCES media_assets(id)`; the register never re-implements storage (`workspace_documents` holds only a title, review state and version chain, joined to `media_assets` for `file_name`/`mime_type`/`byte_size` at read time). This is the one Workspace entity with a file reference at all (contracts, tasks, comments, approvals, calendar and templates were grepped for `media_asset_id`/`mediaAssetId`/`attachment` and hold none). A real, disclosed UI bug was found and fixed this session, not a storage gap: `documents-section.tsx` stored and round-tripped `mediaAssetId` correctly but never rendered a way to actually open the file again — the row showed the file name as inert text and the edit dialog's picker only let you change which asset was linked, never view the current one. Fixed with a link to `mediaFileUrl(id)` (`/api/media/{id}/file`) in both the row and the dialog; the row's link stops click propagation so it opens the file directly rather than the row's own edit-dialog handler intercepting it. `GET /api/media/[id]/file` needed no permission-model change: a workspace document's file is `kind='document'` in the overwhelming case (PDFs, DOCX, drawings), and Section O.1's rule already requires `media.view` unconditionally for every document-kind asset regardless of usage — by explicit, conservative design, not an oversight this session introduced or left unaddressed. |

## O. Permissions & security

### O.1 The named permission bug

`GET /api/media/[id]/file` now authorizes by **asset usage**, not unconditionally by
`media.view`:
- Document-kind assets still always require `media.view` (unchanged, conservative).
- Image/video assets are servable if the caller has `media.view`, **or** has
  `menu.view` and the asset is a menu item's `image_media_id`, **or** has
  `inventory.view` and the asset is an inventory item's `image_media_id`, **or** —
  added this session, migration 0177 — has `ledger.view` and the asset is an expense's
  `receipt_asset_id`, **or** — added later this same session, migration 0179 — has
  `inventory.view` (reusing the exact permission an inventory item's own photo already
  used, not a new one) and the asset is a draft purchase's `invoice_asset_id` — checked
  per request against the database, not by role name. An accountant who can see an
  expense's own receipt photo, or a purchaser who can see a draft purchase's own scanned
  invoice photo, can now actually open it without also needing `media.view`, the same fix
  B.1 already gave the cashier/waiter/kitchen roles for menu/inventory photos; and — added
  later this same session, migration 0181 — has `parties.view` and the asset is a party's
  own `profile_image_asset_id`, so a CRM-only member can see a contact's avatar without
  also needing `media.view`. A new `src/app/api/media/[id]/file/route.test.ts` (9 tests —
  the route had **no direct test at all** before this program, only incidental integration
  coverage) pins all five usage branches plus the document-always-requires-`media.view`
  rule and the "the permission alone is not a blanket grant, it must be *this* asset"
  behaviour for each one.

This does not weaken tenant isolation: the usage lookup is itself tenant-scoped by RLS,
and a caller must still separately hold the relevant `*.view` permission.
`src/app/api/api-guards.test.ts`'s general "every `requireMember`-guarded route scopes
its work to `session.sub`" invariant does not describe this route (it is "every member
reaches the gate; the real decision is a per-request usage/permission check"), so it was
added to that test's existing, documented exemption list with a comment explaining why,
rather than weakened.

### O.2 This session's security fixes (found during the MIME/byte-signature audit)

1. **De-duplicated byte-signature logic.** `hasMatchingMediaSignature`
   (`src/lib/media.ts`) is the canonical check; `business-logo.ts`'s
   `hasMatchingLogoSignature` now delegates to it entirely (its four MIME types are an
   exact subset), and `website/content-service.ts`'s `hasMatchingImageSignature`
   delegates to it for jpeg/png/webp and keeps only its own genuine extension (gif,
   which the Media Library does not accept). Both files' existing unit tests pass
   unchanged, proving the delegation is behavior-preserving. One ruleset, not three.
2. **Closed a real server-side validation gap.** A CRM party's `profileImage` — later
   rendered as `<img src>` in the party form — had a shared pure validator
   (`isProfileImageValue` in `src/lib/parties.ts`) that was called **only** from the
   client-side form (`validatePartyForm`), never from the server write path
   (`normalizePartyWrite` in `parties-service.ts`, which just did `textOf(...)` with no
   shape check at all). Fixed: `normalizePartyWrite` now calls a new
   `validatedProfileImage` helper that (a) runs the existing shape check and (b), for a
   `data:` URL specifically, decodes the base64 and runs it through
   `hasMatchingMediaSignature` — so a value claiming `image/png` whose bytes are not a
   PNG is now rejected with `PartyValidationError("invalid_image", "profileImage")` on
   **both** create and update, at the one place all party writes go through (confirmed
   by `grep` — no other file writes `parties.profile_image`). An `https://` linked
   avatar has no bytes to check and is accepted as before. Verified with 5 new
   integration tests against a real database (valid PNG accepted, valid https link
   accepted, a fake PNG rejected on create, a non-image string rejected, a fake JPEG
   rejected on update).
3. **Migrated the storage, not just the validation (migration 0181, this session).**
   `createParty`/`updateParty` now accept `profileImageAssetId`, resolved through a new
   `assertProfileImageAssetOwned(businessId, assetId)` in `parties-service.ts` — a no-op
   when the id is absent, otherwise a tenant-scoped `getMediaAsset` lookup that throws the
   same `PartyValidationError("invalid_image", "profileImage")` when the asset does not
   exist, belongs to a different business, or is not `kind='image'` (a document asset is
   rejected the same as a fake-signature `data:` URL always was). `normalizePartyWrite`
   makes the two storage mechanisms mutually exclusive on one row by construction: a
   truthy `profileImageAssetId` always forces `profileImage` to `null` in the same write,
   so the database can never carry both at once no matter which order a client sends them
   in. Verified with 9 new integration tests against a real database: link + read back via
   `getMediaAssetUsage`, legacy value cleared when an asset is linked in the same write,
   asset cleared when a later edit picks the legacy link path instead, an unrelated edit
   leaves an existing avatar alone, a cross-tenant asset id rejected, a nonexistent asset
   id rejected, a document-kind asset rejected, the check also runs on update not just
   create, and deleting the underlying asset leaves the party row intact with the
   reference nulled out (`ON DELETE SET NULL`, not a cascade that would delete the CRM
   contact).

No security control was removed or weakened anywhere in this program; every change in
this section either added a check that did not exist or moved an existing check to a
single shared implementation.

## P. Storage / orphan handling

`scripts/media-reconcile-orphans.ts` (new, this session; `npm run media:reconcile-orphans`)
is a real, runnable, tested maintenance script:

- **Dry run by default.** Lists every object under the platform's configured bucket
  prefix (`s3List`, already existed for backups), loads every `media_assets.storage_key`
  (trashed rows included — a trashed asset still legitimately owns its object until the
  retention purge), and reports (a) orphaned objects — no row claims them, and they are
  older than a one-hour grace period (so a concurrent in-flight upload's object is never
  mistaken for an orphan), (b) malformed keys (never auto-deleted, flagged for manual
  review), and (c) broken references — a row whose `storage_key` resolves to nothing in
  the bucket, which the script only ever reports, never acts on, because deleting that
  row is a data-loss decision a maintenance script should not make unattended.
- **`--apply --backup-confirmed`** (both required, mirroring the existing
  `reconcile-opening-inventory.ts` convention) deletes exactly the safely-shaped orphaned
  objects and nothing else — never a database row.
- **Verified against a real database and a real in-memory S3-compatible mock** (not a
  hand-wave): 6 new integration tests in
  `integration/media-reconcile-orphans.integration.test.ts`, invoking the script as an
  actual child process the way an operator or a cron job would, covering: storage not
  configured, dry-run detection with the grace period respected, `--apply` refused
  without `--backup-confirmed` (deletes nothing), `--apply --backup-confirmed` deletes
  exactly the orphan and leaves the claimed object alone, a broken reference is reported
  without touching the row, and a trashed asset's object is correctly treated as claimed.
  All 6 passed on the first real run against the mock bucket.
- **Note on a pre-existing, unrelated repo issue found while building this**: the
  existing `scripts/reconcile-opening-inventory.ts` uses top-level `await`, which fails
  outright when run via `npx tsx` in this environment (`Top-level await is currently not
  supported with the "cjs" output format` — confirmed by actually running it, not by
  inspection) because the root `package.json` declares `"type": "commonjs"`. This is a
  latent, real bug in an unrelated inventory script, discovered as a side effect of this
  work; it was **not** fixed (out of scope for a Media session, and changing the root
  module type is a repo-wide decision this session should not make unilaterally). The
  new `media-reconcile-orphans.ts` avoids the same trap by wrapping its body in an
  `async function main()` instead of top-level `await`, so it actually runs.

Beyond this script, there is still no trash-*independent* orphan sweep triggered
automatically (it is a manually-run maintenance script, not a scheduled tick) — the
scheduled tick that does exist (`runMediaTrashPurgeTick`, wired into `server.ts` on the
same hourly cadence as the billing tick) purges expired trash rows, which is a different
concern (soft-deleted rows past retention) from orphaned bucket objects with no row at
all.

## Q. Route changes (cumulative, all sessions)

| Route | Change |
|---|---|
| `GET /api/media` | + `sort`, `limit`, `source`, `trashed`, `collectionId` query params |
| `POST /api/media` | + tenant-scoped SHA-256 dedup, `allowDuplicate` override, 200-vs-201 split |
| `DELETE /api/media/[id]` | now a soft delete (trash) by default; usage check; `?force=1` override; 409 `asset_in_use` with usage payload |
| `POST /api/media/[id]/restore` **(new)** | restores a trashed asset |
| `POST /api/media/[id]/detect` | response now includes the refreshed `asset` |
| `POST /api/media/[id]/enhance` | + wallet balance preflight → 402 `insufficient_funds` |
| `POST /api/media/[id]/transform` **(new)** | deterministic crop/rotate/resize; no wallet cost |
| `GET/POST /api/media/[id]/collections` **(new)** | which collections an asset belongs to; add to one |
| `GET/POST /api/media/collections` **(new)** | list/create collections |
| `PATCH/DELETE /api/media/collections/[id]` **(new)** | rename/delete a collection |
| `POST/DELETE /api/media/collections/[id]/items[/[assetId]]` **(new)** | add/remove membership |
| `PATCH /api/media/folders/[id]` | + `parentId` (folder move), cycle/depth guards |
| `GET /api/media/[id]/file` | permission model changed from unconditional `media.view` to usage-based (Section O.1) |
| `GET /api/media/[id]/usage` **(new, first session)** | asset usage references for the delete-confirmation UI |
| `GET/POST /api/media/[id]/wordpress` **(new)** | list WooCommerce push targets + current mapping / push a canonical asset out to one |
| `POST /api/media/[id]/bg-remove` **(new)** | AI background removal; wallet preflight → 402; stores a new `bg_removed` asset |
| `POST /api/media/[id]/upscale` **(new)** | AI upscale/resharpen; wallet preflight → 402; stores a new `upscaled` asset |
| `POST /api/media/[id]/variations` **(new)** | AI variations (up to `MEDIA_VARIATIONS_COUNT = 3`); wallet preflight against the full batch price; stores one `variation` asset per image the provider actually returned |
| `POST /api/ai/receipt-ocr` **(new, this session)** | Uploads a receipt photo for metered OCR extraction; persists it into the canonical Media Library (tenant-scoped SHA-256 dedup, `source='ocr_receipt'`) before returning the extracted fields and the resulting `asset` |
| `POST /api/ledger/expenses` (this session) | + optional `receiptAssetId` in the request body, validated (`getMediaAsset`, tenant-scoped) and stored on the new expense (migration 0177) |
| `GET /api/media/[id]/usage`, `GET /api/media/[id]/file`, `DELETE /api/media/[id]` (this session) | Usage-reference shape gained a third category, `expenses` (alongside `menuItems`/`inventoryItems`); `file`'s usage-based permission model (Section O.1) now also accepts `ledger.view` for an asset an expense references as its receipt. No request/response *shape* change beyond the added key — existing consumers reading `menuItems`/`inventoryItems` are unaffected |
| `POST /api/ai/invoice-ocr` (this session) | Now persists the invoice photo into the canonical Media Library on a successful extraction (tenant-scoped SHA-256 dedup, `source='ocr_invoice'`, migrations 0179/0180), the same order `/api/ai/receipt-ocr` uses — storage-ready check and byte-signature validation added; response now includes the resulting `asset`. Previously never persisted the photo at all |
| `POST /api/inventory/purchases` (this session) | + optional `invoiceAssetId` in the request body, re-validated tenant-scoped inside `createDraftPurchase` (mirrors `receiptAssetId` on `POST /api/ledger/expenses`) and stored on the new purchase (migration 0179); a stale/cross-tenant id now 404s `invoice_asset_not_found` rather than either silently accepting it or crashing on the FK |
| `GET /api/media/[id]/usage`, `GET /api/media/[id]/file`, `DELETE /api/media/[id]` (this session) | Usage-reference shape gained a fourth category, `purchases` (alongside `menuItems`/`inventoryItems`/`expenses`); `file`'s usage-based permission model (Section O.1) now also accepts `inventory.view` for an asset a draft purchase references as its invoice. No request/response *shape* change beyond the added key |

No routes were removed.

## R. Dead code / route removal

**None removed.** No dead-code audit pass targeting route/component removal was
performed; everything found during the MIME-centralization audit (Section O.2) was a
duplication to consolidate, not dead code to delete.

## S. Bugs fixed (cumulative — see Sections B and O.2 for detail)

1. Cashier/waiter/kitchen image-permission bug (the prompt's named bug).
2. Media list pagination ceiling / missing sort & source filters.
3. No duplicate detection on upload.
4. Unsafe delete of in-use assets (now further superseded by trash as the default).
5. Unsafe folder move (no cycle/self-parent/depth guard existed at all).
6. AI enhance spent before checking wallet balance.
7. `detect` route silently dropped its own result from the response.
8. Universal picker had no debounce/cancel/pagination and could not detect duplicates.
9. Storage orphans from the two documented crash windows in
   `storeMediaAsset`/`deleteMediaAsset` had no detection or cleanup mechanism at all.
10. Byte-signature-check logic was hand-duplicated in three files with no single source
    of truth.
11. A CRM party's profile image had no server-side format/signature validation at all —
    the only real bug fixed this session with a genuine (if narrow) security dimension.

## T. Tests added / changed (cumulative)

- `src/lib/media.test.ts`: 34 tests total (was 19 before this program) — sort/search
  normalization/folder-cycle helpers (first session) + 5 new this session for
  `parseMediaTransformInput` (crop/rotate/resize valid & invalid shapes, the
  `fit: "inside"` default, unknown-operation and non-object-body rejection).
- `src/lib/media-transform.test.ts` **(new file, this session)**: 6 tests against real
  synthetic PNGs generated with `sharp` — crop dimensions, crop out-of-bounds rejection,
  rotate 90° dimension swap, resize `fit: "inside"` bound check, resize `fit: "fill"`
  exact dimensions, non-image bytes rejected via `MediaTransformError`.
- `integration/media-library.integration.test.ts`: 43 tests total — the first session's
  +5 `describe` blocks (dedup, sort, source filter, search normalization, usage
  references), the phase-2 work's trash/collections/WordPress-mapping blocks, 3 tests for
  the deterministic-transform feature (a `transformed` asset's round-trip through
  `getMediaAsset` including `sourceAssetId`/`transformOps`; a crop-then-resize chain
  recording only its own op at each step, not accumulated history; a transformed asset
  appearing in a filtered library listing next to its source), and 3 new tests this
  session for `readMediaObjectDownloadUrl` (a presigned URL that actually fetches the
  real bytes back from the mock bucket; tenant isolation; nonexistent asset).
- `integration/media-reconcile-orphans.integration.test.ts` **(new file, this session)**:
  6 tests, described in Section P.
- `integration/parties.integration.test.ts`: +5 tests this session for the
  `profileImage` server-side validation fix (Section O.2) — valid PNG accepted, valid
  https link accepted, fake PNG rejected on create, non-image string rejected, fake JPEG
  rejected on update.
- `src/app/api/api-guards.test.ts`: +1 documented exemption entry (the `media/[id]/file`
  usage-based-permission route, Section O.1) — a test-suite correction, not new coverage.
- `src/app/dashboard/media/media-manager.test.tsx` **(new file, this session, jsdom +
  Testing Library, following the same `@vitest-environment jsdom` / real-Pointer-Event
  pattern as `hold-repeat-button.test.tsx`)**: 3 tests against the drawer's new crop UI —
  the "برش تصویر" button is absent for non-image assets; a drag under the 12px minimum
  leaves "اعمال برش" disabled while a real drag arms it and produces the exact expected
  natural-pixel `{operation:"crop", params:{x,y,width,height}}` body against a stubbed
  2×-downscaled image geometry; "انصراف" discards the rectangle and never calls the
  transform endpoint. `AssetDrawer` and `AssetRow` were exported from `media-manager.tsx`
  (previously module-local) solely so this test can render the drawer in isolation
  without mounting the full library page and its data-fetching grid. Extended later the
  same session with a `MediaManager upload panel` suite (3 more tests, full-component
  render with a mocked `fetch` router and `@testing-library/user-event`'s `upload()`):
  one progress row per selected file with fresh-store vs. reused-duplicate reported
  distinctly; a rejected file's server message reaching the visible summary rather than
  being erased (the `reload()`-clobbers-`error` bug, Section J); "لغو بارگذاری" settling
  a 5-file batch under the manager's default concurrency-3 with exactly 3 network calls
  made (3 in flight, 2 still queued when canceled).
- `src/lib/media-uploader.ts` **(new file, follow-up session)** and
  `src/lib/media-uploader.test.ts` **(new file, 8 tests, pure Node — no DOM)**: the
  central upload engine itself. Bounded concurrency measured directly (a shared in-flight
  counter never exceeds the configured cap across 8 files), retry backoff timing
  (exponential: 100ms then 200ms before two retries), a 422 never retried (one attempt,
  reported as `error`), giving up cleanly after `maxRetries` (no infinite loop),
  `cancel()` settling every remaining file as `canceled` without a network call for the
  ones a worker had not reached, and `cancel()` aborting an already in-flight request
  through the shared `AbortSignal`.
- WordPress push (Section K, this session) — 30 new tests across six files:
  `src/lib/s3-lite.test.ts` (+5, `presignS3Get` pinned against boto3 plus clamping/
  encoding/clock edge cases), `integration/media-library.integration.test.ts` (+3,
  covered above), `src/app/api/media/[id]/wordpress/route.test.ts` **(new file, 13
  tests)** — the full permission/kind/capability/paused/REST-mode gating matrix plus the
  outbox-insert/mapping/audit side effects of a successful push, mocked in the same style
  as the pre-existing `wp-manager/media/route.test.ts` — `integration/
  wp-manager.integration.test.ts` (+4, against a real database: operation-id correlation
  confirms the right mapping; an unrelated attachment sync with no operation id touches
  nothing; a dead-lettered `media_create` job fails the mapping; an ordinary retry-able
  failure leaves it pending), `src/lib/integrations/wp-plugin-admin-source.test.ts` (+1,
  asserting the plugin echoes the meta only inside the attachment branch), and
  `media-manager.test.tsx` (+4, the drawer panel's visibility gating, disabled state for
  a connection that cannot push, status badges with a working link, and the push flow
  itself).

- AI editing expansion — background removal, upscale, variations (Section L, this
  session) — 33 new tests across five files: `src/app/api/media/[id]/bg-remove/route.test.ts`
  **(new file, 6 tests)** and `src/app/api/media/[id]/upscale/route.test.ts` **(new file, 6
  tests, derived from the former by mechanical substitution then independently verified)**
  cover 404 missing asset, 400 non-image, 402 wallet-preflight-before-any-provider-call,
  201 success (correct `variant` stored, correct feature key charged), 502 on a
  `MediaAiError("ai_auth")` with no charge, and 503 when AI is not configured;
  `src/app/api/media/[id]/variations/route.test.ts` **(new file, 5 tests)** covers the
  402 preflight checked against the full `enhancePriceRial × MEDIA_VARIATIONS_COUNT`
  batch price (not a per-image price) before the provider is called, the provider being
  asked for the fixed configured count rather than any caller-supplied one, charging and
  storing exactly as many assets as the provider actually returned (proven with a
  provider response shorter than the requested count), a 504-with-no-charge on
  `MediaAiError("ai_network")`, and the non-image 400 guard; `src/lib/ai-media-service.test.ts`
  **(6 new tests appended)** proves — against a stubbed `fetch`, no network — that
  background removal's prompt asks for a transparent background while upscale's asks for
  higher resolution/sharpening (never the enhance prompt, never each other's), that both
  map 404/400 to `enhance_unsupported` exactly like the pre-existing `enhance` test
  already proved, that variations posts to the distinct `/images/variations` endpoint
  (not `/images/edits`) with an `n` form field and no `prompt` field at all, that it
  returns every image the provider sent back, and that a network failure maps to
  `ai_network` — closing the "only exercised indirectly through mocked route tests" gap
  the route-test layer alone would have left; `src/app/dashboard/media/media-manager.test.tsx`
  **(4 new tests appended)**: the three new buttons render only when `asset.variant ===
  "original"` and disappear for a `bg_removed` asset (proving the same
  no-second-uncontrolled-round restriction `enhance` already had is now shared by all
  four AI operations), background removal's own success notice reaching the screen,
  a failed upscale surfacing the server's actual Persian rejection message rather than a
  generic fallback, and variations reporting the number of alternates the server actually
  created rather than the number requested.

- **OCR/document-intelligence — receipt photo → expense (migrations 0177/0178, Sections
  D, M, N, Q, O.1), this session** — 44 new tests across seven files, all passing on
  first or near-first run, none skipped/stubbed:
  - `src/lib/ai-receipt-service.test.ts` **(new file, 6 tests)**: the standalone metered
    extraction service — success, auth failure, provider timeout, network failure, an
    unparseable model reply, and the no-`usage`-in-the-provider-reply fallback path.
  - `src/app/api/ai/receipt-ocr/route.test.ts` **(new file, 8 tests)**: the full 8-guard
    chain (Section M) — storage not configured, invalid/mismatched image bytes, AI not
    configured, wallet-credit-required, a provider error with no charge, and both the
    fresh-store and hash-deduplicated success paths.
  - `src/app/api/media/[id]/file/route.test.ts` **(new file, 7 tests)** — closes a
    pre-existing gap (the route had no direct test at all): the `media.view` bypass
    never even calling `getMediaAssetUsage`; each of the three usage-based branches
    (`menu.view`+menu-item photo, `inventory.view`+inventory-item photo,
    `ledger.view`+expense-receipt photo, the last one new this session) granting access
    only when *this* asset is actually named by that usage category, not as a blanket
    grant; documents always requiring `media.view` regardless of any usage; 404/503.
  - `src/app/api/ledger/expenses/route.test.ts` **(new file, 6 tests)** — another
    pre-existing gap closed: `receiptAssetId` forwarded to `recordExpense` when present,
    normalized to `null` when absent or malformed (never `undefined`), `ExpenseError`
    mapped to its own status code, and the pre-existing GET/bad-JSON paths.
  - `integration/expense.integration.test.ts` **(+4 tests, against a real database)** —
    `recordExpense({receiptAssetId})` actually writes and round-trips the column and
    `getMediaAssetUsage` finds the expense back by it; a receipt asset belonging to a
    different business is rejected (`receipt_asset_not_found`, the same tenant-isolation
    shape `unknown_account` already had for accounts); a nonexistent id is rejected the
    same way; deleting the underlying `media_assets` row afterward leaves the expense's
    amount untouched and just nulls the link (`ON DELETE SET NULL` proven against a real
    delete, not just read from the schema).
  - `src/app/dashboard/media/media-manager.test.tsx` (2 existing fixtures corrected to
    include the new `expenses: []`/`ocr_receipt` shapes; no behavior these fixtures test
    was changed) and `src/app/api/media/[id]/route.test.ts` (5 existing mocked-usage
    fixtures extended the same way) — both were already covered by mocks, not by the
    real `mediaAssetUsageIsEmpty`, so these were shape corrections for accuracy, not bug
    fixes.
  - `src/app/(app)/accounting/expense-section.test.tsx` **(new file, 3 tests — the first
    RTL/component test this file has ever had)**: uploading a receipt photo prefills
    every empty field (vendor/memo/date/amount/category) without overwriting one the
    person had already typed, and shows the matched account by its OCR-suggested code;
    a failed extraction shows the server's own message and leaves the form untouched
    (never blocks manual entry); the extracted asset's id is carried through as
    `receiptAssetId` on `POST /api/ledger/expenses` when the form is actually submitted
    (driven through the real `SearchableSelect` for the payment account, not stubbed).
  - `integration/media-library.integration.test.ts` and the full `test:db` suite were
    re-run after `getMediaAssetUsage` gained the `expenses` category and are unaffected
    (Section U).

- **Invoice-OCR service/route test-coverage gap closed (Section M), this session** —
  17 new tests across two new files, zero behavior changes, all passing on first run:
  - `src/lib/ai-invoice-ocr-service.test.ts` **(new file, 9 tests)**: barcode-first
    catalogue matching, fuzzy-name fallback when a line has no barcode, an unmatched
    line producing `matchStatus: "unmatched"` / a null `inventoryItemId` and a
    non-`"pass"` verdict rather than a guessed link, the vendor-to-supplier fuzzy match
    never firing below its 0.72 name-score threshold, `extraction_failed` thrown (not a
    fabricated result) on an unparseable provider reply, the `ai_auth`/`ai_timeout`/
    `ai_network`/`ai_provider` error-code mapping (mirroring `ai-receipt-service.ts`'s),
    and `collapseCandidates` de-duplicating a catalogue item that a join returned twice.
    `./db`'s `query` is stubbed with `vi.mock("./db", () => ({ query: vi.fn() }))` —
    the same convention `purchase-lines.test.ts` already used — rather than inventing a
    new DB-mocking approach; no real database is touched.
  - `src/app/api/ai/invoice-ocr/route.test.ts` **(new file, 8 tests at this point)**:
    attachment validation before the wallet is ever touched, the `no_location` 409
    unique to this route (the receipt-ocr route has no location precondition), the
    AI-config-then-wallet-preflight ordering, a full success response that explicitly
    carried **no** `asset` field with zero media-service calls made (pinning the
    route's then-current documented "the invoice image is never persisted" design as
    intentional, not an oversight — this assertion was rewritten in the very next step
    below once that design changed), and the `InvoiceOcrError` → HTTP status mapping.
  - `ai-invoice-ocr.ts` (pure prompt/parser/matcher logic) was already tested via the
    pre-existing `ai-invoice-ocr.test.ts`; this closed the remaining service/route gap,
    so all three invoice-OCR files had real coverage — immediately ahead of the storage
    migration below, deliberately in that order (pin the existing behaviour with tests
    first, then change it, rather than changing untested code).

- **Invoice-OCR then migrated onto canonical Media storage (migrations 0179/0180,
  Sections D, M, N, O.1, Q), same session** — 24 new/changed tests across five files
  (one rewritten, four new), all passing:
  - `src/app/api/ai/invoice-ocr/route.test.ts` **(rewritten, 8 → 11 tests)**: added
    `storage_not_configured` 503 and `signature_mismatch` 400 (mirroring
    `receipt-ocr/route.test.ts`'s own equivalents), rewrote the success test to assert
    `json.asset` is now actually returned and `storeMediaAsset` was called with
    `source: "ocr_invoice"`, added a hash-dedup reuse test, and updated the
    `InvoiceOcrError` mapping test to assert `storeMediaAsset` is never called on a
    failed extraction. The "no `asset` field" assertion from the previous step's test
    was replaced, not left contradicting the new code.
  - `src/app/api/media/[id]/file/route.test.ts` **(+1 test)**: a new
    "migration 0179: an inventory.view-only member reads an image a draft purchase
    recorded as its invoice" case, proving the new usage branch grants access only when
    *this* asset is actually the purchase's own invoice photo, and existing fixtures
    updated to include the new `purchases: []` usage-shape key.
  - `src/app/api/inventory/purchases/route.test.ts` **(new file, 4 tests — this route
    had no direct test at all before)**, scoped deliberately to only this session's
    change: `invoiceAssetId` forwarded to `createDraftPurchase` together with this
    business's id, normalized to `null` when absent or non-string, the service's
    `invoice_asset_not_found` mapped to its own 404, and the pre-existing `no_location`
    409 path. The route's unrelated GET/line-validation behaviour remains untested by
    this pass — a pre-existing gap this change did not widen but also did not close.
  - `integration/purchase-invoice-asset.integration.test.ts` **(new file, 6 tests,
    against a real database)** — mirrors `expense.integration.test.ts`'s receipt-asset
    suite exactly: `createDraftPurchase({invoiceAssetId})` writes and round-trips the
    column and `getMediaAssetUsage` finds the purchase back by it (both with and without
    the purchase's own note, since a purchase has no title field); a foreign-business
    asset id is rejected (`invoice_asset_not_found`) and leaves no half-written purchase
    row behind (the whole insert is one transaction); a nonexistent id is rejected the
    same way; deleting the underlying `media_assets` row afterward leaves the purchase's
    total untouched and just nulls the link (`ON DELETE SET NULL` proven against a real
    delete); omitting `invoiceAssetId` entirely still creates a purchase with a null
    link, unchanged from before this migration.
  - `src/app/dashboard/media/media-manager.tsx`'s own `MediaAssetUsage` interface and
    usage-count/delete-confirmation logic gained the `purchases` key (no dedicated new
    RTL test — this mirrors the un-tested-at-the-frontend `expenses` key from the
    receipt-OCR step, an existing, disclosed gap in the RTL layer of the test pyramid
    for Media, not a new one).
- **Migration 0181 (party avatar → canonical Media Library), this session's fourth and
  final per-flow migration**:
  - `src/app/api/media/[id]/file/route.test.ts` **(+1 test, 8 → 9)**: a new "migration
    0181: a parties.view-only member reads an image a party recorded as its avatar"
    case, mirroring the ledger.view/inventory.view precedents exactly; existing fixtures
    updated to include the new `parties: []` usage-shape key.
  - `integration/parties.integration.test.ts` **(+9 tests, this session's second block for
    this file — the first 5 were the O.2 validation fix)**: `profileImageAssetId` links
    and round-trips through `getMediaAssetUsage`; a legacy `profileImage` sent in the same
    write as an asset id is cleared (the asset always wins); a later edit that sends the
    legacy link path instead clears a previously-set asset id (mutual exclusivity holds in
    both directions, not just on the initial write); an unrelated field edit leaves an
    existing avatar untouched; a cross-tenant asset id, a nonexistent asset id, and a
    document-kind asset are each rejected with `invalid_image`; the check also runs on
    update, not just create; and deleting the underlying `media_assets` row afterward
    leaves the party record intact with the reference nulled (`ON DELETE SET NULL`
    proven against a real delete, not assumed from the schema).
  - `src/app/dashboard/media/media-manager.tsx`'s own `MediaAssetUsage` interface and
    usage-count/delete-confirmation logic gained the `parties` key, the same shape as
    `purchases`/`expenses` before it (same disclosed RTL-layer gap: no dedicated new RTL
    test for this specific key, consistent with the existing, disclosed gap noted above).
    While in this code path, a **separate pre-existing display bug** was found and fixed
    in the same paragraph: the "استفاده در:" (used in) usage-summary line rendered
    `menuItems`/`inventoryItems`/`expenses` but silently omitted `purchases` from the
    *displayed* list even though `purchases` was already counted in `usageCount` and
    included in the delete-confirmation name list — a caller could see "used in 3 places"
    but a description naming only 2. Fixed to list all five usage kinds including the new
    `parties`; `media-manager.test.tsx`'s existing 18 tests pass unchanged (optional-
    chaining fallbacks meant older fixtures lacking `parties`/`purchases` stayed safe).
  - `src/app/dashboard/parties/party-form.tsx`: the client-side avatar picker (its own
    `FileReader`, its own `PROFILE_IMAGE_TYPES`/`MAX_PROFILE_IMAGE_BYTES` checks, storing
    a base64 string directly on `state.profileImage`) was replaced with the same
    `MediaImageField`/`MediaPickerDialog` every catalogue item's photo uses for a *new*
    upload; a party's pre-existing legacy value is still rendered via a plain `<img>`
    with an explicit "replace with a library photo" action rather than being
    force-migrated. `src/app/dashboard/parties/parties-directory-regressions.test.ts`'s
    structural pin for the old FileReader path was rewritten (not deleted) into two tests
    asserting the new components are used and the old `FileReader`/`readAsDataURL` path
    is gone, plus that the legacy-value fallback still renders — 40/40 tests in that file
    pass (was 39/40, 1 pinning the now-deliberately-changed code).
- **Workspace document register — the "cannot actually open the file" bug (Section N,
  U item 21), this session's first Workspace audit**: `src/app/(app)/workspace/documents-
  section.test.tsx` **(new file, jsdom + Testing Library, 6 tests)** — a document with a
  linked asset renders its file name as a real link to `mediaFileUrl(id)` with
  `target="_blank"`, not inert text; a document with no linked asset still renders plain
  text, not a broken link; clicking the link opens the file without also triggering the
  row's own edit-dialog `onClick` (the propagation-stopping fix, proven, not assumed); the
  row itself still opens the edit dialog when clicked anywhere else; the edit dialog shows
  a "مشاهدهٔ فایل فعلی" link to the currently-selected asset for a document that already
  has one; and the create dialog shows no such link before any asset is picked. This is
  the fourth dedicated component-test file for a client this program's Media-consolidation
  work touched (after `media-manager.test.tsx`'s two suites and `expense-section.test.tsx`).
- **Version-history (lineage) UI — this session's final addition, no schema change**:
  - `src/app/api/media/[id]/lineage/route.test.ts` **(new file, 4 tests)** — 403 without
    `media.view`; 404 for a missing asset and (separately) for an asset id that belongs
    to another business; 200 returning `{ lineage: { ancestors, descendants } }` from a
    mocked `getMediaAssetLineage`; 200 with both arrays empty for a plain upload.
  - `integration/media-library.integration.test.ts` **(+4 tests, 43 → 47)** — a real
    upload with no history returns `{ ancestors: [], descendants: [] }`; a three-hop
    chain (`original → crop → enhance`) returns the crop's ancestors root-first
    (`[original]`) and its descendants (`[enhance]`) — proving the walk is exactly
    one hop in each direction from a mid-chain node, not the whole tree; a fork (two
    separate children of the same original) lists both children as descendants of the
    shared parent; an asset id from a different business (`BID2`) queried as `BID`
    returns an empty lineage rather than throwing or leaking the other tenant's chain.
    Run against a real Postgres database this session
    (`npm run test:db` equivalent, see Section U) — 47/47 passed.
  - `src/app/dashboard/media/media-manager.test.tsx` **(+3 tests, 18 → 21)** — a new
    `describe("AssetDrawer version history (lineage)")` block: an asset with empty
    `ancestors`/`descendants` renders neither the "سابقهٔ نسخه" nor the
    "نسخه‌های ساخته‌شده از این فایل" panel at all; an asset with a two-entry ancestor
    chain renders each ancestor as a link to `/api/media/<id>/file` and does **not**
    render the open asset's own name as a link (it is already open in this drawer); an
    asset with two descendants renders both, each linked to its own file. All 21 pass;
    the pre-existing 18 tests needed **no changes** — their fetch mocks don't answer the
    new `/api/media/asset-1/lineage` URL, but `src/app/dashboard/ui.tsx`'s `api()` helper
    already swallows any fetch rejection into `{ ok: false }` rather than throwing, so
    `lineage` just stays `null` and the new panel's render-gate correctly shows nothing —
    verified, not assumed, by running the full pre-existing suite unmodified.

No tests were skipped, stubbed, or marked as TODO anywhere in this program. Media now has
four dedicated component-test files (`media-manager.test.tsx`'s crop/upload-panel
suites, `expense-section.test.tsx`, and — new this session — `documents-section.test.tsx`
for the Workspace document register) plus one
pure-Node engine suite (`media-uploader.test.ts`) — a first, narrow instance of the
RTL-component layer of the requested test pyramid for Media, not the full breadth of it.
No E2E, mobile, or accessibility tests were added for Media; the repo's existing generic
design/RTL/dark-mode lint suites, which run against every dashboard page including the
media manager, were re-run and pass, but that remains distinct from dedicated Media
E2E/mobile/a11y coverage. `ai-invoice-ocr.ts`/`ai-invoice-ocr-service.ts`/`invoice-ocr`
route now have real unit coverage AND the invoice photo is now persisted to canonical
Media storage, both this session (Section M) — the "still ephemeral by design" gap this
report described earlier is closed, not merely tested-and-left-as-is.

## U. Verification results (commands actually run this session, in order)

1. `npx tsc --noEmit -p tsconfig.json` → clean, run after every substantive change in
   this session (media-service wiring, the transform route, `media-transform.ts`'s
   `sharp.Sharp` → `Sharp` type fix, the orphan script, the MIME delegation, the parties
   fix) — always re-run to green before moving on, never left red between steps.
2. `npx eslint <touched files>` → clean after every substantive change; `npx eslint
   scripts/media-reconcile-orphans.ts`, `src/lib/parties-service.ts`,
   `src/lib/business-logo.ts`, `src/lib/website/content-service.ts`,
   `integration/*.test.ts` → all clean, `--max-warnings=0`.
3. `npx vitest run src/lib/media.test.ts src/lib/media-transform.test.ts` → 40/40 passed.
4. `npx vitest run src/lib/business-logo.test.ts src/lib/website/content-service.test.ts`
   → 9/9 passed (proves the byte-signature delegation is behavior-preserving).
5. `npx vitest run src/lib/parties*.test.ts src/app/dashboard/parties/*.test.ts` →
   129/129 passed (no regression from the `profileImage` validation change).
6. `npx vitest run` (full unit suite) → **425/425 files passed, 5979/5979 tests
   passed**, run twice this session (once mid-session, once as the final check after
   every change below was in place) — both green.
7. `DATABASE_URL=... npx vitest run --config vitest.db.config.ts` (**full** DB
   integration suite, all files) → run three times this session as changes accumulated:
   132/132 files, 1536/1537 (first run, before this session's new tests existed) →
   132/132, 1539/1540 (after the transform-feature integration tests were added) →
   **133/133 files, 1550/1551 tests passed, 0 failed** (final run, after the
   orphan-reconciliation script, the MIME-signature delegation, and the parties
   `profileImage` fix were all in place — the file count rose from 132 to 133 because
   `media-reconcile-orphans.integration.test.ts` is a new file). Every individual new
   test file (`media-library`, `media-reconcile-orphans`, `parties`) was also run
   standalone and passed cleanly before this final full run. The 1 skipped test
   throughout is pre-existing and unrelated to Media.
8. `npx tsx scripts/media-reconcile-orphans.ts` (against the local dev database, storage
   not configured) → correctly printed "nothing to reconcile" and exited 0, proving the
   script is actually runnable, not just type-checked.
9. `npx tsc --noEmit` / `npx eslint .` (whole repo, prior sessions and re-confirmed at
   the very end of this session) → clean.
10. `npm run build` — **attempted 4 times this session, all 4 killed by the sandbox's
    OOM killer** (`dmesg` confirms a real `oom-kill`, not a code error: the build
    process's anon-rss reached ~3.3 GB against this container's ~3.8 GB total before
    being killed). This is a change from an earlier session in this same program, which
    reports this exact command succeeding once, before the codebase grew further.
    Diagnosed, not just retried blindly: (a) tried `--max-old-space-size` at 3200 and
    2600 — same outcome both times, so the ceiling is not the V8 heap setting; (b)
    added `sharp` to `serverExternalPackages` (a legitimate, kept improvement — native
    addons should never be webpack-bundled — see the diff in `next.config.ts`) in case
    tracing its native bindings was the spike — no change; (c) as a pure diagnostic,
    temporarily set `typescript.ignoreBuildErrors`/`eslint.ignoreDuringBuilds` to `true`
    to isolate whether the duplicate type-check/lint pass inside `next build` was the
    cause — still OOM-killed, so it is the webpack compilation of this app's ~440
    routes itself that no longer fits in this sandbox's memory ceiling; **this
    diagnostic change was reverted immediately** and is not part of the shipped diff.
    `npx tsc --noEmit` (which performs the same type-check `next build` would) is clean,
    and every route file touched this session (`transform`, `collections`, `restore`,
    `usage`, etc.) passed `eslint` individually — this is a sandbox resource ceiling,
    not a code defect, but it is a real gap in this session's own verification chain and
    is reported as such rather than assumed away.
11. **Follow-up session — crop UI**: closed the "crop is implemented but has no click
    target" gap noted in Section L/V of the prior report. `npx tsc --noEmit` clean;
    `npx eslint src/app/dashboard/media/media-manager.tsx
    src/app/dashboard/media/media-manager.test.tsx --max-warnings=0` clean; the new
    `media-manager.test.tsx` (3 tests) passes standalone and inside the full unit run;
    the full unit suite was re-run afterward — **426/426 files, 5982/5982 tests
    passed** (the file/test counts rose by 1 file / 3 tests from the previous report's
    425/5979 — consistent with only the new crop test file being added, 0 regressions
    elsewhere); both Media integration suites
    (`media-library.integration.test.ts` 40/40, `media-reconcile-orphans.integration.test.ts`
    6/6) were re-run against a freshly re-initialized local dev database (this sandbox
    does not persist `node_modules` or the Postgres data directory across sessions —
    `npm ci` and the numbered migrations in `migrations/` were re-applied from scratch,
    all 216 including `0174`/`0175` applying cleanly) and passed.
12. **Same follow-up session — central uploader**: closed the "no bounded-
    concurrency/retry/cancel upload manager" gap (Section J). `npx tsc --noEmit` clean;
    `npx eslint src/app/dashboard/media/media-manager.tsx
    src/app/dashboard/media/media-manager.test.tsx src/app/dashboard/media/media-picker.tsx
    src/lib/media-uploader.ts src/lib/media-uploader.test.ts --max-warnings=0` clean.
    While building the manager's upload-panel tests, found and fixed a real bug (upload
    failure summaries being silently erased by the upload flow's own `reload()` call,
    Section J) — the bug was caught by a test, not observed manually, and the fix was
    verified by re-running that test against the corrected code. Full unit suite re-run
    after all changes: **427/427 files, 5993/5993 tests passed** (427/5993, up from the
    prior 426/5982 by exactly the 1 new file / 11 new tests this step added: 8 in
    `media-uploader.test.ts` + 3 in `media-manager.test.tsx`'s new upload-panel suite — 0
    regressions elsewhere). Both Media integration suites were re-run once more against
    the same freshly-migrated local database and passed (40/40, 6/6) — this step touched
    no server-side code, so this was a regression check, not new integration coverage.
    One residual, disclosed rather than hidden: `media-manager.test.tsx`'s upload-panel
    suite intermittently logs (not fails on) a React "not configured to support
    act(...)" warning from an async `reload()` state update settling outside an explicit
    `act()` boundary in one of its three new tests; the test's assertions are
    deterministic and pass on every repeated run, but the warning itself was not fully
    eliminated.
13. **Same follow-up session — WordPress push (Section K)**: closed the "mapping table
    with no producer" gap. `presignS3Get`'s output was cross-checked byte-for-byte
    against a real boto3 `generate_presigned_url` call under a pinned clock before being
    trusted in `s3-lite.test.ts`. `npx tsc --noEmit` clean; `npx eslint` clean on every
    touched file (`s3-lite.ts`, `media-service.ts`, `wp-content-service.ts`,
    `webhook-ingest-service.ts`, `plugin-service.ts`, the new route and its test, the
    drawer and its test). Full unit suite re-run: **428/428 files, 6017/6017 tests
    passed** (428/6017, up from the prior 427/5993 by the 1 new route-test file plus the
    additions inside `s3-lite.test.ts`, `wp-plugin-admin-source.test.ts` and
    `media-manager.test.tsx` — 0 regressions elsewhere). The full DB integration suite
    (`npm run test:db` equivalent, `vitest.db.config.ts`, all 133 files) was re-run in
    full — not just the Media-touching files — and passed: **133/133 files, 1557/1558
    tests passed, 1 pre-existing skip**, including `media-library.integration.test.ts`
    43/43 and `wp-manager.integration.test.ts` 28/28 (24 pre-existing + 4 new). The PHP
    plugin change (`class-pos-sync.php`, version bumped 1.6.3→1.6.4, changelog entry
    added) has no PHP test runner in this repo; it was verified by careful read-through
    plus the new `wp-plugin-admin-source.test.ts` assertion on the exact source text, not
    by executing PHP. `npm run build` again hit the same sandbox OOM
    (`SIGKILL`) documented in item 10 — unrelated to this change, not re-investigated.
14. **Same follow-up session — Section H correction and a coverage gap it exposed**:
    re-read Section H against the actual `detect`/`PATCH` code (not against the report's
    own earlier text) and found the "review-workflow never implemented" claim there —
    and echoed in Section A and Section V — was simply false; the workflow was real,
    correct, and pre-existing (traced to base commit `81c29c4`, before this program).
    Corrected all three sections. That same code-vs-code audit surfaced a genuine gap the
    false claim had been masking: `src/app/api/media/[id]/route.ts` (the route that
    actually persists `confirm`/`reject`, plus rename/move and the trash/force/purge
    delete branches) had **no test file at all**. Added
    `src/app/api/media/[id]/route.test.ts` — 19 new tests covering the `confirm` merge
    (with and without an operator override), `reject`'s isolation from category/tags, the
    `aiDecision` validator, rename/move/category/tag validation, and `DELETE`'s
    usage-block/force/trash/purge three-way branch. `npx tsc --noEmit` clean; `npx eslint
    src/app/api/media/[id]/route.test.ts --max-warnings=0` clean. Full unit suite re-run:
    **429/429 files, 6036/6036 tests passed** (429/6036, up from the prior 428/6017 by
    exactly this 1 new file / 19 new tests — 0 regressions elsewhere). No server-side
    logic changed, so the DB integration suite was not re-run for this item.
15. **Same follow-up session — visual folder explorer and active-filter chips (Sections F,
    I, V)**: closed the "still flat dropdowns, not a tree/chip UI" gap. Added
    `FolderTreeExplorer`/`FolderTreeNode` — the whole folder hierarchy rendered at once,
    reused verbatim inline (desktop) and inside the app's existing `Sheet` drawer
    (mobile), against the same `/api/media/folders` CRUD endpoints that already enforced
    cycle/depth/cross-tenant safety (no backend change needed). Added a removable
    active-filter-chip row (kind/category/tag/source/pending-only/search/collection) with
    a clear-all action. `npx tsc --noEmit` clean; `npx eslint
    src/app/dashboard/media/media-manager.tsx src/app/dashboard/media/media-manager.test.tsx
    --max-warnings=0` clean. Added 4 new RTL tests (whole-tree navigation into a nested
    child, collapse/expand, a category chip appearing and clearing itself, and "clear all
    filters") — all 4 passed on first run against the implementation, and all 10
    pre-existing tests in the same file kept passing unmodified. Full unit suite re-run:
    **429/429 files, 6040/6040 tests passed** (up from 429/6036 by exactly these 4 new
    tests — 0 regressions elsewhere). No server-side route changed, so the DB integration
    suite was not re-run for this item.
16. **Same follow-up session — AI editing expansion: background removal, upscale,
    variations (migration `0176`, Sections D, L, Q)**: closed the "no background removal,
    upscale, or variations operation" gap named in the prior report's Section L/V. Added
    `MEDIA_BG_REMOVE_PROMPT`/`MEDIA_UPSCALE_PROMPT`/`imageVariationsUrl`/
    `parseImageEditReplies` to `ai-media.ts`; `runMediaImageEdit` (generic, now exported),
    `runMediaBackgroundRemoval`/`runMediaUpscale` (thin wrappers), `runMediaVariations` to
    `ai-media-service.ts`; the `MediaAssetVariant` type and three new feature-key/price
    constants to `media.ts`; three new routes
    (`bg-remove`/`upscale`/`variations`) modeled tightly on the existing `enhance` route's
    permission → storage-ready → asset-read → image/non-SVG guard → AI-config guard →
    wallet preflight → provider call → charge-after-success → store-new-asset shape; and
    UI wiring (three new drawer buttons, five new variant badges including one for the
    pre-existing but previously unbadged `transformed` variant).
    `npx tsc --noEmit -p tsconfig.json` clean throughout (checked after the lib layer, again
    after the three routes, again after the UI wiring). `npx eslint --max-warnings=0` clean
    on every touched/new file (`media.ts`, `media-service.ts`, `ai-media.ts`,
    `ai-media-service.ts`, `ai-media-service.test.ts`, the three new routes and their three
    new route-test files, `media-manager.tsx`, `media-manager.test.tsx`). New tests: 17
    across three new route-test files (`bg-remove/route.test.ts` 6, `upscale/route.test.ts`
    6, `variations/route.test.ts` 5 — 404/400/402/201-success/502-provider-error/
    503-unavailable for the two single-asset routes; batch-price preflight, fixed
    provider-side count, charge-for-actual-not-requested-count, provider-failure-no-charge,
    and the image-type guard for variations), 6 direct provider-layer tests appended to
    `ai-media-service.test.ts` (prompt selection distinguishing bg-remove from upscale from
    the pre-existing enhance prompt, the `/images/variations` endpoint and its `n` form
    field rather than `/images/edits`, and the shared `enhance_unsupported`/`ai_network`
    error-code mapping already proven for `enhance` now proven for the three new
    functions too — closing the "only exercised indirectly through mocked route tests"
    gap the lib layer would otherwise have had), and 4 new RTL tests in
    `media-manager.test.tsx` (all three buttons appear only on an `original` asset and
    disappear on a derived one; background removal's success notice; a failed upscale
    surfaces the server's own Persian message rather than a generic one; variations
    reports the actual returned count, not the requested one). All new tests passed on
    first run. Full unit suite re-run after every step, final state:
    **432/432 files, 6070/6070 tests passed** (up from 429/6040 by exactly 3 new files
    — the three route-test files — and 30 new tests: 3 from `api-guards.test.ts`
    auto-discovering the new routes' permission guards + 17 route-level + 6
    provider-layer + 4 RTL — 0 regressions anywhere). `npx eslint .` (whole repo)
    re-run clean. Migration `0176` was applied and verified end-to-end against a real
    local `embedded-postgres` instance this session (Section D): a fresh
    217-migration forward-apply, the `migrations.integration.test.ts` upgrade-path
    suite (7/7), and the **complete** DB integration suite (`vitest.db.config.ts`, all
    133 files) — **133/133 files, 1557/1557 tests passed, 1 pre-existing unrelated
    skip** — all against a database that had migration `0176` applied. A production
    `next build` was not attempted this step (Section U item 10 already documents this
    sandbox's build-time OOM ceiling as a standing, unrelated constraint, re-confirmed
    rather than re-investigated).
17. **This session — OCR/document-intelligence: receipt photo → expense (migrations
    0177, 0178, Sections D, M, N, O.1, Q, T)**: built `ai-receipt-service.ts` +
    `POST /api/ai/receipt-ocr` (persists the photo into the canonical library on
    success), `expenses.receipt_asset_id`, the `expenses` category on
    `getMediaAssetUsage`/`mediaAssetUsageIsEmpty` (+ its `ledger.view` permission
    exception on `/api/media/[id]/file`), `media_assets.source`'s new `'ocr_receipt'`
    value, `POST /api/ledger/expenses`'s `receiptAssetId` passthrough, and
    `expense-section.tsx`'s upload UI. `NODE_OPTIONS=--max-old-space-size=4096
    npx tsc --noEmit -p .` clean throughout (the sandbox hit the same transient OOM
    Section U item 10 describes for `next build` once during a plain `tsc` run this
    session too — not code-related, resolved by raising the heap ceiling for that one
    invocation); `npx eslint` clean (`--max-warnings=0` implied by the repo's config) on
    every touched/new file. Full unit suite re-run after every step, final state:
    **437/437 files, 6101/6101 tests passed** (up from 432/6070 by exactly 5 new files —
    `ai-receipt-service.test.ts`, `receipt-ocr/route.test.ts`, `file/route.test.ts`,
    `ledger/expenses/route.test.ts`, `expense-section.test.tsx` — and 31 new tests
    (6+8+7+6+3 = 30, plus 1 from `api-guards.test.ts` auto-discovering the new
    `receipt-ocr` route's permission guard) — 0 regressions elsewhere). Migrations
    `0177`/`0178` were applied and verified end-to-end against a real local
    `embedded-postgres` instance (fresh `npm run db:dev:start`, a clean 219-migration
    forward-apply, direct `information_schema`/`pg_indexes`/`pg_constraint` inspection
    confirming the exact column/index/FK-action/CHECK shape described in Section D), and
    the **complete** DB integration suite was run twice this session as the work
    progressed — **133/133 files, 1561/1561 tests passed, 1 pre-existing unrelated
    skip** in its final state, up from 1557 by exactly the 4 new
    `expense.integration.test.ts` cases (Section T) — including
    `migrations.integration.test.ts`'s own forward-apply/upgrade-path suite (7/7) and
    `media-library.integration.test.ts` (43/43) both re-run clean against the
    fully-migrated database. `npm run build` **succeeded this session**
    (`NODE_OPTIONS=--max-old-space-size=6144 npm run build`) — compiled successfully,
    and with the raised heap the type-check/lint pass inside `next build` also completed
    rather than being OOM-killed, so item 10's standing gap is now resolved for a
    heap-adjusted invocation; the default (no `NODE_OPTIONS`) invocation still hits the
    same OOM this sandbox's memory ceiling has shown throughout this program, unchanged
    from item 10.
18. **This session — invoice-OCR service/route test-coverage gap closed (Section M,
    Section T)**: added `src/lib/ai-invoice-ocr-service.test.ts` (9 tests) and
    `src/app/api/ai/invoice-ocr/route.test.ts` (8 tests); zero production code changed.
    Before writing either file, checked this repo's actual convention for unit-testing
    DB-touching service functions (`grep` found no existing `vi.mock("./db")` under
    `src/lib/*.test.ts` at first, then a second broader grep across the same glob found
    ten files already doing exactly that, e.g. `purchase-lines.test.ts`'s
    `vi.mock("./db", () => ({ query: vi.fn() }))` — matched that pattern rather than
    inventing a new one or reaching for the DB-integration suite). Along the way,
    `node_modules` was found wiped again (the same standing sandbox hazard noted for
    item 17 — not a code issue) and reinstalled via `npm ci` before any test could run.
    `npx tsc --noEmit` clean; `npx eslint` clean on both new files; both new files
    passed in full on their first real run once written correctly (one route-test
    ordering bug — `vi.clearAllMocks()` not undoing an earlier test's
    `mockReturnValue(false)` override — was caught and fixed by an explicit reset in
    `beforeEach`, before ever being reported as "passing"). Full unit suite re-run
    after: **439/439 files, 6118/6118 tests passed** (up from 437/6101 by exactly 2 new
    files and 17 new tests — 9 + 8 — 0 regressions elsewhere). No DB migration or schema
    change was involved, so the DB integration suite was not re-run for this step.
19. **This session, immediately after item 18 — invoice-OCR migrated onto canonical
    Media storage (migrations 0179, 0180, Sections D, M, N, O.1, Q, T)**: wrote
    `migrations/0179_purchase_invoice_asset.sql` and
    `migrations/0180_media_source_ocr_invoice.sql`; rewired
    `POST /api/ai/invoice-ocr` to persist the photo (mirroring `/api/ai/receipt-ocr`'s
    order exactly); added `businessId`/`invoiceAssetId` to
    `purchase-service.ts`'s `CreateDraftPurchaseInput` with the same tenant
    re-validation `expense-service.recordExpense` already used for `receiptAssetId`;
    extended `getMediaAssetUsage`/`mediaAssetUsageIsEmpty` with a `purchases` category
    and `/api/media/[id]/file`'s usage exception with the matching `inventory.view`
    branch; wired `invoiceAssetId` through `invoice-ocr-panel.tsx` →
    `purchases-section.tsx` → `POST /api/inventory/purchases`. `node_modules` was found
    wiped a third time this session (the same standing sandbox hazard, unrelated to any
    code change) and reinstalled via `npm ci` before continuing. `npx tsc --noEmit`
    clean; `npx eslint .` clean (whole repo) after every edit. Migrations applied and
    verified end-to-end against a real local `embedded-postgres` instance: a clean
    221-migration forward-apply from empty, direct `information_schema`/`pg_indexes`/
    `pg_constraint` inspection confirming the exact column/index/FK-action/CHECK shape
    described in Section D. Full unit suite re-run after every edit, final state:
    **440/440 files, 6126/6126 tests passed** (up from 439/6118 by exactly 1 new file —
    `src/app/api/inventory/purchases/route.test.ts`, 4 tests — plus 4 tests added to the
    rewritten `invoice-ocr/route.test.ts` and 1 added to `file/route.test.ts` — 4+4+1=9,
    net +8 shown by the file/test delta once `route.test.ts`'s size for `invoice-ocr`
    changed shape rather than only growing — 0 regressions elsewhere). The complete DB
    integration suite was run once against the fully-migrated database, including the
    new `integration/purchase-invoice-asset.integration.test.ts` (6 tests) —
    **134/134 files, 1567/1567 tests passed, 1 pre-existing unrelated skip**, up from
    133/1561 by exactly that one new file. `npm run build` was not re-attempted this
    step (Section U item 10/17's standing sandbox OOM ceiling, re-confirmed rather than
    re-investigated, unchanged).
20. **This session, immediately after item 19 — CRM party avatar migrated onto canonical
    Media storage (migration 0181, Sections D, N, O.1, O.2, T)**: wrote
    `migrations/0181_party_profile_image_asset.sql`; added `assertProfileImageAssetOwned`
    to `parties-service.ts` and wired `profileImageAssetId` through `createParty`/
    `updateParty` with the mutual-exclusivity rule in `normalizePartyWrite` (a truthy
    asset id always nulls the legacy `profileImage` column in the same write); extended
    `getMediaAssetUsage`/`mediaAssetUsageIsEmpty` with a `parties` category and
    `/api/media/[id]/file`'s usage exception with the matching `parties.view` branch;
    rewrote `party-form.tsx`'s avatar control onto `MediaImageField`/`MediaPickerDialog`
    (removing the component's own `FileReader`/type/size-check block entirely — the exact
    duplicated-validation pattern this whole program exists to remove) while preserving a
    read-only fallback for a party's pre-existing legacy value; fixed an unrelated
    usage-display omission bug found in `media-manager.tsx`'s "استفاده در:" summary line while
    extending it (it counted `purchases` toward the usage total but never listed it,
    Section T). `npx tsc --noEmit` clean; `npx eslint .` clean (whole repo). Migration
    applied and verified end-to-end against a real local `embedded-postgres` instance: a
    clean 222-migration forward-apply from empty, direct `information_schema`/
    `pg_indexes`/`pg_constraint` inspection confirming the exact column/index/FK-action
    shape described in Section D. Full unit suite re-run after every edit, final state:
    **440/440 files, 6128/6128 tests passed** (up from 440/6126 by exactly 2 net new
    tests: `route.test.ts` +1, and `parties-directory-regressions.test.ts`'s single
    FileReader-pinning test replaced by two tests for the new behaviour, net +1 there —
    1+1=2 — 0 regressions elsewhere). The complete DB integration suite was run once
    against the fully-migrated database, including the 9 new tests in
    `integration/parties.integration.test.ts`'s migration-0181 block —
    **134/134 files, 1576/1576 tests passed, 1 pre-existing unrelated skip**, up from
    134/1567 by exactly those 9 new tests. `npm run build` was not re-attempted this step
    (Section U item 10/17's standing sandbox OOM ceiling, re-confirmed rather than
    re-investigated, unchanged).
21. **This session, immediately after item 20 — Workspace audited for the first time
    (Sections N, T)**: before touching any code, `git grep` swept every Workspace entity
    (`media_asset_id`, `mediaAssetId`, `attachment`) to check for undisclosed storage
    duplication; found none — `workspace_documents.media_asset_id` is the only file
    reference in Workspace and was already a real Media Library asset from a pre-existing
    migration (`0149`), so there was no fourth migration to write. Found instead a real,
    concrete UI bug: `documents-section.tsx` never rendered a way to open the file a
    document actually points at. Fixed by linking the row's file name and the edit
    dialog's picker to `mediaFileUrl(id)`, with the row's link stopping click propagation
    so it does not also trigger the row's own edit-dialog handler. Also hit, and recovered
    from, the two most severe sandbox faults of this whole program in immediate succession:
    `node_modules` was found wiped (the same standing hazard as item 19, a fourth
    occurrence) AND — new this session, not seen before — the local git repository's
    branch ref had been silently reset all the way back to this branch's own base commit
    (`81c29c4`), discarding every commit made across this entire program from local
    history (though the working tree's files were untouched). Recovered without losing
    any work: `git fetch origin arena/01a0d95b-cafe-restaurant-pos` confirmed every prior
    commit through `01af26d` still existed on the remote, then `git reset --mixed
    FETCH_HEAD` realigned the local branch and index to that commit while leaving the
    working tree exactly as it stood (the initial `--soft` attempt was wrong and produced
    a confusing double `D`/`??` status for every file — corrected to `--mixed`, which is
    what actually reconciles the index with an already-correct working tree). `npm ci`
    reinstalled `node_modules`; `npx tsc --noEmit` and `npx eslint .` (whole repo) both
    clean afterward. Full unit suite re-run, final state: **441/441 files, 6134/6134 tests
    passed** (up from 440/6128 by exactly the 6 new `documents-section.test.tsx` tests, 0
    regressions). The complete DB integration suite was re-run once against a freshly
    re-migrated database (a clean 222-migration forward-apply from empty, unaffected by
    the git incident since no schema changed this step) — **134/134 files, 1576/1576
    tests passed, 1 pre-existing unrelated skip**, unchanged from item 20, as expected for
    a client-only fix. `npm run build` was not re-attempted this step (unchanged reasoning).

22. **Version-history (lineage) UI** (this session, no schema change): `npx tsc --noEmit`
    clean and `npx eslint` clean on `src/lib/media-service.ts`,
    `src/app/api/media/[id]/lineage/route.ts`, its new test file, and
    `integration/media-library.integration.test.ts` after adding
    `getMediaAssetLineage`/the new route/its unit tests
    (`src/app/api/media/[id]/lineage/route.test.ts`, 4/4 passed) and after wiring the
    manager UI (`npx tsc --noEmit` and `npx eslint` both clean on
    `media-manager.tsx`/`media-manager.test.tsx`). New DB-backed lineage tests appended
    to `integration/media-library.integration.test.ts` were run against a real,
    freshly-migrated Postgres database this step: **47/47 passed** (up from 43, the +4
    lineage tests, 0 regressions). New UI tests appended to `media-manager.test.tsx`
    (a dedicated `describe("AssetDrawer version history (lineage)")` block, 3 tests) ran
    alongside the pre-existing 18 unmodified: **21/21 passed**. Full final regression run
    this step, in order: whole-repo `npx tsc --noEmit` clean; whole-repo `npx eslint .`
    clean; full unit suite (`npx vitest run`) — **442/442 files, 6142/6142 tests passed**,
    0 regressions; full DB integration suite against a freshly re-migrated database
    (`npx vitest run --config vitest.db.config.ts`, `npm run db:migrate` reporting
    "Nothing to do — schema is up to date" since this step added no migration) —
    **134/134 files, 1580/1581 tests passed, 1 pre-existing unrelated skip** (up from
    1576, the +4 lineage integration tests, 0 regressions); `npm run build` (with
    `NODE_OPTIONS=--max-old-space-size=6144`, the same heap-ceiling workaround an earlier
    session in this program established as this sandbox's actual constraint, not a code
    problem — see the retracted "build could not be completed" item this report's
    Section V once carried) — **succeeded**, only the same two pre-existing
    Edge-Runtime-API warnings from `jose` (unrelated to Media, present before this
    program started) and no errors.
23. **Real GitHub Actions CI checked for the first time this session — found genuinely
    red, for a reason none of this program's many local-sandbox green runs could have
    caught, and partially fixed**: every verification item above (1–22) was run against
    this Linux sandbox's own Postgres and Node — this session was the first time this
    program actually looked at `gh run list` for this branch's real CI. Result: the
    `test` workflow's `test` job had been failing on **every single push since commit
    `6778b46`** (\"deterministic crop/rotate/resize transforms ... storage orphan
    reconciliation ...\", 12 commits/pushes, roughly a day of this program's own elapsed
    time), for two separate, unrelated reasons — both real, neither previously caught,
    because `.github/workflows/test.yml` runs every job on `windows-latest` (documented
    in its own header comment) while every local check this whole program ever ran was
    on this Linux sandbox:
    - **`integration/media-reconcile-orphans.integration.test.ts`, 6/6 tests failing**:
      `runScript()` invoked the CLI under test via
      `execFile("npx", ["tsx", "scripts/media-reconcile-orphans.ts", ...])`. On Windows
      there is no `npx.exe` on PATH, only `npx.cmd`, and Node's `execFile` refuses to
      launch a `.cmd` without a shell — the spawn itself fails with `error.code ===
      "ENOENT"` (a string), which the test's own catch block then reported as the
      script's *exit code*, so every assertion of the form `expect(code).toBe(0)` saw
      the string `"ENOENT"` instead of a number and failed. Fixed by resolving `npx.cmd`
      on `win32` and setting `shell: true` in that case — the exact `shell: isBatch`
      convention `src/lib/pg-tools.ts` already established for the same Windows/`.cmd`
      reason, not a new pattern invented for this fix. Verified on this sandbox's own
      Linux, where the fix is a no-op (`npxBin` stays `"npx"`, `shell` stays `false`):
      6/6 passed, unchanged from before the fix. **Not yet verified on the real Windows
      CI runner** — the next push to this branch will be the first real confirmation;
      see the honesty note below.
    - **`visual-regression` job: a real, described, but never-re-recorded UI diff**:
      `accounting-expenses` (the exact screen this program's own item 11, receipt-photo
      OCR wired into Accounting's expense form, added a file-upload control to) now
      renders 0.83% of its pixels differently from the committed baseline PNG. Read
      against `docs/design/visual-regression.md`'s own rule (\"a diff is either a bug you
      introduced or a design change you can describe\"): this is squarely the second
      case, not the first — item 11 is a real, intentional, already-documented UI change,
      not a regression. **Left open, honestly, rather than fabricated shut**: re-recording
      a baseline needs a real headless Chromium rendering the actual page pixel-for-pixel,
      and this sandbox has neither a cached Chromium binary nor network access to
      `cdn.playwright.dev`/`deb.debian.org` to fetch one (confirmed this session by
      actually attempting `npx playwright install chromium` and `--with-deps`, both
      failing on network, not skipped speculatively) — and the workflow's own
      `record_baselines` manual-dispatch input exists specifically so a re-recording is a
      deliberate human action (\"a baseline is an approval, and approving it is a human's
      job\", the workflow file's own words), which this session's GitHub App token cannot
      trigger either (`gh workflow run` returned `403: Resource not accessible by
      integration`). Fabricating a replacement PNG by hand, without ever actually
      rendering the real page, would be worse than leaving this red: a hand-edited
      \"baseline\" that was never really photographed is exactly the kind of fake-passing
      check the standing instructions forbid. **What a maintainer with the right CI
      permissions needs to do**: trigger `test.yml` via `workflow_dispatch` with
      `record_baselines: true` on this branch, download the `visual-baselines` artifact,
      open `accounting-expenses.png` to confirm it shows the new upload control and
      nothing else changed, and commit it — a five-minute, low-risk, purely-visual review,
      not a re-investigation.
    - **Honesty note this finding requires**: every earlier item in this Section U that
      said a "full suite" or "full regression" was green was true of this sandbox's own
      Linux/Postgres environment, run repeatedly and genuinely — but none of those runs
      were ever the real CI this branch's PR actually gates on, and this session is the
      first time anyone (human or agent) actually checked `gh run list` for it. That gap
      in verification method, not a gap in effort, is why a real bug (the Windows
      `execFile` spawn) sat undetected through 12 pushes. It is fixed now; the visual
      diff is real, described, and blocked on a permission/tooling limit this session
      does not have — not hidden, not invented as a false "resolved".

Net effect on the test suite across this whole program: **+35 unit tests from earlier
sessions (`media.test.ts` 19→34, `media-transform.test.ts` 0→6, `media-manager.test.tsx`
0→10 counting an earlier step's +4, `media-uploader.test.ts` 0→8) plus +23 unit tests from
the WordPress-push step (`s3-lite.test.ts` +5, `src/app/api/media/[id]/wordpress/route.test.ts`
+13 new file, `wp-plugin-admin-source.test.ts` +1), plus +19 unit tests from the Section H
correction step's new `src/app/api/media/[id]/route.test.ts`, plus +4 unit tests from the
folder-explorer/filter-chips step (`media-manager.test.tsx` 10→14), plus +30 unit tests
from the AI-editing-expansion step (`bg-remove/route.test.ts` +6 new file,
`upscale/route.test.ts` +6 new file, `variations/route.test.ts` +5 new file,
`ai-media-service.test.ts` +6, `media-manager.test.tsx` 14→18, plus 3 from
`api-guards.test.ts` auto-discovering the three new routes' permission guards), +14
integration tests from an earlier session (3 transform + 6 orphan-reconciliation + 5
parties) plus +7 from the WordPress-push step (3 `readMediaObjectDownloadUrl` + 4
WordPress-correlation), plus the phase-2 trash/collections/WordPress-mapping integration
coverage from the middle of this program, plus +31 unit tests and +4 integration tests
from this session's OCR/receipt-to-expense work (item 17), plus +17 unit tests from this
session's invoice-OCR test-coverage closure (item 18), plus +9 unit tests and +6
integration tests from this session's invoice-OCR storage migration (item 19), plus +2
net unit tests and +9 integration tests from this session's CRM party avatar storage
migration (item 20), plus +6 unit tests from this session's Workspace document-register
audit and UI fix (item 21), plus +7 unit tests (4 route + 3 manager UI) and +4
integration tests from this session's version-history/lineage UI (item 22 above) —
0 net regressions** at every checkpoint where the full suite was re-run (final state:
**442 unit-suite files / 6142 tests, 134 DB integration files / 1580 tests (1 pre-existing
unrelated skip), both fully
green**).

## V. Second audit / genuine remaining work

A dead-code removal pass was never performed (Section R), so there is no
"re-run tests after cleanup" step to report beyond what Section U already shows: every
full-suite re-run this session, after every change, was green.

**Before closing, an honest list of what remains — not "limitations," open scope:**

- ~~**Central uploader** with bounded concurrency, retry, and cancel~~ — closed in a
  follow-up session: `src/lib/media-uploader.ts` now backs both the manager's multi-file
  upload and the picker's single-file upload, tested and verified (Section J, Section U
  item 12).
- ~~**WordPress as "a view over central Media"**~~ — closed in a follow-up session: a
  producer route pushes a canonical asset to a connected plugin-mode WooCommerce
  connection via a presigned bucket URL, the plugin's echoed operation id closes the loop
  back to `confirmWordPressMediaSync`/`failWordPressMediaSync`, and the asset drawer shows
  per-connection push/status, all tested (Section K, Section U item 13). The existing
  independent content mirror (`integration_wp_content`) is a different, still-untouched
  feature by design, not a gap in this one.
- ~~**Crop has no UI entry point**~~ — closed in a follow-up session: a drag-to-select
  crop rectangle is now wired into the manager's asset drawer, tested, and verified
  (Section L, Section U item 11).
- ~~**AI tag review-workflow states** (`pending_review`/`confirmed`/`rejected`) — never
  implemented; tags apply directly with no human gate.~~ Not a gap: this was already
  fully and correctly implemented before this program started (Section H). An earlier
  draft of this report wrongly listed it here; retracted. The one real thing this audit
  found and closed was a missing test file for the route that persists the decision —
  see Section U item 14.
- ~~**Visual folder explorer / mobile drawer, rich filter-chip UI** — the manager still
  uses flat dropdown/list controls, not the tree-explorer/chip UI the original request
  described.~~ Closed in a follow-up session: `FolderTreeExplorer`
  (`src/app/dashboard/media/media-manager.tsx`) renders the whole folder hierarchy at once
  — not just the current level, unlike the breadcrumb strip it sits beside — with
  expand/collapse per node and the same rename/move/delete/new-subfolder actions the flat
  chip row already had, always visible rather than hover-only so it works the same on a
  touchscreen. Inline (collapsible) on a wide screen; the identical component reused
  inside the app's existing `Sheet` drawer primitive on a narrow one, opened by a
  "کاوشگر پوشه‌ها" button next to the breadcrumb. Every active filter (kind, category, tag,
  source, pending-review-only, search, collection) now also renders as its own removable
  chip in a "فیلترهای فعال" row, with a "پاک کردن همهٔ فیلترها" to clear all at once — see
  Section U item 15.
- ~~**New AI editing operations** beyond crop/rotate/resize — no background removal,
  upscale, or variations operation exists.~~ Closed in a follow-up session (migration
  `0176`): `POST /api/media/[id]/bg-remove`, `.../upscale`, `.../variations`, all on the
  existing wallet-preflight-before-cost, new-derived-asset, source-untouched shape
  `enhance` already used, wired into the asset drawer with per-variant badges. See
  Sections D, L, Q, T, U item 16. ~~Genuinely still open within this closed item: no
  version-history UI walking a derived asset back through its full ancestor chain (crop →
  enhance → upscale, etc.) beyond the existing per-asset "usage" panel~~ — **also closed,
  this session (item 22, Sections L, T, U)**: `getMediaAssetLineage` walks
  `source_asset_id` in both directions (root-first ancestor chain, direct-descendant
  list), `GET /api/media/[id]/lineage` exposes it, and the asset drawer renders a
  "سابقهٔ نسخه" panel with a link to every ancestor's and descendant's own file, lazily
  fetched the same way the pre-existing "usage" panel already is. Still genuinely true
  and unchanged: "upscale" is a generative resharpen through the same image-edit model
  `enhance` uses, not a dedicated super-resolution model (disclosed in Section L, not a
  claim this report walks back from); once an asset has any of the four AI/transform
  variants, this drawer does not offer a second round of AI edits on it (a deliberate,
  disclosed scope boundary mirroring `enhance`'s own pre-existing restriction, not an
  oversight); and there is still no UI to pick which of several variation results to
  "keep" beyond deleting unwanted ones from the grid — read-only lineage disclosure was
  the requested/missing piece, not a new curation workflow.
- ~~**Centralized OCR/document intelligence** for Accounting/CRM/Workspace — not built;
  `ai-receipt.ts` remains a deliberately ephemeral, single-purpose helper by its own
  documented design.~~ **Closed for both existing OCR flows this session** (migrations
  0177/0178/0179/0180, Sections D, M, N, O.1, Q, T, U items 17–19): a receipt photo
  submitted through Accounting's upload control, and an invoice photo submitted through
  Inventory's purchase-draft OCR panel, are now both real, deduplicated, tenant-scoped
  Media Library assets (`source='ocr_receipt'` / `source='ocr_invoice'`), and the expense
  or draft purchase each one produces keeps a durable, safe-delete-aware pointer back to
  its own source photo (`expenses.receipt_asset_id`, `purchases.invoice_asset_id`, both
  `ON DELETE SET NULL`, both reachable through `getMediaAssetUsage` and the matching
  `*.view`-scoped exception on `/api/media/[id]/file`). Genuinely still open, not hidden:
  (a) CRM has no business-card-scanning feature at all to migrate onto this pipeline, and
  Workspace has no contract-extraction feature either — "centralized OCR consumed by
  Accounting/CRM/Workspace" is true for Accounting and Inventory only, because those are
  the only two OCR consumers that exist in the product today; there is nothing in CRM or
  Workspace to migrate, only a hypothetical future feature to design storage for in
  advance, which this program did not do; (b) no shared "document-intelligence"
  abstraction layer exists above `runReceiptOcr`/`runInvoiceOcr` — each was built and
  then migrated onto canonical storage independently, with its own hand-written
  metered-call/persist/settle shell duplicated between the two routes rather than
  factored into one, because refactoring two similar-but-not-identical routes into a
  shared abstraction was judged lower-value than closing the storage gap in both, and
  was not attempted; a genuine third consumer (business-card or contract extraction)
  would still be written as its own service today, not a plugin into a common one.
- ~~**CRM party avatars** are still independent of the canonical Media Library's
  S3-backed storage~~ — **resolved this session (migration 0181, Sections D, N, O.1,
  O.2, T, U item 20)**: a new upload now goes through `MediaImageField`/
  `MediaPickerDialog` and becomes a real, deduplicated Media Library asset via
  `parties.profile_image_asset_id`. **The website builder's own media** remains
  independent by design, not oversight — it pushes bytes to an external headless-CMS
  adapter, a genuinely different target from this app's own S3-compatible storage
  (Section N); its byte-signature check already delegates to the canonical one
  (Section O.2).
- ~~**Workspace** files were not audited this session at all~~ — **audited this session
  (Section N, U item 21)**: the only file reference anywhere in Workspace
  (`workspace_documents.media_asset_id`) was already on canonical storage from a
  pre-existing migration; the one genuine bug the audit found (no way to actually open a
  document's file) was fixed and tested, not merely noted.
- **E2E, mobile, and accessibility test coverage specific to Media** — never attempted;
  only the repo's pre-existing generic design-lint/RTL/dark-mode suites (which happen to
  cover every dashboard page, including media) were re-run.
- **CI configuration — verified this session, corrected from an earlier draft's
  overstated gap**: no *new* CI job or named check was added specifically for Media (no
  workflow file was edited). But `.github/workflows/test.yml`'s `unit-tests` job runs
  `npm test` (`vitest run`, configured with `include: ["src/**/*.test.ts",
  "src/**/*.test.tsx"]`) and its `integration-tests` job runs `npm run db:migrate` then
  `npm run test:db` (`vitest run --config vitest.db.config.ts`, `include:
  ["integration/**/*.test.ts"]`) — both are wildcard globs, not explicit file lists, so
  every test this program added (`media.test.ts`, `media-manager.test.tsx`,
  `route.test.ts` for every new Media route, `parties.integration.test.ts`'s two new
  blocks, `documents-section.test.tsx`, all of it) already runs in CI on every PR and
  every push to `main`/`arena/**` with **no workflow edit required**, and
  `integration-tests` re-applies every migration through `0181` twice in a row (the
  second run "must be a no-op" step), which is exactly the idempotency proof a new
  migration needs. What genuinely does not exist is a *named*, Media-specific check the
  way `api-guard-tests`/`design-checks`/`data-transfer-tests` each get one for
  legibility — a reporting/legibility choice this session did not make, not a coverage
  gap in what actually runs.
- **The real GitHub Actions CI for this branch was actually checked for the first time
  this session, and was red** (Section U item 23) — every prior "full suite green"
  claim in this report was true of this sandbox's own Linux/Postgres run, never of the
  real Windows CI this repo's `test.yml` actually runs on. Two real, unrelated causes,
  found by reading `gh run list`/`gh run view` for this branch rather than assumed:
  (a) `integration/media-reconcile-orphans.integration.test.ts` spawned `npx` via
  `execFile` without a shell, which fails to launch on Windows (`npx.cmd`, not
  `npx.exe`) — **fixed this session**, same `shell: isBatch` convention
  `src/lib/pg-tools.ts` already used, verified 6/6 passing on this sandbox's Linux where
  the fix is a no-op, **not yet confirmed on the actual Windows runner** (the next push
  is the first real test of it); (b) the `visual-regression` job's `accounting-expenses`
  baseline is genuinely, describably stale — it predates item 11's receipt-upload
  control, a real and already-documented UI addition, not a bug — and **remains open**:
  re-recording it needs a real headless Chromium this sandbox cannot obtain (`npx
  playwright install chromium` fails on network to `cdn.playwright.dev`, confirmed by
  attempting it, not assumed) and a `workflow_dispatch` trigger this session's GitHub
  token cannot fire (`403: Resource not accessible by integration`, confirmed by
  attempting it). A maintainer needs to run `test.yml` with `record_baselines: true`,
  eyeball the one changed PNG, and commit it — genuinely blocked on tooling/permissions
  this session does not have, not deprioritized.
- ~~**`npm run build` could not be completed in this sandbox**~~ — **resolved this
  session**, not by a code change but by raising the heap ceiling for the one command
  that needed it: it had been attempted 4+ times across earlier sessions and OOM-killed
  every time at the default heap (confirmed by `dmesg`, not inferred) — this session ran
  `NODE_OPTIONS=--max-old-space-size=6144 npm run build` and it completed cleanly,
  compilation and the build's internal type-check/lint pass both finishing without a
  kill. The default (no `NODE_OPTIONS`) invocation still OOM-kills in this sandbox at
  the plain default heap — that half of the gap is a sandbox memory-ceiling fact, not a
  code defect, and is not claimed as fixed — but "a completed `next build` remains a
  genuinely unverified step" (the prior wording here) is no longer accurate: it has now
  actually been produced and inspected end-to-end in this program, with this session's
  own new routes/lib/UI changes included in that build.
- **A pre-existing, unrelated bug was found and left unfixed on purpose**:
  `scripts/reconcile-opening-inventory.ts` cannot actually run via `npx tsx` in this
  environment (top-level `await` vs. the repo's `"type": "commonjs"`) — out of scope
  for a Media-focused session, noted in Section P instead of silently ignored.

These are exactly the parts of the original request this program did not reach, or
reached only partially. Nothing above is hidden in vaguer language than this.
