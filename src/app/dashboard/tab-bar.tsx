"use client";

/**
 * `TabBar`/`TabPanel` live in their own client module, split out of
 * `page-chrome.tsx`, because they are the only pieces of that shared file
 * that need a React hook (`useRef`, for the tab strip's roving focus) — and
 * `page-chrome.tsx` itself is imported from Server Components (e.g.
 * `src/app/loading.tsx`) that must stay hook-free. `page-chrome.tsx`
 * re-exports both so every existing `import { TabBar, TabPanel } from
 * "../page-chrome"` keeps working unchanged.
 */
import type { ReactNode } from "react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { radioMoveForKey, radioTargetIndex } from "@/lib/radio-keys";
import { cardClass } from "./page-chrome-styles";

export interface Tab<K extends string> {
  key: K;
  label: string;
}

/**
 * The dashboard's tab strip: a card of pills, two per row on a phone and a
 * single wrapping row from `sm` up, 52px tall because these are pressed on
 * tablets at a counter. A real `role="tablist"`: one roving Tab stop and
 * Left/Right/Home/End move it (WAI-ARIA authoring practices), the same
 * contract — and the same shared `radio-keys.ts` helper — a `role="radiogroup"`
 * promises. This used to be a row of `aria-pressed` toggle buttons in a
 * `<nav>`, which is a different widget than a tab strip: no roving tabindex,
 * no arrow keys, and a screen reader announced it as a navigation landmark of
 * toggle buttons rather than as tabs with one of them selected.
 */
export function TabBar<K extends string>({
  idPrefix,
  label,
  tabs,
  active,
  onChange,
  className,
}: {
  /** Prefixes the button and panel ids, so two strips can coexist on a page. */
  idPrefix: string;
  label: string;
  tabs: readonly Tab<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(cardClass, "p-2", className)}
    >
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {tabs.map((tab, index) => {
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              ref={(node) => {
                buttonsRef.current[index] = node;
              }}
              id={`${idPrefix}-tab-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              aria-controls={`${idPrefix}-tabpanel`}
              onClick={() => onChange(tab.key)}
              onKeyDown={(event) => {
                const move = radioMoveForKey(event.key, true);
                const target = move && radioTargetIndex(move, index, tabs.length);
                if (target === null || target === undefined) return;
                event.preventDefault();
                onChange(tabs[target].key);
                buttonsRef.current[target]?.focus();
              }}
              className={cn(
                "min-h-[52px] rounded-xl border px-3 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 sm:px-4",
                isActive
                  ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200 shadow-[0_1px_2px_rgb(120_53_15/0.08)]"
                  : "border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The region a `TabBar` controls. Separate from `TabBar` so a manager can put
 * an error box or a warning banner between the strip and the panel.
 */
export function TabPanel<K extends string>({
  idPrefix,
  active,
  children,
}: {
  idPrefix: string;
  active: K;
  children: ReactNode;
}) {
  return (
    <div
      id={`${idPrefix}-tabpanel`}
      role="tabpanel"
      tabIndex={0}
      aria-labelledby={`${idPrefix}-tab-${active}`}
      className="min-w-0 outline-none"
    >
      {children}
    </div>
  );
}
