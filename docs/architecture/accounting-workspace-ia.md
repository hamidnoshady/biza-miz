# The Accounting workspace — information architecture

This is the route and navigation contract for the Accounting workspace. It
supersedes older notes about *navigation* in `docs/design-system.md`; the visual
canon remains unchanged.

## 1. Why this shape

Accounting is the business's primary work menu, not a narrow ledger tool. It
brings together the daily business work (sales, inventory, products, operations
and business reporting) and the ledger as **one ordinary menu link** —
«فضای کار حسابداری» — that opens the ledger workspace page at
`/accounting/ledger`, where the permitted tools are listed. The previous flat
`/dashboard/*` operational URLs made a person leave Accounting to complete
routine work and created competing navigation structures; the previous sidebar
disclosure (a chevron over sixteen ledger rows) made the menu read as a drawer
bolted onto the workspace. Both are gone.

`/accounting` is one shell with one menu. The menu composes, rather than copies,
the shell's already-gated business entries with Accounting's own workspace link.
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
| Taxpayer invoices (سامانه مودیان) | `/accounting/tax-invoices` |

### The app home and who lands on it (issue #1124)

`/accounting/overview` is the app's single home and the landing for **every**
member admitted to the app (`AppDef.sharedHome` in `src/lib/apps.ts`, read by
`resolveAccessibleAppLanding` for both `/accounting` and the workspace
launcher). The till is never forced as the app home; it stays its own row and
shortcut. What the page renders is decided by effective permissions:

- `ledger.view` (and the ledger feature on): the ledger dashboard, whose figures
  come from `/api/ledger/overview`, still guarded server-side.
- No `ledger.view` (a cashier, waiter, kitchen role, or any custom role): a
  server-rendered page of shortcuts into the work areas that member's own
  navigation already admits (`AccountingStaffOverview`). It mounts no ledger
  component and fetches no figures, so no balance can reach it.
- A member the app has nothing for: a policy explanation, not a redirect.

A hand-typed ledger section without the door still returns to `/accounting`,
which now lands on the overview. The Hybrid desktop's till home is unchanged
(`siteHomeFor` in `src/lib/site-routes.ts`); the overview itself is a cloud
screen there, as it is for owners.

The rest of the workspace has these responsibilities:

| Group | Entries |
| --- | --- |
| میز کار | داشبورد حسابداری (`/accounting/overview`); «نمای کلی» at the same address for a member without `ledger.view` |
| فروش و درآمد | existing canonical sales entries, including POS and customer work |
| خرید و انبار | inventory, products and industry-specific trade entries |
| عملیات | the industry’s canonical operations screens, such as floor, kitchen, reservations and delivery |
| اشخاص | the one directory (`/accounting/directory`) and its `?view=` links |
| **فضای کار حسابداری** | ONE ordinary link to the workspace page `/accounting/ledger`, which lists the permitted ledger tools (trial balance, journal, voucher numbering, manual entry, chart of accounts, accounting dimensions, receivables, payables, receipts/payments, financial accounts, internal transfers, instalments, cheques, expenses, bank reconciliation, fixed assets, shareholders, periods, tax, payroll) under five named divisions |
| گزارش و تحلیل | financial reports (`/accounting/financial-reports`), business reports (`/accounting/reports`), growth/marketing |
| پیکربندی | business settings, technical connections, credit and billing |

`/accounting/financial-reports` is the ledger report index. `/accounting/reports`
is the business reporting workspace; they are intentionally different routes.

### How the workspace link is drawn

Every group in this menu is rendered by the shared
[`src/app/dashboard/sidebar-nav-group.tsx`](../../src/app/dashboard/sidebar-nav-group.tsx),
so the sidebar has one spelling of a row instead of one per menu.

- «فضای کار حسابداری» is **one ordinary menu link** — the same
  `SidebarMenuButton`/`Link` row as «فروش و فاکتور» (`APP_NAV_BUTTON_CLASS`,
  `NAV_LABEL_CLASS`, a 20px glyph from the shared nav icon map
  (`navIconFor` in `sidebar-nav-icons.ts`, which reads the section's glyph in
  `ACCOUNTING_SECTION_ICONS`), hover/focus/selected states, `aria-current` and
  the collapsed-rail tooltip). It has **no disclosure, no chevron, no `aria-expanded`
  and no nested panel** — the words live on the row, not on a heading above it.
  Clicking it opens `/accounting/ledger` immediately.
- The workspace page (`/accounting/ledger`, the `ledger` section) lists the
  permitted tools under the accountant's own divisions:

  | division | sections |
  | --- | --- |
  | دفتر و اسناد | تراز آزمایشی، دفتر روزنامه، اسناد و شماره‌گذاری، ثبت سند دستی، ارز و تسعیر، سرفصل حساب‌ها، ابعاد حسابداری |
  | دریافتنی و پرداختنی | حساب‌های دریافتنی، حساب‌های پرداختنی، اقساط، چک‌ها |
  | وجوه و هزینه | دریافت و پرداخت، حساب‌های مالی، انتقال وجه، هزینه‌ها، تطبیق بانکی، دارایی‌های ثابت |
  | سرمایه و مالکیت | سهام‌داران |
  | دوره، مالیات و حقوق | دوره‌های مالی، ترازات افتتاحیه، گزارش مالیات، صورتحساب مؤدیان، حقوق و دستمزد |

  They are an *arrangement* of `LEDGER_WORKSPACE_SECTION_KEYS`, never a second
  list: `ledgerWorkspaceToolGroups()` builds the page from
  `LEDGER_WORKSPACE_SUBGROUPS` and the same `accountingSectionsFor` permission
  helper the section routes enforce, and a test asserts the tool sets are
  identical, so a section cannot end up in one and not the other.
- The row **lights on its landing page and on every tool route it owns**
  (`isLedgerWorkspacePathname`) and stays dark on unrelated Accounting areas —
  sales, inventory, the directory, reports and the overview each have their own
  row. At the 4rem icon rail the label hides and the row keeps its tooltip.
  A bottom-bar tab pinned to `/accounting/ledger` follows the same rule
  (`isActive` in `dashboard-sidebar.tsx` layers it over the shared
  `navHrefIsActive`), so the tab does not go dark while the member is inside a
  ledger tool.
- The tools' own direct URLs are unchanged and remain bookmarkable,
  pinnable to the mobile bottom bar and permission-gated exactly as before.

In-page, a ledger tool screen draws the compact contextual chip row of its own
division («دفتر و اسناد»، «وجوه و هزینه»، «سرمایه و مالکیت»…) after its content on a phone and
above it from `sm` up (`accounting-manager.tsx`); the workspace page, the
overview, the directory and the reports pages render as plain pages. That chip
row is navigation between sibling tools, not a second copy of the menu.

### The money containers and their transfers

«حساب‌های مالی» and «انتقال وجه» are the ledger's operational register for the
money the business actually holds: bank accounts, cash boxes, petty cash and
POS/PSP settlement accounts (`financial_accounts`), and the document that moves
money between two of them (`financial_transfers`, migration `0224_…`, issue
#862). They sit in the funds division because they are the containers the
receipts and expenses beside them pay into and out of.

Three rules keep them inside the one accounting engine rather than beside it:

- **One container, one postable GL account.** `uq_financial_accounts_gl_account`
  makes the link unique, so two containers can never display the same
  chart-of-accounts balance; a container may only point at a leaf, active,
  correctly-typed account.
- **No balances of their own.** Nothing caches a container's money: the register,
  the account card, the balance summary and the exports all sum `journal_lines`
  of the linked account, and the card prints its own closing figure beside that
  ledger balance rather than instead of it.
- **Transfers post like any other document.** Amount and fee are one balanced
  `postExactJournalEntry` inside one transaction, idempotent by key and refused
  across branches, tenants, currencies or closed periods; a correction is an
  append-only reversal entry that references the original, and an account with
  history is archived, never deleted.

What they deliberately do *not* own: bank reconciliation (#830) and the
receipt/payment, expense and payroll documents (#829, #832, #835). Those keep
their own flows and consume this model through
`/api/ledger/financial-accounts/payment-sources` instead of re-deriving which
container money came from.

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
  label to `ACCOUNTING_SECTIONS`, a glyph to `ACCOUNTING_SECTION_ICONS` (it is
  the one place a section's glyph lives: the sidebar, the bottom bar and its
  pin picker all read it through `navIconFor`), and
  (if it is a ledger tool) one division of `LEDGER_WORKSPACE_SUBGROUPS` — the
  tool set `LEDGER_WORKSPACE_SECTION_KEYS` is derived from those divisions. The
  workspace page then lists it automatically, filtered by the same permission
  helper. A non-tool section gets a menu row through
  `accountingWorkspaceGroups()`. `app-ownership.test.ts` fails if a section ends
  up with neither a menu row nor a workspace-page tool, and
  `accounting-workspace.test.ts` pins the complete tool set and its divisions.
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

- **New ledger section:** add its key, label, icon and division through the
  Accounting route constants (`LEDGER_WORKSPACE_SECTION_KEYS` +
  `LEDGER_WORKSPACE_SUBGROUPS`). It then appears on the
  «فضای کار حسابداری» page (`/accounting/ledger`) at its canonical URL; the
  sidebar does not list it. `accounting-workspace.test.ts` must still prove
  every section has an intended home, and `accounting-workspace-ia.test.ts`
  proves the divisions table on this page still matches them — update the table
  above when it does not.
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


## Commission settlement boundary (#869 completion, 2026-10-15)

Commission approval and standalone payouts remain in Growth at `/growth/commission/runs`
and `/growth/commission/runs/[id]`; they are not another payroll engine or Accounting menu.
Their journals link to the existing journal workspace, and seller statements link sales,
standalone runs and the canonical payroll workspace. Legacy payroll sources use
`/accounting/payroll?run=<id>`: the existing Accounting page/section gates remain intact,
and the source panel fetches the exact run through the existing `payroll.view` API,
not from the first history page. It opens immutable lines read-only, aborts/ignores stale
responses, and shows explicit missing/foreign/error/retry states. It does not select an
engine run or create a second payroll navigation item. The normal monthly workspace
and its permitted mutation controls remain unchanged.
Both payroll and Growth reconcile against account 2300 through the existing tenant-scoped
read-only snapshot helper. A real difference stays visible. See
[commission settlement](../features/commission-settlement.md) for exact contracts and outstanding gates.
