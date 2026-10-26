"use client";

/**
 * Page navigation for the website managers' client-side lists (taxonomy
 * groups, and any list a manager keeps in memory). The server-backed lists
 * keep their own pagers because they also carry a page size in the URL; this
 * one is the small shared shape: «صفحهٔ x از y», previous/next, optional size.
 *
 * Previous sits at the inline-start edge, so in RTL it is the right-hand
 * button and the chevrons point the way the page numbers actually run.
 */
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

/** The slice of `items` that page `page` (1-based) shows; the page is clamped. */
export function pageSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const last = pageCount(items.length, pageSize);
  const safe = Math.min(Math.max(1, page), last);
  return items.slice((safe - 1) * pageSize, safe * pageSize);
}

export function ListPager({
  page,
  total,
  pageSize,
  pageSizeOptions,
  onPage,
  onPageSize,
  noun,
}: {
  page: number;
  total: number;
  pageSize: number;
  /** When given, a size select is shown beside the buttons. */
  pageSizeOptions?: readonly number[];
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  /** What is being counted, e.g. «گروه». */
  noun: string;
}) {
  const pages = pageCount(total, pageSize);
  const current = Math.min(Math.max(1, page), pages);
  // One short page and no size choice is not worth a control row.
  if (pages <= 1 && !pageSizeOptions) return null;
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);
  return (
    <nav aria-label={`صفحه‌بندی ${noun}`} className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span aria-live="polite">
        {toPersianDigits(from)}–{toPersianDigits(to)} از {toPersianDigits(total)} {noun} — صفحهٔ {toPersianDigits(current)} از{" "}
        {toPersianDigits(pages)}
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {pageSizeOptions && onPageSize ? (
          <label className="flex items-center gap-1">
            تعداد در صفحه
            <select
              className={`${inputClass} h-8 w-auto py-0.5 text-xs`}
              value={pageSize}
              onChange={(event) => onPageSize(Number(event.target.value))}
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {toPersianDigits(size)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button type="button" size="sm" variant="outline" disabled={current <= 1} onClick={() => onPage(current - 1)}>
          <ChevronRightIcon aria-hidden="true" className="size-4" />
          قبلی
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={current >= pages} onClick={() => onPage(current + 1)}>
          بعدی
          <ChevronLeftIcon aria-hidden="true" className="size-4" />
        </Button>
      </span>
    </nav>
  );
}
