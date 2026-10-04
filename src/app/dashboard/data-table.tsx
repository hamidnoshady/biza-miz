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
import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

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
  return (
    <div
      className={cn(
        frame ? "overflow-hidden rounded-xl border border-border/80" : "min-w-0",
        className,
      )}
    >
      <div className="overflow-x-auto">
        <table className={cn("w-full text-sm", tableClassName)}>
          <caption className="sr-only">{caption}</caption>
          {children}
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
