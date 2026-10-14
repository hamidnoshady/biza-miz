"use client";
import { useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";
import { ReportTable } from "./report-table";
/** A bounded result, paged for readability; never recalculates the chart's result set. */
export function PagedReportTable<Row>(props: ComponentProps<typeof ReportTable<Row>>) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(props.rows.length / 50));
  const current = Math.min(page, pages - 1);
  return <>
    <ReportTable {...props} rows={props.rows.slice(current * 50, (current + 1) * 50)} />
    {pages > 1 && <div className="flex items-center justify-between gap-3 p-3">
      <Button variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)}>قبلی</Button>
      <span>{formatPersianNumber(current + 1)} / {formatPersianNumber(pages)}</span>
      <Button variant="outline" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>بعدی</Button>
    </div>}
  </>;
}
