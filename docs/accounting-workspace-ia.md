# The Accounting workspace — information architecture

This is the route and navigation contract for the Accounting workspace. It
supersedes older notes about *navigation* in `docs/design-system.md`; the visual
canon remains unchanged.

## 1. Why this shape

Accounting is the business's primary work menu, not a narrow ledger tool. It
brings together the daily business work (sales, inventory, products, operations
and business reporting) and the ledger as a named group in one app shell. The
previous flat `/dashboard/*` operational URLs made a person leave Accounting to
complete routine work and created competing navigation structures.

`/accounting` is one shell with one menu. The menu composes, rather than copies,
the shell's already-gated business entries with Accounting's own ledger entries.
`workspace-shell.tsx` remains the source of module, role, feature and permission
gating; `accounting-workspace.ts` adopts eligible entries by their canonical
href. A business without a module simply has no corresponding menu entry.

## 2. Canonical work areas

The following operational workspaces have exactly one public destination. Use
`ACCOUNTING_WORKSPACE_HREFS` and `accountingProductsHref()` from
`src/lib/app-routes.ts` in code rather than recreating these strings.

| Work area | Canonical route |
| --- | --- |
| POS / cashier | `/accounting/pos` |
| Inventory | `/accounting/inventory` |
| Products | `/accounting/products` |
| New product | `/accounting/products/new` |
| Product prices | `/accounting/products/prices` |
| Product attributes | `/accounting/products/attributes` |
| Barcode templates | `/accounting/products/barcode-templates` |
| Product reports | `/accounting/products/reports` |
| Cosmetics | `/accounting/cosmetics` |
| Business reports | `/accounting/reports` |
| Floor / tables | `/accounting/floor` |
| Kitchen | `/accounting/kitchen` |
| Reservations | `/accounting/reservations` |
| Delivery | `/accounting/delivery` |

The rest of the workspace has these responsibilities:

| Group | Entries |
| --- | --- |
| میز کار | داشبورد حسابداری (`/accounting/overview`) |
| فروش و درآمد | existing canonical sales entries, including POS and customer work |
| خرید و انبار | inventory, products and industry-specific trade entries |
| عملیات | the industry’s canonical operations screens, such as floor, kitchen, reservations and delivery |
| اشخاص | the one directory (`/accounting/directory`) and its `?view=` links |
| **فضای کار حسابداری** | trial balance, journal, manual entry, chart of accounts, accounting dimensions (`/accounting/dimensions`), receivables, payables, receipts/payments, instalments, cheques, expenses, bank reconciliation, fixed assets, periods, tax, payroll and accounting settings |
| گزارش و تحلیل | financial reports (`/accounting/financial-reports`), business reports (`/accounting/reports`), growth/marketing |
| پیکربندی | business settings, technical connections, credit and billing |

`/accounting/financial-reports` is the ledger report index. `/accounting/reports`
is the business reporting workspace; they are intentionally different routes.

### How the group is drawn


Every group in this menu — plain or collapsible — is rendered by the shared
[`src/app/dashboard/sidebar-nav-group.tsx`](../src/app/dashboard/sidebar-nav-group.tsx),
so the sidebar has one spelling of a group instead of one per menu.

- The ledger group's **disclosure header matches every other group heading** —
  `text-[11px] font-semibold tracking-wide text-muted-foreground`, a chevron,
  and a touch-sized hit target (`NAV_COLLAPSIBLE_GROUP_TOGGLE_CLASS` in
  `sidebar-nav-group.tsx`). It is not a second, always-bold nav row with its
  own icon sitting between «اشخاص» and «گزارش و تحلیل». Closed **over the page
  you are on**, the header keeps the amber selected skin so «you are here»
  survives collapsing.
- The group has **named sub-groups**, the way every other group has a heading:

  | sub-group | sections |
  | --- | --- |
  | دفتر و اسناد | تراز آزمایشی، دفتر روزنامه، ثبت سند دستی، سرفصل حساب‌ها، ابعاد حسابداری |
  | دریافتنی و پرداختنی | دریافتنی، پرداختنی، اقساط، چک‌ها |
  | وجوه و هزینه | دریافت و پرداخت، هزینه‌ها، تطبیق بانکی، دارایی ثابت |
  | دوره، مالیات و حقوق | دوره‌های مالی، مالیات، حقوق و دستمزد |
  | پیکربندی حسابداری | تنظیمات حسابداری |

  They are an *arrangement* of `LEDGER_WORKSPACE_SECTION_KEYS`, never a second
  list: the group's flat `entries` are built from the sub-groups, and a test
  asserts the two sets are identical, so a section cannot end up in one and not
  the other.
- At the 4rem icon rail the headings and the chevron hide and the rows stay
  listed — a closed group must never leave the rail empty, because collapsed
  there is no chevron to reopen it with.

Its **in-page rail** — the `SectionNav` that used to list every section in the
app, i.e. a second copy of the whole menu inside the page — is now scoped to
exactly that group. `/accounting/settings` now appears in this rail as the
single «تنظیمات حسابداری» destination; the route and page were moved into the
group rather than copied. On a page outside the group (`/accounting/overview`,
`/accounting/directory`, `/accounting/reports`) there is no rail at all: those
are top-level areas of the workspace and render as plain pages.

### Where the business entries come from

They are **not** re-declared. `workspace-shell.tsx` already builds the
business nav with every module / role / feature / permission filter applied;
that list is handed to the app shell nav (`AppShellNavProps.navItems`) and the
Accounting menu picks the work areas out of it by href
(`src/app/(app)/accounting/accounting-workspace.ts`). A business whose trade
has no انبار simply has no انبار row — the gate is the one that already
existed.

## 3. Legacy URLs

Nothing was moved, so nothing broke:

- every `/dashboard/*` page is still a real page at its own URL;
- `/dashboard/accounting/*` still redirects (middleware `app-routes.ts`);
- `/accounting/customers`, `/accounting/suppliers`, `/accounting/vendors` are
  now **route-level redirects** onto the canonical directory with the matching
  filter, preserving every other query parameter:

  | legacy | canonical |
  | --- | --- |
  | `/accounting/customers` | `/accounting/directory?view=customers` |
  | `/accounting/suppliers` | `/accounting/directory?view=suppliers` |
  | `/accounting/vendors` | `/accounting/directory?view=vendors` |
  | `/accounting/parties` | `/accounting/directory` |

  The old in-page tab addresses forward the same way, with the filter kept:

  | legacy | canonical |
  | --- | --- |
  | `/dashboard/ledger?tab=customers` | `/accounting/directory?view=customers` |
  | `/dashboard/ledger?tab=suppliers` | `/accounting/directory?view=suppliers` |
  | `/dashboard/ledger?tab=vendors&party=X` | `/accounting/directory?view=vendors&party=X` |

  These are real `redirect()` calls in `src/app/(app)/accounting/[section]/page.tsx`,
  not middleware pathname rewrites.

## 4. The people directory

There is **one** directory (`/accounting/directory`) and **one** create/edit
flow (`src/app/dashboard/parties/party-form.tsx`). The directory has views:

`all` · `customers` · `suppliers` · `vendors` (the supplier record under the
other word) · `employees`

A view is a `?view=` filter over the same component, the same
`/api/parties` endpoint and the same `parties` table. Other apps deep-link
into it with `partyDirectoryHref(view)`.

### Multiple roles per person

Migration `0148_party_roles.sql` adds `parties.roles text[]` beside the
existing `parties.role`:

- `role` stays the **primary** role — every existing query, the accounting-code
  prefix scheme (۱/۲/۳), the employee link and every report keep working
  unchanged;
- `roles` is the full set, kept consistent by a trigger so that *any* writer
  (including old ones and importers) ends up with `role = ANY(roles)`;
- listings filter on `roles && ARRAY[…]`, so one person who is both a customer
  and a supplier appears in both views — one record, one balance, one file.

No data is deleted and no schema is merged: `parties` was already the one
table for all three roles (migration 0137).

## 5. Adding to the menu

- **A new accounting section** — add the key to `ACCOUNTING_SECTION_KEYS`, a
  label to `ACCOUNTING_SECTIONS`, a glyph to `ACCOUNTING_SECTION_ICONS`, a home
  to `ACCOUNTING_NAV_GROUPS`, and (if it is a ledger tool) to
  `LEDGER_WORKSPACE_SECTION_KEYS`. `accounting-workspace.test.ts` fails if it
  ends up in no menu group.
- **A business page the workspace should adopt** — add its href to
  `WORKSPACE_GROUP_SLOTS` in `accounting-workspace.ts`. Do **not** re-declare
  the page: the composer picks it out of the nav the shell already gated, so
  the role/module/feature/permission check stays in one place.

## 6. What did *not* change

- The `(app)` route group and the real top-level routes.
- Middleware: no pathname rewrites were added.
- `/dashboard/*` pages, their guards, their APIs.
- Tenant isolation, app availability, feature flags, role gating.

### Inventory is one door

Every industry enters inventory through `/accounting/inventory`. Hospitality and
retail retain their appropriate stock-record and posting adapters
(`inventory_items` versus the retail `items` stock model), but there is no second
public inventory URL, nav item or route page. The canonical workspace selects the
industry-appropriate data surface after the server-side module guard. Any new
inventory feature must start from this canonical door; do not reintroduce a
`/dashboard/stock` or `/dashboard/inventory` page.

## 3. Retired dashboard URLs and bookmark compatibility

The old route modules have been removed from the Dashboard route tree. They do
not load their former pages. Middleware performs a permanent redirect using
`LEGACY_PREFIX_MAP` in `src/lib/app-routes.ts`, preserving a nested suffix and
query string, so existing bookmarks continue to land on the canonical page.

| Retired URL prefix | Canonical URL prefix |
| --- | --- |
| `/dashboard/pos` | `/accounting/pos` |
| `/dashboard/stock` | `/accounting/inventory` |
| `/dashboard/inventory` | `/accounting/inventory` |
| `/dashboard/products` | `/accounting/products` |
| `/dashboard/cosmetics` | `/accounting/cosmetics` |
| `/dashboard/reports` | `/accounting/reports` |
| `/dashboard/floor` | `/accounting/floor` |
| `/dashboard/kitchen` | `/accounting/kitchen` |
| `/dashboard/reservations` | `/accounting/reservations` |
| `/dashboard/delivery` | `/accounting/delivery` |

For example, `/dashboard/products/new?from=menu` redirects to
`/accounting/products/new?from=menu`. A legacy path is a compatibility input to
the redirect table only. It must never be emitted by new application code or
appear as a live `page.tsx` route.

The directory consolidation is independent and remains in place:

| Former accounting URL | Canonical destination |
| --- | --- |
| `/accounting/customers` | `/accounting/directory?view=customers` |
| `/accounting/suppliers` | `/accounting/directory?view=suppliers` |
| `/accounting/vendors` | `/accounting/directory?view=vendors` |
| `/accounting/parties` | `/accounting/directory` |

Those are real `redirect()` calls in `src/app/(app)/accounting/[section]/page.tsx`,
not middleware pathname rewrites.

## 4. The people directory

There is one directory (`/accounting/directory`) and one create/edit flow
(`src/app/dashboard/parties/party-form.tsx`). The directory views are `all`,
`customers`, `suppliers`, `vendors`, and `employees`; `?view=` filters the same
component, `/api/parties` endpoint and `parties` table. Other workspaces link via
`partyDirectoryHref(view)`.

A person can have several roles. Migration `0148_party_roles.sql` keeps
`parties.role` as the primary accounting-code role and adds `parties.roles` as
the complete set. The trigger and listings keep both representations consistent,
so one person who is both a customer and supplier is still one record, one
balance and one file.

## 5. Adding or moving a route

- **New ledger section:** add its key, label, icon and menu group through the
  Accounting route constants. `accounting-workspace.test.ts` must still prove
  every section has an intended menu home.
- **Business page adopted by Accounting:** add its **canonical** href to
  `WORKSPACE_GROUP_SLOTS`. Do not duplicate its gating; the composer receives
  the shell’s already-filtered nav.
- **Moved page:** create/move the canonical `page.tsx`, remove the old
  `page.tsx`, add the permanent legacy prefix mapping, update every producer and
  document, and extend the route-tree, middleware and navigation tests. A
  redirect is mandatory for existing bookmarks, but it is not permission to
  retain a duplicate live route.

## 6. What did not change

- The `(app)` route group and the real top-level app routes.
- Tenant isolation, app availability, feature flags and role/module gates.
- Inventory’s distinct underlying data models and their posting safeguards.
- Dashboard surfaces that are not in the retirement table, such as
  `/dashboard/orders`.
