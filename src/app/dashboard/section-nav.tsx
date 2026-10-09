"use client";

/**
 * The in-page menu, on a phone as well as on a desktop.
 *
 * Every screen that is really several screens behind one route — تنظیمات,
 * حسابداری, انبار, گزارش‌ها, اتصال‌ها, the industry managers — used to render
 * its whole menu *and* the section under it on one mobile page. Two problems
 * came out of that at once: the menu is a tall scroller of its own, so it ate
 * the page's vertical scroll and covered the phone with nothing but a list of
 * links; and the section it controlled started below the fold, so the answer to
 * "why can I only see the menu?" was "the content is down there, somewhere".
 *
 * So a phone gets what the sidebar already gives it — one level at a time. The
 * menu is the page; picking an entry replaces it with that section under a
 * «بازگشت» arrow that returns to the list. From `md` up nothing changes: the
 * strip (or the rail) and its panel sit side by side exactly as before.
 *
 * The drill-down is a CSS switch over one boolean, not a `matchMedia` read, so
 * the server's markup and the first client paint agree and a desktop layout
 * never flashes on a phone. `open` only ever means something below `md`.
 */

import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TabBar, TabPanel, cardClass, type Tab } from "./page-chrome";

/** A menu entry: a `TabBar` tab that may also carry a line of help and an icon. */
export interface Section<K extends string> extends Tab<K> {
  description?: string;
  icon?: LucideIcon;
}

/** Optional headings over the entries, in the order they should appear. */
export interface SectionGroup<K extends string> {
  label: string;
  keys: readonly K[];
}

interface SectionNavProps<K extends string> {
  /** Prefixes the button and panel ids, so two menus can coexist on a page. */
  idPrefix: string;
  /** Names the menu for a screen reader, and labels the mobile back button. */
  label: string;
  /** Heading over the mobile list / the desktop rail. Defaults to `label`. */
  title?: ReactNode;
  description?: ReactNode;
  sections: readonly Section<K>[];
  groups?: readonly SectionGroup<K>[];
  active: K;
  onChange: (key: K) => void;
  /**
   * `strip` — the shared pill strip above the panel from `md` up (the default,
   * and what every `TabBar` screen had). `rail` — a sticky menu card beside the
   * panel from `lg` up, for menus too long to read as pills (تنظیمات, حسابداری).
   */
  variant?: "strip" | "rail";
  /** Controlled drill-down, for a screen that deep-links straight into a section. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}

export function SectionNav<K extends string>({
  idPrefix,
  label,
  title,
  description,
  sections,
  groups,
  active,
  onChange,
  variant = "strip",
  open: openProp,
  onOpenChange,
  className,
  children,
}: SectionNavProps<K>) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const listHeadingId = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openProp],
  );

  // Whichever half of the drill-down just appeared starts at its own top: a
  // phone that opened a section three screens down the menu would otherwise
  // land in the middle of it. `main` is the dashboard's scroller, not the
  // document, so scroll the anchor rather than the window.
  const focusTop = useCallback(() => {
    rootRef.current?.scrollIntoView({ block: "start" });
  }, []);

  const openSection = useCallback(
    (key: K) => {
      onChange(key);
      setOpen(true);
      focusTop();
    },
    [focusTop, onChange, setOpen],
  );

  const back = useCallback(() => {
    setOpen(false);
    focusTop();
  }, [focusTop, setOpen]);

  const { byKey, rendered } = useMemo(() => {
    const mappedByKey = new Map(
      sections.map((section) => [section.key, section]),
    );

    const mappedRendered: ReadonlyArray<{
      label: string | null;
      items: Section<K>[];
    }> = groups
      ? groups
          .map((group) => ({
            label: group.label,
            items: group.keys
              .map((key) => mappedByKey.get(key))
              .filter((item): item is Section<K> => Boolean(item)),
          }))
          .filter((group) => group.items.length > 0)
      : [{ label: null, items: [...sections] }];

    return {
      byKey: mappedByKey,

      rendered: mappedRendered,
    };
  }, [sections, groups]);
  const activeSection = byKey.get(active);

  // The rail owns the tab ids because it renders no `TabBar`; in the strip
  // variant the strip owns them and the mobile list only points at the panel,
  // so one id never lands on two elements.
  const listOwnsIds = variant === "rail";

  // Where the drill-down gives way to the side-by-side layout. The strip turns
  // into pills at `md`; the rail only has room for a 280px column at `lg`, so
  // below that a tablet gets the phone's one-level-at-a-time treatment too
  // rather than a screenful of menu with the section under it. Written out as
  // whole class names because Tailwind reads them literally.
  const bp =
    variant === "rail"
      ? { hide: "hidden lg:block", only: "lg:hidden", show: "hidden lg:block" }
      : { hide: "hidden md:block", only: "md:hidden", show: "hidden md:block" };

  const list = (
    <nav
      aria-labelledby={listHeadingId}
      className={cn(
        "overflow-hidden",
        cardClass,
        variant === "strip" && "md:hidden",
      )}
    >
      <div className="border-b border-border/80 px-5 py-4">
        <h2 id={listHeadingId} className="text-base font-bold text-foreground">
          {title ?? label}
        </h2>
        {description ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="p-2 lg:max-h-[calc(100dvh-190px)] lg:overflow-y-auto">
        {rendered.map((group, index) => (
          <div key={group.label ?? index} className="mb-3 last:mb-0">
            {group.label ? (
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
                {group.label}
              </p>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = active === item.key;
                return (
                  <button
                    key={item.key}
                    id={listOwnsIds ? `${idPrefix}-tab-${item.key}` : undefined}
                    type="button"
                    aria-controls={`${idPrefix}-tabpanel`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => openSection(item.key)}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-right text-sm transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40",
                      isActive
                        ? "bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {Icon ? (
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          "size-[18px] shrink-0",
                          isActive
                            ? "text-amber-800 dark:text-amber-300"
                            : "text-muted-foreground",
                        )}
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                    {isActive && listOwnsIds ? (
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full bg-amber-700 dark:bg-amber-400",
                          bp.show,
                        )}
                        aria-hidden="true"
                      />
                    ) : null}
                    <ChevronLeftIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground",
                        bp.only,
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );

  return (
    <div
      ref={rootRef}
      className={cn(
        "min-w-0 scroll-mt-3",
        variant === "rail"
          ? "flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-6"
          : "space-y-4 sm:space-y-5",
        className,
      )}
    >
      <div
        className={cn(
          // Below the breakpoint the menu *is* the page until a section opens.
          open && bp.hide,
          variant === "rail" &&
            "w-full shrink-0 lg:sticky lg:top-5 lg:w-[280px]",
        )}
      >
        {variant === "strip" ? (
          <TabBar
            idPrefix={idPrefix}
            label={label}
            tabs={sections}
            active={active}
            onChange={onChange}
            className="hidden md:block"
          />
        ) : null}
        {list}
      </div>

      <div
        className={cn(
          "min-w-0 flex-1 space-y-4 sm:space-y-5",
          !open && bp.hide,
        )}
      >
        <button
          type="button"
          onClick={back}
          className={cn(
            "flex min-h-11 w-full items-center gap-2 rounded-xl border border-border/80 bg-card px-3 text-sm font-semibold text-foreground/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40",
            bp.only,
          )}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-right">
            {activeSection?.label ?? label}
          </span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            بازگشت
          </span>
        </button>

        <TabPanel idPrefix={idPrefix} active={active}>
          {children}
        </TabPanel>
      </div>
    </div>
  );
}
