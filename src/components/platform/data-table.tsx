"use client";

import * as React from "react";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PlatformEmptyState,
  PlatformFilteredEmptyState,
  PlatformErrorState,
} from "./states";

/**
 * The one operational table for the console (section 6). It renders a real
 * table on desktop and a stacked card list on mobile from the SAME column
 * definitions, so no section reinvents a responsive list. It owns the shared
 * loading / empty / filtered-empty / error bodies too, so every list behaves
 * identically.
 *
 * Sorting is server-driven: the header reports a sort request via `onSort`; the
 * component never sorts client-side (it would lie about a paginated list).
 */
export interface Column<T> {
  /** Stable key, also the sort key sent to `onSort`. */
  key: string;
  header: React.ReactNode;
  /** Cell renderer. */
  cell: (row: T) => React.ReactNode;
  /** A shorter/plain value for the mobile card label; defaults to `cell`. */
  mobileCell?: (row: T) => React.ReactNode;
  sortable?: boolean;
  align?: "start" | "end" | "center";
  /** Hide this column below `md` (still shown in the mobile card). */
  hideOnMobile?: boolean;
  className?: string;
  headerClassName?: string;
}

export type SortDirection = "asc" | "desc";

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  /** Row click / navigation. When set, rows get hover + pointer affordance. */
  onRowClick?: (row: T) => void;
  /** Per-row action node (a menu), rendered in a trailing column. */
  rowActions?: (row: T) => React.ReactNode;
  loading?: boolean;
  error?: string | null;
  errorStatus?: number | null;
  onRetry?: () => void;
  isFiltered?: boolean;
  onResetFilters?: () => void;
  emptyTitle?: string;
  emptyDescription?: React.ReactNode;
  emptyAction?: React.ReactNode;
  sortKey?: string;
  sortDir?: SortDirection;
  onSort?: (key: string, dir: SortDirection) => void;
  /**
   * Renders the mobile card title (first line). When omitted, the first
   * column is rendered once as the card title (the identifying record name).
   */
  mobileTitle?: (row: T) => React.ReactNode;
  /**
   * Accessible name prefix for the keyboard details control on each row,
   * e.g. "جزئیات کسب‌وکار". Defaults to "جزئیات".
   */
  detailsLabel?: string;
  className?: string;
  minWidthClass?: string;
}

const alignClass: Record<NonNullable<Column<unknown>["align"]>, string> = {
  start: "text-start",
  end: "text-end",
  center: "text-center",
};

export function PlatformDataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowActions,
  loading,
  error,
  errorStatus,
  onRetry,
  isFiltered,
  onResetFilters,
  emptyTitle = "چیزی برای نمایش نیست.",
  emptyDescription,
  emptyAction,
  sortKey,
  sortDir,
  onSort,
  mobileTitle,
  detailsLabel = "جزئیات",
  className,
  minWidthClass = "min-w-[720px]",
}: DataTableProps<T>) {
  // Every column stays in the mobile list. Without an explicit mobileTitle the
  // first column is rendered once, as the card title (see the map below); the
  // previous filter removed it before that fallback could run, hiding names.
  const mobileColumns = columns;
  const hasActionsCell = Boolean(rowActions || onRowClick);
  // Background refresh failure: rows stay visible, the failure is announced.
  const staleWithRows = Boolean(error) && rows !== null && rows.length > 0;

  const showInitialLoading = loading && (rows === null || rows.length === 0);

  if (error && (rows === null || rows.length === 0)) {
    return (
      <PlatformErrorState
        message={error}
        status={errorStatus}
        onRetry={onRetry}
      />
    );
  }

  if (showInitialLoading) {
    return (
      <div
        className="space-y-2"
        role="status"
        aria-busy="true"
        aria-label="در حال بارگذاری"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (rows && rows.length === 0) {
    if (isFiltered)
      return <PlatformFilteredEmptyState onReset={onResetFilters} />;
    return (
      <PlatformEmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  const data = rows ?? [];

  function handleSort(col: Column<T>) {
    if (!col.sortable || !onSort) return;
    const nextDir: SortDirection =
      sortKey === col.key && sortDir === "desc" ? "asc" : "desc";
    onSort(col.key, nextDir);
  }

  return (
    <div className={className} aria-busy={loading ? "true" : undefined}>
      {staleWithRows ? (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
        >
          <span className="flex items-center gap-2">
            <AlertTriangleIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
            <span>
              به‌روزرسانی فهرست ناموفق بود؛ داده‌های نمایش‌داده‌شده ممکن است قدیمی باشند.
              {error ? <span className="text-muted-foreground"> ({error})</span> : null}
            </span>
          </span>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              تلاش دوباره
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-xl ring-1 ring-foreground/10 md:block">
        <Table className={minWidthClass}>
          <TableHeader>
            <TableRow className="bg-card">
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={cn(
                    "text-muted-foreground",
                    col.align && alignClass[col.align],
                    col.headerClassName,
                  )}
                >
                  {col.sortable && onSort ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col)}
                      aria-label={`مرتب‌سازی بر اساس ${typeof col.header === "string" ? col.header : "این ستون"}`}
                      className="inline-flex items-center gap-1 rounded font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {col.header}
                      {sortKey === col.key ? (
                        sortDir === "asc" ? (
                          <ChevronUpIcon
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        ) : (
                          <ChevronDownIcon
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        )
                      ) : (
                        <ChevronsUpDownIcon
                          className="size-3.5 opacity-40"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              ))}
              {hasActionsCell ? (
                <TableHead className="w-10" aria-label="عملیات" />
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(onRowClick && "cursor-pointer")}
              >
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={cn(
                      col.align && alignClass[col.align],
                      col.className,
                    )}
                  >
                    {col.cell(row)}
                  </TableCell>
                ))}
                {hasActionsCell ? (
                  <TableCell
                    className="text-end"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-end gap-1">
                      {onRowClick ? (
                        <DetailsButton
                          label={detailsLabel}
                          onClick={() => onRowClick(row)}
                        />
                      ) : null}
                      {rowActions ? rowActions(row) : null}
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-2 md:hidden">
        {data.map((row) => (
          <div
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn(
              "rounded-xl bg-card p-3 ring-1 ring-foreground/10",
              onRowClick && "cursor-pointer transition-colors hover:bg-muted/40",
            )}
          >
            {/* The card itself is not interactive; the details control and the
                row actions are sibling buttons so no interactive roles nest. */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                {mobileTitle ? (
                  <div className="font-medium text-foreground">
                    {mobileTitle(row)}
                  </div>
                ) : null}
                {mobileColumns.map((col) => {
                  // When there's an explicit mobileTitle, show every column as a labelled row.
                  // Otherwise the first column IS the title (rendered above via cell fallback).
                  if (!mobileTitle && col.key === columns[0].key) {
                    return (
                      <div
                        key={col.key}
                        className="font-medium text-foreground"
                      >
                        {(col.mobileCell ?? col.cell)(row)}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={col.key}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="shrink-0 text-muted-foreground">
                        {col.header}
                      </span>
                      <span className="min-w-0 text-end text-foreground">
                        {(col.mobileCell ?? col.cell)(row)}
                      </span>
                    </div>
                  );
                })}
              </div>
              {hasActionsCell ? (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="flex shrink-0 items-center gap-1"
                >
                  {onRowClick ? (
                    <DetailsButton
                      label={detailsLabel}
                      onClick={() => onRowClick(row)}
                    />
                  ) : null}
                  {rowActions ? rowActions(row) : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The keyboard-reachable detail control for a clickable row. Mouse users can
 * still click the row; keyboard and screen-reader users get a named button
 * instead of an unreachable `onClick` on a `<tr>`.
 */
function DetailsButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <ChevronLeftIcon className="size-4" aria-hidden="true" />
    </Button>
  );
}
