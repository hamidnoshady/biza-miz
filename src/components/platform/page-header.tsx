import * as React from "react";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The console's one page header. Every section renders this so the title,
 * description, breadcrumb and action area line up identically — the single
 * visual anchor that makes 16 sections feel like one product (section 4).
 */
export interface Breadcrumb {
  label: string;
  href?: string;
}

export function PlatformPageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: Breadcrumb[];
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 border-b border-border pb-4", className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <PlatformBreadcrumbs items={breadcrumbs} className="mb-2" />
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

/** RTL breadcrumbs: the separator points inline-start («‹») for right-to-left. */
export function PlatformBreadcrumbs({
  items,
  className,
}: {
  items: Breadcrumb[];
  className?: string;
}) {
  return (
    <nav
      aria-label="مسیر"
      className={cn(
        "flex flex-wrap items-center gap-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={`${item.label}-${i}`}>
            {item.href && !last ? (
              <Link
                href={item.href}
                className="rounded transition-colors hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50"
              >
                {item.label}
              </Link>
            ) : (
              <span
                aria-current={last ? "page" : undefined}
                className={last ? "text-foreground" : undefined}
              >
                {item.label}
              </span>
            )}
            {!last ? (
              <ChevronLeftIcon
                className="size-3.5 shrink-0 opacity-50"
                aria-hidden="true"
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/**
 * A lighter header for a card/section inside a page — a heading, optional
 * description, and a right-aligned action slot (a filter, an "add" button…).
 */
export function PlatformSectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-3 flex flex-wrap items-start justify-between gap-2",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/** The console's max content width + centering, applied once per page. */
export function PlatformPageContainer({
  children,
  className,
  width = "default",
}: {
  children: React.ReactNode;
  className?: string;
  width?: "default" | "wide" | "full";
}) {
  const max = { default: "max-w-6xl", wide: "max-w-7xl", full: "max-w-none" }[
    width
  ];
  return <div className={cn("mx-auto w-full", max, className)}>{children}</div>;
}
