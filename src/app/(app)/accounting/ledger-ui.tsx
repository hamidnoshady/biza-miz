"use client";

/**
 * The pieces every ledger section repeats — extracted so they are written once.
 *
 * The accounting app grew screen by screen, and three shapes ended up
 * hand-rolled again and again, one copy per file:
 *
 *  - the **failed-load card** («تلاش دوباره» over a destructive wash) — A/R,
 *    A/P and the statement panels each had their own;
 *  - the **ISO-or-dash Jalali date** (`fmtJalali`) — «دریافت و پرداخت» and
 *    «اقساط» each carried a private copy of the same three lines;
 *  - the **fixed-position overlay** — backdrop, `<section role="dialog"
 *    aria-modal>`, click-to-close, Escape-to-close — spelled out in ten files,
 *    which is how one of them ended up closing on Escape *while its POST was
 *    still in flight* and another forgot the busy guard entirely.
 *
 * They live together here because they are used together: a ledger overlay
 * almost always shows a Jalali date and can fail to load. `OverlayDialog`
 * keeps the ledger's panel styling while composing Radix FocusScope for
 * initial focus, Tab containment and restoration. Portals avoid ancestor
 * clipping; inactive content is hidden from assistive technology. Nested scopes
 * pause their parent; Escape dismisses only the top ledger layer.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FocusScope } from "@radix-ui/react-focus-scope";
import { Portal } from "radix-ui";
import { hideOthers } from "aria-hidden";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { SecondaryButton } from "@/app/dashboard/ui";
import { useOverlayEscape } from "./use-overlay-escape";

/**
 * «تلاش دوباره» for a failed load. A failed request is not an empty list —
 * saying «هیچ حسابی وجود ندارد» claims knowledge nobody has, and an error
 * banner alone leaves the retry to a refresh.
 */
export function LedgerLoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-6 text-center">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      <div className="mt-3 flex justify-center">
        <SecondaryButton onClick={onRetry}>تلاش دوباره</SecondaryButton>
      </div>
    </div>
  );
}

/**
 * `formatJalali`, not a second hand-rolled conversion — the repo keeps one
 * Shamsi formatter so two screens cannot disagree about a date. The date-only
 * slice keeps a `timestamptz` from shifting the day for anyone west of UTC,
 * and a missing date answers «—» rather than crashing or lying.
 */
export function fmtJalali(iso: string | null): string {
  if (!iso) return "—";
  return toPersianDigits(formatJalali(iso.slice(0, 10)));
}

/**
 * The ledger's hand-rolled overlay: a fixed backdrop, a panel that names
 * itself to assistive tech, Escape and backdrop to close.
 *
 * `dismissible={false}` is the state every dialog is in while its POST is in
 * flight: neither Escape nor the backdrop may dismiss it then, or the request
 * still lands while the refresh that should reflect it never runs. Panels that
 * never submit anything leave it at the default.
 *
 * `sheet` is the taller variant the two full-height ledger forms use: no
 * backdrop padding on phones, so the panel hugs the bottom edge like the
 * platform's sheets do, centred again from `sm:` up.
 *
 * The caller owns the panel's own classes (width, max-height, scroll) and
 * composes `overlayPanelClass` into `className` itself — this component owns
 * only what every one of those overlays spelled identically.
 */
export function OverlayDialog({
  headingId,
  describedById,
  onClose,
  dismissible = true,
  sheet = false,
  role = "dialog",
  className,
  children,
}: {
  /** The id of the heading that names the panel — `aria-labelledby`. */
  headingId: string;
  /** The id of the description paragraph — `aria-describedby`, for alertdialogs. */
  describedById?: string;
  onClose: () => void;
  /** False while a submit is in flight: Escape and the backdrop must not dismiss then. */
  dismissible?: boolean;
  /** The bottom-sheet padding the two tall ledger forms use on phones. */
  sheet?: boolean;
  role?: "dialog" | "alertdialog";
  /** The panel's own classes — compose `overlayPanelClass` here. */
  className?: string;
  children: ReactNode;
}) {
  const requestClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);
  const panelRef = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const attachPanel = useCallback((node: HTMLElement | null) => {
    panelRef.current = node;
    setPanel(node);
  }, []);
  useEffect(() => panel ? hideOthers(panel) : undefined, [panel]);
  useOverlayEscape(requestClose, true, panelRef);

  return (
    <Portal.Root asChild>
      <div
        className={`fixed inset-0 z-50 flex items-end justify-center bg-black/40 ${
          sheet ? "p-0 sm:items-center sm:p-4" : "p-3 sm:items-center sm:p-4"
        }`}
        onClick={requestClose}
      >
        <FocusScope asChild trapped loop>
          <section
            ref={attachPanel}
            data-ledger-dialog=""
            tabIndex={-1}
            role={role}
            aria-modal="true"
            aria-labelledby={headingId}
            aria-describedby={describedById}
            className={className}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </section>
        </FocusScope>
      </div>
    </Portal.Root>
  );
}
