# Permission reconciliation: this branch × current `main`

Two authorization refactors were built in parallel and both are real work:

- **`main`** — PR #728 (Arena session `01a0d52a`) plus #727's wp/woo capability
  gating and `c08c0a1` (authorization CI fixes). Merge-base `f10bfe9`.
- **this branch** — PR #729 (Arena session `01a0d529`), six commits from the
  same merge-base.

They share 46 permission keys, and disagree on 43 more (26 only on `main`, 17
only here). This document is the inventory and the canonical decision for every
one of them. **It is the prerequisite for touching `permissions.ts`:** the goal
is one catalogue, chosen on domain semantics, not on which branch wrote a name
first.

> **Git note.** An earlier reading of this divergence as "main was rewritten
> into an unrelated root" was wrong. The sandbox clone is *shallow*, and
> `.git/shallow` grafts both `be900b9` and `f10bfe9` as parentless, which makes
> `git merge-base` report unrelated histories. After `git fetch --unshallow`,
> `merge-base(HEAD, origin/main)` = `f10bfe9` and the branches are 6/6. `main`
> was never rewritten and must not be.

## Method

Consumer counts are `grep -rl 'PERMISSIONS.<camel>'` over each tree, split into
API route files and non-API (UI/lib) files. Preset membership is computed by
calling each tree's own `roleBasePermissions()`. Both are evidence about what a
key *actually gates today*, which is what decides whether it is load-bearing or
just a declared name.

## 1. Keys on both sides with identical meaning — adopt as-is (33)

`orders.create` `orders.void` `orders.amend_closed` `orders.discount`
`payments.take` `payments.refund` `tables.manage` `reservations.manage`
`kitchen.view` `delivery.manage` `menu.view` `menu.edit` `inventory.view`
`inventory.adjust` `purchases.manage` `parties.view` `parties.manage`
`crm.view` `crm.manage` `crm.merge` `crm.consent_manage` `crm.export`
`crm.configure` `workspace.view` `workspace.manage`
`workspace.contracts_manage` `workspace.approve` `ledger.view` `ledger.post`
`ledger.approve` `ledger.close_period` `accounts.edit` `reports.view`
`reports.export` `data.import` `data.export` `team.manage` `settings.manage`
`locations.manage` `backup.manage` `api.manage` `website.view` `growth.view`
`loyalty.view` `loyalty.manage`

No decision needed; preset membership still has to be reconciled (§6).

## 2. Website / CMS / WooCommerce — the largest semantic clash

Both sides gate **the same routes** under `src/app/api/cms/website/**`.

| Capability | `main` | this branch | API consumers (main / branch) | Canonical |
|---|---|---|---|---|
| Open the website app | `website.view` | `website.view` | — | **`website.view`** |
| Website-level settings | `website.settings_manage` | — | 0 / — | **`website.settings_manage`** |
| Read CMS content | `cms.view` | `website.view` | 7 / 7 | **`cms.view`** |
| Write CMS content | `cms.content_manage` | `website.manage` | 9 / — | **`cms.content_manage`** |
| Publish a draft | `cms.publish` | `website.publish` | 1 / 1 | **`cms.publish`** |
| DNS/CDN/domain/provisioning | `cms.configure` | `website.configure` | 7 / 7 | **`cms.configure`** |
| WooCommerce surface | `woocommerce.{view,manage,sync,configure}` | `website.{view,manage}` | **0** / 6 | **`woocommerce.*`** |

**Decisions.**

- `main`'s `cms.*` wins over this branch's `website.{manage,publish,configure}`.
  They are exact synonyms over the same routes, and `cms.*` names the resource
  (content) rather than the app shell. This branch's names are retired; no
  `website.publish` **and** `cms.publish` pair survives.
- `website.view` stays as the *app door*, `website.settings_manage` as
  website-level settings that are neither CMS nor WooCommerce. This preserves
  this branch's **app-door rule**: the door is the app's read capability, writes
  are enforced per action.
- **`woocommerce.*` is currently dead on `main`** — four declared keys, zero
  consumers — while the actual WooCommerce surface
  (`api/integrations/wp-manager/**`, 6 route files) rides on the generic
  `integrations.*`. That is an internal inconsistency on `main`. Canonically the
  wp-manager routes move onto `woocommerce.{view,manage,sync,configure}`, which
  both retires the dead keys and stops WooCommerce authority hiding behind a
  generic integrations key. `integrations.*` keeps the genuinely generic
  connection surface (§3).

## 3. Marketing / growth

| Capability | `main` | this branch | Consumers | Canonical |
|---|---|---|---|---|
| Growth app door | `growth.view` | `growth.view` | — | **`growth.view`** |
| Read campaigns | `campaigns.view` | (`growth.view`) | 0 api / 1 ui | **`campaigns.view`** |
| Run campaigns | `campaigns.manage` | `growth.manage` | 4 / 3 | **`campaigns.manage`** |
| Loyalty | `loyalty.{view,manage}` | same | — | **`loyalty.*`** |
| Growth/marketing settings | `marketing.configure` | `growth.manage` | 0 / — | **`marketing.configure`** |

`growth.manage` is retired: it meant two things at once (run a campaign,
configure the module), which `main` had already split. `growth.view` survives
only as the app-wide door.

**Superseded by issue #764.** `growth.view` is no longer the app door: it is
the management dashboard, audience insights and the accounting bridge, and no
floor preset holds it. The door is the union of the section keys
(`GROWTH_APP_PERMISSIONS` in `src/lib/growth-access.ts`). `loyalty.manage` now
means loyalty-program configuration only; the acts it used to bundle have
their own keys — `loyalty.redeem`, `store_credit.issue`, `store_credit.payout`,
`gift_cards.view`/`issue`/`redeem` — and compensation is `commission.view` /
`commission.manage`. `src/lib/growth-access.ts` is the one page/API/button
matrix, asserted against the route handlers' source by its test; migration
0191 rewrote stored overrides and custom roles.

## 4. Backup — keep `main`'s granularity

| `main` | this branch | Canonical |
|---|---|---|
| `backup.manage` (run/status) | `backup.manage` (everything) | **`backup.manage`** |
| `backup.configure` / `backup.export` / `backup.restore` (owner) | — | **keep all three** |

Export hands over the whole tenant and restore overwrites it; they must not
collapse into "backup.manage" just because this branch had one key.

## 5. Keys to carry over unchanged

**From `main` (real consumers, no counterpart here):** `integrations.view` (23
api), `integrations.manage` (36), `media.view` (3), `media.manage` (6),
`billing.view` (4), `billing.manage` (3), `rollup.manage` (5), `orders.view`
(3), `tables.edit` (1), `printing.execute` (1), `delivery.configure` (1),
`backup.{configure,export,restore}` (1 each).

**From this branch (real consumers, no counterpart on `main`):**

| Key | API consumers | Why it must survive |
|---|---|---|
| `finance.expenses_manage` | 1 | Operational finance ≠ accounting authority. Sixteen ledger write routes used `requireRole("owner","manager","accountant")` as a proxy for two different capabilities. Mapping them to `ledger.post` either removes work every manager does, or widens `ledger.post` past its name. |
| `finance.receivables_manage` | 1 | ″ |
| `finance.payables_manage` | 1 | ″ |
| `finance.cheques_manage` | 2 | ″ |
| `finance.installments_manage` | 2 | ″ |
| `finance.reconciliation_manage` | 4 | ″ |
| `finance.assets_manage` | 3 | ″ |
| `ledger.propose` | 2 | Drafting a manual journal has no ledger effect; approval is separately gated on `ledger.approve`. Folding it into `ledger.post` makes the review queue decorative. |
| `payroll.view` | 2 | Salary data is narrower than the surrounding ledger. Without it payroll reads ride on `ledger.view`, which manager holds — every manager sees every wage. |
| `payroll.manage` | 4 | ″ |
| `team.view` | 1 | Reading the team ≠ administering it; `main` has only `team.manage`. |
| `team.permissions_manage` | 2 | Handing out capability is the delegated-admin escalation path and is gated apart from suspend/rename. |
| `crm.delete` | 1 | Destroying a customer record with its history. |
| `reservations.view` | 1 | `main` has only `reservations.manage`; reading the book is not changing it. |

`ledger.post`, `ledger.approve`, `ledger.close_period` and `accounts.edit`
remain accounting authority, and `manager` holds none of them.

## 6. Role taxonomy and presets

- **`admin`** — both define it as `ALL_PERMISSIONS` minus owner-only, computed
  rather than listed. Identical; adopt.
- **`viewer`** — exists only on this branch. `main` has **no** `viewer` (zero
  occurrences) and instead ships tenant custom roles (migration `0171`). This is
  the one open question in §8.
- 13 shared keys have differing preset membership, and **all but two of the
  differences are `viewer`**, i.e. they disappear with the `viewer` decision.
  The two real ones:
  - `loyalty.manage` — `main` grants `cashier`, this branch does not.
    **Adopt `main`**: no existing access should be removed.
  - `reservations.manage` — `main` grants `waiter`, this branch does not.
    **Adopt `main`**, same rule.

## 7. Schema — `main`'s migrations supersede this branch's

This branch adds `migrations/0170_authorization_roles_and_location_scope.sql`.
`main` already has **`0170_membership_lifecycle_location_scope.sql`** and
**`0171_tenant_custom_roles.sql`**.

`main`'s `0170` creates the same `users.location_scope` column, with the same
`'home'` default, and an enum that is a **superset** of this branch's:

```
main:        location_scope AS ENUM ('all', 'selected', 'home', 'none')
this branch: location_scope AS ENUM ('all', 'selected', 'home')
```

plus a `membership_status` enum this branch does not have.

**Decision: delete this branch's `0170` entirely.** It is superseded, not merely
mis-numbered — renumbering it to `0172` would create a second representation of
location scope. `location-access.ts` is then reconciled onto `main`'s schema and
taught the fourth value `'none'` (no branch access at all), which pairs
naturally with this branch's finding that a member with no rows and a NULL home
must reach **nothing** rather than everything. Migration numbering continues at
`0172` for any genuinely new schema.

## 8. Open questions for the maintainer

1. **Does `viewer` survive?** `main` deliberately has no built-in read-only role
   and offers tenant custom roles (`0171`) instead. Keeping both means two ways
   to express "read-only", which violates the one-catalogue rule. Options: (a)
   drop `viewer` and express it as a custom role; (b) keep `viewer` as a
   built-in preset and treat custom roles as the extension mechanism.
   Recommendation: **(a)**, since `0171` already shipped.
2. **wp-manager onto `woocommerce.*`** changes `main`'s current behaviour
   (today `integrations.*`). It is the right model per §2, but it is a
   behavioural change to merged work and should be acknowledged, not slipped in.

## 9. Sequenced plan

1. Reconcile `permissions.ts` on top of `main`: union of *capabilities*,
   deduplicated by semantics, using the canonical names above.
2. Reconcile `location-access.ts` onto `main`'s 4-value scope; delete this
   branch's `0170`.
3. Reconcile `team.ts`, `team-service.ts`, `member-access.ts`, `setup-state.ts`,
   `role-labels.ts` — starting from `main`, porting this branch's escalation
   refusal, `team.view`/`team.permissions_manage` split and location-scope
   validation.
4. Port this branch's single decision point (`authorize.ts`) and the unified
   guards, keeping `main`'s route implementations.
5. Re-run the guard migration over `main`'s routes (`main` has ~644 `requireRole`
   route files; this branch had driven its own tree to 281). Classify per route;
   every survivor documented in `JUSTIFIED_ROLE_CHECKS`.
6. Rebuild the test suites against the canonical catalogue.

No step may leave two catalogues, two scope models or two role sources behind.
