# Issue #947 — Team section consolidation: implementation plan

Scope: **Settings → کاربران و دسترسی‌ها (`/settings/team`)** — Members/Access, Roles,
Invitations, PIN staff onboarding and the linked Employee personnel files. `/settings/team`
stays the canonical route; no new page tree, no replacement Person table, no payroll engine.

This file records what each finding (TEAM-F01…F08) resolves to, where the code lives, and
which existing work is deliberately left alone. It is written *before* the change so the
review can read the intent next to the diff.

## Ownership boundaries kept

- **#854 / #889** (merged): Team/auth hardening, canonical identity ownership
  (`assertLinkedPartyFollowsCanonicalIdentity`), owner semantics, audit reasons. Preserved.
- **#809 / #816**, **#843 / #850 / #846**, **#885 / #929**: global identity, credential
  convergence, seven-day trust. Not touched.
- **#835 / #876** payroll foundation, **#268 / #869 / #930** commission: untouched.
- **#916** floor staff selector, **#933** shifts, **#900** marketers: consume the shared
  eligibility contract added here; their own screens are not rebuilt in this issue.

## Findings → resolution

| Finding | Resolution | Where |
|---|---|---|
| TEAM-F01 sensitive Employee data behind generic `parties.view` | Field-level read projections: `PartyReadAudience` (`personnel`, `financial`) applied by `listParties`/`searchParties`/`getParty`; both party routes derive the audience from the caller's **effective** membership (`team.view`/`team.manage`/`payroll.view`/`payroll.manage` for personnel fields; `ledger.view` for the bank/financial tab, mirroring the write gate). Withheld fields are emptied **and** named in `restrictedFields`, so the UI explains rather than showing blanks. | `src/lib/personnel-access.ts` (new), `src/lib/parties-service.ts`, `src/app/api/parties/{route,[id]/route}.ts` |
| TEAM-F02 employee link not tenant-safe | `resolveEmployeeLinkTarget` validates every proposed link (create, link, relink, repair) against the same business and refuses a foreign/dangling/duplicate target with a named error; every link change is audited (`team.personnel_link_changed`); migration 0221 adds the composite same-business FK `parties(business_id, employee_user_id) → users(business_id, id)` (`ON DELETE SET NULL (employee_user_id)`), after logging and clearing pre-existing invalid links. | `src/lib/parties-service.ts`, `migrations/0221_personnel_link_tenant_affinity.sql` |
| TEAM-F03 PIN onboarding without a branch choice | The add-staff form carries the same explicit branch policy as the invite form (`all`/`selected`/`home`/`none`, branch pickers, home picker) and sends it; PIN uniqueness copy corrected to business-wide (the actual invariant). Server keeps accepting an omitted policy for old clients, but the *derived* policy is now visible in the response/audit. | `src/app/dashboard/team/team-manager.tsx`, `src/app/api/team/route.ts` |
| TEAM-F04 personnel file depends on the onboarding door | One idempotent `ensurePersonnelFileForMembership` called by every membership writer: direct create, setup wizard, invitation acceptance, rehire and IAM replica apply. MFA-before-acceptance and replica authority stay distinct. | `src/lib/personnel-file.ts` (new), `src/app/api/{team,setup/users}/route.ts`, `src/lib/team-service.ts`, `src/lib/iam/sync.ts` |
| TEAM-F05 partial/silent identity projection | Canonical identity is derived from the membership row (name + phone + email) and propagated to the file; a failed propagation is recorded durably in `personnel_file_drift` and retried — on the next Team read, on the next membership edit, and from the reconciliation script — so no path silently loses the file. Phone verification on the self-service door now updates the file too. | `src/lib/personnel-file.ts`, `src/lib/phone-otp.ts`, `scripts/reconcile-personnel-files.ts` |
| TEAM-F06 read-only Team visits issue a forbidden invitation request | The invitations request is capability-gated (`team.manage`), and a partial failure no longer replaces a roster that loaded. | `src/app/dashboard/team/team-manager.tsx` |
| TEAM-F07 linked identity competes with canonical ownership | The party form shows the three membership-owned fields read-only on a linked personnel file with a link to the canonical editor, states access state explicitly («بدون حساب ورود» / «متصل به حساب …»), and offers a controlled link/create-account action for standalone files. | `src/app/dashboard/parties/party-form.tsx`, `src/lib/personnel-file.ts` |
| TEAM-F08 roles/onboarding/list feedback and scale | System role cards summarise capabilities and the login expectation; custom-role archive failures surface in the handler; `confirm()`/`prompt()` replaced by the application dialogs; the roster gains search, branch/role/status filters, pagination and per-action errors. | `src/components/team/roles-manager.tsx`, `src/app/dashboard/team/team-manager.tsx` |
| Consumer seam (#916 / #933) | `eligibleStaffForLocation` + `minimalStaffProjection` become the one branch-eligibility answer (`location_scope` + `user_locations` + home branch), consumed by `/api/staff`; `/api/floor/sections` keeps its own call site owned by #916 and is migrated in one coordinated change. | `src/lib/staff-eligibility.ts` (new), `src/app/api/staff/route.ts`, `src/lib/floor.ts` |

## Non-goals

- No universal `persons` table, no rewrite of `platform_users`/`users`/`parties`.
- No financial-history identifier rewriting.
- No removal of the legacy `users.pin_hash` read fallback (still needed for pre-credential rows).
- No automatic name-based merging of standalone personnel files.
