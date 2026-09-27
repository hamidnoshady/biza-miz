/**
 * The chrome every dashboard page is built from.
 *
 * The dashboard's look was set by the newest screens (Phase 25/27/29 —
 *`inventory`,`jewelry`,`watch`,`accessories`,`cosmetics`): a warm stone
 * canvas, one 1600px column, an underlined page header, amber-accented tab
 * pills tall enough for a touch screen, and`rounded-2xl` section cards. Every
 * page written before that language settled had its own header spacing, its own
 * tab style and its own card border, so moving between two screens of the same
 * product looked like moving between two products.
 *
 * These components are that language, in one place. A page composes them
 * instead of re-deriving the classes — so a change to the shared look is one
 * edit, and a new page cannot drift by accident. See docs/ui-conventions.md.
 *
 * Deliberately not a client component: a page shell is markup, and every server
 * page can import it directly. `TabBar`/`TabPanel` are the one piece that
 * needs interactivity (a roving-focus tab strip), so they live in their own
 * `"use client"` module, `tab-bar.tsx` — re-exported below so this file stays
 * the single import path every caller already uses.
 */
import type { ComponentType, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { cardClass, overlayPanelClass, popoverPanelClass } from "./page-chrome-styles";
import { TabBar, TabPanel } from "./tab-bar";
import type { Tab } from "./tab-bar";

// Re-exported so existing imports (`import { cardClass } from "../page-chrome"`,
// `import { TabBar, TabPanel } from "../page-chrome"`) keep working — see
// `page-chrome-styles.ts` and `tab-bar.tsx` for why these moved out.
export { cardClass, overlayPanelClass, popoverPanelClass, TabBar, TabPanel };
export type { Tab };


/**
 * The one-column page canvas. Wraps every dashboard page so a wide monitor
 * doesn't stretch a table to 3000px while a laptop shows the same page snug.
 */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1600px]", className)}>{children}</div>;
}

/**
 * A page's title, one line of what the page is for, and optional actions on the
 * far side. The rule underneath separates the header from the page's content
 * without needing a card around it.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Page-level controls (a date range, an export button) — rendered opposite the title. */
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border/80 pb-5 sm:mb-6 sm:pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-[1.7rem]">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
 );
}

/**
 * A titled surface. Two shapes, one component: pass`flush` for a card whose
 * body is an edge-to-edge list or table (the divider lines reach the card's
 * edges), otherwise the body gets the standard padding.
 *
 * The`<section>` takes its accessible name from a string`title`, which makes
 * it a landmark a screen reader can jump to without the caller inventing an id.
 */
export function SectionCard({
  title,
  description,
  actions,
  footer,
  children,
  flush,
  className,
  bodyClassName,
  actionsClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Controls belonging to this card — rendered opposite its title. */
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** The body is a list/table that should reach the card's edges. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  /**
   * Tuning for the actions strip (same escape hatch as `className`/`bodyClassName`).
   * Toolbars with a search box + a couple of controls pass `max-sm:w-full` so
   * they take their own full-width row under the title on phones instead of
   * squeezing beside it.
   */
  actionsClassName?: string;
}) {
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      className={cn("min-w-0 overflow-hidden", cardClass, className)}
    >
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
          <div className="min-w-0">
            {typeof title === "string" || typeof title === "number" ? (
              <h2 className="font-semibold text-foreground">{title}</h2>
            ) : (
              // Several cards need an eyebrow plus a larger heading. Do not
              // wrap that ReactNode in another <h2>: doing so creates invalid
              // nested headings and causes the browser to repair the markup
              // differently across desktop and mobile. The caller owns the
              // heading in this branch.
              <div className="font-semibold text-foreground">{title}</div>
            )}
            {description ? (
              // A <div>, not a <p>: descriptions are often a plain string, but
              // SectionCardSkeleton hands over block-level <Skeleton> bars and a
              // <div> inside a <p> is invalid HTML — the parser hoists it out,
              // the server/client trees disagree and React throws the whole
              // section tree away as a hydration failure.
              <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div>
            ) : null}
          </div>
          {actions ? (
            // The strip used to be `shrink-0`: sized to its widest content, it
            // crossed the edge on narrow screens and the card's overflow-hidden
            // clipped whatever stuck out (the leftmost button went off-screen).
            // min-w-0 lets it give way and wrap gracefully instead — same look
            // whenever there *is* room, never off-screen when there isn't.
            <div className={cn("flex min-w-0 flex-wrap items-center gap-2", actionsClassName)}>{actions}</div>
          ) : null}
        </div>
      ) : null}
      {children ? (
        <div className={cn(flush ? "min-w-0" : "min-w-0 p-4 sm:p-5", bodyClassName)}>{children}</div>
      ) : null}
      {footer ? (
        <div className="border-t border-border/80 bg-muted/60 px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/**
 * What a page shows where a list would be, before anything has been created.
 *
 * Two shapes, one component, because the reference screens use both:
 *
 * - **the quiet line** (`<EmptyState>متنی…</EmptyState>`) — a dashed rule with
 *   one sentence, for an empty sub-list inside a card that already has a title
 *   explaining what is missing. This is the original shape and the one 130-odd
 *   existing callers use, so it stays the default.
 * - **the rich state** (`title` given) — the Orders screenshot's amber icon
 *   chip over a bold title over a muted explanatory line, optionally with an
 *   action under it. This is what a *page's* main region shows when it has
 *   nothing, and before this prop it was hand-rolled in at least four files
 *   with four slightly different icon chips.
 *
 * `icon` is decorative: the title carries the meaning, so the chip is
 * `aria-hidden` and the region announces only the text.
 *
 * Both shapes render a `<div>`, never a `<p>`: callers routinely centre a small
 * stack inside the quiet shape (icon, line, button), and a `<div>` inside a
 * `<p>` is invalid HTML that browsers re-flow unpredictably.
 */
export function EmptyState({
  children,
  icon: Icon,
  title,
  action,
  className,
}: {
  /** The explanatory line. With `title`, renders as the muted paragraph under it. */
  children?: ReactNode;
  /** A Lucide icon for the amber chip. Only used with `title`. */
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** Promotes the state to the rich, centred shape from the reference screens. */
  title?: ReactNode;
  /** A recovery action — «پاک‌کردن فیلترها», «تلاش دوباره». */
  action?: ReactNode;
  className?: string;
}) {
  if (!title) {
    return (
      <div
        className={cn(
          "rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-64 flex-col items-center justify-center p-6 text-center",
        className,
      )}
    >
      {Icon ? (
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
        >
          <Icon className="size-5" aria-hidden="true" />
        </span>
      ) : null}
      <p className={cn("text-sm font-bold text-foreground", Icon && "mt-4")}>{title}</p>
      {children ? (
        <p className="mt-2 max-w-72 text-xs leading-6 text-muted-foreground">{children}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * A KPI tile — the stat cards that head the overview screens.
 *
 * Five files had grown their own `StatCard`/`KpiCard` with the same three
 * lines (muted label, big number, muted hint) and slightly different sizes;
 * `KpiRowSkeleton` already reserved the shape for all of them, so the loading
 * state was shared while the loaded state was not. This is the loaded state.
 *
 * The number is `tabular-nums` so a row of tiles doesn't jitter as figures
 * refresh, and truncates rather than wrapping — a long Rial total must not make
 * one tile taller than its neighbours.
 */
export function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  /** Optional amber icon chip, as the dashboard overview uses. */
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 p-4 sm:p-5", cardClass, className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-xs font-medium leading-5 text-muted-foreground">{label}</p>
        {Icon ? (
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      {/*
        `truncate` on a long Rial figure hides the digits that matter, so the
        full value stays reachable as the element's own title. Only when the
        value is a plain string — a ReactNode has no sensible title text.
      */}
      <p
        title={typeof value === "string" ? value : undefined}
        className="mt-2 truncate text-xl font-bold tracking-tight tabular-nums text-foreground sm:text-2xl"
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * The grid KPI tiles sit in — the shape `KpiRowSkeleton` reserves, so the
 * skeleton and the loaded row cannot drift apart.
 */
export function KpiRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>{children}</div>
  );
}

/**
 * A content-shaped placeholder for data that is still being read.
 *
 * Keep the loading state visually stable: rows have the same density as the
 * lists and tables they replace, the animation is inherited from the shared
 * Skeleton primitive, and the global reduced-motion rule disables its pulse.
 * The spoken label means assistive technology receives useful progress while
 * the decorative bars stay out of its accessibility tree.
 */
export function LoadingSkeleton({
  rows = 4,
  label = "در حال بارگذاری اطلاعات",
  className,
  compact = false,
}: {
  rows?: number;
  label?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={cn("min-w-0 space-y-3", className)}
    >
      <div aria-hidden="true" className="space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className={cn(
              "flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/60",
              compact ? "min-h-10 px-3 py-2" : "min-h-14 px-4 py-3",
            )}
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className={cn("h-3.5", index % 3 === 0 ? "w-2/5" : "w-3/5")} />
              {!compact ? <Skeleton className="h-3 w-4/5" /> : null}
            </div>
            <Skeleton className={cn("shrink-0", compact ? "h-5 w-12" : "h-7 w-16", "rounded-full")} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A complete card placeholder, used while a client-rendered section hydrates its data. */
export function SectionCardSkeleton({
  rows = 4,
  label,
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <SectionCard
      className={className}
      title={<Skeleton aria-hidden="true" className="h-5 w-36" />}
      description={<Skeleton aria-hidden="true" className="h-3 w-56 max-w-full" />}
    >
      <LoadingSkeleton rows={rows} label={label} />
    </SectionCard>
 );
}

/**
 * The KPI stat row while its numbers are still being read — the element-level
 * counterpart of`LoadingSkeleton`, for the stat cards that sit above a page's
 * lists. Reserves the exact grid and card shape so a loading page and a loaded
 * one keep the same height.
 */
export function KpiRowSkeleton({
  count = 4,
  label = "در حال بارگذاری نشانگرها",
  className,
  standalone = true,
}: {
  count?: number;
  label?: string;
  className?: string;
  /**
   * Announce itself to assistive tech (its own loading region). Pass false when
  * it is composed inside a larger`role="status"` fallback such as
  *`DashboardPageSkeleton`, so the region is not announced twice.
   */
  standalone?: boolean;
}) {
  return (
    <div
      role={standalone ? "status" : undefined}
      aria-live={standalone ? "polite" : undefined}
      aria-busy={standalone ? "true" : undefined}
      aria-label={standalone ? label : undefined}
      className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} aria-hidden="true" className={cn(cardClass, "space-y-3 p-4 sm:p-5")}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-3 w-36 max-w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Route-level dashboard fallback. It mirrors the shared header, KPI cards and
 * primary table so navigation never produces a blank canvas or a misleading
 * empty state while a server page is resolving.
 */
export function DashboardPageSkeleton() {
  return (
    <PageShell>
      <div role="status" aria-live="polite" aria-busy="true" aria-label="در حال بارگذاری صفحه">
        <header className="mb-5 flex items-start justify-between gap-3 border-b border-border/80 pb-5 sm:mb-6 sm:pb-6">
          <div aria-hidden="true" className="min-w-0 flex-1 space-y-3">
            <Skeleton className="h-8 w-48 max-w-2/3" />
            <Skeleton className="h-4 w-[32rem] max-w-full" />
          </div>
          <Skeleton aria-hidden="true" className="h-10 w-24 shrink-0 rounded-lg" />
        </header>
        <div aria-hidden="true" className="mb-5">
          <KpiRowSkeleton standalone={false} />
        </div>
        <SectionCardSkeleton rows={5} label="در حال بارگذاری محتوای صفحه" />
      </div>
    </PageShell>
  );
}

/**
 * A state pill, in the shape and the four tones the Phase 25/27 screens
 * established — amber for "in progress", green for "done", stone for "no longer
 * relevant", red for "needs attention" — so a status reads the same everywhere.
 */
export function StatusBadge({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: "active" | "positive" | "neutral" | "danger";
  /**
   * The leading dot the report headers use («متوازن» on the trial balance).
   * Same tone as the text, so it needs no colour of its own.
   */
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        dot && "gap-1.5",
        tone === "active" && "bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200",
        tone === "positive" && "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-900 dark:text-emerald-100",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "danger" && "bg-destructive/10 text-destructive",
      )}
    >
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/**
 * The amber eyebrow over a card title — the small category line («گزارش مالی»,
 * «انبارها», «عملیات هزینه») the reference cards open with. Three characters of
 * meaning in a class string that was being retyped in a dozen files.
 */
export function CardEyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">{children}</p>;
}

/**
 * The eyebrow + heading pair a `SectionCard` takes as its `title`.
 *
 * `CardEyebrow` already owned the amber line, but the *pair* — eyebrow over an
 * `<h2>` — was still being hand-written, and the two halves drifted: some cards
 * spelled the heading `text-base sm:text-lg`, others `text-base … sm:text-lg`
 * with the responsive step in a different position, and the Growth dashboard
 * kept a private `CardTitle` helper with `text-stone-950 dark:text-stone-100`
 * where every neighbour used the `text-foreground` token. Composing this means
 * a card title cannot be styled two ways again.
 */
export function CardTitle({ eyebrow, title }: { eyebrow: ReactNode; title: ReactNode }) {
  return (
    <div className="min-w-0">
      <CardEyebrow>{eyebrow}</CardEyebrow>
      <h2 className="mt-1 text-base font-semibold text-foreground sm:text-lg">{title}</h2>
    </div>
  );
}
