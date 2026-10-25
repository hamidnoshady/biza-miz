# UI conventions — the dashboard's design language

> **Pixel-level canon:** [docs/design-system.md](design-system.md) is the normative visual
> spec — exact colours, the control/table/chip recipes, hover/focus/active states, motion
> vocabulary, the banned old look, and a **decision guide** mapping each UI need to the one
> approved component. Its authority is the approved reference screenshots (the pre-2026-09
> set is archived under [`docs/design/reference/archive-2026-09/`](design/reference/archive-2026-09)
> and is historical, not normative). Read it alongside this file; this file is the
> composition rules, that file is what things look like.

**Every new page and panel under `src/app/dashboard/**` is built from
[`src/app/dashboard/page-chrome.tsx`](../src/app/dashboard/page-chrome.tsx). Do not
re-derive its classes, and do not invent a second spelling of a shape it already has.**

That file *is* this document's normative half: the classes live there, so a change to the
shared look is one edit and a new screen cannot drift by accident. What follows is why each
piece exists and how to reach for it.

## Where the language came from

The look was set by the newest screens — Phase 25/27/29's `inventory`, `jewelry`, `watch`,
`accessories`, `cosmetics`: a warm stone canvas, one 1600px column, an underlined page
header, amber-accented tab pills tall enough to hit on a tablet, and `rounded-2xl` section
cards on a one-pixel warm shadow.

Everything written before that settled had its own header spacing, its own tab style and its
own card border. Three different tab dialects and five different page headers coexisted, so
moving between two screens of the same product looked like moving between two products.
`page-chrome.tsx` ended that by making the shared pieces components instead of conventions.

## The primitives

| Use | Instead of |
| --- | --- |
| `<PageShell>` | `<div className="mx-auto w-full max-w-[1600px]">` |
| `<PageHeader title description actions>` | a hand-rolled `<header>` with an `<h1>` |
| `<SectionCard title description actions footer flush>` | `<section className="rounded-2xl …">` |
| `cardClass` | restating the card's border/shadow on a bespoke layout |
| `<TabBar>` + `<TabPanel>` | a row of `<button>`s styling their own active state |
| `<SectionNav>` | a page's own in-page menu wired to its own panel |
| `<EmptyState>` | `<p className="rounded-xl border border-dashed …">` |
| `<StatusBadge tone>` | a `rounded-full` span with hand-picked tone classes |
| `<CardEyebrow>` | a hand-spelled amber `text-[11px]` category line |
| `<KpiCard>` + `<KpiRow>` | a local `StatCard`/`MetricCard` (there were three) |
| `<DataTable>` + `<Th>`/`<Td numeric>` | `<table>` with its own header wash and cell padding |
| `<FilterChip>` / `<FilterChipRow>` | an `aria-pressed` button styling its own amber fill |
| `<SearchField>` | an input with a hand-positioned search icon |

Notes that are easy to get wrong:

- **A titled card always draws a divider under its header.** One rule, both card shapes.
  Pass `flush` when the body is an edge-to-edge list or table so its dividers reach the card's
  edges; otherwise the body gets the standard `p-4 sm:p-5`.
- **A table is `DataTable`, including its mobile half.** `Th`/`Td` own the header wash, the
  cell padding and the hairlines; `<Td numeric>` end-aligns with `tabular-nums` for money and
  counts, `<Td muted>` dims a secondary column. Keep the `lg:hidden` card list beside it for
  phones, and set the minimum width on `tableClassName`, never on a wrapper you invent.
  Two narrower props exist, each added for exactly one real caller rather than speculatively:
  `<DataTable frame={false}>` drops the panel border for a table already sitting inside a
  `flush` `SectionCard` (double borders otherwise), and `<Th scope="row">` marks a row header
  where the first cell labels the row instead of a column. `numeric` is about *alignment*,
  so it is wrong for a Jalali date or an end-aligned action column even though both may look
  numeric — use plain `text-end` there.
- **Density is a prop, not a fork.** `FilterChip dense` gives operational surfaces their
  taller touch target without a second chip. If you find yourself writing `bg-amber-100
  … aria-pressed`, you are re-deriving `FilterChip`.
- **`cardClass` is for bespoke *layout*, not bespoke *skin*.** A chat panel that fills a fixed
  height or a canvas that scrolls composes `cn("flex h-… flex-col", cardClass)`. If all you
  need is padding and a title, that's `SectionCard`.
- **`PageShell` accepts a `className` width override** — `max-w-[1100px]` for a narrow
  single-column form page. Use it for a real content-width decision, not to avoid the shell.
- **`TabBar`'s pills are `aria-pressed`, not `role="tab"`**, because the panel below is a plain
  region rather than a tabpanel widget. `TabPanel` is separate so a manager can put an error
  box between the strip and the panel.
- **A page whose menu *is* a menu uses `<SectionNav>`** (`src/app/dashboard/section-nav.tsx`),
  which wraps `TabBar`/`TabPanel` and adds the phone's behaviour: below the breakpoint the menu
  is the whole page, and picking an entry replaces it with that section under a «بازگشت» arrow —
  the same one-level-at-a-time shape the sidebar already gives a phone. Two variants:
  `strip` (the default: pills above the panel from `md` up) and `rail` (a sticky menu card
  beside the panel from `lg` up, for a menu too long to read as pills — تنظیمات, حسابداری, رشد و بازاریابی).
  Reach for `TabBar` on its own only where there is no menu to drill into.
  - CRM, Growth and Website Management deliberately do **not** use `SectionNav`: they render
    their header in an app shell and their menu in the dashboard sidebar. That is their IA,
    not drift — do not convert them to a rail.
  - Rendering both halves and switching them with `hidden`/`md:block` is deliberate: the
    drill-down state means nothing above the breakpoint, so there is no `matchMedia` read and
    therefore no desktop layout flashing on a phone before hydration.

## The phone's bottom band

`--app-bottom-nav` (globals.css) is how tall the fixed mobile bar is, safe area
included, and it is the only definition of that. The bar sizes itself from it,
and everything that has to sit on top of the bar offsets from it: the dashboard
scroller's bottom padding, the assistant's floating button, a page's own docked
bar. Never write that height out again as a number of your own — three
independent guesses are what left the sell screen's cart summary floating a
hundred pixels above the nav.

A page that docks its own bar on top of the nav marks it `data-bottom-dock`, and
`--app-bottom-dock` lifts the assistant's button clear of it (phone widths only,
since such a bar is `md:hidden`). Dock a bar with `fixed`, not `sticky`: Chrome
measures a sticky offset from the scrollport's *content* box, so the scroller's
own bottom padding gets added to it and the bar drifts.

## Controls, text and forms

- **Buttons are `<Button>`** from `src/components/ui/button.tsx`. Sizes: `default` (h-10),
  `sm`, `lg`, `xs` for a row action, `icon-sm`/`icon-xs` for an icon-only one. A destructive
  row action is `variant="ghost"` plus
  `className="text-destructive hover:bg-destructive/10 hover:text-destructive"`. Never a raw
  `<button>` with its own padding and border.
  - `PrimaryButton`/`SecondaryButton` in `src/app/dashboard/ui.tsx` are the **full-width form
    submit** pair. In a card header or a toolbar use `<Button>` directly — `PrimaryButton`
    carries `w-full` and will stretch.
- **Inputs use `inputClass`** and are labelled by `<Field>`, both from
  `src/app/dashboard/ui.tsx`. A `<select>` takes `inputClass` too; a long list of options is
  `<SearchableSelect>` from `src/components/ui/searchable-select.tsx`.
- **Messages are `<ErrorBox>` and `<InfoBox>`** (also `ui.tsx`) — not a bare `<p>` in red or a
  hand-rolled tinted div. Both already carry their own bottom margin.
- **A pressed/selected chip is amber**: `border-amber-200 bg-amber-100 text-amber-950`, with
  `aria-pressed` on the button. Never `bg-stone-900 text-white` and never a teal fill.

## Colour

- **Neutrals are the warm stone scale.** `border-stone-200/80` for a hairline,
  `text-stone-950` for a heading, `text-muted-foreground` for supporting copy, `bg-stone-50/60`
  for a footer wash. The `--border`/`--input`/`--muted`/`--accent` tokens in
  `src/app/globals.css` are tuned to that same warmth, so `border-border` and `bg-muted` are
  also correct — a cool `gray-*`/`slate-*`/`zinc-*` class is not.
- **Amber is selection and emphasis** — the active tab, a pressed chip, a focus ring
  (`focus-visible:ring-3 focus-visible:ring-amber-400/40`), a warning banner.
- **Teal (`--primary`) is the brand accent**, and stays where it is: filled `<Button>`s,
  links, the today cell in a date picker. Don't repaint it amber, and don't introduce a third
  accent.
- **Shadows are warm and small.** `shadow-[0_1px_2px_rgb(41_37_36/0.035)]` is the card shadow
  (that's what `cardClass` carries). Never `shadow-sm`/`shadow-md` on a card — they are cooler
  and heavier than the rest of the app — and never a `rgb(15 23 42 / …)` shadow.

## What is deliberately *not* covered

- **Full-screen operational surfaces keep their own compact chrome**: POS
  (`pos/pos-screen.tsx`), the orders queue, the floor plan, the kitchen display, the waiter
  and delivery boards, reservations. Their headers are icon-led and dense on purpose because
  they are read at arm's length at a counter — they use the same palette, tokens, radii and
  states, but not `PageHeader`. This is an **approved variation** (see the design system's
  "When an operational variation is allowed"), bounded to those paths and to four dimensions:
  taller targets, denser cards, a smaller/absent page header, and an amber filled CTA. It is
  not a licence to hand-roll a table or a chip, and it must never leak onto an ordinary CRM,
  Growth or Website Management page.
- **`src/app/platform/**` is a separate realm** with its own `ui.tsx`, internally consistent.
  Leave it alone; it is the super-admin console, not a tenant screen.
- **`src/components/ui/*` is shadcn's** generated layer. Change a token or a variant there,
  never a one-off class at a call site.
- **Dark mode is supported.** The theme follows `next-themes` (`class` strategy, system
  default; toggle in the sidebar). Write colours from the theme tokens so they flip
  automatically — surfaces `bg-card`/`bg-background`/`bg-muted`, text `text-foreground`/
  `text-muted-foreground`, rules `border-border`. The brand amber and the emerald/rose/red/sky
  status colours keep their hue but need a light-on-dark shade, so pair them (e.g.
  `bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200`). A solid amber fill
  keeps dark amber text in both themes (`text-amber-950`). Never leave a hardcoded light-only
  colour class without a token or a `dark:` counterpart. QR-code images stay white and the
  camera viewfinder stays black (scannability/video), regardless of theme.

## Reviewing a change

The design-system bans (cool neutrals, heavy shadows, hand-rolled shells and card chrome,
light-only colour classes without a token/`dark:` counterpart, raw hex classes, solid
`bg-white` off a QR image, spinner loaders, bare loading copy, bare `<h1>`) are **enforced by
two tests that keep no baseline**:

- [`src/app/dashboard/design-lint.test.ts`](../src/app/dashboard/design-lint.test.ts) —
  every dashboard file, plus a page-frame rule: every route renders `PageShell` itself or
  through a component it imports.
- [`src/app/design-lint.test.ts`](../src/app/design-lint.test.ts) — the same bans on every
  other tenant-facing surface (login, welcome, setup, invite, consent, business directory,
  `src/components` minus the shadcn layer), so no business type's screens drift from
  حسابداری's look.
- [`src/app/dashboard/primitive-lint.test.ts`](../src/app/dashboard/primitive-lint.test.ts) —
  the **structural** half, which walks the JSX instead of grepping text: a hand-built table,
  filter chip, KPI tile or rich empty state fails, wherever it is in the tenant app.
  Operational paths are exempt by path with the reason written down. There is no longer a
  table exception list: `TABLE_MIGRATION_BACKLOG` was **deleted** once the last hand-rolled
  table was migrated, so the rule is unconditional and a new `<thead>` cannot be excused.
- [`src/app/loading-coverage.test.ts`](../src/app/loading-coverage.test.ts) — every layout
  realm sits under a skeleton boundary, and every client component that fetches on mount
  renders a `*Skeleton`.
- [`src/app/reference-screenshots.test.ts`](../src/app/reference-screenshots.test.ts) — the
  approved-screenshot availability note in `design-system.md` must match what is actually in
  `docs/design/reference/`, in both directions.

They run with `npm test`, as `npm run test:design`, and as the `design-checks` job on every
pull request. The pixel half is separate: `npm run test:visual` (the `visual-regression` job)
diffs representative screens of all four apps against the committed baselines in
`docs/design/visual/`. **Never re-record a baseline to make a red run green** — see
[`docs/design/visual-regression.md`](design/visual-regression.md). The same checks by hand:

These greps should each return nothing new under `src/app/dashboard/`:

```bash
grep -rn 'shadow-sm\|shadow-md' src/app/dashboard/ && echo "card shadow drifted"
```

```bash
grep -rn 'mx-auto w-full max-w-\[' src/app/dashboard/ --include='*.tsx' | grep -v page-chrome && echo "page shell hand-rolled instead of PageShell"
```

```bash
grep -rn '<h1' src/app/dashboard/ --include='page.tsx' && echo "page header bypassed PageHeader"
```
