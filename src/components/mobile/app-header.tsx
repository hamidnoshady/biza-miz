"use client";

/**
 * Compact mobile top app bar (`MobileAppHeader`) for the Android TWA and phone
 * experience (issue #884).
 *
 * Provides:
 * - Current screen title and optional business/subtitle context
 * - Back button when inside nested detail/sub-routes
 * - Quick barcode/QR scanner trigger (`CameraBarcodeScanner`)
 * - Notification inbox entry point with unread count badge
 * - Optional contextual primary/overflow action slot
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ArrowRightIcon, BellIcon, QrCodeIcon, SearchIcon } from "lucide-react";
import { CameraBarcodeScanner } from "@/components/scanner/camera-barcode-scanner";
import { toPersianDigits } from "@/lib/digits";

export interface MobileAppHeaderProps {
  title: string;
  subtitle?: string | null;
  backHref?: string | null;
  unreadNotifications?: number;
  notificationHref?: string;
  onScanCode?: (code: string) => void;
  onSearchClick?: () => void;
  actions?: ReactNode;
}

export function MobileAppHeader({
  title,
  subtitle,
  backHref,
  unreadNotifications = 0,
  notificationHref = "/settings/notifications",
  onScanCode,
  onSearchClick,
  actions,
}: MobileAppHeaderProps) {
  const router = useRouter();
  const [scannerOpen, setScannerOpen] = useState(false);

  function handleBack() {
    if (backHref) {
      router.push(backHref);
    } else {
      router.back();
    }
  }

  return (
    <header className="sticky top-0 z-20 flex min-h-14 items-center justify-between gap-2 border-b border-border/75 bg-card/95 px-3 py-2 backdrop-blur-md lg:hidden">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {backHref !== undefined && backHref !== null ? (
          <button
            type="button"
            onClick={handleBack}
            aria-label="بازگشت"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-secondary/70 text-foreground transition hover:bg-muted"
          >
            <ArrowRightIcon className="size-4" aria-hidden="true" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
          {subtitle ? (
            <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {onSearchClick ? (
          <button
            type="button"
            onClick={onSearchClick}
            aria-label="جستجو"
            className="inline-flex size-10 items-center justify-center rounded-xl border border-border/70 bg-secondary/70 text-foreground transition hover:bg-muted"
          >
            <SearchIcon className="size-4" aria-hidden="true" />
          </button>
        ) : null}

        {onScanCode ? (
          <>
            <button
              type="button"
              onClick={() => setScannerOpen(true)}
              aria-label="اسکن بارکد یا QR"
              className="inline-flex size-10 items-center justify-center rounded-xl border border-border/70 bg-secondary/70 text-foreground transition hover:bg-muted"
            >
              <QrCodeIcon className="size-4" aria-hidden="true" />
            </button>
            <CameraBarcodeScanner
              open={scannerOpen}
              onClose={() => setScannerOpen(false)}
              onScan={(code) => {
                setScannerOpen(false);
                onScanCode(code);
              }}
            />
          </>
        ) : null}

        <Link
          href={notificationHref}
          aria-label="اعلان‌ها"
          className="relative inline-flex size-10 items-center justify-center rounded-xl border border-border/70 bg-secondary/70 text-foreground transition hover:bg-muted"
        >
          <BellIcon className="size-4" aria-hidden="true" />
          {unreadNotifications > 0 ? (
            <span className="absolute -top-1 -start-1 inline-flex min-w-4 items-center justify-center rounded-full bg-amber-600 dark:bg-amber-500 px-1 text-[10px] font-bold text-white dark:text-stone-950">
              {toPersianDigits(unreadNotifications > 99 ? "99+" : String(unreadNotifications))}
            </span>
          ) : null}
        </Link>

        {actions}
      </div>
    </header>
  );
}
