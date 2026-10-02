"use client";

/**
 * Phase 14 — the persistent branch control in the dashboard shell.
 *
 * Fetches the caller's active branch and switchable set from
 * /api/locations/active (every member has an active branch, from a PIN
 * cashier fixed to one to an owner roaming all of them).
 *
 * Two things this control has to do, in this order:
 *
 *  1. **Say which branch you are in, without being read.** Every branch
 *     carries a colour (migration 0149) and the trigger wears it — tinted
 *     surface, matching dot. Branch names in the same business are frequently
 *     near-identical («ونک», «ونک ۲»), so a name alone is a control you have
 *     to *check*; a colour is one you notice. The cost of misreading is an
 *     order rung up, stock counted or a till opened against the wrong branch.
 *     Deliberately not the primary colour: the brand belongs to the business
 *     and does not change as you move around inside it.
 *  2. **Switch in one click.** A menu, not a combobox: the list is a business's
 *     branches, so it is short, and the previous searchable select made
 *     switching a click-then-read-then-click.
 *
 * It has three shapes — a menu, a static label, or nothing at all — and which
 * one it takes is decided by branchSwitcherMode(), where the reasoning and
 * its tests live. In short: a member who cannot switch but belongs to a
 * multi-branch business still needs telling which branch they are in, while a
 * single-branch business has no such question and gets no chip.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { branchColorStyle } from "@/lib/branch-color";
import { branchSwitcherMode } from "@/lib/branch-switcher-mode";

interface Branch {
  id: string;
  name: string;
  color: string;
}

interface ActiveResponse {
  active: Branch | null;
  locations: Branch[];
  canSwitch: boolean;
  /** Branches the business has, before this member's access narrows the list. */
  businessLocationCount?: number;
}

/**
 * Broadcast whenever the branch changes, so other copies of this control (the
 * rail and a page header can both be mounted) repaint together instead of one
 * of them keeping the old colour until its next mount.
 */
const BRANCH_CHANGED_EVENT = "branch-switcher:changed";

/**
 * The last answer, kept for the page's lifetime. The sidebar remounts whenever
 * navigation crosses a layout (`/accounting/*` ↔ `/settings`); without this it
 * flashed a placeholder each time and, on a one-branch business, then removed
 * it — every menu entry below jumped ~56px and a click landed on the wrong one.
 */
let lastKnown: ActiveResponse | null = null;

export function BranchSwitcher({
  compact = false,
  quietLoading = false,
}: {
  compact?: boolean;
  /** Render nothing (not a placeholder) until the first answer: for a slot above clickable rows. */
  quietLoading?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<ActiveResponse | null>(lastKnown);
  useEffect(() => {
    if (state) lastKnown = state;
  }, [state]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/locations/active");
        if (!res.ok || cancelled) {
          if (!cancelled) setState({ active: null, locations: [], canSwitch: false });
          return;
        }
        const data = (await res.json()) as ActiveResponse;
        if (!cancelled) setState(data);
      } catch {
        if (!cancelled) setState({ active: null, locations: [], canSwitch: false });
      }
    }

    void load();
    window.addEventListener(BRANCH_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(BRANCH_CHANGED_EVENT, load);
    };
  }, []);

  if (state === null) {
    if (quietLoading) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="در حال بارگذاری شعبه فعال"
        className={compact ? "" : "mb-3"}
      >
        <Skeleton aria-hidden="true" className={compact ? "h-11 w-40 rounded-xl" : "h-12 w-full rounded-lg"} />
      </div>
    );
  }
  if (!state.active) return null;

  const active = state.active;
  const activeStyle = branchColorStyle(active.color);

  async function switchTo(locationId: string) {
    if (locationId === active.id || busy) return;
    setBusy(true);
    const res = await fetch("/api/auth/switch-location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId }),
    });
    setBusy(false);
    if (res.ok) {
      window.dispatchEvent(new Event(BRANCH_CHANGED_EVENT));
      // Every scoped screen resolves its branch server-side per request, so a
      // full data refresh — not just local state — is what actually matters.
      router.refresh();
    }
  }

  // The colour is decoration; the branch name is the accessible answer, and it
  // is always present in the label rather than conveyed by colour alone.
  const triggerLabel = `شعبهٔ فعال: ${active.name}`;

  const surface = cn(
    "flex min-h-11 items-center gap-2 rounded-xl border text-sm font-semibold transition-colors",
    activeStyle.surface,
    // Compact lives in tight rows (the phone header, the POS and overview page
    // headers) where the name has to yield before the neighbouring controls
    // wrap. The dot never shrinks, so the branch stays identifiable even when
    // the name is down to a few characters.
    compact ? "w-auto max-w-32 px-2.5 sm:max-w-44 sm:px-3" : "w-full px-3",
  );

  // Which shape this control takes is a rule with its own tests — see
  // branch-switcher-mode.ts for why the member's reachable count is not
  // enough to decide it.
  const mode = branchSwitcherMode({
    canSwitch: state.canSwitch,
    businessLocationCount: state.businessLocationCount,
    accessibleCount: state.locations.length,
  });

  if (mode === "hidden") return null;

  if (mode === "label") {
    // A member fixed to one branch of a business that has several still needs
    // telling which one — they can be looking at North while the owner talks
    // about Main. It is a status, not a control: a menu whose only item is
    // where you already are is dead.
    return (
      <div className={compact ? "" : "mb-3"}>
        {!compact ? (
          <span className="mb-1 block text-xs text-muted-foreground">شعبهٔ فعال</span>
        ) : null}
        <div className={cn(surface, "cursor-default")} role="status" aria-label={triggerLabel}>
          <span className={cn("size-2.5 shrink-0 rounded-full", activeStyle.dot)} aria-hidden="true" />
          <span className="truncate">{active.name}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={compact ? "" : "mb-3"}>
      {!compact ? (
        <span className="mb-1 block text-xs text-muted-foreground">شعبهٔ فعال</span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          aria-label={triggerLabel}
          className={cn(
            surface,
            "outline-none hover:brightness-[0.97] focus-visible:ring-2 focus-visible:ring-offset-1 dark:hover:brightness-110",
            activeStyle.ring,
            busy && "opacity-60",
          )}
        >
          <span className={cn("size-2.5 shrink-0 rounded-full", activeStyle.dot)} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-start">{active.name}</span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-70" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuLabel className="text-xs text-muted-foreground">تغییر شعبه</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {state.locations.map((branch) => {
            const style = branchColorStyle(branch.color);
            const isActive = branch.id === active.id;
            return (
              <DropdownMenuItem
                key={branch.id}
                disabled={busy}
                onSelect={() => void switchTo(branch.id)}
                // min-h-11 because this is a primary touch target on a
                // floor terminal; the primitive's default row is sized for a
                // mouse-driven menu.
                className="min-h-11 gap-2 px-2"
              >
                <span className={cn("size-2.5 shrink-0 rounded-full", style.dot)} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                {isActive ? (
                  <CheckIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                ) : null}
                {isActive ? <span className="sr-only">(شعبهٔ فعلی)</span> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
