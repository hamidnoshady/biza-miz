"use client";

/**
 * Filter chrome — the row of chips and the search field the reference screens
 * put directly under a page header.
 *
 * The Orders screenshot is the canonical one: a full-width search field with a
 * leading magnifier, then a wrapping row of chips where the selected chip is
 * amber-filled and the rest are quiet outlines. The Inventory screenshot shows
 * the same chip row inline beside a search field, and Accounting's lists use
 * the chips alone.
 *
 * Every one of those screens previously wrote the chip's ~340 characters of
 * Tailwind by hand, once per chip, which is how three different focus rings and
 * two different active fills ended up in the product. `FilterChip` is that
 * spelling, once. `aria-pressed` (not `role="tab"`) because a chip toggles a
 * filter; the list under it is a plain region, not a tabpanel.
 */

import { EraserIcon, SearchIcon, XIcon, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { inputClass } from "./ui";

/**
 * One filter chip. Amber fill when selected — amber is selection everywhere in
 * this language — and a quiet outline otherwise.
 *
 * `dense` is the POS/operational height (44px, thumb-sized). The default is the
 * ordinary page height (40px), which is what CRM, Growth and Website
 * Management should use: the POS's denser chrome is an approved variation of
 * this system, not a target for regular pages to imitate.
 */
export function FilterChip({
  children,
  selected,
  onClick,
  dense = false,
  className,
  ...rest
}: {
  children: ReactNode;
  selected: boolean;
  onClick: () => void;
  dense?: boolean;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className" | "children">) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-xl border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40",
        dense ? "min-h-11 font-bold" : "min-h-10",
        selected
          ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
          : "border-border/80 bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The row chips sit in. Scrolls horizontally on a phone rather than wrapping
 * into a three-line block that pushes the list below the fold — which is what
 * the Orders screen does.
 */
export function FilterChipRow({
  label,
  children,
  className,
}: {
  /** Names the group for a screen reader («فیلتر وضعیت سفارش»). */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      data-tour-id="page.filters"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {children}
    </div>
  );
}

/**
 * The search field with its leading magnifier and optional clear button.
 *
 * The icon is positioned with logical properties (`start-3`), so it sits on the
 * right in this RTL product and would flip correctly if the app were ever run
 * LTR. The clear button only renders when there is something to clear.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  id,
  className,
  onClear,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Accessible name. Required — a bare search box announces only "edit text". */
  label: string;
  id?: string;
  className?: string;
  /** Shows a clear button. Defaults to clearing through `onChange("")`. */
  onClear?: () => void;
}) {
  const clear = onClear ?? (() => onChange(""));
  return (
    <div data-tour-id="page.filters" className={cn("relative min-w-0", className)}>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
      />
      <input
        id={id}
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn(inputClass, "ps-9", value ? "pe-9" : "")}
      />
      {value ? (
        <button
          type="button"
          onClick={clear}
          aria-label="پاک‌کردن جستجو"
          className="absolute inset-y-0 end-2 my-auto flex size-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The compact filter toolbar — one row of icon buttons for a phone.
 *
 * The problem it solves: a filter panel that is comfortable on a desktop
 * (a full-width search field, a wrapping chip row, three labelled selects) is
 * four stacked blocks on a 360px phone. On the orders screen that pushed the
 * actual list most of a screen down, and «پاک‌کردن فیلترها» — the way out of a
 * filter someone set by accident — ended up below the fold entirely.
 *
 * So on a phone each filter collapses to a single icon-sized target in one
 * non-wrapping row, and the control itself opens in a sheet underneath it. The
 * icon is the affordance, the amber ring and the value badge are the state, and
 * everything the desktop layout shows is still reachable in one tap. From `sm:`
 * up the toolbar is not rendered at all and the ordinary panel takes over —
 * this is a *phone* dialect, not a replacement.
 *
 * Three rules it keeps, all of them things the stacked version got wrong:
 *
 *   * **Active state is visible without opening anything.** A filter holding a
 *     value gets the amber selected treatment plus its value as a badge, so
 *     «چرا این لیست خالی است؟» is answerable from the toolbar.
 *   * **Every filter clears from where it is set** (a «حذف» inside its own
 *     sheet) and all of them clear together (the eraser at the end of the row,
 *     which only exists when something is set).
 *   * **It cannot overflow.** The row scrolls horizontally with the scrollbar
 *     hidden and each target is a fixed 44px square, so more filters make a
 *     longer scroll rather than a second line or a clipped page.
 */
export function FilterToolbar({
  children,
  onClearAll,
  className,
}: {
  children: ReactNode;
  /** Clears every filter at once. The button appears only when this is given. */
  onClearAll?: () => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="فیلترهای فهرست"
      className={cn(
        "-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {children}
      {onClearAll ? (
        <button
          type="button"
          onClick={onClearAll}
          aria-label="پاک‌کردن همهٔ فیلترها"
          className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-amber-200 bg-amber-100 text-amber-950 transition-colors hover:bg-amber-200/70 focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
        >
          <EraserIcon aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * One filter in {@link FilterToolbar}: an icon button that opens its control in
 * a bottom sheet.
 *
 * `value` is what the filter currently holds, in words — it becomes the badge
 * on the button, part of its accessible name («فیلتر میز: میز ۴»), and the
 * presence of it is what makes the button read as active. Passing `undefined`
 * means "not filtering", which is the resting state.
 *
 * The control itself is whatever the caller renders inside; this owns only the
 * button, the sheet, the title and the per-filter clear. That keeps the filter
 * *logic* where it already lives — one `useState` per filter in the screen — so
 * opening the toolbar cannot lose a selection, a sibling filter or the list's
 * scroll position, none of which it touches.
 */
export function FilterToolbarButton({
  icon: Icon,
  label,
  value,
  onClear,
  children,
}: {
  icon: LucideIcon;
  /** What this filter is, for the sheet's title and the accessible name. */
  label: string;
  /** What it currently holds, in words. Undefined when it is not filtering. */
  value?: string;
  /** Resets this one filter. Rendered inside the sheet when the filter is set. */
  onClear?: () => void;
  /** The control — a chip row, a select, a date picker. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const active = Boolean(value);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={active ? `${label}: ${value}` : label}
          className={cn(
            "flex h-11 min-w-11 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40",
            active
              ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
              : "border-border/80 bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {active ? (
            <span className="max-w-24 truncate text-xs font-bold">{value}</span>
          ) : null}
        </button>
      </SheetTrigger>
      {/*
        A bottom sheet, not a dropdown: it is reachable by a thumb, it cannot
        be clipped by the toolbar's own horizontal scroller, and it keeps the
        list behind it in place. The safe-area padding is what stops the clear
        button sitting under a home indicator.
      */}
      <SheetContent
        side="bottom"
        className="max-h-[70dvh] gap-3 overflow-y-auto rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pb-0">
          <SheetTitle className="text-sm">{label}</SheetTitle>
        </SheetHeader>
        <div className="px-4">{children}</div>
        {active && onClear ? (
          <div className="px-4">
            <button
              type="button"
              onClick={() => {
                onClear();
                setOpen(false);
              }}
              className="min-h-11 w-full rounded-xl border border-border/80 text-sm font-bold text-amber-700 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:text-amber-300"
            >
              حذف این فیلتر
            </button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The search filter's toolbar slot: an icon that expands into a full-width
 * field in the row itself rather than opening a sheet.
 *
 * Search is the one filter where a sheet would be wrong — typing wants to see
 * the list filtering underneath — so it expands in place and collapses again
 * when it is empty and loses focus.
 */
export function FilterToolbarSearch({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const open = expanded || value.length > 0;
  return open ? (
    <div className="relative flex min-w-40 flex-1 items-center">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
      />
      <input
        type="search"
        autoFocus
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => setExpanded(false)}
        className={cn(inputClass, "h-11 ps-9", value ? "pe-9" : "")}
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            setExpanded(false);
          }}
          aria-label="پاک‌کردن جستجو"
          className="absolute inset-y-0 end-2 my-auto flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setExpanded(true)}
      aria-label={label}
      aria-expanded={false}
      className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/80 bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40"
    >
      <SearchIcon aria-hidden="true" className="size-4" />
    </button>
  );
}
