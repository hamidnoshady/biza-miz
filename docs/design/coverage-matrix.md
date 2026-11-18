# Design-system coverage matrix

An audit of every tenant-facing area against the approved reference screenshots,
with what each screen uses today, how it differs, and its migration priority.

> This matrix measures component adoption *inside* screens. The route and
> workflow coverage *across* screens — navigation, forms/tables, responsive and
> system states — is in [route-audit.md](route-audit.md).

Measured on the branch `arena/01a0b61c-cafe-restaurant-pos`, not estimated.
Counts are files that reference the primitive at all, so they are an upper
bound on adoption per area, not per screen.

> **On the earlier "roughly 40% coverage" estimate:** measured, it is close but
> mislocated. Adoption of `cardClass`/`SectionCard` is high almost everywhere
> (the palette and the card skin were already normalised by an earlier token
> pass). The real gap is **chrome above and inside the card** — page headers,
> section navigation, tables, chips and KPI tiles — where CRM, Growth and
> Website Management were at or near zero, and where Accounting itself was
> inconsistent.

## Summary by app

| App | `.tsx` files | PageHeader | DataTable | FilterChip | KpiCard | Assessment |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Accounting | 48 | 14 | 1 | 4 | 2 | Closest to the references. Tables were the gap: 13 sections still hand-roll `<thead>`. |
| CRM | 29 | 1 | 0 | 0 | 1 | Header comes from the app shell (correct); had its own `StatCard`, now shared. No tables of its own. |
| Growth and Marketing | 23 | 1 | 1 | 0 | 1 | Same shell pattern. Its one table was the worst-drifted in the product — now migrated. |
| Website Management (CMS + WP/Woo) | 39 | 3 | 2 | 0 | 0 | Both managers migrated for tables; no KPI tiles exist yet to share. |
| Settings | 41 | 7 | 0 | 1 | 0 | Matches screenshots 2 and 4 closely already (section nav + stacked cards). |

`PageHeader` counts look low for CRM/Growth/Websites by design: those apps render
one header in their **app shell** (`crm-app-shell.tsx`, the Growth and Websites
equivalents) and their sections render only the body. That is the correct
pattern, not drift — a per-section header would double up.

## What the six screenshots establish, and where each rule now lives

| # | Screenshot | Rules it fixes | Implementation |
| --- | --- | --- | --- |
| 1 | Orders | Page header + search + chip row; order queue; rich empty state (amber icon chip, bold title, muted line) | `PageHeader`, `SearchField`, `FilterChip`, `EmptyState` (`title`/`icon`) |
| 2 | POS | The approved **dense operational variation**: taller targets, denser cards, amber CTA | `FilterChip dense`, `ops-styles.ts`; exempt by path in the primitive lint |
| 3 | Inventory | Section nav, form card, filters, data table, status badges | `SectionNav`, `SectionCard`, `DataTable`, `StatusBadge` |
| 4 | Menu / file import | Section nav, stacked cards, form controls, file upload, info callout | `SectionNav`, `SectionCard`, `Field`/`inputClass`, `InfoBox` |
| 5 | Accounting trial balance | Table density, header wash, numeric columns, `متوازن` status pill, amber eyebrow | `DataTable`/`Th`/`Td`, `StatusBadge dot`, `CardEyebrow` |
| 6 | Business settings | Section nav, stacked form cards, selected money-unit control (amber-100 fill) | `SectionNav`, `SectionCard`, `CurrencyChoice` |

## Conflicts found between the old canon and the new screenshots

| Conflict | Resolution |
| --- | --- |
| `docs/design-system.md` described the table header wash as `bg-stone-50`; the screenshots show the warm token wash, and the code had **three** spellings (`bg-stone-50 text-stone-500 …`, `bg-muted/60`, bare `text-xs text-muted-foreground`) | One spelling, `bg-muted/60 text-muted-foreground`, stated once in `DataTable`. 79 files normalised off hardcoded `stone-*` pairs onto the tokens. |
| Doc said "no baseline anywhere" for design lint, but there was no structural check at all, so duplicated chrome passed | Added `primitive-lint.test.ts`. Its one exception list (`TABLE_MIGRATION_BACKLOG`) was an ordered, shrinking work list that could not grow silently — and it has since been **deleted entirely**, because the work it tracked is finished. The table rule is now unconditional. |
| Three files defined an identical `StatCard`; `KpiRowSkeleton` already shared the *loading* shape | `KpiCard`/`KpiRow` in `page-chrome.tsx`. Two other local tiles were genuinely different and were renamed (`ChequeToneTile`, `OpsKpiTile`) rather than forced onto the shared one. |
| The old reference set has no Orders, Inventory or menu-import image; `pos-sell-screen.png` was the only operational reference | See "Reference images" below. |

## Migrated in this change

| Screen | Was | Now |
| --- | --- | --- |
| Accounting → trial balance | Hand-rolled `<thead>`, hand-rolled status pill, hand-rolled eyebrow | `DataTable`, `StatusBadge dot`, `CardEyebrow` |
| Accounting → AP / AR | Hand-rolled amber view-switcher chips | `FilterChip` |
| Accounting → fiscal periods, reconciliation | Hand-rolled chips | `FilterChip` |
| Accounting → ledger dashboard | Local `StatCard` | `KpiCard` |
| Accounting → cheques | Local `KpiCard` that was actually a toned tile | Renamed `ChequeToneTile`; distinction documented |
| Accounting → orders queue | Hand-rolled chips ×3, two hand-rolled empty states | `FilterChip dense`, `EmptyState` |
| Accounting → inventory warehouses | Hand-rolled `<thead>` | `DataTable` |
| CRM → overview | Local `StatCard` | `KpiCard` |
| Growth → overview | Local `StatCard` | `KpiCard` |
| Growth → customers | Bare `<table>`, **no panel and no header wash at all** | `DataTable` |
| Websites → CMS billing | Hand-rolled `<thead>` | `DataTable` |
| Websites → CMS product sync | Hand-rolled `<thead>` | `DataTable` |
| Settings → print template designer | Hand-rolled multi-select chips | `FilterChip` |
| Dashboard → media manager | Hand-rolled chips | `FilterChip` |
| 79 files across all apps | Hardcoded `stone-*` light/dark pairs | Theme tokens that flip automatically |

## Table migration — complete

Every hand-rolled table in the tenant-facing apps now composes `DataTable`.
`TABLE_MIGRATION_BACKLOG` — the named-exception list that tracked this work —
**has been deleted**, because there is nothing left on it. The rule in
`src/app/dashboard/primitive-lint.test.ts` is now unconditional: any `<thead>`
in a non-operational tenant file that does not import `DataTable` fails the
check. That was verified by reintroducing one and watching it fail with the
file and line.

| Batch | Files | Tables | Status |
| --- | --- | --- | --- |
| A — Accounting ledger | 13 | 15 | **done** |
| B — Inventory, stock, products | 7 | 10 | **done** |
| C — Reports | 4 | 6 | **done** |
| D — Long tail | 4 | 4 | **done** |

Batch B and C swapped order against the original plan: the inventory tables
were near-duplicates of each other and of the accounting ones just finished, so
doing them second kept the conversion in one mental model, while Reports needed
a design decision (below) that was better taken with more of the product
already migrated.

Two things worth knowing before touching this area again:

- **`report-table.tsx` was not replaced.** It is the reports section's own
  declarative table — columns as data, desktop grid and phone cards generated
  from one declaration — and that is a genuinely better abstraction for those
  screens. It now composes `DataTable` internally, so its three consumers
  inherit the shared chrome without changing a line.
- **The primitive grew exactly two props**, each forced by a real caller:
  `DataTable frame={false}` for a table that sits inside a `flush` SectionCard
  and would otherwise draw a hairline inside a hairline, and `Th scope="row"`
  for a totals row that labels its figures with a row header. Both keep their
  previous behaviour as the default.

### What the conversion changed beyond deduplication

- **Accessible names.** `DataTable` makes `caption` required. Most of these
  tables had none and presented to a screen reader as an unnamed grid.
- **Money columns are end-aligned.** The approved trial-balance screenshot
  shows them that way; the majority of the migrated tables had them
  start-aligned.
- **Judgement the mapping could not make.** A Jalali date carrying
  `tabular-nums` is *not* a numeric column — it keeps tabular figures and stays
  start-aligned. Nor is an end-aligned action column: it says `text-end`
  directly rather than borrowing `numeric` and picking up tabular figures and a
  medium weight. Same for two-line quantity cells.

### Remaining — not yet covered by any automated rule

- [x] **Search fields**: the four files whose markup matched `SearchField`
      exactly were migrated in this PR (inventory + stock `warehouses-section`,
      `products-list-section`, `price-lists-section`) and their now-dead
      `SearchIcon` imports removed. Six remain, each with a real difference
      (an inline clear button at a different offset, a combobox, a nav filter);
      they need `SearchField` to grow a prop rather than a copy-paste, so they
      are deliberately left until that prop is designed. A lint rule is worth
      adding once they are all migrated.
- [ ] **Mobile card fallbacks**: each migrated table keeps a bespoke `lg:hidden`
      card list. These are consistent in palette but not shared; a
      `DataTableMobileList` would remove ~15 near-duplicates.
- [ ] **Section navigation in CRM / Growth / Websites**: these apps use sidebar
      doors rather than in-page `SectionNav`. This matches their IA and is
      *not* drift, but it should be stated in the design doc so a future agent
      does not "fix" it into inconsistency.
