"use client";

import {
  BarChart,
  LineChart,
  NumberCard,
  PieChart,
  type ChartDatum,
} from "../charts";
import { toPersianDigits } from "@/lib/digits";
import { ReportTable } from "./report-table";
import type { ChartType } from "./report-ui";

/**
 * How a measure is written out.
 *
 * A report's value column was always printed as a bare grouped number, which
 * is wrong for the 43 metrics that are Rial: a business displaying «تومان» read
 * its sales ten times too high, with no unit anywhere on the card to reveal it.
 * Callers that know the measure is money pass their `useMoney().format`; the
 * default keeps counts, minutes and quantities as plain numbers.
 */
export type ValueFormatter = (value: number) => string;

const formatPlain: ValueFormatter = (value) => toPersianDigits(Math.round(value).toLocaleString("en-US"));

export function ChartPreview({
  chartType,
  data,
  label,
  formatValue = formatPlain,
}: {
  chartType: ChartType;
  data: ChartDatum[];
  label: string;
  formatValue?: ValueFormatter;
}) {
  if (chartType === "number") {
    const total = data.reduce((sum, datum) => sum + datum.value, 0);
    return <NumberCard label={label} value={formatValue(total)} />;
  }
  return <figure aria-label={label}>
    {chartType === "line" ? <LineChart data={data} height={260} formatValue={formatValue} /> :
      chartType === "pie" ? <PieChart data={data} height={260} formatValue={formatValue} /> :
      <BarChart data={data} height={260} formatValue={formatValue} />}
  </figure>;
}

/**
 * A built report's rows: one dimension, one measure.
 *
 * This was a hand-rolled table plus a hand-rolled card list — the same pair
 * `ReportTable` now owns — so it is a thin declaration over that instead. It
 * expects to sit inside a `flush` SectionCard, which supplies the card edges
 * this used to draw for itself.
 */
export function DataTable({
  columns,
  data,
  formatValue = formatPlain,
}: {
  columns: [string, string];
  data: ChartDatum[];
  formatValue?: ValueFormatter;
}) {
  return (
    <ReportTable
      caption="داده‌های گزارش"
      rows={data}
      rowKey={(_, index) => String(index)}
      cardTitle={(datum) => datum.label}
      columns={[
        { key: "label", header: columns[0], cell: (datum) => datum.label },
        {
          key: "value",
          header: columns[1],
          align: "end",
          numeric: true,
          cell: (datum) => formatValue(datum.value),
        },
      ]}
    />
  );
}
