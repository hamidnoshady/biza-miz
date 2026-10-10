"use client";

import { useEffect, type RefObject } from "react";

/**
 * Close a hand-rolled overlay on Escape.
 *
 * The ledger's panels (statement, history, voucher, installment, edit-account)
 * are plain fixed-position `<section role="dialog" aria-modal="true">` elements
 * rather than the shadcn `<Dialog>` the cheques register uses, and they only
 * ever closed on a backdrop click or the «بستن» button. A dialog that ignores
 * Escape is a keyboard trap for anyone not using a mouse, and it is the one
 * behaviour every reader already expects from `aria-modal="true"`.
 *
 * Deliberately only the key: OverlayDialog composes Radix FocusScope for
 * focus containment/restoration rather than duplicating that behavior here.
 */
export function useOverlayEscape(onClose: () => void, enabled = true, panel?: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      // A floating layer above this panel — a Radix popover (SearchableSelect)
      // — handles its own Escape and marks the event `defaultPrevented`; Radix
      // never stops propagation, so without this check the panel underneath
      // closed with it: one press, two layers gone.
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      if (panel) {
        // A statement can open an entry above it. Older window listeners run
        // first, so propagation alone cannot protect the parent. Busy top
        // layers also consume Escape rather than dismissing anything below.
        const layers = document.querySelectorAll("[data-ledger-dialog]");
        if (layers[layers.length - 1] !== panel.current) return;
        event.preventDefault();
      }
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onClose, panel]);
}
