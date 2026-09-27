/**
 * The dashboard's surface tokens (card / overlay / popover skins), pulled out
 * of `page-chrome.tsx` into their own dependency-free module so `tab-bar.tsx`
 * (a `"use client"` file) and `page-chrome.tsx` (imported from Server
 * Components) can both import `cardClass` without an import cycle between
 * them. `page-chrome.tsx` re-exports all three so existing callers —
 * `import { cardClass } from "../page-chrome"` and friends — are unaffected.
 */

/**
 * The card skin — border, radius and the one-pixel warm shadow. `SectionCard`
 * is built from it; a surface whose *layout* is bespoke (a chat panel that
 * fills a fixed height, a canvas that scrolls) composes this instead of
 * restating the classes, so there is still exactly one definition of what a
 * card looks like.
 */
export const cardClass = "rounded-2xl border border-border/80 bg-card shadow-[0_1px_2px_rgb(41_37_36/0.035)]";

/**
 * The floating-panel skin — modals, statement panels, date-picker popovers:
 * the one surface allowed to sit *above* the page rather than on it, so it is
 * the one surface with more than a one-pixel shadow. Same warm ink as
 * `cardClass`, just deeper and softer, still on a 1px hairline. Compose it
 * (`className={`${overlayPanelClass} p-5`}`) instead of hand-rolling
 * `shadow-lg` — a modal that restates its elevation drifts from every other
 * dialog the moment one of them is tuned.
 */
export const overlayPanelClass =
  "rounded-2xl border border-border/80 bg-card shadow-[0_12px_32px_-6px_rgb(41_37_36/0.18)]";

/**
 * The dropdown-popover skin — the shadcn popover spelling (`rounded-lg`,
 * `border-border`, `bg-popover`, the one sanctioned `shadow-md`) stated once
 * so app-level popovers (the Jalali date picker, inline menus) match the ones
 * the shadcn layer renders. Compose it rather than restating it.
 */
export const popoverPanelClass = "rounded-lg border border-border bg-popover text-popover-foreground shadow-md";
