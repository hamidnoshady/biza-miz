# Issue #947 — Team section consolidation: report

**Branch** `arena/ce58f373-biza-miz` · **head** `2f77a56f` (**code head** `10e0740f`) ·
**baseline** `0c4a77c` · **main integrated** `cf2b39dd` (`merge 66f7535a`) — `main`'s head at
the time of the integration; the branch's earlier head (`03846456`) had merged `916df457`,
and the issue's audit baseline `35cb0cd` is not in this clone's history, so every finding was
re-verified against the working tree rather than the issue's line links. `main` has advanced
since (`fff5016e` at the time of writing: a document and one new integration test file, no
`src/**` or migration change); the branch does not contain those commits, and §8.4 states
that exactly rather than implying otherwise.

The report is committed as a child of the code head; the commit that carries it changes
documentation only, and the code head's own last change fixed the three findings from the
PR review at `4c3a72053a` (see §1, «The three review findings»). The evidence below therefore
names the head each gate ran on.

Scope delivered: TEAM-F01 … TEAM-F08, the consumer seam, migrations 0221–0223 and 0226 with
the reconciliation work, and the follow-up work the second directive named — stored-export
privacy (1), import field-write authorization (2), the transactional personnel-file
obligation (3), the Team UX completion (4), the accounting-visual investigation (5) and the
cross-issue contracts (6). Ownership boundaries from the issue's §1 were respected: the
floor *selector* capability reconciliation stays with #916 (this branch ships the shared
resolver it consumes), the identity-propagation contract with #854, and no payroll- or
commission-engine code was touched.

---

## 1. Implemented

### TEAM-F01 — sensitive Employee data no longer leaks through the party read

- **One policy module, `src/lib/personnel-access.ts`** (new, framework-free): an audience
  is two booleans — `personnel` (Employee identity numbers, address, HR notes, contact
  documents) and `financial` (the bank block). `personnel` opens with any of
  `team.view`, `team.manage`, `payroll.view`, `payroll.manage`; `financial` with
  `ledger.view` — the same key the corresponding *write* already needs. No new permission
  key, no preset widened.
- **Server-side projection** in `src/lib/parties-service.ts`: `partyForAudience` +
  `PERSONNEL_RESTRICTED_FIELDS` / `FINANCIAL_RESTRICTED_FIELDS`, naming the withheld paths
  (`generalInfo.nationalId`, `generalInfo.economicCode`, `address`, `addressInfo`,
  `contactInfo`, `notes`, `financialInfo`) in `restrictedFields` so the client can explain
  the blanks instead of guessing.
- **The write half** (`restrictPartyWriteToAudience`, the same file): a form round-trips
  every field it read, so a withheld field would come back blank and erase the stored
  value. Every path the audience denies is restored from the row before validation, for a
  caller who cannot express an opinion about it. Deliberately *not* a refusal — a minimal
  projection must not turn «بخشی از این پرونده برای شما پنهان است» into «ذخیره نشد».
- **Consumers updated**: `GET/POST /api/parties`, `GET/PUT /api/parties/[id]` (which hands
  its audience to the write), `GET /api/crm/customers/[id]/file`, the assistant's
  `getCustomer` tool (`src/lib/ai-tools.ts`, `src/lib/crm-service.ts`), and the bulk export
  seam: `AdapterContext.partyAudience` → `data-transfer/entities/crm.ts`
  (`restrictPartyColumnsForAudience`, the flat twin of the same list) plus the Holoo persons
  workbook, with the audience resolved from the actor in `/api/data/exports` and
  `/api/data/providers/holoo/export`, and from the schedule's *creator* in
  `schedule-service.ts` (an unresolvable creator narrows rather than widens).
- **Client**: `party-form.tsx` consumes `restrictedFields` — those inputs are `readOnly`
  with a hint, the address/contact tabs are disabled `fieldset`s with an explanatory
  notice, and `restrictPartyPayload` (`src/lib/parties.ts`) omits them from the body.

### TEAM-F02 — the membership link is tenant-safe at both layers

- `assertEmployeeLinkTarget` (service): create, link and relink all validate the target
  membership is a *live member of the same business*; refusals are
  `employee_link_unknown` / `employee_link_taken`.
- `auditPersonnelLink` writes `team.personnel_link_changed` with actor, before and after.
- **Migration `0221_personnel_links.sql`** (forward-only): `uq_users_business_membership`
  gives the composite key a unique parent, then
  `parties_employee_same_business (business_id, employee_user_id) → users(business_id, id)
  ON DELETE SET NULL (employee_user_id)` makes the invariant hold for *every* writer,
  including a raw import. Pre-existing cross-business links are audited
  (`team.personnel_link_repaired`) and cleared in the same transaction — no guessed
  replacement membership, the file itself untouched.

### TEAM-F03 — PIN onboarding carries an explicit, honored branch policy

- `resolveMembershipBranchPolicy` (`src/lib/location-access.ts`) turns the requested mode
  into `{scope, defaultLocationId, basis}` or a named refusal
  (`selected_locations_required`, `home_location_required`). Only *creation* may fall back
  to the business's default branch; an update that clears a member's branches takes `none`
  — the `ELSE 'all'` arm is gone from the writers.
- `POST /api/team` validates the scope before writing and applies the assignments
  atomically; `/api/setup/users` and the invitation flow go through the same resolver.
- The screen asks for the policy («دسترسی شعبه») as part of onboarding, and the copy now
  states PIN uniqueness is **business-wide**, not per branch.

### TEAM-F04 / TEAM-F05 — one personnel file per membership

- **`src/lib/personnel-file.ts`** (new): `ensurePersonnelFileForMembership` is idempotent,
  never throws, and is called *after commit* by every door that creates or changes a
  membership — `team-service.ts` (create, rename, `setMemberPhone`, accept invitation,
  rehire), `iam/sync.ts` (replica), `phone-otp.ts` (self-service phone), and the
  `PUT /api/parties/[id]` link path. A lost create race (a real unique index) adopts the
  winner's file instead of reporting a phantom debt.
- **Durable debt record**: `personnel_file_drift` (migration 0221, RLS enabled and forced)
  records reason, attempt count, last error and last attempt. `GET /api/team` retries up to
  five rows and returns the drift list; `npm run personnel:reconcile`
  (`scripts/reconcile-personnel-files.ts`) is the operator's retry, and both use the same
  service.
- Canonical identity is written in full (name, phone, email) and only the fields the
  membership actually owns — a membership without an email never blanks the file's.
- **Item 3 (second directive) — the obligation is part of the membership write.**
  Migration `0223_personnel_file_obligation.sql` puts the debt in the membership's *own*
  transaction (an `AFTER INSERT` / `AFTER UPDATE OF full_name, email, phone_e164` trigger
  on `users`), so a process that dies between the membership `COMMIT` and the projection
  can no longer lose the debt, and a writer nobody updated (a restored dump, a repair
  script, a replica apply) is covered without being edited. The trigger neither creates the
  file nor resolves a row: an existing episode keeps its diagnosis
  (`ON CONFLICT … WHERE resolved_at IS NULL DO NOTHING`). `listPersonnelFileDebts`
  (the debt inventory) and `listPersonnelFileDrift` (the bookkeeping) are independent
  reads — the roster flag is «no file *or* an open row» — and `personnelFileIsStale` is
  the single comparator. The reconcile script is idempotent across restarts, reports
  `recorded:false` as the alarm, and probes (23 tests across the two revisions) cover the
  lost-row member, the
  never-reachable other business, the missing-name case and the re-run.
  **Honest scope of the word «durable»:** what is durable is the *record* — the file
  itself is still written after commit. A committed membership with an open debt row is a
  legitimate, visible state; what this change removes is the silent one.
- **The seed is a writer like any other** (`scripts/seed.ts`): after `COMMIT` it runs the
  same projection for every membership of the seeded business, so a freshly seeded (or
  older, or `psql`-created) demo business does not open on «پرونده در انتظار ساخت».
  Verified: seed → `Personnel files synced for 2/2 member(s)`, then
  `npm run personnel:reconcile --dry-run` → `nothing owed`.

### The three review findings on PR #958 (all fixed, each falsified)

The review of `4c3a72053a` raised three findings — one P1 and two P2. Each fix has a test that
fails without it, and each test was run in both directions (`git checkout`-style revert of the
one line, or the migration removed) rather than being asserted green only.

- **P1 — the creation event replicated a home member with no home.** `createMembership`
  published `locations.defaultLocationId` while the row it had just written used
  `homeLocationId`; the two differ in exactly the fallback case a legacy caller produces
  (no branch policy named → scope `home`, home = the business's default branch,
  `locations.defaultLocationId` **null**). `applyIamEvents` writes that payload value straight
  into `users.location_id`, and `branchScopeSql` matches a home member only on
  `location_id = $loc`, so a Hybrid/Local site stored `location_scope = 'home'` with
  `location_id = NULL` and the member the cloud had just hired could work **nowhere**.
  `src/lib/team-service.ts` now publishes `homeLocationId`, as the rehire event already did.
  Evidence: `integration/team.integration.test.ts`, «replicates the fallback branch the row
  actually stored, all the way to access» — cloud row `{home, alpha.locationId}` →
  `iam_events` payload → `iamSync.applyIamEvents` → replica row → `isEligibleStaffAtLocation`
  and the roster, with a **control** event carrying the pre-fix `defaultLocationId: null`
  showing the replica row `{home, null}` and ineligibility at every branch. Falsified by
  reverting the one line: `AssertionError: expected null to be '45cf46c9-…'` at the replica-row
  equality (852 ms green with the fix, red without).
- **P2 — the obligation trigger missed a cleared membership phone.** `0223`'s predicate only
  looked at the phone when the membership *had* one, so `phone_e164: number → NULL` while the
  file kept the number recorded nothing in the membership's transaction, and the backfill
  repeated the same predicate. The application's rule is the opposite — a membership with no
  phone is canonical and clears the file's (`personnelFileIsStale`, and the projection writes
  `patch.phone = identity.phone`) — so the gap left a number the member no longer has
  reachable through search and the OTP door, with nothing owed and nothing to retry.
  `migrations/0226_personnel_file_obligation_phone_cleared.sql` corrects the arm
  **forward-only** (`0223` is applied wherever this branch has run; an applied migration is a
  record, not a draft): it replaces `personnel_file_obligation()` and re-runs the inventory
  with the corrected predicate, leaving existing open episodes' diagnosis and attempt count
  alone, exactly as `0223`'s did. The name and email arms, the `attempts >= 0` contract, the
  partial unique index and the trigger's binding are untouched, and `personnel-file.ts` stays
  the one decider. Evidence: `integration/personnel-file-obligation.integration.test.ts`,
  «the obligation follows a cleared membership phone» — a number replaced, a number
  **cleared**, a missing number filled in, two absences agreeing (no false alarm), the crash
  case (membership commits, no projection call, the sweep still repairs it because the debt is
  in the row the database wrote), the backfill of a pre-`0226` row, and the name/email arms
  unchanged. Falsified by moving `0226` aside: two of the seven fail
  (`expected null to match object { reason: 'identity_stale' … }`, and the crash case's sweep
  reports `{attempted: 0, repaired: 0}`).
- **P2 — the never-throws contract had two stages outside its boundary.**
  `ensurePersonnelFileForMembership` promises never to throw because every caller invokes it
  **after** committing (creation, edits, invitation acceptance, phone verification, replica
  applies), but `canonicalIdentity` ran before the `try` and the nameless case's drift write
  outside it — so a transient query failure surfaced as a 500 for a request that had already
  succeeded, and a retried creation then answered «این ایمیل قبلاً استفاده شده است», or a phone
  verification failed after being stamped. The whole synchronization now sits in one boundary
  (`stage` marks whether the failure was the identity lookup or the projection), the
  projection is extracted as `synchronizePersonnelFile` (keeping its create-race recovery,
  which only it can decide), and the failure code and the debt reason each have one decider.
  Two honest details came out of the same work: a database refusal now carries its **SQLSTATE
  plus the constraint** that refused the statement (node-postgres reports `name === "error"`
  for every server error, so the drift row used to say `error` and nothing else), and the
  boundary returns `recorded` so an operator can see when the *note* could not be written
  either. What it does **not** promise is stated in the code: it cannot un-fail a caller's
  transaction, and `iam/sync.ts` applies inside one, so a statement-level failure there has
  already aborted it — the boundary informs the caller, it does not make that transaction
  committable. Evidence: «the synchronization never throws after the caller has committed» —
  three real injections (a renamed `users.phone_e164`, a temporary CHECK that refuses the
  write, a renamed `personnel_file_drift`), each restored in a `finally`, plus the two
  properties that must not regress: a membership still cannot commit without its obligation,
  and a committed membership is never turned into a failed request. Falsified against the
  pre-fix file: the three injections throw raw database errors
  (`column "phone_e164" does not exist`, `relation "personnel_file_drift" does not exist`) and
  the write-refusal case records the useless `error` code.

### TEAM-F06 / TEAM-F07 / TEAM-F08 — the screen

- Read-only `team.view` no longer requests the invitation list (`canManage` gates the
  request) and a 403 renders «فهرست دعوت‌ها برای شما قابل مشاهده نیست…» rather than an
  error surface; the invitation **link** is still a manually shared link — nothing claims
  automatic delivery.
- Linked personnel files render their identity read-only with a pointer to the canonical
  editor (`/settings/team`), while employment/accounting edits stay available; a member
  without a file shows «بدون حساب ورود» and gets the controlled **«اتصال پروندهٔ پرسنلی»**
  flow (candidates = unlinked Employee files, server-validated and audited).
- Role cards show capability/reach/credential summaries; archive asks for a meaningful
  reason (min 8 chars) and an `expectedRevision`, shows per-action errors, and refreshes
  itself on `revision_conflict`; role filtering is a real `type="search"` input.
- `SecurityConfirmDialog` gained the `reason` field, replacing `window.confirm`/`prompt`
  (the source ban in `admin-screen-contracts.test.ts` still holds).

### Consumer seam (shared eligibility)

`src/lib/staff-eligibility.ts` (new) answers «may this member work at this branch» once:
live membership (`is_active` *and* `membership_status`), role, and the branch via
`branchScopeSql` — the SQL twin of `accessibleLocationIds`, with the pre-0170 inference
kept and every arm tenant-scoped. `GET /api/staff` and `floor.validWaiterId` use it, so
the picker and the write-side check cannot disagree. The capability question of the floor
*selector* is explicitly left to #916 (documented in the module header and in
`docs/issue-947-integration-contracts.md`).

### Item 1 — a stored export file is re-checked against today's permissions

- **Migration `0222_export_job_audience.sql`**: `data_export_jobs.party_audience` (the two
  booleans the party-shaped rows were produced under) and `data_export_jobs.domain_keys`
  (the permission keys a provider workbook was produced under), both nullable, both
  written at production time. `domain_keys` is backfilled for Holoo jobs from their own
  `provider_metadata.selectedScopes`.
- **`src/lib/data-transfer/export-audience.ts`** (new, framework-free, 8 unit tests):
  `decideExportDownload` answers one question — «was this file produced under a sensitivity
  this caller can still read?» — checking the domain keys first, then the party halves, and
  answering `{ allowed: false, requires, reason }` with
  `reason ∈ legacy_provenance | audience_revoked | domain_keys_revoked`.
- **Null provenance is a date, not a permission**: rows written before the column, and
  files produced by a schedule with no requesting member, are read as
  `LEGACY_EXPORT_AUDIENCE` (both halves open, no key waives it) — the conservative
  direction, which can only refuse more than it grants. A legacy file a permitted reader
  still needs is one click away, and the route says so
  (`export_requires_regeneration`, 403, `{ error, requires, reason }`); refusal never
  mutates the stored bytes, and a pruned file still answers `410`, not `403`.
- **Consumers**: `GET /api/data/exports/[id]` (the download), the history list
  (`data-transfer-ui.tsx`, `history-section.tsx` — rows the caller may no longer download
  are marked as such), `export-service.ts`, `provider-export-service.ts`,
  `schedule-service.ts`; the producers record `recordedAudienceFor(...)` — an unresolvable
  audience is recorded as *absent* rather than narrowed, so a script cannot launder the
  wide read into a narrow-looking file.

### Item 2 — import and async writes go through the canonical party authorization seam

- **`partyWriteAudienceForActor(businessId, userId)`** (`src/lib/member-access.ts`): async
  writers that name the member a write belongs to resolve that member's **current**
  membership at *run* time — resolving at enqueue time would let a revocation be outlived
  by a queued job. A revoked or suspended member answers the narrow audience; `undefined`
  («no actor at all» — a migration, a script) is the engine's internal default, said out
  loud instead of invented.
- **Consumers updated**: `import-service.ts` (`AdapterContext.partyAudience`, same resolver
  as `POST /api/parties`, so a CSV and a form cannot disagree), `ai-autopilot-executors.ts`
  (both party-writing executors), `data-transfer/adapters.ts`, `entities/crm.ts`, and the
  Holoo import adapter — with `restrictPartyWriteToAudience` keeping the protected cells
  and reporting each as a row warning rather than a silent drop. The AI note writer fails
  `staff_file_requires_team_access` instead of writing a file it cannot read back.
- Fixtures cover the two-business case and the Employee-who-is-also-a-Customer case
  (an import that matches a customer CSV must not write the personnel columns), with roles
  **unioned** across the merge and merges naming **no** `role`.

### Item 4 — the Team screen completed with the existing components

- **Companion views** on `/settings/team`: `members | onboarding | files | roles`
  (`TabBar`/`TabPanel`, the same primitives `settings-manager.tsx` already uses), so the
  screen is four readable surfaces instead of one column of dialogs.
- **One onboarding chooser** with three explicitly labelled modes — `invite`
  («ورود با لینک دعوت»), `pin` («ورود با رمز عددی», only with `canManage`) and `file`
  («فقط پرونده، بدون ورود») — which routes to the flow that already owns that operation.
  Honest boundary: this is one *entry point on the screen*, **not** one merged flow — the
  invitation lifecycle stays in `api/team/invitations`, PIN creation stays in
  `POST /api/team`, and the file-only mode hands off to the personnel directory.
  The file-only mode states its own consequence («بدون حساب کاربری و بدون …»).
- **One member detail surface** (`member-detail-dialog.tsx`, new): six read-only sections —
  membership state, the role and capabilities in force, the login and its credential state,
  the personnel file and whether the platform still owes one, the finance door
  (`accountingSectionHref("payroll")`, only with `payroll.view`), and dates. Every mutation
  opens the dialog the API already owns, so there is one writer per operation and this
  surface cannot drift from what the routes accept.
- **Filters and pagination**: `MEMBER_PAGE_SIZE = 25` with a Persian footer
  («نمایش … تا … از … عضو», «صفحهٔ قبل/بعد») and a clamped last page; the file-link picker
  searches the **server** (`/api/parties?role=Employee&includeInactive=1&q=…&pageSize=25`,
  300 ms debounce, real total count) instead of pulling `pageSize=200` and filtering in the
  browser — the difference matters past 200 records.
- **All states**: loading (`role="status"` + `LoadingSkeleton`), empty roster, empty
  filter result, drift/owe-file, 403-on-invitations, per-action errors, and the
  revision-conflict refresh. Keyboard and focus behaviour comes from the shared dialog
  primitives; the screen adds no new colour, spacing or copy conventions — RTL, Persian
  digits, Jalali and both themes come from the existing helpers, and design-lint holds them
  (`test:design` 38/38).

### Item 5 — the accounting visuals, investigated (no code change)

The failing screen-set was exactly three cheques/chart-of-accounts baselines, and the
comparison was made against the actual/baseline/diff pair in CI rather than by eye: the
diff bounds (`41,2 1383×799` and `71,9 1353×811`) cover the whole table area, the three
files are the ones `376b618b` (PR #858) re-recorded on `main` on 2026-10-13, and that commit
is not an ancestor of the failing head. The clock is the second half of the story — the
cheques screen prints day counts, and PR #858 added `VISUAL_NOW`/`setFixedTime` to the
harness in the same commit, which is why the pre-integration head measured a live clock
against a frozen-clock baseline. Evidence, line by line, in 8.2. **Nothing was re-recorded,
no threshold was raised, no check was skipped**: the integration with `main` resolved it,
and the visual job is green at this head.

### Item 6 — the seams shared with #854 and #916, written down

`docs/issue-947-integration-contracts.md` (new) records, with file-and-test references:
the **#854 identity-propagation contract** (the single `ensurePersonnelFileForMembership`
door list, the 0223 obligation trigger, the `identity_*_managed_by_membership` 409, and
what stays #854's — MFA-before-acceptance, replica authority, `stampPhoneVerified`, profile
self-service), the **#916 eligibility contract** (both consumers on `staff-eligibility.ts`,
the unchanged `{ id, full_name }` wire shape, and what is explicitly deferred: the picker's
`team.manage` vs the floor editor's `tables.edit`), a test map for each, and a «Things #947
did not do» list. `docs/auth-hardening-854.md` (P2.5) now records that the obligation is
written in the membership's own transaction, that `listPersonnelFileDebts` is the
inventory, and that drift is bookkeeping rather than evidence.

---

## 2. Bugs fixed

| # | Bug | Where |
|---|---|---|
| 1 | `parties.view` (held by the cashier preset) returned national/economic IDs, address, HR notes, contact documents and the bank block for Employee rows | `parties-service.ts` projection + all consumers |
| 2 | A save that round-tripped a withheld field erased it (`national_id = NULL`, `address_info = '{}'`, `notes = NULL`) | `restrictPartyWriteToAudience` |
| 3 | The customer export handed an Employee-who-is-also-a-customer's personnel columns to a key set the manager holds | `data-transfer/entities/crm.ts`, `providers/holoo/export.ts`, `schedule-service.ts` |
| 4 | `employeeUserId` accepted any business's membership id | `assertEmployeeLinkTarget` + composite FK |
| 5 | Personnel-file creation depended on which door created the membership; failures were swallowed | `personnel-file.ts` + callers + drift table |
| 6 | PIN onboarding silently granted `all` branches when no assignment was named | `resolveMembershipBranchPolicy` |
| 7 | The PIN copy claimed per-branch uniqueness (it is business-wide) | onboarding form |
| 8 | Read-only `team.view` requested (and surfaced the 403 of) the invitation list | `team-manager.tsx` |
| 9 | The party form offered edits the service refuses for linked members, with no way to reach the canonical editor | `party-form.tsx` |
| 10 | Role archiving failures were invisible and `window.confirm`/`prompt` were used | `roles-manager.tsx`, `security-confirm-dialog.tsx` |
| 11 | Waiter eligibility read `users.location_id` as if it were still the only branch | `staff-eligibility.ts` |
| 12 | A `PARTY_FINANCIAL_PRESET_ROLES` hand-copy of the role taxonomy (flagged by `roles.test.ts`) | derived from the personnel list + `manager` |
| 13 | A stored export produced under wide keys stayed downloadable by a member whose keys had since narrowed | `export-audience.ts`, `export-service.ts`, `0222` |
| 14 | An export whose provenance was never recorded was treated as if it were narrow | `recordedAudienceFor` (records absence, not the narrowest audience) |
| 15 | A CSV import wrote the personnel columns of an Employee party even when its actor could not read them | `import-service.ts` + `partyWriteAudienceForActor` |
| 16 | The membership→file debt could be lost by a crash between the membership commit and the bookkeeping insert | `0223` trigger |
| 17 | A `psql`/script-seeded demo business opened with two members that silently owed a file | `scripts/seed.ts` |
| 18 | **Review P1** — the creation event published `locations.defaultLocationId` (null in the fallback case) while the row stored `homeLocationId`, so a replica held `location_scope = 'home'` with `location_id = NULL` and the new member matched no branch | `team-service.ts` (`createMembership` payload) |
| 19 | **Review P2** — `0223`'s trigger (and its backfill) missed a membership phone that was **cleared** while the file kept the old number, so the number stayed on the file with no debt and nothing to retry | `0226` (forward-only replacement + inventory) |
| 20 | **Review P2** — `canonicalIdentity` and the nameless case's drift write ran outside the never-throws boundary, so a transient failure became a 500 for an already-committed membership (a retried creation then answered «این ایمیل قبلاً استفاده شده است»); database refusals were also recorded with the useless code `error` | `personnel-file.ts` (one boundary, `synchronizePersonnelFile`, `recorded`, SQLSTATE codes) |

---

## 3. Architecture changes

- **One audience decision** (`personnel-access.ts`) with three consumers of the same
  policy: the wire projection, the write-back guard, and the flat row projection used by
  bulk readers and imports — plus `export-audience.ts` for *stored* files.
- **One membership→file obligation** (`personnel-file.ts` behind five doors), now recorded
  by the database (`0223`, phone arm corrected by `0226`) rather than by each writer, with a
  debt inventory, a retry in the roster read, and an operator script.
- **One failure boundary** around that synchronization (`personnel-file.ts`): the caller has
  already committed, so every failure comes back as `{ ok, reason, error, recorded }` — with
  one decider for the reason and one for the code (SQLSTATE + constraint for database
  refusals) — and the boundary says out loud what it cannot do (un-fail a caller's
  transaction, which `iam/sync.ts` relies on being aborted as a whole).
- **One eligibility resolver** (`staff-eligibility.ts` → `branchScopeSql`) shared by the
  floor picker and its write-side check.
- **Tenant affinity by construction** for the membership link (composite FK), not only in
  the service.
- No new permission key; `permission-registry.ts` untouched (`ALL_PERMISSIONS` unchanged,
  so the effective-count table stands: owner 115 / admin 109 / manager 92 / accountant 40 /
  cashier 21 / waiter 9 / kitchen 4).

## 4. UX/UI changes

- One onboarding entry point on the Team screen with explicit modes (invite / create PIN
  staff with an explicit branch policy / create a personnel file only, «بدون حساب ورود»);
  the three server flows behind it are unchanged and stay separately owned.
- Four companion views (`members`, `onboarding`, `files`, `roles`) replace the single
  column; member rows show the personnel file and its drift state, with a retry.
- One member detail surface reads the six sections and hands every edit to the dialog that
  owns it — including the payroll door, which appears only where the screen behind it would
  open.
- Roster pagination and a server-backed personnel-file search (beyond 200 records).
- Restricted fields are visible *as* restricted: `readOnly` inputs with a hint, disabled
  tabs with a notice, and a summary line naming the withheld sections.
- Role cards carry capability/reach/credential summaries; reasons and revisions are
  collected in accessible dialogs.
- RTL/Persian digit/Jalali conventions preserved; the design-lint and primitive-lint
  suites (38 tests) pass unchanged.

## 5. Security changes

- Sensitive personnel reads: `team.view`/`team.manage`/`payroll.view`/`payroll.manage`;
  the bank block: `ledger.view` — both matching the writes they gate.
- **Stored exports** are refused (not redacted) when the caller can no longer read what the
  file was produced under; unknown provenance is read as the widest audience, and a
  refusal never mutates the bytes.
- **Async writes** are authorized against the actor's *current* membership at run time, and
  imports resolve the same audience the interactive route does; protected cells survive a
  merge and are reported.
- Cross-business link refusal at the service *and* the database; the repair audit record
  names the previous link.
- No permission widened; `parties.view` still opens the directory, and the directory now
  returns the operational subset only.
- Failure injection (the export seam, the drift table) keeps «we do not know» distinct
  from «allowed».

## 6. Dead/legacy code removed

- The route-local `ensureEmployeeParty` writer (replaced by
  `ensurePersonnelFileForMembership`).
- The `ELSE 'all'` branch-policy fallback in the membership writers.
- `window.confirm`/`window.prompt` in the team/roles screens.
- The duplicated waiter-eligibility SQL in `api/staff/route.ts` and `lib/floor.ts`.
- The browser-side `pageSize=200` staffing picker (replaced by the paginated server
  search) and the duplicated Invite/Add sections on the Team screen.
  No route, API or writer was removed without checking its dynamic consumers
  (`grep` over `src/`, `scripts/`, `integration/`, `docs/` — recorded in the plan).

## 7. Tests added/updated

- `integration/parties.integration.test.ts` — **73 tests**: the F01 audience cases
  (collection/item/search/CRM file/internal default), the write-back cases (manager and
  **cashier** round trips, deliberate clears still land), the **route** round trip through
  `GET`/`PUT /api/parties/[id]` with a signed session, the controlled link flow, the export
  projection (narrow vs wide vs unnamed), F02 service refusals plus the raw-insert `23503`
  and the null-link deletion case, and the F04/F05 drift/repair cases — including the two
  deterministic concurrency tests: a lost create race and a **held-lock barrier** that
  proves the contender is waiting on a real lock (`pg_blocking_pids`, polled from the
  observing client) before releasing it.
- `integration/team.integration.test.ts` — **54 tests**: the F03 scope cases for all four
  policies, refusal codes and the cleared-assignment case; the branch-scope SQL twin; the
  floor staff eligibility cases (all/selected/home/none, foreign branch, inactive member,
  the pre-0170 roaming member, no widening fallback); and the P1 replica case above, which
  applies the published event on a replica and walks it to `isEligibleStaffAtLocation`.
- `integration/personnel-file-obligation.integration.test.ts` — **23 tests** (new): the
  debt in the membership's own transaction, «aborted membership, aborted debt», the
  diagnosis-preserving conflict, the independent inventory, cross-business reachability,
  idempotent retry across restarts, the «cannot invent a name» case and the roster's single
  read; the seven `0226` phone-arm cases (including the crash-then-sweep case and the
  pre-`0226` backfill); and the five failure-boundary injections, each of which restores the
  schema it disturbed.
- `integration/export-download-audience.integration.test.ts` — **5 tests** (new): bytes to
  a reader who still holds what the file was produced under; refusal to a manager whose key
  set no longer covers them; the history's per-row answer; `410` for pruned bytes, not
  `403`; and a suspended member refused *before* provenance is consulted.
- `integration/data-transfer.integration.test.ts` — **65 tests**: the item-2 fixtures
  (two businesses, Employee-who-is-also-a-Customer, the revoked actor resolving narrow, the
  no-actor default, protected cells kept as row warnings).
- `src/app/dashboard/team/member-detail-dialog.test.tsx` (**7 tests, new, rendered**): the
  member detail surface under jsdom with `@testing-library/react` — the six sections and the
  facts behind them, a `team.view` visit getting the facts and none of the writers (not even
  the audit-log door), the payroll door appearing only with `payroll.view` (and, when it is
  absent, the requirement sentence instead of a link the screen behind it would refuse), a
  manager never being offered edit controls for an owner, an owed file rendering
  «در انتظار ساخت» with its attempt count and last error, and every mutation handing off to
  the dialog that owns the write. This is the gate the source-contract test cannot be: the
  visual harness's 14 screens do not include `/settings/team`, so until this file no test
  rendered the surface.
- `src/lib/data-transfer/export-audience.test.ts` (8), `src/lib/personnel-access.test.ts`
  (14), `src/lib/staff-eligibility.test.ts` (3), `src/lib/location-access.test.ts` (16),
  `src/app/dashboard/team/team-manager.test.ts` (33 — seven source-contract tests for the
  detail surface, the server-backed search and the hand-offs),
  `src/app/dashboard/parties/parties-directory-regressions.test.ts` (44),
  `src/lib/admin-screen-contracts.test.ts` (17).
- No test was disabled, skipped or weakened, and no baseline or budget was changed to make
  anything pass.

## 8. Exact verification and CI results

Everything below is on the working tree of the head named in each row — `10e0740f` unless
the row says otherwise — with local Postgres 16 on 127.0.0.1:5432 and
`DATABASE_URL=postgres://pos:pos@localhost:5432/pos`, unless the row names CI. **Source** and **checks** are separated on purpose: this sandbox is a 2-vCPU /
3.9 GB box with no swap, and three of the gates do not fit in it — that is a property of
the box, not a claim about the code.

### 8.1 Local gates

All at the head named in each row, on the **merged** tree (main `cf2b39dd` integrated by
`66f7535a`) with the three review fixes on top, local Postgres 16 on 127.0.0.1:5432 and
`DATABASE_URL=postgres://pos:pos@localhost:5432/pos`, unless the row names CI. The code head
of this revision is **`10e0740f`**.

| Gate | Command | Result |
|---|---|---|
| Formatting/lint | `npm run lint` (`eslint . --max-warnings=0`) | **clean, exit 0** (59 s) |
| Typecheck, scoped to the change | `tsc --noEmit -p tsconfig.scoped-tmp.json` (extends the project's own config; `include` = `src/lib/personnel-file.ts`, `src/lib/team-service.ts`, the two changed integration tests — the compiler still pulls their whole import graph) | **clean, no diagnostics** (10 s). The temp config was deleted after the run and is not in the diff. |
| Typecheck, whole project | `npx tsc --noEmit` | **cannot complete locally**: V8 `Ineffective mark-compacts near heap limit`, exit 134 at the default heap; killed by the kernel at 3600 MB. Green in CI (`type check`, 8.2). |
| Unit + component | `npm test` (`vitest run`) | **887 files / 11 749 tests passed, exit 0** (469 s) |
| Design system | `npm run test:design` | **5 files / 38 tests passed** |
| Database — the suites this issue rewrites | `integration/personnel-file-obligation` **23**, `integration/team` **54**, `integration/parties` **73**, `integration/phone-otp` **8**, `integration/iam-control-plane` **2**, `integration/staff-login-tenant` **7** | **167 passed, 0 failed** (86 s for the first five together) |
| Database — full sweep | `npm run test:db` (`vitest run --config vitest.db.config.ts`) | **236 files · 3 622 passed · 2 skipped · exit 0** (3 196 s, 53 min) — every file, no failure and **no load-induced timeout this time**: `integration/fixed-assets.integration.test.ts` (the file that timed out in the pre-integration sweep) is **75/75 in 14 s**. Two tests are skipped by their own `it.skip` in `main`, unchanged here. |
| Migrations | `tsx scripts/migrate.ts` | **`Applying 0226_personnel_file_obligation_phone_cleared.sql … ok`**, `schema_migrations` = **363** with `0226_…` the newest (`0225` and `0224` came from `main`); the DB harness rebuilds a scratch database per file, so the sweep above ran every migration 363 times over, including 0226 |
| Operator retry, on real leftover rows | `npm run personnel:reconcile` then `--dry-run` | **`1 attempted, 1 repaired, 0 still owed`** per business → **`Personnel files: all repaired (3 of 3)`**, and the dry run afterwards reads **`nothing owed`** (idempotent). The three rows were left by the sweep itself: `integration/pairing.integration.test.ts` and `integration/seed-live-chart.integration.test.ts` create their businesses in the shared local database, so their raw-SQL owners are exactly the «writer nobody updated» case the obligation covers. |
| Seed coherence | `tsx scripts/seed.ts` | **refused on this database** (`Refusing to seed with default credentials into an already-initialized database`), which is the seed's own guard; coherence was verified on a **fresh** database before the integration (`Personnel files synced for 2/2 member(s)`, reconcile → `nothing owed`) and CI's `integration tests (real database)` runs the seed on a fresh database every time. |
| Production build | `npm run build` | **not possible locally**: exit 137 (`Killed`) with `NODE_OPTIONS=--max-old-space-size=3000`, V8 heap OOM at the default heap. Green in CI (`production build`, 8.2). |
| Visual regression | `npm run test:visual` | **not run locally**: it needs the production server the build above cannot produce. Green in CI (`visual regression`, 8.2). No baseline was re-recorded, edited or approved. |

### 8.2 CI on the pushed head

`test.yml` runs on Arena branch pushes as well as PRs (the workflow says so in its own `on:`
comment: GitHub suppresses the App-created PR-synchronize event, so the same required suite is
run on the push). The code head `10e0740f` changed `src/**`, a migration, `scripts/**` and
tests — so unlike the documentation-only heads of the previous round, **every** workflow's
path filter matched here.

| Workflow | Run | Result |
|---|---|---|
| `test.yml` (push) | **38887048976** (`10e0740f`) | **✅ completed success — all 11 jobs**: `type check` ✅, `unit tests` ✅, `ESLint (noninteractive)` ✅, `API guard and permission tests` ✅, **`visual regression` ✅**, `design checks` ✅, **`integration tests (real database)` ✅** (32m20s, the longest job), **`production build` ✅**, `data transfer engine (real database)` ✅, `media E2E tests` ✅, `all checks passed` ✅ |
| `test.yml` (pull_request) | **38887053757** (`10e0740f`) | **✅ completed success — the same 11 jobs, all green** (the PR event and the push event both ran, which is why this head has two complete sets) |
| `visual regression` job (`38887053757`) | steps, verbatim | `Build` ✅, `Start the production server` ✅, `Visual regression` ✅, `Subledger keyboard and WCAG checks` ✅, `Publish visual regression summary` ✅; **`Record visual baselines (manual, opt-in)` skipped** (the opt-in recording step) and `Upload diffs` skipped (there were no diffs) |
| `build-desktop-installer` | 38887049006 (push) · 38887053682 (PR) | ✅ success — `packaged Windows end-to-end` ✅ (10m25s) |
| `verify-shippables` | 38887049330 (push) · 38887053930 (PR) | ✅ success — `which shippables changed` ✅, `desktop shell` ✅ (6m39s), `production container` ✅ (14m35s), `Windows print connector` ✅; `WordPress plugin` and `commit and tag the desktop version` **skipped** by their own conditions |
| `android-build` | — | **did not trigger**: its path filter watches `android/**` and `src/lib/native/**`, and this head touches neither |
| `test.yml` (push) | **38894957543** (report head `2f77a56f`) | **✅ completed success — all 11 jobs green**, over a tree identical to `10e0740f` except for this report |
| `test.yml` (pull_request), `build-desktop-installer`, `verify-shippables` | **38894963539**, **38894963364**, **38894963351** (`2f77a56f`) | **✅ all three success**. Only the PR-triggered packaging runs appeared at this head: the push event's path filter does not match a documentation-only commit, which is the path filter doing its job |

Every head of this branch that matters has its own completed run:

| Head | What it is | Checks |
|---|---|---|
| `03846456` | the previous code head (pre-integration) | `test.yml` **✅ 11/11** (`38718493517`); PR checks **15 passed, 3 skipped, none red** |
| `66f7535a` | the merge commit (not pushed on its own — it is the parent of `10e0740f`) | — |
| `10e0740f` | the code head of this revision: the merge + the three review fixes + migration 0226 | `test.yml` **38887048976** (push) and **38887053757** (PR), each **11/11 jobs green** including `integration tests (real database)` and `visual regression`; `build-desktop-installer` and `verify-shippables` green on both events |
| `2f77a56f` | the head this report is committed at: `10e0740f` plus `ISSUE_947_REPORT.md` only | `test.yml` **38894957543** (push) and **38894963539** (PR) **11/11 each**; `build-desktop-installer` **38894963364** ✅ and `verify-shippables` **38894963351** ✅ on the PR event |

The run that failed on this branch is the one at the **pre-integration** head `0723b53`
(`38452006386`), and its failure is the item-5 finding:

| | |
|---|---|
| Visual job at `0723b53` | ❌ on exactly three baselines, verbatim annotations: `docs/design/visual/accounting-cheques-dark.png: 4.26% of pixels changed, bounds 41,2 1383×799`; `docs/design/visual/accounting-cheques.png: 6.23% of pixels changed, bounds 41,2 1383×799`; `docs/design/visual/accounting-chart-of-accounts.png: 4.08% of pixels changed, bounds 71,9 1353×811` |
| Why those three | `376b618b` (PR #858, merged 2026-10-13) changed exactly those three baselines plus `cheques-section.tsx`, `chart-of-accounts-section.tsx`, `accounting-workspace.ts`, `coa-template.ts` and `scripts/visual-regression.mjs` — where it added `const VISUAL_NOW = new Date("2026-10-10T08:30:00.000Z")` with `context.clock.setFixedTime(VISUAL_NOW)` (the cheques screen prints day counts). |
| Inheritance proof | `376b618b` is **not** an ancestor of `0723b53`; the branch touched none of the three screens or the harness; `git diff --stat 0c4a77c 0723b53 -- docs/design/visual/` is **empty**; `grep -c VISUAL_NOW` is **0** at `0723b53` and **2** at this head; at this head `git diff --stat HEAD origin/main -- scripts/visual-regression.mjs "src/app/(app)/accounting" docs/design/visual/` is **empty**. |
| Conclusion | The three diffs were main's own transition inside `376b618b`, which had not yet reached the branch — inherited, and resolved by the integration. No baseline was re-recorded, no threshold raised, no check skipped by this branch. |

### 8.3 Running, finished and impossible

- **Local, finished** (all at `10e0740f`, on the merged tree unless noted): lint (exit 0),
  scoped typecheck (clean), unit (887 files / 11 749 tests), design (38), the changed database
  suites (167), the **full 236-file database sweep** (3 622 passed, 2 skipped, exit 0, no
  timeout), migration application (363), the operator reconcile and its idempotent re-run.
- **Local, impossible**: `npm run build` (kernel OOM at 3000 MB), whole-project `tsc --noEmit`
  (V8 OOM at 3072 MB, kernel OOM at 3600 MB), and therefore `npm run test:visual` (needs the
  build's server). Those are exactly the gates CI owns in this repository, and all three are
  green there (8.2). The *scoped* typecheck above is what this box can do about `tsc`, and it
  covers every file this revision changed.
- **CI, finished**: the runs listed in 8.2, for the code head `10e0740f` **and** for the report
  head `2f77a56f` — nothing is pending at either.
- Nothing is running when the report commit was made; the sweep, the unit suite and the
  focused runs had all finished. (`node_modules` was re-installed from the lockfile with
  `npm ci` after the integration; `node_modules` is committed on `main` as a symlink blob,
  which is a repository-hygiene issue outside this issue's scope.)

### 8.4 The split the second directive asks for

| Dimension | State |
|---|---|
| Source | `2f77a56f` on `arena/ce58f373-biza-miz`, pushed, in **PR #958** — the code head `10e0740f` (the merge of `cf2b39dd` plus the three review fixes) and then this report, which changes no source |
| Tests | **11 749** unit/component + **38** design green locally at the code head; the **full database sweep** green at it (236 files, 3 622 passed, 2 skipped, exit 0 — no timeout); **33** new database tests across the three fixes (7 phone-arm, 5 boundary injections, 1 replica chain, plus the earlier ones), each falsified in the failing direction |
| Checks | `test.yml` at **`10e0740f`**: `test.yml` **38887048976** (push) and **38887053757** (PR), each **11/11 jobs green** including `integration tests (real database)` and `visual regression`; `build-desktop-installer` and `verify-shippables` green on both events — the packaging workflows also ran at this head, because a source change matches their path filters (see 8.2) |
| Mergeability | No conflicts. `cf2b39dd` — `main` at the integration — is an ancestor of this branch through the merge `66f7535a`, which is what `git merge-base --is-ancestor` verified when the merge was made. **`main` has since advanced** to `fff5016e` (PR #978: one operator-checklist document plus `integration/automotive-reports.integration.test.ts`; **no `src/**`, migration or script change**), so it is 19 commits ahead of the integration point — and against *that* head `git merge-tree --write-tree HEAD origin/main` exits **0** with no conflict entries (tree `b5eca689`); GitHub reports PR #958 **MERGEABLE / CLEAN**. Integration with the newer `main` is therefore a merge away and conflict-free, but this revision does **not** claim to contain it, and no gate here was run against it. PR #958 is the only PR for this branch |
| Deployment | **Nothing deployed, published, tagged or merged**, and nothing was authorised to be. The migrations (0221, 0222, 0223, 0226) are forward-only and unapplied anywhere except this sandbox's local database |
| Runtime acceptance | Not claimed. The gates that exercise a running server (production build, visual regression, subledger keyboard/WCAG, media E2E) passed **in CI on GitHub's runners** at the head named above; no runtime acceptance was performed against a deployed environment |

### 8.5 Pull-request checks

**[PR #958](https://github.com/hamidnoshady/biza-miz/pull/958)** (`arena/ce58f373-biza-miz` →
`main`) carries the repository's full required suite, including the `pull_request`-triggered
desktop/container/workflow paths a branch push skips by path filter. At the code head
`10e0740f`: **16 checks passed, 2 skipped, none pending and none red** — the eleven `test.yml`
jobs plus `desktop shell`, `production container`, `packaged Windows end-to-end`, `Windows
print connector`, `which shippables changed` and the aggregate `all checks passed`. At the
head this report is committed at (`2f77a56f`, the same tree plus this document):
**15 passed, 3 skipped, none pending and none red**, the three skips being `Windows print
connector`, `WordPress plugin` and `commit and tag the desktop version`, each by its own path
condition — and the PR itself is **MERGEABLE / CLEAN**. The visual job's own step list is in 8.2: it built, served, compared and ran the
subledger keyboard/WCAG script, and the baseline-recording step stayed **skipped** at every
head of this branch — no baseline was re-recorded, edited or approved.

**The fiscal-periods race is `main`'s, and `main` fixed it while this PR was open.** The PR's
first runs failed at `src/app/(app)/accounting/fiscal-periods-section.test.tsx:214` on
`windows-latest` while the *same commit's* push run passed (`4c3a720`: push `38655674538` ✅,
PR `38703844576` ❌, `38708097514` ❌). The race is structural: the heading the test waits for
renders as soon as the year *list* lands (`years.length > 0`), while the periods request is
issued by an effect keyed on `selectedYearId`, which React runs *after* that commit — so the
assertion read a request that had not been made yet. This branch fixed it in `8b7f692d`
(awaiting the request, assertion unchanged in force, proven live by renaming the URL so the
request is never made). Then **`main` fixed the same race independently** (`03f9cb36`,
«test(commission): retry payments through browser authority context (refs #869)»), and the
integration merge kept **main's** text:

- `git diff origin/main HEAD -- src/app/(app)/accounting/fiscal-periods-section.test.tsx` is
  **empty** — the branch no longer carries its own version of that file, so there is nothing
  for a reviewer to extract and `8b7f692d` is recorded as superseded rather than pending.
- Both versions wait for the periods call inside `waitFor`; main's wording is shorter, the
  assertion is the same one at the same strength. No test was disabled, skipped or weakened by
  either change.

**Open PR**: **[#958](https://github.com/hamidnoshady/biza-miz/pull/958)** — the only PR for
this branch; no duplicate was opened, and nothing was merged, tagged or deployed.

## 9. Genuine remaining issues

- **A stored file cannot be re-projected, only refused.** PDFs and workbooks have
  positional columns and labelled headers, so the engine refuses
  (`export_requires_regeneration`, 403 with `requires`) and the file is regenerated by a
  member who *is* allowed to read it. That is deliberate; a product that wanted in-place
  redaction would need a document format that carries its own field provenance.
- **Legacy provenance is read as the widest audience.** Files produced before `0222`, or by
  a schedule with no requesting member, carry no provenance; they are refused to any
  narrower reader (and regenerated). This is the conservative direction, and it means an
  owner with genuinely broad rights sees one extra regeneration step for old files.
- **Floor selector capability** (`team.manage` on the `/api/staff` picker vs `tables.edit`
  on the floor editor) is deliberately untouched: the issue assigns that reconciliation to
  #916, which now consumes `staff-eligibility.ts` instead of re-deriving the rule. Written
  up in `docs/issue-947-integration-contracts.md`.
- **The #854 invitation lifecycle** (MFA-before-acceptance, replica authority,
  `stampPhoneVerified`, profile self-service) is untouched by design; this branch's
  contract doc records what #947 relies on and what it does not own.
- **The Team screen has no browser-level gate.** The visual harness renders fourteen
  screens and `/settings/team` is not one of them, so the surface is held by the rendered
  jsdom test (`member-detail-dialog.test.tsx`), the source-contract test, CI's design
  checks and CI's subledger keyboard/WCAG script — but not by a pixel baseline. Adding one
  means recording a new baseline, which the brief puts behind separate design approval, so
  it is recorded here rather than done unilaterally.
- **Browser/visual gates and the production build do not fit this sandbox** (3.9 GB, no
  swap): `npm run build` is killed at 3000 MB, `tsc --noEmit` aborts at 3072 MB, and
  `npm run test:visual` needs the build's server. CI is where those gates are meaningful,
  and their results are reported above — nothing here claims a local pass.
- **The fiscal-periods race was `main`'s, and `main` has fixed it — this branch no longer
  carries a fix of its own.** `unit tests` failed twice in a row at
  `fiscal-periods-section.test.tsx:214` on the PR while passing on a push run of the same
  commit; this branch repaired it in `8b7f692d`, and then `main` fixed the same race
  independently (`03f9cb36`) before the integration. The merge kept main's text, and
  `git diff origin/main HEAD -- src/app/(app)/accounting/fiscal-periods-section.test.tsx` is
  **empty** — so the earlier version of this report was wrong to list it as a deliverable of
  this branch or as something for a reviewer to extract: both fixes wait inside `waitFor` for
  the same call, and the file now belongs to main. Nothing was disabled, skipped or weakened
  by either change (see 8.5).
- **One inherited database test times out under the full serial sweep.** In a 230-file run,
  `integration/fixed-assets.integration.test.ts` (issue #833, `main`'s code, byte-identical
  to `origin/main`) had one test hit its 30 s budget after the file had already taken 194 s;
  alone, the file is 75/75 green in 13 s and that single test passes. It is load, not logic
  — and it is left alone rather than given a longer timeout, because raising a budget to get
  green is exactly what the brief forbids.
- **Dependencies**: local runs use `node_modules` from the lockfile (`npm ci` at the code
  head, after the sandbox was re-created and the committed symlink had to be replaced).
  `node_modules` is committed on `main` as a symlink blob pointing outside the repository —
  a repository-hygiene issue outside this issue's scope; CI is unaffected because it runs
  `npm ci` itself.

---

## 10. Migrations

Forward-only, none applied outside this sandbox:

| # | File | What it changes |
|---|---|---|
| 0221 | `0221_personnel_links.sql` | `uq_users_business_membership` (the unique parent the composite key needs) + `parties_employee_same_business (business_id, employee_user_id)` → `users(business_id, id)` `ON DELETE SET NULL`; pre-existing cross-business links audited and cleared; `personnel_file_drift` (RLS enabled and forced) for the debt bookkeeping. |
| 0222 | `0222_export_job_audience.sql` | `data_export_jobs.party_audience` (jsonb, nullable) and `data_export_jobs.domain_keys` (jsonb, nullable); `domain_keys` backfilled for Holoo provider jobs from `provider_metadata.selectedScopes`. Nullable by design: null means «produced before this column, or by nobody», and is read as the widest audience. |
| 0223 | `0223_personnel_file_obligation.sql` | The membership → file obligation as a property of the membership row: `AFTER INSERT` and `AFTER UPDATE OF full_name, email, phone_e164` on `users` write the debt in the membership's own transaction, without creating the file or overwriting an existing diagnosis. |
| 0226 | `0226_personnel_file_obligation_phone_cleared.sql` | **Corrects 0223's phone arm, forward-only** (a review finding; 0223 is applied and unedited): a membership phone that is **cleared** is canonical and must clear the file's, so the predicate now records the debt for `NULL`-or-blank membership phone over a non-blank `file_phone` as well as for the reverse, and the inventory is re-run with the corrected predicate. Name and email arms, the `attempts >= 0` contract, the partial unique index and the trigger's binding are unchanged; an existing open episode keeps its diagnosis and attempt count. |

Applied locally with `scripts/migrate.ts` (**363 migrations** total — `0224` and `0225` came
from `main` — `schema_migrations` records each one); `npm run personnel:reconcile` is the
operator's retry (it repaired 3 of 3 owed files on this database and then read
`nothing owed`).

## 11. Consumer coverage on the changed contracts

| Contract | Consumers updated in this branch |
|---|---|
| `PartyReadAudience` / `restrictedFields` (`personnel-access.ts`) | `GET/POST /api/parties`, `GET/PUT /api/parties/[id]`, `GET /api/crm/customers/[id]/file`, `ai-tools.ts` → `getCustomer`, `crm-service.ts`, `parties-directory-regressions.test.ts`, `party-form.tsx` (+ `restrictPartyPayload` in `parties.ts`) |
| `restrictPartyWriteToAudience` (`parties-service.ts`) | `PUT /api/parties/[id]` (the write path), `data-transfer/entities/crm.ts` (the flat row twin) |
| `AdapterContext.partyAudience` | `data-transfer/import-service.ts`, `adapters.ts`, `entities/crm.ts`, `providers/holoo/*` (import and export), `ai-autopilot-executors.ts` (two executors), `schedule-service.ts`, `/api/data/exports`, `/api/data/providers/holoo/export`, `/api/data/guard.ts` |
| `decideExportDownload` / `recordedAudienceFor` | `export-service.ts` (`getExportContent`), `provider-export-service.ts`, `/api/data/exports/[id]`, `data-transfer-ui.tsx`, `history-section.tsx` |
| `ensurePersonnelFileForMembership` | `team-service.ts` (create, rename, phone, accept, rehire), `iam/sync.ts` (replica), `phone-otp.ts`, `/api/parties/[id]` (link), `/api/team` (retry + drift), `scripts/reconcile-personnel-files.ts`, `scripts/seed.ts` |
| `personnel_file_drift` (trigger, 0223 + 0226) | Every writer of `users` without app involvement — raw SQL, a restored dump, a repair script, a replica apply — is covered by the database rather than by a list of callers; the trigger is the only definition, and 0226 replaces it in place so the binding cannot drift. |
| `staff-eligibility.ts` (`listEligibleStaffAtLocation`, `isEligibleStaffAtLocation`, `branchScopeSql`) | `/api/staff`, `lib/floor.ts` (`validWaiterId`), `/api/floor/sections*` |
| `resolveMembershipBranchPolicy` | `POST /api/team`, `/api/setup/users`, the invitation acceptance path, `setup/users/page.tsx` |

Every changed route was traced UI → request → auth → permission → service → DB → response
→ UI; a contract change was followed by updating *all* of its consumers in the same branch,
and no route, API or writer was deleted without a `grep` over `src/`, `scripts/`,
`integration/` and `docs/` for dynamic consumers.

## 12. Requirement-to-evidence map

| Requirement | Where it is implemented | Evidence |
|---|---|---|
| F01 — no sensitive Employee field under plain `parties.view`, in collection/item/search/export/AI | `personnel-access.ts`, `parties-service.ts`, `entities/crm.ts`, `party-form.tsx` | `parties.integration.test.ts` (audience cases, route round trip, export projection), `personnel-access.test.ts` (14), `parties-directory-regressions.test.ts` (44) |
| F02 — tenant-safe identity link | `assertEmployeeLinkTarget`, `0221` | `parties.integration.test.ts` (service refusals, raw-insert `23503`, null-link delete) |
| F03 — explicit PIN branch policy, honest copy | `resolveMembershipBranchPolicy`, onboarding form | `team.integration.test.ts` (four policies, refusals, cleared assignment), `location-access.test.ts` (16) |
| F04/F05 — one file per membership on every path; MFA-before-acceptance and replica authority preserved | `personnel-file.ts`, `0221`, `0223`, `0226`, `seed.ts` | `personnel-file-obligation.integration.test.ts` (23), `team.integration.test.ts` (invitation/rehire cases), `docs/issue-947-integration-contracts.md` |
| Review P1 — the creation event replicates the branch the row stored | `team-service.ts` (`defaultLocationId: homeLocationId`) | `team.integration.test.ts` «replicates the fallback branch the row actually stored, all the way to access» (payload → replica row → eligibility, with a pre-fix control event) |
| Review P2 — the obligation covers a **cleared** membership phone | `0226` (function + backfill), `personnel-file.ts` unchanged as the decider | `personnel-file-obligation.integration.test.ts` «the obligation follows a cleared membership phone» (7 cases; 2 fail without 0226) |
| Review P2 — the synchronization never throws after its caller committed | `personnel-file.ts` (one boundary, `synchronizePersonnelFile`, `recorded`, SQLSTATE codes) | `personnel-file-obligation.integration.test.ts` «the synchronization never throws after the caller has committed» (5 injections: renamed column, refused write, renamed drift table, transactional membership, committed-request case) |
| F06 — capability-gated invitations in a read-only visit | `team-manager.tsx` (`canManage`) | `team-manager.test.ts` (33) |
| F07 — linked identity read-only in the party form | `party-form.tsx`, `parties.ts` | `parties.integration.test.ts` (linked-member write refusals), `parties-directory-regressions.test.ts` |
| F08 — role summaries, revisions, dialogs, filters/pagination, all states | `team-manager.tsx`, `member-detail-dialog.tsx`, `roles-manager.tsx`, `security-confirm-dialog.tsx` | `member-detail-dialog.test.tsx` (7, rendered), `team-manager.test.ts` (33), `admin-screen-contracts.test.ts` (17), CI `design checks` + `visual regression` (subledger keyboard/WCAG step) |
| Consumer seam — `/api/staff` + `floor.validWaiterId` on canonical eligibility | `staff-eligibility.ts`, `/api/staff`, `lib/floor.ts` | `staff-eligibility.test.ts` (3), `team.integration.test.ts` (floor cases) |
| Stored-export privacy under current permissions | `export-audience.ts`, `0222`, `export-service.ts`, `/api/data/exports/[id]` | `export-download-audience.integration.test.ts` (5), `export-audience.test.ts` (8) |
| Import field-write authorization | `partyWriteAudienceForActor`, `import-service.ts`, `ai-autopilot-executors.ts` | `data-transfer.integration.test.ts` (65) |
| Atomic/durable projection obligation, honest error contract, idempotent retry | `0223`, `0226`, `personnel-file.ts`, `reconcile-personnel-files.ts` | `personnel-file-obligation.integration.test.ts` (23); `npm run personnel:reconcile` on this tree: 3 of 3 repaired, then `nothing owed` |
| Cross-issue contracts with #854 and #916 | `docs/issue-947-integration-contracts.md`, `docs/auth-hardening-854.md` | the two documents; floor/eligibility tests referenced inside them |
| No test disabled/weakened; no baseline re-recorded; no budget raised | — | every run in §8; the CI visual job's `Record visual baselines` step is `skipped` at every head |
