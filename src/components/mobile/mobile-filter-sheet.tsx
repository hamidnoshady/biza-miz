"use client";

/**
 * Mobile filter and sort bottom sheet (`MobileFilterSheet`) for list and report
 * screens on phone viewports (issue #884).
 */
import { useState, type ReactNode } from "react";
import { SlidersHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { AppSheet } from "./app-sheet";

export interface MobileFilterSheetProps {
  title?: string;
  activeCount?: number;
  onReset?: () => void;
  children: ReactNode;
}

export function MobileFilterSheet({
  title = "فیلتر و مرتب‌سازی",
  activeCount = 0,
  onReset,
  children,
}: MobileFilterSheetProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="min-h-10 gap-1.5"
      >
        <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
        <span>{title}</span>
        {activeCount > 0 ? (
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/60 px-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
            {toPersianDigits(String(activeCount))}
          </span>
        ) : null}
      </Button>

      <AppSheet
        open={open}
        onOpenChange={setOpen}
        title={title}
        footer={
          <div className="flex items-center gap-2">
            {onReset ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 flex-1"
                onClick={() => {
                  onReset();
                  setOpen(false);
                }}
              >
                پاک کردن فیلترها
              </Button>
            ) : null}
            <Button
              type="button"
              className="min-h-11 flex-1"
              onClick={() => setOpen(false)}
            >
              اعمال و بستن
            </Button>
          </div>
        }
      >
        <div className="space-y-4">{children}</div>
      </AppSheet>
    </>
  );
}
