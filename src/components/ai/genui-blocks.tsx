"use client";

/**
 * Issue #1140 §A4 — draws the assistant's controlled report blocks.
 *
 * Only the three registered block types exist here, and the input is parsed
 * again with `parseGenUiBlocks` before anything is drawn, so a payload that
 * does not pass the allowlist renders nothing. Money arrives as integer Rial
 * and is shown through `useMoney()` in the business's chosen unit; values are
 * text nodes, never markup.
 */
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber } from "@/lib/digits";
import { parseGenUiBlocks, type GenUiBlock, type GenUiValueKind } from "@/lib/ai-genui";
import { cn } from "@/lib/utils";

const frame = "rounded-xl border border-border bg-card shadow-[0_1px_2px_rgb(41_37_36/0.035)]";

function useCell() {
  const money = useMoney();
  return (kind: GenUiValueKind, value: number | string): string => {
    if (typeof value === "string") return value;
    return kind === "money" ? money.format(value) : formatPersianNumber(value);
  };
}

function Block({ block }: { block: GenUiBlock }) {
  const cell = useCell();
  if (block.type === "kpi_row") {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {block.items.map((item, index) => (
          <div key={`${item.label}-${index}`} className={cn(frame, "px-3 py-2")}>
            <p className="text-[11px] text-muted-foreground">{item.label}</p>
            <p className={cn("mt-0.5 break-words text-sm font-semibold tabular-nums", item.tone === "warn" && "text-destructive")}>
              {cell(item.kind, item.value)}
            </p>
          </div>
        ))}
      </div>
    );
  }
  if (block.type === "table") {
    return (
      <section className={cn(frame, "overflow-hidden")}>
        <h4 className="border-b border-border px-3 py-2 text-xs font-semibold">{block.title}</h4>
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-max text-xs">
            <thead>
              <tr className="text-muted-foreground">
                {block.columns.map((column) => (
                  <th key={column.key} scope="col" className="px-3 py-1.5 text-start font-medium">{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-t border-border/60">
                  {block.columns.map((column) => (
                    <td key={column.key} className={cn("px-3 py-1.5", column.kind !== "text" && "tabular-nums")}>
                      {cell(column.kind, row[column.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }
  const peak = Math.max(1, ...block.items.map((item) => Math.abs(item.value)));
  return (
    <section className={cn(frame, "px-3 py-2")}>
      <h4 className="mb-2 text-xs font-semibold">{block.title}</h4>
      <ul className="space-y-2">
        {block.items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span>{item.label}</span>
              <span className="tabular-nums">{cell(block.kind, item.value)}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-muted" aria-hidden="true">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((Math.abs(item.value) / peak) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GenUiBlocks({ blocks }: { blocks: unknown }) {
  const safe = parseGenUiBlocks(blocks);
  if (!safe.length) return null;
  return (
    <div className="flex w-full min-w-0 flex-col gap-2" data-genui>
      {safe.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
