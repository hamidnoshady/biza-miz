"use client";

/**
 * Scannable mobile record card list (`MobileRecordList`) for phone viewports
 * (issue #884).
 *
 * Renders a semantic `<ul>` of compact cards where each record shows its primary
 * title, optional subtitle, status badge, primary metric/amount, key-value
 * metadata pairs, and a tap/action footer.
 */
import type { ReactNode } from "react";

export interface MobileRecordField {
  label: string;
  value: ReactNode;
}

export interface MobileRecordItem {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  amount?: ReactNode;
  fields?: MobileRecordField[];
  actions?: ReactNode;
  onSelect?: () => void;
}

export interface MobileRecordListProps {
  items: MobileRecordItem[];
  emptyMessage?: string;
  className?: string;
}

export function MobileRecordList({
  items,
  emptyMessage = "موردی یافت نشد.",
  className = "",
}: MobileRecordListProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <ul className={`space-y-2.5 ${className}`.trim()}>
      {items.map((item) => (
        <li
          key={item.id}
          className="rounded-xl border border-border bg-card p-3.5 transition hover:border-amber-500/40 dark:hover:border-amber-400/40"
        >
          <div
            role={item.onSelect ? "button" : undefined}
            tabIndex={item.onSelect ? 0 : undefined}
            onClick={item.onSelect}
            onKeyDown={
              item.onSelect
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      item.onSelect?.();
                    }
                  }
                : undefined
            }
            className={item.onSelect ? "cursor-pointer outline-none" : undefined}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-foreground">{item.title}</div>
                {item.subtitle ? (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{item.subtitle}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {item.badge}
                {item.amount ? (
                  <div className="text-sm font-bold tabular-nums text-foreground">{item.amount}</div>
                ) : null}
              </div>
            </div>

            {item.fields && item.fields.length > 0 ? (
              <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-border/60 pt-2.5 text-xs">
                {item.fields.map((field, index) => (
                  <div key={`${item.id}-f-${index}`} className="flex items-baseline justify-between gap-1.5">
                    <dt className="truncate text-muted-foreground">{field.label}</dt>
                    <dd className=" truncate font-medium text-foreground">{field.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>

          {item.actions ? (
            <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 pt-2.5">
              {item.actions}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
