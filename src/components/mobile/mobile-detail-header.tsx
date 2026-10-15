"use client";

/**
 * Mobile detail header (`MobileDetailHeader`) for entity detail screens
 * (orders, invoices, customers, products, inventory documents, purchases) on
 * phone viewports (issue #884).
 *
 * Replaces cramped multi-button desktop toolbars on phones with a clean header
 * card containing a back link, title, status badge, metadata chips, primary
 * action, and an overflow bottom sheet for secondary actions.
 */
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ArrowRightIcon, MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppSheet } from "./app-sheet";

export interface MobileSecondaryAction {
  key: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MobileDetailHeaderProps {
  title: string;
  subtitle?: string | null;
  backHref?: string;
  backLabel?: string;
  badge?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: MobileSecondaryAction[];
}

export function MobileDetailHeader({
  title,
  subtitle,
  backHref,
  backLabel = "بازگشت به فهرست",
  badge,
  primaryAction,
  secondaryActions = [],
}: MobileDetailHeaderProps) {
  const [actionsOpen, setActionsOpen] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-card p-3.5 sm:p-4">
      {backHref ? (
        <div className="mb-2">
          <Link
            href={backHref}
            className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
          >
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
            <span>{backLabel}</span>
          </Link>
        </div>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-bold text-foreground sm:text-lg">{title}</h1>
            {badge}
          </div>
          {subtitle ? (
            <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {primaryAction}
          {secondaryActions.length > 0 ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-10 px-2.5"
                aria-label="عملیات بیشتر"
                onClick={() => setActionsOpen(true)}
              >
                <MoreHorizontalIcon className="size-4" aria-hidden="true" />
              </Button>
              <AppSheet
                open={actionsOpen}
                onOpenChange={setActionsOpen}
                title="عملیات"
                description={title}
              >
                <div className="flex flex-col gap-1.5">
                  {secondaryActions.map((action) => (
                    <button
                      key={action.key}
                      type="button"
                      disabled={action.disabled}
                      onClick={() => {
                        setActionsOpen(false);
                        action.onSelect();
                      }}
                      className={`flex min-h-11 w-full items-center gap-2.5 rounded-xl border border-border/70 px-3.5 py-2.5 text-start text-sm font-medium transition disabled:opacity-50 ${
                        action.destructive
                          ? "bg-rose-50/70 text-rose-700 hover:bg-rose-100/70 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/50"
                          : "bg-secondary/60 text-foreground hover:bg-muted"
                      }`}
                    >
                      {action.icon}
                      <span className="flex-1">{action.label}</span>
                    </button>
                  ))}
                </div>
              </AppSheet>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
