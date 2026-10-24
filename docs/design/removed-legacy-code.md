# Removed legacy design code — inventory and evidence

Deliverable 4 of the design-system PR. One row per thing deleted, with the
evidence that it was unused or superseded. The standing rule is that **nothing
is removed on the strength of its filename or a naive `grep` for an import**:
each entry below names the check that was run, and where a consumer existed the
call site was migrated first and is listed.

Nothing here is kept "just in case", and no compatibility shim was added —
no existing caller needed one. If a future caller does, the shim goes in with
the reason written next to it, per `AGENTS.md`.

## How each removal was verified

1. **Symbol sweep, not import sweep.** For every exported symbol in the four
   shared modules (`page-chrome.tsx`, `filters.tsx`, `data-table.tsx`,
   `ui.tsx`), count the files under `src/` that mention the bare word at all —
   not the files that `import` it — so a re-export, a dynamic `import()`, a
   string in a config or a mention in a test all count as a consumer:

   ```bash
   for n in $(grep -oE "^export (const|function|type) [A-Za-z0-9_]+" "$f" | awk '{print $3}'); do
     c=$(grep -rl "\b$n\b" src --include=*.tsx --include=*.ts | grep -v "^$f$" | wc -l)
     [ "$c" -le 1 ] && echo "$f :: $n -> $c external file(s)"
   done
   ```

2. **CSS classes are swept the same way**, because a Tailwind-adjacent utility
   in `globals.css` is referenced by string, never imported:

   ```bash
   grep -oE "^\s*\.[a-zA-Z0-9_-]+" src/app/globals.css | tr -d ' .' | sort -u |
     while read c; do echo "$(grep -rl "\b$c\b" src --include=*.tsx --include=*.ts | wc -l) $c"; done | sort -n
   ```

3. **Type check + the four lints + a route fetch** after each removal:
   `npx tsc --noEmit`, `npm run test:design`, and a `curl` of the affected route
   against the dev server.

## Removed

| # | Removed | Where it lived | Evidence it was unused or superseded |
| --- | --- | --- | --- |
| 1 | `StatCard` (three separate local definitions) | `(app)/accounting/ledger-dashboard-section.tsx`, `(app)/crm/overview-section.tsx`, `(app)/growth/overview-section.tsx` | Three copies of the same tile — a label, a value, a delta — drifted in padding and delta colour. Superseded by the shared `KpiCard`; all 19 call sites migrated in this PR. The `primitive-lint` KPI rule now fails any new local `StatCard`/`KpiCard`/`MetricCard`. |
| 2 | `filterButtonClass` (two identical definitions) | `dashboard/inventory/warehouses-section.tsx`, `dashboard/stock/warehouses-section.tsx` | Byte-identical 4-line class helper in two files, a third spelling of the chip (`ring-2` where `FilterChip` uses `ring`, `text-xs` where the approved chip is `text-sm`). Both call sites migrated to `FilterChipRow` + `FilterChip`; helper deleted. Symbol sweep after the change: `grep -rn filterButtonClass src` → no matches. |
| 3 | Twelve hand-rolled chip blocks (~340 Tailwind characters each) | `media-manager.tsx`, accounting `ap-section`, `ar-section`, `fiscal-periods-section`, `reconciliation-section`, `template-designer` | Each re-derived the amber active fill and its own focus ring. Replaced by `FilterChip`; the `primitive-lint` chip rule fails re-derivation, with the three defining files and the genuinely different controls (stacked tiles, segmented radios, the sidebar picker) exempted by shape rather than by name. |
| 4 | Four hand-rolled search fields (`relative` wrapper + absolutely positioned `SearchIcon` + `inputClass ps-9`) | `dashboard/inventory/warehouses-section.tsx`, `dashboard/stock/warehouses-section.tsx`, `dashboard/products/products-list-section.tsx`, `dashboard/products/price-lists-section.tsx` | Structurally identical to `SearchField`, which had **zero** consumers (symbol sweep: `SearchField -> 0`) while the pattern was copied around the app. Migrated; the now-unused `SearchIcon` import was removed from each of the four files (verified: each file's only remaining mention of `SearchIcon` was the import line). |
| 5 | `FilterBar` | `dashboard/filters.tsx` | A three-line `flex flex-col gap-3` wrapper. Symbol sweep found exactly one other file mentioning the word — `src/app/platform/page.tsx`, which defines and uses **its own local** `FilterBar` (line 426) and never imports this one. Dead on arrival: it was added earlier in this same PR (`5b7cee7`) and never used, so deleting it removes a second way to spell a flex column rather than breaking a caller. `npx tsc --noEmit` clean after removal. |
| 6 | Hardcoded `stone-*` colour classes in 79 files | across `src/app` | Superseded by the theme tokens (`bg-card`, `bg-muted/60`, `text-muted-foreground`, `border-border`). The hardcoded form did not flip in dark mode, which is the bug; `design-lint.test.ts`'s `darkMode` rules already fail the reintroduction. |
| 7 | Seven reference PNGs moved out of the normative path | `docs/design/reference/*.png` → `docs/design/reference/archive-2026-09/` | Superseded as *authority* by the 2026-09-18 screenshot set. **Moved, not deleted**, because three of them document a state the new set does not cover (the combobox popover, the overview chart, the reservations empty states) — `archive-2026-09/README.md` records why each is kept and the two specific points on which it now disagrees with the spec. The two in-document links to them were repointed, so no reference is broken. |

## Deliberately *not* removed

Recording these so the next person does not re-litigate them:

| Kept | Why |
| --- | --- |
| `src/app/platform/**`'s own `ui.tsx`, including its local `FilterBar` | The super-admin console is a separate identity by design and is out of this PR's scope. It is internally consistent; unifying it would be a different decision, not a cleanup. |
| `.ops-card-enter`, `.ops-chart-bar`, `.ops-chart-line`, `.ops-data-resolve`, `.ops-order-row`, `.ops-sync-pulse` | The class sweep scores each at one referencing file, which looks dead but is not: all six are used by `dashboard/operations-overview.tsx`, which is simply their only consumer. Verified by reading the call sites (e.g. `ops-order-row` at lines 389 and 407). A count of one is a single consumer, not zero. |
| `docs/design/verification/*.png` | Captures of the earlier token normalization. Explicitly re-labelled historical in `docs/design-system.md` rather than deleted, because they are the evidence for that earlier change. |
| `docs/reports/DESIGN_LINT_FIXES.md` | A record of a previous branch's fixes. Historical, referenced by nothing, harmless, and deleting it would destroy the rationale for a set of edits still present in the code. |
| The `lg:hidden` mobile card lists that sit beside tables | Duplicated in shape across ~15 files and a genuine consolidation candidate (`DataTableMobileList`), but they are *live* and each one renders different fields. Listed as Batch E in `docs/design/coverage-matrix.md` rather than removed blind. |

## Net effect

`filters.tsx` now exports only what is used (`FilterChip`, `FilterChipRow`,
`SearchField`), `page-chrome.tsx`'s `KpiRow` has real consumers instead of
being a decorative export, and there is exactly one spelling in the codebase of
a chip, a search field, a KPI tile and a table header.
