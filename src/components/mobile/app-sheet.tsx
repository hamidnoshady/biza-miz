"use client";

/**
 * Mobile bottom-sheet primitive (`AppSheet`) for the Android TWA and mobile web
 * experience (issue #884).
 *
 * Uses the canonical Radix Dialog (`@/components/ui/dialog`) anchored to the
 * bottom of the viewport on mobile (`sm:max-w-lg` centered on larger screens),
 * with safe-area bottom inset padding, a drag handle indicator, keyboard-aware
 * scrollable content, and an optional docked action footer.
 */
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface AppSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AppSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: AppSheetProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-auto bottom-0 max-h-[88dvh] w-full max-w-full translate-y-0 gap-0 overflow-hidden rounded-t-2xl rounded-b-none border-t border-border bg-card p-0 sm:top-[50%] sm:bottom-auto sm:max-w-lg sm:translate-y-[-50%] sm:rounded-2xl">
        <div className="flex justify-center pt-2.5 pb-1 sm:hidden" aria-hidden="true">
          <span className="h-1.5 w-10 rounded-full bg-muted-foreground/25" />
        </div>
        <DialogHeader className="border-b border-border/60 px-4 py-3 text-start">
          <DialogTitle className="text-base font-semibold text-foreground">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-xs text-muted-foreground">
              {description}
            </DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>
        <div className="max-h-[65dvh] overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <div className="border-t border-border/60 bg-muted/40 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : (
          <div className="pb-[env(safe-area-inset-bottom)]" aria-hidden="true" />
        )}
      </DialogContent>
    </Dialog>
  );
}
