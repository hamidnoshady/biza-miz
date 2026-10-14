"use client";

/**
 * The reports section's one table.
 *
 * Every report screen here had grown its own copy of the same thing: a
 * `<table>` for `sm:` and up, a duplicate `sm:hidden` list of `<article>`
 * cards below it, and a third spelling of the empty row — in
 * `chart-preview.tsx`, `branch-overview-section.tsx`, `ledger-report-view.tsx`
 * and again in each of the per-trade report tabs. Four copies of a table is
 * four places for a column to fall out of alignment with its header, and the
 * mobile halves had already drifted apart (one used `bg-muted` cards, another
 * dashed borders, a third nothing at all).
 *
 * So the table was declared once, as data, right here — and then promoted
 * into `@/app/dashboard/data-table` as `DataCardTable`, so every *other*
 * module with a plain `DataTable` and no phone view (issue #884's device-
 * registry follow-up, acceptance criterion #10) can reuse the same engine
 * instead of hand-rolling it again. `ReportTable` is kept as the name reports
 * already call it by — a thin wrapper, not a second implementation, so this
 * file's own column/row types and every existing caller are unaffected.
 *
 * The desktop table is deliberately *not* wrapped in its own card — it is meant
 * to sit inside a `flush` `SectionCard`, which is what gives it the section
 * heading, the divider under it and the card's own edges (docs/design-system.md
 * §Tables).
 */
import {
  DataCardTable,
  type DataCardTableColumn,
  type DataCardTableFooterCell,
  type DataCardTableProps,
} from "@/app/dashboard/data-table";

export type ReportTableColumn<Row> = DataCardTableColumn<Row>;
export type ReportTableFooterCell = DataCardTableFooterCell;

export function ReportTable<Row>(props: DataCardTableProps<Row>) {
  return <DataCardTable {...props} />;
}
