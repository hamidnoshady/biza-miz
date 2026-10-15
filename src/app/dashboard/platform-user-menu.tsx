"use client";

/**
 * The sidebar footer's identity control — the member's name, and the drop-up
 * behind it.
 *
 * The menu it replaces was hand-rolled: an `absolute bottom-full z-50` panel
 * rendered inside the sidebar's own footer. That is fine in isolation and
 * wrong in place, because the footer sits inside the sidebar's scroll
 * container and, on a phone, inside the drawer's sheet — both of which clip
 * their overflow and both of which create their own stacking context, so a
 * `z-50` inside them cannot rise above anything outside them. The result was a
 * menu that opened (its `aria-expanded` flipped, the chevron turned) while
 * being visually cut off at the sidebar's edge, or hidden behind the page.
 *
 * A portal is the fix, so the panel is a child of `<body>` rather than of the
 * thing clipping it. Everything else the menu needed — Escape, outside click,
 * `aria-haspopup`, roving focus over `role="menuitem"` children, focus
 * returning to the trigger on close, positioning that flips when there is no
 * room above — is exactly what the app's Radix dropdown primitive already
 * gives every other menu in the product, so the menu now uses it instead of a
 * second, worse implementation of the same thing.
 *
 * Two behaviours are added on top:
 *
 *  - **close on route change.** Radix closes on item *select*, but not when the
 *    route changes some other way (the browser's back button, a redirect from
 *    the page underneath). Watching the pathname covers all of them.
 *  - **collapsed rail.** At 4rem there is no room for a name, so the trigger
 *    becomes the avatar button — and it must still open the menu rather than
 *    only widening the rail, since sign-out lives in here.
 *
 * RTL is also deliberate here rather than inherited-by-accident. Nothing wraps
 * the app in Radix's `DirectionProvider`, so the popper and its arrow-key
 * logic would compute logical alignment as LTR out of the box; `dir="rtl"` on
 * the root puts them on the document's real direction, and the portaled
 * content restates it so the panel renders as right-reading Persian even if
 * it is ever mounted where the document's `<html dir>` is not inherited.
 *
 * The entries themselves come from `platform-user-menu.ts`, framework-free and
 * unit-tested, so what the menu *contains* is checkable without mounting any
 * of this.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDownIcon, UserRoundIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBugReport } from "@/components/bug-report/bug-report-provider";
import { useNative } from "@/components/native/native-provider";
import { triggerNativeBackgroundSync } from "@/lib/native/capabilities-client";
import { platformUserMenuItems } from "@/lib/platform-user-menu";
import { clearRememberedLoginDoor } from "@/lib/login-door";
import { roleLabel } from "@/lib/role-labels";

const ITEM_CLASS =
  "min-h-10 cursor-pointer rounded-lg px-3 text-sm focus:bg-muted focus-visible:bg-muted";

export function PlatformUserMenu({
  role,
  fullName,
  /** The collapsed rail's icon-only trigger; the expanded rail shows the name. */
  compact = false,
}: {
  role: string;
  fullName: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const { openReport } = useBugReport();
  const { connection, request } = useNative();
  const label = roleLabel(role);
  const items = platformUserMenuItems(role);

  // A route change with the menu still open leaves it hanging over the new
  // page. Item clicks close it themselves; this covers the back button and any
  // navigation the page underneath starts.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  async function logout(returnTo: string) {
    if (signingOut) return;
    setSigningOut(true);
    try {
      if (connection === "connected") {
        await triggerNativeBackgroundSync(request, {
          action: "clear_all",
          businessId: null,
        });
      }
      await fetch("/api/auth/logout", { method: "POST" });
      router.push(returnTo);
      router.refresh();
    } catch {
      // Offline: the session cookie is still local, so let them try again
      // rather than stranding them on a dead button.
      setSigningOut(false);
    }
  }

  /**
   * "Switch account": the same sign-out, but forgets this browser's
   * remembered login door first, so `/login` shows the chooser again instead
   * of jumping straight back into whichever door this device had settled on.
   */
  async function switchAccount() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      clearRememberedLoginDoor();
      if (connection === "connected") {
        await triggerNativeBackgroundSync(request, {
          action: "clear_all",
          businessId: null,
        });
      }
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch {
      setSigningOut(false);
    }
  }

  return (
    <DropdownMenu dir="rtl" open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label={`${fullName} — ${label} — منوی حساب کاربری`}
            title={`${fullName} — ${label}`}
            className="flex size-9 items-center justify-center rounded-full border border-border bg-muted/60 text-xs font-bold text-foreground transition-colors hover:border-amber-300/70 hover:bg-amber-50 hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/15 dark:hover:text-amber-300 dark:focus-visible:ring-amber-400/45"
          >
            <UserRoundIcon aria-hidden="true" className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-xl border border-border/80 bg-background px-3 py-2.5 text-start transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50"
          >
            <span className="min-w-0">
              <span className="block truncate font-semibold text-foreground">{fullName}</span>
              <span className="block text-xs text-muted-foreground">{label}</span>
            </span>
            <ChevronDownIcon
              aria-hidden="true"
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </DropdownMenuTrigger>

      {/*
        `side="top"` is the drop-*up* the footer wants; Radix flips it to the
        bottom by itself when the trigger is too close to the top of the
        viewport, which is what a short mobile drawer does. The width follows
        the trigger in the expanded rail and needs a floor of its own next to
        the 36px avatar.

        `align="start"` is the RTL-correct choice, and it only means anything
        because the root above carries `dir="rtl"`: with the rail on the
        physical right edge of the viewport, logical start IS the physical
        right, so the panel's right edge sits flush with the rail and the menu
        opens leftward into the screen — nothing hangs past the right edge of
        the viewport. Kept blindly as `align="end"`, the same geometry would
        pin the panel's physical-left edge instead and could project it past
        the right side on a narrow screen. The restated `dir` on the portaled
        content is the half of this that the popper logic does not already
        get from the root.
      */}
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        dir="rtl"
        className="min-w-56 p-1.5 text-right"
        aria-label="منوی حساب کاربری"
      >
        {items.map((item) => {
          if (item.kind === "link") {
            return (
              <DropdownMenuItem key={item.key} asChild className={ITEM_CLASS}>
                <Link href={item.href}>{item.label}</Link>
              </DropdownMenuItem>
            );
          }
          if (item.kind === "bug-report") {
            return (
              <DropdownMenuItem
                key={item.key}
                className={ITEM_CLASS}
                // A dialog, not a route: the report captures the page the
                // member is standing on, so navigating away would lose it.
                onSelect={() => openReport()}
              >
                {item.label}
              </DropdownMenuItem>
            );
          }
          if (item.kind === "switch-account") {
            return (
              <DropdownMenuItem
                key={item.key}
                className={ITEM_CLASS}
                disabled={signingOut}
                onSelect={() => void switchAccount()}
              >
                {signingOut ? "در حال خروج…" : item.label}
              </DropdownMenuItem>
            );
          }
          return (
            <div key={item.key}>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={ITEM_CLASS}
                disabled={signingOut}
                onSelect={() => void logout(item.returnTo)}
              >
                {signingOut ? "در حال خروج…" : item.label}
              </DropdownMenuItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
