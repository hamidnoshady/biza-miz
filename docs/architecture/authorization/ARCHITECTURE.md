# Authorization architecture

How Eshobe decides whether a request is allowed. This is the reference the doc
comments in `src/lib/auth.ts`, `src/lib/authorize.ts`, `src/lib/setup-state.ts`
and `src/app/api/authorization-contract.test.ts` point at.

## The decision chain

```
Identity → Tenant membership → Role preset → Member overrides → Scope → Context → Resource policy → Allow / Deny
```

Every step can only ever *narrow*, with one exception noted under
[Absolute roles](#absolute-roles). The default is deny: a capability that
nothing grants is not held.

| Step | Where it lives | What it answers |
|---|---|---|
| Identity | `platform_users` | Who is the human? |
| Tenant membership | `users` (one row per person per business) | Which business are they acting in, and are they still active? |
| Role preset | `ROLE_PRESETS` in `src/lib/permissions.ts` | What does this role do by default? |
| Member overrides | `users.permissions` (`{granted, revoked}`) | What has been adjusted for this person? |
| Scope | `users.location_scope` + `user_locations` | Which branches? |
| Context | business status, feature flags, industry modules | Is this business/trade/plan able to do it at all? |
| Resource policy | route bodies | Is *this* record theirs to touch? |

Identity and membership are deliberately separate tables. A person can be a
member of several businesses, and a PIN-only member of staff has
`platform_user_id = null` — they exist as a membership with no global identity
at all. Nothing in the chain may assume a platform user exists.

## Permissions are authoritative

Ordinary authorization is expressed as a **capability key**, never a role name.
`PERMISSIONS` in `src/lib/permissions.ts` is the catalogue; `PERMISSION_METADATA`
in `src/lib/permission-registry.ts` carries the label, description, risk band,
audit flag and dependencies used by the team screen.

The reason is the one failure this whole area kept producing: a role list in a
menu and a different role list on the route behind it. When both sides ask
`permissions.has("growth.manage")`, they cannot disagree. See
[UI and API must ask the same question](#ui-and-api-must-ask-the-same-question).

Effective permissions are `preset ∪ granted \ revoked`, resolved by
`effectivePermissions(role, overrides)`.

### Absolute roles

`owner` is every permission *by rule*, and overrides are not applied to it. A
business that could revoke its way out of `team.manage` on its only owner would
be permanently locked out of itself.

`admin` is every permission except `OWNER_ONLY_PERMISSIONS` (currently
`api.manage`), also by rule — but it is **not** absolute, so overrides still
apply and an admin remains reducible.

Both are rules rather than lists so that a permission added in a later release
is picked up automatically instead of silently excluding the owner from it.

## One guard

`authorize()` in `src/lib/authorize.ts` is the single decision point. The four
public guards — `requirePermission`, `requireRole`, `requireMember`,
`requireManager` — all funnel through it, so every one of them performs the
same checks:

1. a valid session;
2. the membership still exists;
3. `users.is_active`;
4. `platform_users.token_version` still matches the token (session revocation);
5. the business is active;
6. the specific role/permission demand.

This mattered: before unification, `requireRole()` authorized from the JWT's
`session.role` and re-checked only `token_version` — never `is_active`, never
the business status, never the member's *current* database role.
`requireManager()` was worse, a pure JWT comparison with no database read at
all. `requirePermission()` checked is_active and status but not
`token_version`, so a revoked session kept working. Each of those holes has a
named regression test in `src/lib/authorize.test.ts`.

Guards hand onward a session carrying the **database** role, not the token's.

### Denial contract

```ts
{ error: "unauthorized" | "forbidden" | "business_suspended",
  code: DenialCode,
  permission?: Permission }
```

`DenialCode` is one of `UNAUTHENTICATED`, `MEMBERSHIP_NOT_FOUND`,
`MEMBERSHIP_INACTIVE`, `SESSION_REVOKED`, `BUSINESS_NOT_ACTIVE`,
`MISSING_PERMISSION`, `MISSING_ROLE`, `OWNER_ONLY`, `LOCATION_FORBIDDEN`.
Status is 401 for the first, 403 otherwise. The three `error` strings are
preserved verbatim because the dashboard consumes them
(`src/app/dashboard/ui.tsx` switches on `"business_suspended"`).

## Branch scope

`users.location_scope` is an explicit enum — `all`, `selected`, `home` —
introduced by migration `0170`. Before it, a non-owner with no `user_locations`
rows and a `NULL` location_id reached **every** branch in the business, which
is the opposite of deny-by-default.

The column defaults to `home`. An unrecognised explicit scope in a request body
is a `400 invalid_location_scope`, never a silent fallback: quietly dropping it
would leave the member on a policy the caller did not ask for and believes they
changed. The migration's backfill preserves each member's current reach exactly
— legacy roamers become an explicit `all` — so nobody is narrowed at deploy.

## Role-identity checks

A small number of decisions genuinely depend on *who someone is* rather than
what they may do, and those stay role tests. They are enumerated in
`JUSTIFIED_ROLE_CHECKS` in `src/app/api/authorization-contract.test.ts`, each
with a written reason, and the allowlist is policed by two meta-tests:

- a **stale-allowlist** test, so an entry cannot silently exempt a file that has
  since grown a *different*, unreviewed role check; and
- a minimum length on the reason, so "justified" cannot be asserted by a word.

The current entries are the five AI autonomous-approval routes, `ai/chat`'s
floor-assistant selection, `setup/state`'s first-run wizard, and
`platform/ai/gateway`'s owner authority.

Everything else is a capability. `requireRole` call sites are counted by a
ratchet test that can only go down.

## UI and API must ask the same question

A menu entry, a button and the route behind them must be gated on the same key.
The failure mode is specific and was observed repeatedly:

- granting `growth.manage` to a salesperson produced an API that accepted them
  behind a menu that never appeared; and
- revoking `growth.view` from a manager left every Growth screen visible with
  every fetch inside it returning 403.

Practical rules:

- Server components resolve `memberAccessFor(session)` and gate on
  `permissions.has(...)`.
- A `Set` cannot cross into a client component. Serialise as an array and
  rebuild it with `useMemo(() => new Set(permissions), [permissions])`.
- Nav items carry `requiredAnyPermission`, never a `roles` list.
- `session.role` may still reach a *view* as presentation (a label, an
  empty-state hint). It must never be the input to a gate;
  `src/app/navigation-route-guards.test.ts` asserts the negative.

## Minting a key: name the action, not the table

A permission key is minted when no existing key *means* the right thing. Two
failure modes push in opposite directions, and the accounting surface hit both:

- **Reusing a key for its audience.** The accounting nav gated its payroll
  section on `ledger.post` because that preset happened to be exactly
  owner + accountant. It read as correct and was a latent bug: the moment
  either preset changes, a menu about wages starts following a rule about
  journal entries. Payroll now has `payroll.view` / `payroll.manage`.
- **Collapsing distinct capabilities.** Sixteen ledger write routes were guarded
  `requireRole("owner", "manager", "accountant")`, using role as a proxy for two
  different things: operational finance a manager legitimately performs, and
  accounting authority that should not be theirs. Mapping them all onto
  `ledger.post` would either have removed work every manager already did, or
  widened `ledger.post` far beyond its name.

The resolution is a `finance.*` family named for the business action —
`expenses_manage`, `receivables_manage`, `payables_manage`, `cheques_manage`,
`installments_manage`, `reconciliation_manage`, `assets_manage` — plus
`ledger.propose` for drafting a manual journal. Each of these does produce
accounting entries downstream, but the user is recording a payment, not posting
to the ledger; the key is named for what they are doing, not for the table that
ends up written. `ledger.post`, `ledger.approve`, `ledger.close_period` and
`accounts.edit` stay accounting authority, and the manager preset holds none of
them.

Drafting is separated from posting deliberately: a draft has no ledger effect,
and `/api/ledger/entries/drafts/[id]/approve` is gated on `ledger.approve`.
Folding `ledger.propose` into `ledger.post` would make the review queue
decorative.

**`ledger.propose` gates entry to the queue, not decisions inside it.** Both
draft-discard routes — `DELETE /api/ledger/entries/drafts/[id]` and
`POST /api/ledger/entries/drafts/[id]/reject` — used to require it up front,
which read as the natural pairing (the permission that puts a draft there is the
permission that takes it away) and was wrong twice over: an approve-only custom
role could not reject the drafts its whole job is deciding, and a drafter whose
`ledger.propose` was later revoked was left holding a draft they could no longer
withdraw. They now require `ledger.view` to reach the draft at all, then allow
the action to **its author or to `ledger.approve`** — one rule,
`canDecideOnDraft` in `src/lib/manual-journal.ts`, shared by both routes and by
the review screen so the three cannot disagree about what a person may click.

The corollary for sweeps: a verb-aware migration is not audience-aware. Mapping
"every GET in this tree" onto one read key is only safe if every one of those
GETs had the same audience to begin with. Here two payroll reads were narrower
than the ledger around them, and the sweep leaked salary data to presets that
should not have held it before the contract test caught it. (This paragraph used
to name a `viewer` preset among them; `viewer` is a `workspace-shared.ts`
project role, not a member `Role`, so no preset could have held it.)

## Delegating team administration

Three keys, deliberately separate:

| Key | Covers |
|---|---|
| `team.view` | See the team list |
| `team.manage` | Create staff, rename, suspend, re-branch, reset credentials |
| `team.permissions.manage` | Change a member's role or permission overrides |

Handing out capability is how a delegated team administrator would escalate, so
it is gated apart from ordinary administration — a suspend or a rename still
needs nothing more than `team.manage`, so no existing workflow breaks.

On top of that, `escalationRefusal()` in `src/lib/team.ts` refuses two moves by
anyone who is not an owner:

1. **Granting beyond yourself.** The permissions an edit *adds* must be a subset
   of what the editor already holds. Only additions are measured — removing
   access is never escalation, and testing the whole resulting set instead would
   wrongly block a manager from adjusting an accountant whose preset contains
   `ledger.post`.
2. **Changing your own role.** Not caught by the permission delta, because of
   the role-identity checks above: someone could move to a role whose permission
   set is a subset of their current one and still cross one of those gates.

`api.manage` is owner-only and is stripped by `sanitizeOverrides` as well as
refused by `effectivePermissions`, so it cannot be granted through this path at
all. Owner safety is completed by the last-owner rule in `checkLastOwner`.

## Separate realms

- **Superadmin** is a different realm entirely (`platform-auth.ts`), not a
  tenant role, and never appears in `ROLE_PRESETS`.
- **API keys** are separate scoped identities (`api-scopes.ts`), not a member's
  permissions borrowed.
- **AI** acts as the requesting member and is bounded by that member's effective
  permissions; autonomy level is a separate, role-gated decision.

## Tenant isolation

None of the above replaces RLS. Every tenant read runs inside an explicit
`withTenant(businessId, …)` scope, and the permission layer sits on top of that
boundary rather than in place of it.

## Where things live

| File | Contents |
|---|---|
| `src/lib/permissions.ts` | Catalogue, presets, effective-permission resolution |
| `src/lib/permission-registry.ts` | UI metadata: labels, risk, dependencies, grouping |
| `src/lib/authorize.ts` | The single decision point and the denial contract |
| `src/lib/auth.ts` | Public guards, session handling, `withTenantScope` |
| `src/lib/roles.ts` | Role taxonomy: which roles exist, how each signs in |
| `src/lib/member-access.ts` | One server-side read of a member's effective access |
| `src/lib/location-access.ts` | Branch scope resolution |
| `src/lib/team.ts` | Invitations, lockout rules, escalation policy |
| `migrations/0170_…sql` | `location_scope`, the new roles |

## Test map

| Concern | Test |
|---|---|
| Preset matrix and back-compat | `src/lib/permission-matrix.test.ts` |
| Guard behaviour and the closed holes | `src/lib/authorize.test.ts` |
| Catalogue metadata | `src/lib/permission-registry.test.ts` |
| Role taxonomy, no hand-copied lists | `src/lib/roles.test.ts` |
| Branch scope | `src/lib/location-access.test.ts` |
| Escalation policy (pure) | `src/lib/team.test.ts` |
| Escalation policy (route) | `src/app/api/team/[id]/route.test.ts` |
| Every route has a guard | `src/app/api/api-guards.test.ts` |
| Role-gate ratchet and justified checks | `src/app/api/authorization-contract.test.ts` |
| Nav gates match route gates | `src/app/navigation-route-guards.test.ts` |
| Permission editor | `src/components/team/permission-editor.test.tsx` |
