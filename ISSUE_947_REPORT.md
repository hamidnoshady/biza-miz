# Issue #947 — Team section consolidation: report

**Branch** `arena/ce58f373-biza-miz` · **head** `19daecd` (the report itself is its child commit) · **baseline** `0c4a77c`
(clone of `main`; the issue's audit baseline `35cb0cd` is not in this clone's history, so
every finding was re-verified against the working tree rather than the issue's line
links).

Scope delivered: TEAM-F01 … TEAM-F08, the consumer seam, the migration/reconciliation
work and the UX consolidation the issue's §7/§8 ask for. Ownership boundaries from the
issue's §1 were respected — the floor *selector* capability reconciliation stays with
#916 (this branch ships the shared resolver it consumes), and no payroll- or
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
  `getCustomer` tool (`src/lib/ai-tools.ts`, `src/lib/crm-service.ts`), and — new in this
  pass — the **bulk export seam**: `AdapterContext.partyAudience` →
  `data-transfer/entities/crm.ts` (`restrictPartyColumnsForAudience`, the flat twin of the
  same list) plus the Holoo persons workbook, with the audience resolved from the actor in
  `/api/data/exports` and `/api/data/providers/holoo/export`, and from the schedule's
  *creator* in `schedule-service.ts` (an unresolvable creator narrows rather than widens).
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

### TEAM-F04 / TEAM-F05 — one personnel file per membership, complete and durable

- **`src/lib/personnel-file.ts`** (new): `ensurePersonnelFileForMembership` is idempotent,
  never throws, and is called *after commit* by every door that creates or changes a
  membership — `team-service.ts` (create, rename, `setMemberPhone`, accept invitation,
  rehire), `iam/sync.ts` (replica), `phone-otp.ts` (self-service phone), and the new
  `PUT /api/parties/[id]` link path. A lost create race (a real unique index) adopts the
  winner's file instead of reporting a phantom debt.
- **Durable failure record**: `personnel_file_drift` (migration 0221, RLS enabled and
  forced) records reason, attempt count, last error and last attempt. `GET /api/team`
  retries up to five rows and returns the drift list; `npm run personnel:reconcile`
  (`scripts/reconcile-personnel-files.ts`) is the operator's retry, and both use the same
  service.
- Canonical identity is written in full (name, phone, email) and only the fields the
  membership actually owns — a membership without an email never blanks the file's.

### TEAM-F06 / TEAM-F07 / TEAM-F08 — the screen

- Read-only `team.view` no longer requests the invitation list (`canManage` gates the
  request) and a 403 renders «فهرست دعوت‌ها برای شما قابل مشاهده نیست…» rather than an
  error surface; the invitation **link** is still a manually shared link — nothing claims
  automatic delivery.
- Linked personnel files render their identity read-only with a pointer to the canonical
  editor (`/settings/team`), while employment/accounting edits stay available; a member
  without a file shows «بدون حساب ورود» and gets the new controlled **«اتصال پروندهٔ
  پرسنلی»** flow (candidates = unlinked Employee files, server-validated and audited).
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
*selector* is explicitly left to #916 (documented in the module header).

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

---

## 3. Architecture changes

- **One audience decision** (`personnel-access.ts`) with three consumers of the same
  policy: the wire projection, the write-back guard and the flat row projection used by
  bulk readers.
- **One membership→file guarantee** (`personnel-file.ts`) behind five doors, with a
  durable debt table, a retry in the roster read and an operator script.
- **One eligibility resolver** (`staff-eligibility.ts` → `branchScopeSql`) shared by the
  floor picker and its write-side check.
- **Tenant affinity by construction** for the membership link (composite FK), not only in
  the service.
- No new permission key; `permission-registry.ts` untouched (`ALL_PERMISSIONS` unchanged,
  so the effective-count table stands: owner 115 / admin 109 / manager 92 / accountant 40 /
  cashier 21 / waiter 9 / kitchen 4).

## 4. UX/UI changes

- Onboarding has one entry point with explicit modes (invite / create PIN staff with an
  explicit branch policy / create a personnel file only, «بدون حساب ورود»).
- Member rows show the personnel file and its drift state, with a retry; the link flow is a
  named dialog, not a checkbox.
- Restricted fields are visible *as* restricted: `readOnly` inputs with a hint, disabled
  tabs with a notice, and a summary line naming the withheld sections.
- Role cards carry capability/reach/credential summaries; reasons and revisions are
  collected in accessible dialogs.
- RTL/Persian digit/Jalali conventions preserved; the design-lint and primitive-lint
  suites (38 tests) pass unchanged.

## 5. Security changes

- Sensitive personnel reads: `team.view`/`team.manage`/`payroll.view`/`payroll.manage`;
  the bank block: `ledger.view` — both matching the writes they gate.
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

## 7. Tests added/updated

- `integration/parties.integration.test.ts` — 73 tests (was 44 at baseline): the F01
  audience cases (collection/item/search/CRM file/internal default), the write-back cases
  (manager and **cashier** round trips, deliberate clears still land), the **route** round
  trip through `GET`/`PUT /api/parties/[id]` with a signed session, the controlled link
  flow, the export projection (narrow vs wide vs unnamed), F02 service refusals plus the
  raw-insert `23503` and the null-link deletion case, and the F04/F05 drift/repair cases —
  including the two deterministic concurrency tests: a lost create race and a **held-lock
  barrier** that proves the contender is waiting on a real lock (`pg_blocking_pids`,
  polled from the observing client) before releasing it.
- `integration/team.integration.test.ts` — 53 tests: the F03 scope cases for all four
  policies, refusal codes and the cleared-assignment case; the branch-scope SQL twin; the
  floor staff eligibility cases (all/selected/home/none, foreign branch, inactive member).
- `src/lib/personnel-access.test.ts` (14), `src/lib/staff-eligibility.test.ts` (3),
  `src/lib/location-access.test.ts` (16), `src/app/dashboard/team/team-manager.test.ts`
  (26), `src/app/dashboard/parties/parties-directory-regressions.test.ts` (44),
  `src/lib/admin-screen-contracts.test.ts` (17).

## 8. Exact verification

All numbers are from this working tree, 2026-10-13, on the branch head recorded above
(local Postgres 16 on 127.0.0.1:5432, `DATABASE_URL=postgres://pos:pos@localhost:5432/pos`).

| Gate | Command | Result |
|---|---|---|
| Formatting/lint | `npm run lint` (`eslint . --max-warnings=0`) | **clean, exit 0** (no warnings) |
| Typecheck | `NODE_OPTIONS=--max-old-space-size=3000 npx tsc --noEmit` | **clean, exit 0** |
| Unit + component | `npm test` | **806 files / 10475 tests passed, exit 0** (430 s) |
| Design system | `npm run test:design` | **5 files / 38 tests passed** |
| Database — the two suites this issue rewrites | `integration/parties.integration.test.ts` **73 passed**; `integration/team.integration.test.ts` **53 passed** | green |
| Database — consumer batch | `crm` 17, `crm-relationship-os` 31, `crm-data-quality` 6, `party-merge-coverage` 5, `data-transfer` 55, `phone-otp` 8, `iam-login-credentials` 2, `iam-control-plane` 2, `staff-login-tenant` 7 | **186 passed, 0 failed** |
| Database — onboarding/auth batch | `setup-complete`, `setup-completion-backfill`, `authorization`, `plan-limits`, `runtime-role-regrant`, `hybrid-credential-sync`, `ai-phase-c-tools`, `ai-tenant-isolation` | **72 passed, 0 failed** |
| Database — full sweep (`npm run test:db`, 214 files, serial) | started, **11 files green before the time budget was spent** (`payroll` 184, `fixed-assets` 70, `cheques`, `watch`, `team` 53, `parties` 73, `multicurrency`, `platform-company`, `auth-hardening-854-gaps`, `chart-of-accounts`, `tax-invoices`), **no failure observed**; the whole sweep needs ≈3 h at ~1 file/minute in this 2-vCPU sandbox, so it is reported as partial and the touched subsystems were run to completion instead | partial (green) |
| Migration | `npx tsx scripts/migrate.ts` on the dev database → `0221_personnel_links.sql` applied; `npm run personnel:reconcile` → **no drift** | green |
| Production build | `NODE_OPTIONS=--max-old-space-size=2560 npm run build` | **exit 137 — OOM-killed** by the sandbox kernel (`Out of memory: Killed process … (node) total-vm:68846748kB, anon-rss:3541940kB`) during «Creating an optimized production build». This box has 3 GB and no swap; `docs/auth-hardening-854.md` already records the same limitation for this repo. Not attempted with a higher heap, because 2560 MB is already above what the box can back. |
| Visual regression | `npm run test:visual` | **not run**: it needs a Chromium download, a seeded fixture database and a production server — the last of which the memory ceiling above blocks. No baseline was re-recorded or edited. |

## 9. Genuine remaining issues

- **Stored export files are not re-projected.** The *production* of an export is narrowed
  per caller (verified), but a file an owner produced earlier stays downloadable by any
  holder of the export keys — re-projecting stored bytes needs the producing audience on
  the job row, which is `data-transfer` schema work (issue #835/#876's area).
- **Imports can still write the personnel columns** of an Employee-role party that a
  customer CSV matches (the write path defaults to the internal full audience). That is a
  write-authorization question, not the read leak F01 describes, and no read of it was
  found; recorded rather than silently changed.
- **Floor selector capability** (`team.manage` on the `/api/staff` picker vs `tables.edit`
  on the floor editor) is deliberately untouched: the issue assigns that reconciliation to
  #916, which now consumes `staff-eligibility.ts` instead of re-deriving the rule.
- **Browser/visual gates and the production build** could not complete in this sandbox
  (no swap, 3 GB): `npm run build` is OOM-killed and `npm run test:visual` needs that build.
  CI on a normal runner is the place those two gates are meaningful; nothing here claims
  they passed.
- **Dependencies not installed from scratch**: `node_modules` came from the lockfile via
  `npm ci` earlier in the session; it was not re-installed against the final tree.
- **`npm run test:db` ran partially** (see §8): the touched subsystems are green in full,
  the untouched remainder was not exercised on this tree.
