# Issue #947 — integration contracts with #854 and #916

Issue #947 consolidates the Team section without replacing the systems around it. Two
neighbours share seams with it, and a shared seam that is only understood by whoever wrote
it is how the next change breaks it. This page names each seam, what #947 lands on it, what
it deliberately leaves to the other issue, and the tests that hold the contract.

Ownership in one line each:

| Issue | Owns | #947 does not |
| --- | --- | --- |
| **#854** (auth & account hardening follow-up) | the Profile/MFA surfaces, login/session ceremonies, the phone-verification flow, the Hybrid deny-only and IAM replica policy | redesign the Profile or MFA features, add a second phone writer, or change replica authority |
| **#916** (floor & table management audit) | the floor's staff **selector** and its assignment integration, including which capability the picker demands | build a second eligibility rule, or change the floor's assignment model |

---

## 1. Contract with #854 — identity propagation

### What #947 changed

The pass-4 rules (P2.5) already said which direction identity flows: the membership row
(`users.full_name` / `email` / `phone_e164`) and the global identity own the login fields;
the personnel file follows. #947 consolidated *where* that rule runs and what happens when
it cannot:

- one operation, `ensurePersonnelFileForMembership` (`src/lib/personnel-file.ts`), called
  by every membership door: direct creation, membership edit, rehire, `setMemberPhone`,
  invitation acceptance, the setup wizard, and an IAM replica apply;
- since migration `0223_personnel_file_obligation.sql`, the *obligation* is written by a
  trigger on `users` in the membership's own transaction, so a committed membership can no
  longer be silently file-less — the file is the service's job, the debt is the database's;
  `0226_personnel_file_obligation_phone_cleared.sql` corrects one arm of that predicate,
  forward-only: 0223 only looked at the phone when the membership *had* one, so clearing a
  member's number left the old number on their file with nothing owed. The corrected arm
  reads a cleared membership phone as canonical — `COALESCE(btrim(NEW.phone_e164), '') = ''
  AND COALESCE(btrim(file_phone), '') <> ''` — which is what `personnelFileIsStale` and the
  projection already did, and it re-runs the inventory with the same predicate (existing
  episodes keep their diagnosis and attempt count, exactly as 0223's did);
- the same operation is the one failure boundary for the whole synchronization
  (`canonicalIdentity` included): its callers are membership changes that have *already
  committed*, so a transient failure has to come back as a result — `{ ok: false, reason,
  error, recorded }` — never as a 500 about a request that succeeded. What it cannot do is
  un-fail a transaction: `iam/sync.ts` applies its events inside one, and a statement-level
  failure there has already aborted it, so the boundary informs the caller rather than
  making the site's transaction committable;
- `listPersonnelFileDebts` (`users` × `parties`) is the inventory the sweep reads;
  `personnel_file_drift` is bookkeeping about a debt, never the evidence of one;
- a conflicting write in the reverse direction is still refused with
  `identity_{name,email,phone}_managed_by_membership` (409 + fieldErrors), and no caller
  may write a shared field around the membership.

### What stays #854's

- **MFA-before-acceptance.** Invitation acceptance still validates and authenticates in a
  first phase that writes no membership, then writes it in a second; `#947` only added the
  file guarantee *after* that second phase commits. An aborted second factor still creates
  nothing, including no obligation.
- **Replica authority.** The IAM apply path keeps its own authority: it writes a
  membership and then calls the same guarantee. A Hybrid site still cannot originate
  memberships, and the cloud still owns identity.
- **Phone verification.** `stampPhoneVerified` remains the #854 flow; what #947 added is
  that it ends in the same `ensurePersonnelFileForMembership` call, so the file's phone
  cannot lag the verified one.
- **Profile self-service.** The member detail surface (Team, issue #947) *links* to
  `/settings/profile` for a member's own number and sessions; it does not reimplement
  those controls.

### Tests that hold it

| Contract | Test |
| --- | --- |
| membership → file, one file, idempotent | `integration/personnel-file-obligation.integration.test.ts` (11 cases) |
| the debt is recorded in the membership transaction, and rolled back with it | same file, «records a durable debt…» / «aborted the membership, aborted the debt» |
| rename/phone travel to the file; a party edit cannot travel back | `integration/team.integration.test.ts` → «the membership owns the login phone…»; `integration/parties.integration.test.ts` → canonical-ownership cases |
| no file invented for a nameless membership | `integration/parties.integration.test.ts` → «creates no file for a nameless membership…» |
| the roster tells the truth about which members are owed | `integration/personnel-file-obligation.integration.test.ts` → «is the same guarantee the roster reports» |

---

## 2. Contract with #916 — staff eligibility

### The seam

«Who may be put on floor work at this branch» had two implementations
(`GET /api/staff` for the picker, `floor.validWaiterId` for the write) and both read
`users.location_id` as if it were still the member's only branch. Since migration 0170 that
column is the member's *default* branch; the access set lives on `location_scope` +
`user_locations`.

#947 landed the shared answer — `src/lib/staff-eligibility.ts` — and migrated both
consumers onto it:

- `staffEligibilitySql()` — the predicate (live membership, role, `branchScopeSql`);
- `listEligibleStaffAtLocation()` — what `/api/staff` returns;
- `isEligibleStaffAtLocation()` — what `floor.validWaiterId` enforces before a section
  assignment is written.

`/api/staff`'s wire shape is unchanged (`{ id, full_name }`), because the floor renders
those two columns and a shape change would be #916's to make.

### What is explicitly left to #916

1. **The picker's capability.** `/api/staff` asks for `team.manage` while the floor editor
   beside it asks for `tables.edit`. Either the picker moves behind the capability of the
   feature that consumes it, or the floor's editor is documented as requiring both — the
   decision belongs to the floor audit, and #947 deliberately did not change the gate
   (changing it here would have widened floor access as a side effect of a Team issue).
2. **The selector's own UX** — where the picker lives, how it filters, what it shows about
   a member's branches. #947 provides the predicate, not the interface.
3. **Assignment integration** — any change to how sections store their staff must keep
   calling `isEligibleStaffAtLocation` (or the SQL predicate), never a role/branch
   condition of its own.

### Tests that hold it

| Contract | Test |
| --- | --- |
| policy decides eligibility, not the default-branch column | `integration/team.integration.test.ts` → «follows the policy, not the default branch column» |
| «home» / «none» / «all» | same file → «keeps the other three policies honest» |
| suspended members drop out; roles and tenants stay apart | same file → «drops a suspended member and keeps roles and tenants apart» |
| the pre-0170 roaming member stays reachable, with no widening fallback | same file → «keeps the pre-0170 roaming member reachable…» |
| the predicate itself | `src/lib/staff-eligibility.test.ts` (3 cases) |

If #916 changes the picker's capability, these cases must move with it in the same change —
that is the one co-ordinated edit this contract anticipates.

---

## 3. Things #947 did **not** do (so they are not mistaken for done)

- No payroll/commission engine change, and no new payroll enrolment: wages live on the
  membership (`listStaffWages` reads `users`), while the accounting file lives on
  `parties`. The file-only onboarding mode says exactly that instead of implying otherwise.
- No universal Person table, no rewriting of financial-history ids, no change to AR/payroll
  references.
- No change to the invitation delivery model: invitations still produce a link for manual
  sharing; the UI says so and does not imply automatic delivery.
- No global-auth change: platform identities, MFA and sessions remain #854's.
