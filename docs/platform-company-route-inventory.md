# Platform Business — route inventory

The audit's dead-code question, answered for every route in the Platform Business surface.
Nothing here was deleted on the strength of a text search alone: each classification below is
backed by the check in the *Evidence* column, and the list itself is pinned by a test
(`src/app/api/platform/company/route-guards.test.ts`) so a route that appears later cannot sit
unclassified.

Classification key:

| Class | Meaning |
|---|---|
| `ACTIVE` | Reachable, wired, exercised by a test or by the running app |
| `NEEDS_CALLER` | Reachable only from a named caller (a page, a job, an external form) |
| `INTERNAL_ONLY` | Not reachable from a browser at all; called by the worker or a script |
| `EXTERNAL_INTEGRATION` | Public, authenticated by something other than a user session |
| `DUPLICATE` | Two routes doing the same job — must be resolved, not merely noted |
| `OBSOLETE` | No caller left |

## Browser routes (GET)

| Route | Class | Notes / evidence |
|---|---|---|
| `/platform/company` | `ACTIVE` | Company home; renders state, entitlements, members, destinations |
| `/platform/company/workspace` | `ACTIVE` | Lists the company's projects through the shared `listWorkspaceProjects` engine |
| `/platform/company/accounting` | `ACTIVE` | Reconciliation; per-event state and authorized retry |
| `/platform/company/crm` | `ACTIVE` | Customers + won deals; «ایجاد پروژه» posts to `workspace/from-deal` |
| `/platform/company/growth` | `ACTIVE` | Audience summary; links into the Growth engine |
| `/platform/company/websites` | `ACTIVE` | Credential manager + the app handoff |

These are the only company browser routes. `/platform/businesses` (Platform Management) is a
different realm and is deliberately **not** in this list — the two were never merged, and the
console keeps them in separate navigation sections.

## Platform APIs (`/api/platform/company/**`)

All run `withPlatformScope` except the two pre-membership routes, which exist to establish what
that adapter requires. The exception is allow-listed *by name* in the test, not by a flag inside
the file, so adding one is a visible decision.

| Route | Methods | Class | Notes / evidence |
|---|---|---|---|
| `status` | GET | `ACTIVE` | First question the console asks; works before a membership exists |
| `setup` | POST | `ACTIVE` | Idempotent central-cloud initializer |
| `members` | GET, PATCH | `ACTIVE` | Preset/activation management; guarded by `team.manage` |
| `open` | POST | `ACTIVE` | Mints the two-minute, one-use handoff |
| `accounting/reconciliation` | GET, POST | `ACTIVE` | POST is the authorized retry |
| `crm/customers` | GET | `ACTIVE` | Relationship projection; balance from posted accounting only |
| `crm/deals` | GET | `ACTIVE` | Won-deal list backing «ایجاد پروژه» |
| `growth/audience` | GET | `ACTIVE` | Leads, consent, churn risk, 14-day renewals |
| `workspace/projects` | GET | `ACTIVE` | The company's own projects, no second project system |
| `workspace/from-deal` | POST | `ACTIVE` | CRM → Workspace handoff, idempotent |
| `websites/sites` | GET | `ACTIVE` | Real site records credentials can bind to |
| `websites/credentials` | GET, POST | `ACTIVE` | Show-once credential mint/rotate |

## Supporting routes outside `/company`

| Route | Class | Notes / evidence |
|---|---|---|
| `GET /api/auth/company-handoff` | `ACTIVE` | Redeems the token on the tenant origin; host-scoped, single-use |
| `POST /api/website/leads` | `EXTERNAL_INTEGRATION` | Public lead intake; bearer credential, honeypot, per-minute limit |

## Redirect policy

* **No API route redirects.** A redirect on `POST /api/website/leads` or on any
  `/api/platform/company/**` route would drop the method, the body and the `Authorization`
  header; every one of them answers with a status code instead.
* **GET browser routes prefer redirects.** A company page reached without a usable membership
  renders an explanation *in place* rather than bouncing the operator somewhere else — the
  original defect was a button that did nothing and no explanation of why. The only redirect in
  the feature is the handoff redeemer, whose entire purpose is to move the browser from the
  platform origin to the tenant origin, and it redirects to a path validated as a single-segment
  app root both when minted and again when redeemed.

## Unresolved duplicates

None. Every route above has exactly one job and one owner. Where the company needs a capability
that already exists (projects, deals, campaigns, sites), it calls the existing engine rather than
adding a parallel route.
