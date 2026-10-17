/**
 * The approved table, stated once.
 *
 * Every data screen in the reference set — the accounting trial balance, the
 * inventory warehouse list, the WP/Woo order lists — draws the same table: a
 * `rounded-xl` hairline panel that clips its rows, a warm `bg-muted/60` header
 * wash carrying muted column labels, rows separated by the row hairline
 * (`border-border`) with the last one flush against the panel edge, and money
 * columns set in a medium weight with Persian digits.
 *
 * Before this file each screen spelled that out by hand, which is why the
 * header wash had three different spellings (`bg-muted/60`, `bg-muted/60`,
 * `text-xs text-muted-foreground`) and the row rule drifted between
 * `border-border` and `border-border/80`. The components here are the single
 * definition; a screen composes them instead of restating them, exactly as it
 * composes `SectionCard`.
 *
 * Not a client component: a table is markup. `DataTable` handles the horizontal
 * scroll and the panel; callers own the columns because column semantics
 * (scope, alignment, numeric formatting) belong to the data, not the chrome.
 */
import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type ThHTMLAttributes,
  type TdHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

function extractHeaderText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node).trim();
  if (Array.isArray(node)) return node.map(extractHeaderText).filter(Boolean).join(" ").trim();
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractHeaderText(node.props.children);
  }
  return "";
}

function cloneWithChildren(
  element: ReactElement<{ children?: ReactNode }>,
  nextChildren: ReactNode,
  extraProps: Record<string, unknown> = {},
): ReactElement<{ children?: ReactNode }> {
  if (Array.isArray(nextChildren)) {
    const allHaveKeys = nextChildren.every(
      (item) => isValidElement(item) && item.key !== null,
    );
    if (allHaveKeys) {
      return cloneElement(element, extraProps, nextChildren);
    }
    return cloneElement(element, extraProps, ...nextChildren);
  }
  return cloneElement(element, extraProps, nextChildren);
}

function injectMobileDataLabels(children: ReactNode): { children: ReactNode; hasLabels: boolean } {
  const topNodes = Children.toArray(children);
  let headers: string[] = [];

  for (const child of topNodes) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === DataTableHead || child.type === "thead") {
      const headChildren = Children.toArray(child.props.children);
      const thNodes =
        headChildren.length === 1 &&
        isValidElement<{ children?: ReactNode }>(headChildren[0]) &&
        headChildren[0].type === "tr"
          ? Children.toArray(headChildren[0].props.children)
          : headChildren;
      headers = thNodes.map((th) => extractHeaderText(th));
      break;
    }
  }

  if (headers.length === 0 || headers.every((h) => !h)) {
    return { children, hasLabels: false };
  }

  let injectedAny = false;
  const mapNodes = (nodes: ReactNode, fn: (node: ReactNode, idx: number) => ReactNode): ReactNode =>
    Array.isArray(nodes) ? nodes.map(fn) : fn(nodes, 0);

  const nextChildren = mapNodes(children, (child, childIdx) => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    if (child.type !== DataTableBody && child.type !== "tbody") {
      return child.key !== null ? child : cloneElement(child, { key: `dt-top-${childIdx}` });
    }

    const nextRows = mapNodes(child.props.children, (row) => {
      if (!isValidElement<{ children?: ReactNode }>(row)) return row;
      if (row.type !== DataTableRow && row.type !== "tr") return row;

      const cells = Children.toArray(row.props.children);
      const hasSpanningCell = cells.some(
        (c) =>
          isValidElement<{ colSpan?: number }>(c) &&
          typeof c.props.colSpan === "number" &&
          c.props.colSpan > 1,
      );
      if (hasSpanningCell) return row;

      let colIdx = 0;
      const nextCells = mapNodes(row.props.children, (cell) => {
        if (!isValidElement<Record<string, unknown>>(cell)) return cell;
        if (cell.type !== Td && cell.type !== "td") return cell;
        const label = headers[colIdx] ?? "";
        colIdx += 1;
        if ("data-label" in cell.props) {
          injectedAny = true;
          return cell;
        }
        if (!label) return cell;
        injectedAny = true;
        return cloneElement(cell as ReactElement<Record<string, unknown>>, {
          "data-label": label,
        });
      });

      return cloneWithChildren(row as ReactElement<{ children?: ReactNode }>, nextCells);
    });

    return cloneWithChildren(
      child as ReactElement<{ children?: ReactNode }>,
      nextRows,
      child.key !== null ? {} : { key: `dt-body-${childIdx}` },
    );
  });

  return { children: nextChildren, hasLabels: injectedAny };
}

/**
 * The bordered, clipped panel a table sits in, plus its horizontal scroller.
 *
 * `caption` is required rather than optional: a table with no accessible name
 * is the single most common screen-reader failure on these pages, and every
 * reference screen's table has an obvious one to give. It renders `sr-only`.
 */
export function DataTable({
  caption,
  children,
  className,
  tableClassName,
  frame = true,
}: {
  /** The table's accessible name. Rendered visually hidden. */
  caption: string;
  children: ReactNode;
  className?: string;
  tableClassName?: string;
  /**
   * The bordered panel around the table.
   *
   * Almost every table wants it — that panel *is* the approved table. Pass
   * `frame={false}` only when the table already sits directly inside a `flush`
   * `SectionCard`, which supplies the same edges; drawing both puts a hairline
   * a few pixels inside another hairline. `ReportTable` is the one case in the
   * product today.
   */
  frame?: boolean;
}) {
  const alreadyHasDedicatedMobileView = Boolean(className && /\bhidden\b/.test(className));
  const { children: labeledChildren, hasLabels } = alreadyHasDedicatedMobileView
    ? { children, hasLabels: false }
    : injectMobileDataLabels(children);
  return (
    <div
      className={cn(
        frame ? "overflow-hidden rounded-xl border border-border/80" : "min-w-0",
        className,
      )}
    >
      <div className="overflow-x-auto">
        <table
          data-mobile-cards={hasLabels ? "true" : undefined}
          className={cn("w-full text-sm", tableClassName)}
        >
          <caption className="sr-only">{caption}</caption>
          {labeledChildren}
        </table>
      </div>
    </div>
  );
}

/** The warm header wash and its muted label colour — the one spelling of it. */
export function DataTableHead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead className={cn("bg-muted/60 text-muted-foreground", className)}>
      <tr className="border-b border-border">{children}</tr>
    </thead>
  );
}

export function DataTableBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={className}>{children}</tbody>;
}

/** What counts as a control of its own inside a clickable row. */
const ROW_CONTROLS = "a, button, input, select, textarea, label, summary, [role='button'], [role='menuitem']";

/**
 * A body row. `selected` is the amber-tinted "this is the one you picked" wash
 * from the reference tables; `onClick` additionally makes the row behave as a
 * pressable target (quiet hover wash, keyboard focus ring) rather than a
 * silently clickable div.
 */
export function DataTableRow({
  children,
  className,
  selected = false,
  onClick,
  onKeyDown,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  selected?: boolean;
} & Omit<React.HTMLAttributes<HTMLTableRowElement>, "className" | "children">) {
  const interactive = typeof onClick === "function";
  return (
    <tr
      aria-selected={selected || undefined}
      tabIndex={interactive ? 0 : undefined}
      // A control inside the row (an action button, a file link) does its own
      // thing — it must not also open the row (#761 §23).
      onClick={
        interactive
          ? (event) => {
              const control = (event.target as Element).closest?.(ROW_CONTROLS);
              if (control && control !== event.currentTarget && event.currentTarget.contains(control)) return;
              onClick(event);
            }
          : undefined
      }
      // Focusable means operable: Enter/Space on the row itself opens it.
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!interactive || event.defaultPrevented || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}
      className={cn(
        "border-b border-border last:border-b-0",
        selected && "bg-amber-50/60 dark:bg-amber-500/10",
        interactive &&
          "cursor-pointer transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/45",
        className,
      )}
      {...rest}
    >
      {children}
    </tr>
  );
}

/**
 * A column header. `numeric` right-aligns in the logical sense (`text-end`)
 * so an RTL money column lines up under its label the way the references show.
 */
export function Th({
  children,
  className,
  numeric = false,
  scope = "col",
  ...rest
}: {
  children?: ReactNode;
  className?: string;
  numeric?: boolean;
  /**
   * `col` for the header row — the default, and what nearly every caller
   * wants. `row` is for a totals row's label cell, where the figures beside it
   * are named by that label rather than by a column heading.
   */
  scope?: "col" | "row";
} & Omit<ThHTMLAttributes<HTMLTableCellElement>, "className" | "children" | "scope">) {
  return (
    <th
      scope={scope}
      className={cn(
        "px-4 py-3.5 text-xs font-medium sm:text-sm",
        numeric ? "text-end" : "text-start",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

/**
 * A body cell. `numeric` carries the reference tables' money/number treatment —
 * end-aligned, medium weight, `tabular-nums` so digits in a column share a
 * width and the decimal points stack.
 */
export function Td({
  children,
  className,
  numeric = false,
  nowrap = false,
  muted = false,
  ...rest
}: {
  children?: ReactNode;
  className?: string;
  numeric?: boolean;
  nowrap?: boolean;
  /** Secondary columns (a code, a type) read in the muted tone. */
  muted?: boolean;
} & Omit<TdHTMLAttributes<HTMLTableCellElement>, "className" | "children">) {
  return (
    <td
      className={cn(
        "px-4 py-3.5",
        numeric ? "text-end font-medium tabular-nums" : "text-start",
        nowrap && "whitespace-nowrap",
        muted ? "text-muted-foreground" : "text-foreground",
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/**
 * The totals strip under a table — the trial balance's bottom row. Same
 * hairline as the header, a warm wash, and semibold numbers.
 */
export function DataTableFoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tfoot className={cn("border-t border-border bg-muted/60 font-semibold text-foreground", className)}>
      {children}
    </tfoot>
  );
}

/**
 * A table, declared once as data, that renders as a table on a wide screen and
 * as a labelled list of cards on a phone — issue #884 acceptance criterion
 * #10 ("major lists/tables have mobile-native card/row representations").
 *
 * This was `ReportTable` (`src/app/dashboard/reports/report-table.tsx`),
 * which the reports screens had already converged on after the same table
 * got hand-copied — once per screen, with the desktop grid and the phone
 * cards drifting apart each time (see that file's own history). Promoting it
 * here makes it the one definition for *every* module, not just reports:
 * `ReportTable` is now a thin wrapper over this component so its existing
 * callers are unaffected, and any other screen with a `DataTable` it wants a
 * phone view for can use this instead, without copying the table by hand.
 *
 * A column says how to render a cell and how it should align; that single
 * declaration drives both the desktop `<table>` and the phone `<ul>` of
 * cards, so a column can never appear in one and not the other (short of the
 * deliberate `desktopOnly` escape hatch, for a column that only makes sense
 * beside others, e.g. a running balance).
 */
export interface DataCardTableColumn<Row> {
  key: string;
  header: ReactNode;
  /** The cell's content. Return a string/number for text, or a node for chips and buttons. */
  cell: (row: Row) => ReactNode;
  /**
   * `end` for money and counts (a number column reads right-aligned even in an
   * RTL table, which is why this says `end`/`start` and never left/right).
   */
  align?: "start" | "end";
  /** Rendered in a lighter weight — codes, dates, secondary detail. */
  muted?: boolean;
  /** Numbers get tabular figures so columns line up digit for digit. */
  numeric?: boolean;
  /** Kept out of the phone cards: a column that only makes sense beside others. */
  desktopOnly?: boolean;
}

export interface DataCardTableFooterCell {
  key: string;
  content: ReactNode;
  align?: "start" | "end";
  numeric?: boolean;
  /**
   * What to call this figure on a phone, where the footer is a summary card
   * with no column headers above it to inherit a name from. The first cell is
   * the row's own label and needs none.
   */
  label?: string;
}

export interface DataCardTableProps<Row> {
  columns: readonly DataCardTableColumn<Row>[];
  rows: readonly Row[];
  /** Stable key per row; falls back to the row index. */
  rowKey?: (row: Row, index: number) => string;
  /** Names the table for a screen reader. */
  caption: string;
  /** Shown in place of the rows when there are none. */
  empty?: ReactNode;
  /** A totals row — rendered as a `<tfoot>` on desktop and a summary card on a phone. */
  footer?: readonly DataCardTableFooterCell[];
  /** The card's title on a phone, when the first column is not self-explanatory. */
  cardTitle?: (row: Row) => ReactNode;
  className?: string;
  /**
   * The breakpoint the table switches to cards below. Defaults to `sm`
   * (horizontally scrollable tables tolerate a narrow tablet; a phone gets
   * cards). Pass `"lg"` for a table wide enough that it still cramps on a
   * small tablet (many columns, e.g. a CRM customer roster).
   */
  breakpoint?: "sm" | "md" | "lg";
}

const DATA_CARD_TABLE_EMPTY_TEXT = "داده‌ای یافت نشد.";

const BREAKPOINT_CLASSES: Record<
  NonNullable<DataCardTableProps<unknown>["breakpoint"]>,
  { table: string; cards: string }
> = {
  sm: { table: "hidden sm:block", cards: "sm:hidden" },
  md: { table: "hidden md:block", cards: "md:hidden" },
  lg: { table: "hidden lg:block", cards: "lg:hidden" },
};

export function DataCardTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  empty = DATA_CARD_TABLE_EMPTY_TEXT,
  footer,
  cardTitle,
  className,
  breakpoint = "sm",
}: DataCardTableProps<Row>) {
  const cardColumns = columns.filter((column) => !column.desktopOnly);
  const { table: tableVisibility, cards: cardsVisibility } = BREAKPOINT_CLASSES[breakpoint];

  return (
    <div className={cn("min-w-0", className)}>
      {/* Wide screen: one scrollable grid. */}
      <DataTable caption={caption} frame={false} className={tableVisibility} tableClassName="min-w-full">
        <DataTableHead>
          {columns.map((column) => (
            <Th key={column.key} numeric={column.align === "end"}>
              {column.header}
            </Th>
          ))}
        </DataTableHead>
        <DataTableBody>
          {rows.map((row, index) => (
            <DataTableRow key={rowKey?.(row, index) ?? index}>
              {columns.map((column) => (
                <Td
                  key={column.key}
                  numeric={column.align === "end"}
                  muted={column.muted}
                  className={cn(column.numeric && "tabular-nums")}
                >
                  {column.cell(row)}
                </Td>
              ))}
            </DataTableRow>
          ))}
          {rows.length === 0 ? (
            <DataTableRow>
              <Td colSpan={columns.length} muted className="py-10 text-center">
                {empty}
              </Td>
            </DataTableRow>
          ) : null}
        </DataTableBody>
        {footer && rows.length > 0 ? (
          <DataTableFoot>
            <tr>
              {footer.map((cell) => (
                <Td key={cell.key} numeric={cell.align === "end"} className={cn(cell.numeric && "tabular-nums")}>
                  {cell.content}
                </Td>
              ))}
            </tr>
          </DataTableFoot>
        ) : null}
      </DataTable>

      {/* Phone: the same columns as a labelled card, so nothing is hidden by width alone. */}
      <ul className={cn("divide-y divide-border", cardsVisibility)}>
        {rows.map((row, index) => {
          // The first column is always this card's heading — either an
          // explicit cardTitle or the column's own cell — so it never also
          // appears as the first body row; rendering it twice was the old
          // `title ? cardColumns : …slice(1)` mistake this replaced.
          const title = cardTitle?.(row);
          const bodyColumns = cardColumns.slice(1);
          return (
            <li key={rowKey?.(row, index) ?? index} className="px-4 py-4">
              {/* A `<div>`, not a `<p>`: the title source is a column's own cell
                  renderer, which — unlike a report's plain-text first column —
                  can be a whole block (name, organisation, phone stacked), and
                  a block element nested in a `<p>` is invalid HTML. */}
              <div className="min-w-0 break-words font-semibold text-foreground">
                {title ?? cardColumns[0]?.cell(row)}
              </div>
              <dl className="mt-2 grid gap-1.5">
                {bodyColumns.map((column) => (
                  <div key={column.key} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0 text-xs text-muted-foreground">{column.header}</dt>
                    <dd
                      className={cn(
                        "min-w-0 break-words text-end text-sm text-foreground",
                        column.numeric && "tabular-nums",
                      )}
                    >
                      {column.cell(row)}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
        {rows.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-muted-foreground">{empty}</li>
        ) : null}
        {footer && rows.length > 0 ? (
          <li className="bg-muted/60 px-4 py-3 dark:bg-muted">
            <p className="font-semibold text-foreground">{footer[0]?.content}</p>
            <dl className="mt-2 grid gap-1.5">
              {footer.slice(1).map((cell) => (
                <div key={cell.key} className="flex items-baseline justify-between gap-3">
                  <dt className="text-xs text-muted-foreground">{cell.label ?? cell.key}</dt>
                  <dd className={cn("text-sm font-semibold text-foreground", cell.numeric && "tabular-nums")}>
                    {cell.content}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
