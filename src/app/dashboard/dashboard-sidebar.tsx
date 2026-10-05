"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";
import {
  CalendarDaysIcon,
  CalculatorIcon,
  CheckIcon,
  CircleIcon,
  ContactIcon,
  FolderIcon,
  GlobeIcon,
  LayoutGridIcon,
  SparklesIcon,
  TrendingUpIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import {
  BOTTOM_NAV_MAX,
  BOTTOM_NAV_STORAGE_KEY,
  parseBottomNavHrefs,
  resolveBottomNavHrefs,
  toggleBottomNavHref,
} from "@/lib/bottom-nav";
import type { Industry } from "@/lib/industries";
import {
  resolveSidebarMode,
  toggleDashboardSidebarPreference,
  type DashboardSidebarPreference,
} from "@/lib/sidebar-state";
import { isAssistantSurface } from "@/lib/assistant-route";
import {
  ACCOUNTING_WORKSPACE_HREFS,
  DASHBOARD_HOME,
  isWorkspacePathname,
  WORKSPACE_MODULE_HOME,
  workspaceSectionHref,
} from "@/lib/app-routes";
import { bestNavMatch, flattenNav } from "@/lib/nav-tree";
import { appForModule, resolveAccessibleAppLanding, type AppKey } from "@/lib/apps";
import type { AppAvailabilityState } from "@/lib/app-availability";
import { appShellForPathname, type AppShellDef } from "@/lib/app-shells";
import {
  WorkspaceAppNav,
  type WorkspaceSidebarSection,
} from "@/app/(app)/workspace/workspace-app-nav";
import { AppStateBadge } from "./app-availability-gate";
import { CreditBadge } from "./credit-badge";
import { NAV_ICONS } from "./sidebar-nav-icons";
import {
  APP_NAV_BUTTON_CLASS,
  NAV_LABEL_CLASS,
  SIDEBAR_FOOTER_BUTTON_CLASS,
} from "./sidebar-nav-styles";
import { appShellNavFor, type AppShellNavProps } from "./app-shell-nav";
import type { ModuleKey } from "@/lib/industry-profile";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { PIN_ROLES } from "@/lib/roles";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { BiometricSettingsButton } from "./biometric-settings";
import { BranchSwitcher } from "./branch-switcher";
import { LockButton } from "./lock-screen";
import { PlatformUserMenu } from "./platform-user-menu";
import { ShiftButton } from "./shift-panel";
import { DeploymentStatusIndicator } from "./deployment-status-indicator";
import type { DeploymentProfile } from "@/lib/deployment-mode";


const SIDEBAR_PREFERENCE_KEY = "dashboard-sidebar-preference";

/**
 * Resizable sidebar width. The rail starts at the same width the fixed shell
 * always used (w-64 = 16rem), and drag/arrow keys move it between the bounds;
 * the choice is remembered per device.
 */
const SIDEBAR_WIDTH_KEY = "dashboard-sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 460;
const SIDEBAR_KEYBOARD_STEP = 16;


/**
 * The apps the workspace rail launches, in rail order.
 *
 * A table rather than a block of markup per app: the rail is the front door to
 * every app in the platform, so adding one (the CRM, and whatever follows it)
 * should be an entry here, not another copy of a `SidebarMenuItem`.
 *
 * Route ownership and landing preference live in the canonical app registry.
 * Only routes the server already admitted to the member are considered, which
 * makes an app disappear when the member cannot reach any of its sections.
 *
 * Neither the assistant nor the technical-connections hub is a launcher: the
 * assistant IS the rail's home («دستیار هوشمند» above opens it), and
 * «اتصال‌های فنی» lives on the platform user menu, not beside the apps.
 */
const WORKSPACE_APP_LAUNCHERS: readonly {
  key: AppKey;
  label: string;
  icon: LucideIcon;
}[] = [
  {
    key: "accounting",
    label: "حسابداری",
    icon: CalculatorIcon,
  },
  {
    key: "crm",
    label: "ارتباط با مشتری",
    icon: ContactIcon,
  },
  {
    key: "growth",
    label: "رشد و بازاریابی",
    icon: TrendingUpIcon,
  },
  {
    key: "website",
    label: "مدیریت وب‌سایت",
    icon: GlobeIcon,
  },
];

export interface NavItem {
  label: string;
  /** The industry module that owns this entry (src/lib/industry-profile.ts); already filtered out of navItems for an industry that has no such module. */
  module: ModuleKey;
  href?: string;
  /**
   * Phase 42 — a collapsible group («محصولات») rather than a link: the button
   * discloses `children` beneath it. The `iconKey` names the NAV_ICONS entry
   * the group wears, since a group has no href of its own to derive one from.
   */
  children?: NavItem[];
  iconKey?: string;
  roles?: string[];
  /** Set when this page is gated by a Phase 17 feature flag; already filtered out of navItems if disabled and not lockable. */
  flag?: string;
  /**
   * The flag is off but the feature is lockable (features.ts's
   * LOCKABLE_FEATURES), so the entry stays in the nav and its page renders a
   * read-only preview. Server-computed; the padlock here only labels it.
   */
  locked?: boolean;
  /**
   * The state of the *app* this entry belongs to, when it is anything other
   * than plain «فعال» (migration 0128 / src/lib/app-availability.ts). Present
   * only for a badged state, so rendering is `appState ? <badge> : null`.
   * `usable: false` means the link goes to the explanation screen rather than
   * the app — the entry is deliberately still here, because "coming soon" is
   * news the business should have rather than an absence they should guess at.
   */
  appState?: { state: AppAvailabilityState; label: string; usable: boolean };
  /** Server-filtered against the member's effective permission set before reaching the client. */
  requiredAnyPermission?: Permission[];
  /** Every capability listed is required (for compound surfaces such as POS). */
  requiredAllPermissions?: Permission[];
}

interface SidebarProps {
  navItems: NavItem[];
  role: string;
  permissions: readonly string[];
  fullName: string;
  /** From the business's industry profile — a jewellery shop is not «کافه و رستوران». */
  brandTitle: string;
  brandSubtitle: string;
  /** The business's industry. */
  industry?: Industry;
  /** Permission-filtered contextual Workspace entries from the server shell. */
  workspaceSections: readonly WorkspaceSidebarSection[];
  deploymentProfile: DeploymentProfile;
  /** `businessId:memberId` — keys client caches so one member never sees another's. */
  account: string;
}

/**
 * Whether a nav href is the current location.
 *
 * A bare href (no `?`) is a section's home and is active on its whole path
 * prefix, the way the flat nav always behaved — so a group's parent link stays
 * lit on every one of its query-string tabs. A `?tab=` href is a *named* sub-
 * section: it matches only that tab (other query params, like a `party=` deep
 * link, are ignored so the «مشتریان» entry stays lit on one customer's file).
 */
function isActive(pathname: string, href: string, search?: ReadonlyURLSearchParams | null): boolean {
  // Platform and Workspace homes are exact destinations; a prefix match would
  // make Home active throughout another workspace.
  if (href === DASHBOARD_HOME || href === WORKSPACE_MODULE_HOME) return pathname === href;
  if (href === workspaceSectionHref("overview")) {
    return pathname === WORKSPACE_MODULE_HOME || pathname === href;
  }
  const q = href.indexOf("?");
  if (q >= 0) {
    const hrefPath = href.slice(0, q);
    if (pathname !== hrefPath) return false;
    const hrefTab = new URLSearchParams(href.slice(q + 1)).get("tab");
    return (search?.get("tab") ?? null) === hrefTab;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The workspace rail (Phase 35 Wave 2).
 *
 * This is the intentionally small global platform navigation: assistant home,
 * My Workspace, and exactly four business-app launchers. Shared utilities stay
 * in the user menu instead of becoming more rail rows. Clicking an app replaces
 * this launcher with that app's contextual navigation, so the rail never sits
 * beside a second full application menu.
 *
 * The rail carries NO chat navigation: starting a conversation is the chat
 * header's «گفت‌وگوی جدید» alone, and «گفتگوهای اخیر» is the chat page's own
 * left sidebar (search/rename/delete/continue) — see ai-chat-hub.tsx.
 */
function WorkspaceRail({ navItems, pathname }: { navItems: NavItem[]; pathname: string }) {
  // The four apps this rail launches, as data rather than four copies of the same
  // markup. The app registry resolves the best route from this server-filtered
  // tree, so the rail cannot accidentally turn "open Accounting" into
  // "may read the ledger".
  // An app's state («به‌زودی», «در حال تعمیر», …) travels on the nav entries the
  // layout already resolved — grouped here by *owning app*, so each launcher
  // wears its own app's badge, exactly what the flat sidebar shows for the
  // same app, rather than re-deriving it. Looking the state up by the
  // launcher's resolved href instead is what once badged «حسابداری» with the
  // old Sales state: now POS and the overview belong to Accounting.
  const stateByApp = new Map<AppKey, NonNullable<NavItem["appState"]>>();
  for (const item of navItems) {
    if (!item.appState) continue;
    const owner = appForModule(item.module);
    if (owner && !stateByApp.has(owner)) stateByApp.set(owner, item.appState);
  }
  const launchers = WORKSPACE_APP_LAUNCHERS.flatMap((launcher) => {
    const href = resolveAccessibleAppLanding(launcher.key, navItems);
    if (!href) return [];
    return [
      {
        ...launcher,
        href,
        active: isActive(pathname, href),
        appState: stateByApp.get(launcher.key),
      },
    ];
  });

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="میز کار" className="space-y-4">
        <SidebarMenu className="space-y-1.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname === DASHBOARD_HOME}
              tooltip="دستیار هوشمند"
              className={APP_NAV_BUTTON_CLASS}
            >
              <Link href={DASHBOARD_HOME} aria-current={pathname === DASHBOARD_HOME ? "page" : undefined}>
                <SparklesIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className={NAV_LABEL_CLASS}>دستیار هوشمند</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* Phase G — «پروژه‌ها» is the Projects SECTION of «میز کار من»
                now, so the rail's entry names the module and opens its
                overview. `/projects` still resolves (middleware forwards it),
                but nothing in the product links there any more. */}
            <SidebarMenuButton
              asChild
              isActive={isWorkspacePathname(pathname)}
              tooltip="میز کار من"
              className={APP_NAV_BUTTON_CLASS}
            >
              <Link href={WORKSPACE_MODULE_HOME}>
                <FolderIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className={NAV_LABEL_CLASS}>میز کار من</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {launchers.length > 0 ? (
          <div role="group" aria-labelledby="workspace-apps-heading">
            <p
              id="workspace-apps-heading"
              className="px-2 pb-1 text-xs font-medium text-muted-foreground group-data-[state=collapsed]/sidebar:hidden"
            >
              برنامه‌ها
            </p>
            {/* Collapsed to icons the heading is gone, so the apps would run
                into «میز کار من» as one undifferentiated column of glyphs. A
                hairline keeps the two groups apart at 4rem wide. */}
            <div
              aria-hidden="true"
              className="mx-2 mb-2 hidden border-t border-border/70 group-data-[state=collapsed]/sidebar:block"
            />
            <SidebarMenu className="space-y-1.5">
              {launchers.map((launcher) => {
                const Icon = launcher.icon;
                return (
                  <SidebarMenuItem key={launcher.key}>
                    <SidebarMenuButton
                      asChild
                      isActive={launcher.active}
                      tooltip={
                        launcher.appState ? `${launcher.label} — ${launcher.appState.label}` : launcher.label
                      }
                      className={APP_NAV_BUTTON_CLASS}
                    >
                      <Link href={launcher.href} aria-current={launcher.active ? "page" : undefined}>
                        <Icon aria-hidden="true" className="size-5 shrink-0" />
                        <span className={NAV_LABEL_CLASS}>{launcher.label}</span>
                        {launcher.appState ? (
                          <AppStateBadge
                            state={launcher.appState.state}
                            label={launcher.appState.label}
                            className="shrink-0 group-data-[state=collapsed]/sidebar:hidden"
                          />
                        ) : null}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </div>
        ) : null}

        {/* «اتصال‌های فنی» used to render here as a seventh rail row. It is a
            shell utility, not an app, and its door is the platform user menu
            (the footer menu lists it beside حقوق اشتراک و تنظیمات کسب‌وکار);
            the row is gone rather than a second door to the same hub. */}

        {/* Chat history no longer lives here: «گفتگوهای اخیر» is the chat
            page's own left sidebar (search, rename, delete, continue), and
            creating a conversation stays in the chat header alone — the rail
            keeps only the assistant's home, the workspace and the apps, so it
            carries no second chat navigation. */}
      </nav>
    </SidebarContent>
  );
}

function SidebarBrand({ title, subtitle, account }: { title: string; subtitle: string; account: string }) {
  return (
    <SidebarHeader className="border-border/80 bg-card p-4 group-data-[state=collapsed]/sidebar:px-2">
      {/*
        Two layouts, not one squeezed layout. Expanded: the business name and
        its trade beside the controls. Collapsed: a single centred column, so
        the credit pill and the reopen control stack instead of fighting over
        4rem of width — the old row centred the whole flex line and the trigger
        drifted off the rail's centre.
      */}
      <div className="flex items-start justify-between gap-2 group-data-[state=collapsed]/sidebar:flex-col group-data-[state=collapsed]/sidebar:items-center group-data-[state=collapsed]/sidebar:gap-2">
        <div className="min-w-0 group-data-[state=collapsed]/sidebar:hidden">
          <p className="truncate font-bold text-foreground" title={title}>
            {title}
          </p>
          <p className="truncate text-xs text-muted-foreground" title={subtitle}>
            {subtitle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 group-data-[state=collapsed]/sidebar:flex-col">
          <span className="hidden md:block group-data-[state=collapsed]/sidebar:hidden"><CreditBadge /></span>
          <span className="hidden group-data-[state=collapsed]/sidebar:md:block"><CreditBadge compact /></span>
          {/* The theme switch used to vanish with the labels; it is an icon
              button already, so there is no reason it cannot stay on the rail. */}
          <span className="hidden md:block"><ThemeToggle /></span>
          <SidebarTrigger className="hidden text-muted-foreground md:inline-flex" />
        </div>
      </div>
      {/*
        The branch control sits here, directly under the business name, rather
        than at the bottom of the rail where it used to live among the
        sign-out/lock/shift buttons. Which branch you are working in is
        context for everything on screen — the same class of information as
        *which business* — not an account action, and at the foot of a long
        scrolling rail it was both hard to find and easy to never notice.
        Colour-coded, so the answer arrives before it is read (see
        branch-switcher.tsx).

        Hidden when the rail is collapsed to icons: the trigger needs its name
        to be useful, and the branch colour still shows on the mobile header
        and on the POS/overview page headers.
      */}
      <div className="mt-3 group-data-[state=collapsed]/sidebar:hidden">
        <BranchSwitcher compact quietLoading account={account} />
      </div>
    </SidebarHeader>
  );
}

/**
 * Chooses which pages the mobile bottom bar shows.
 *
 * Lives in the drawer footer next to the other per-device switches (theme, the
 * biometric opt-in) — the same drawer the header's hamburger opens, so the
 * setting sits one tap from the thing it changes. Mobile-only, since the bar
 * itself is.
 */
function BottomNavSettings({
  navItems,
  current,
  onSave,
}: {
  navItems: NavItem[];
  current: string[];
  onSave: (hrefs: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(current);
  // Sub-sections count too: a member who lives in «لیست قیمت» could not pin it
  // before, because the picker only ever read the nav's top level.
  const options = flattenNav(navItems);
  const full = draft.length >= BOTTOM_NAV_MAX;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reopening always starts from what is on screen, so cancelling by
        // tapping away discards the draft rather than half-keeping it.
        if (next) setDraft(current);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <button type="button" className={`${SIDEBAR_FOOTER_BUTTON_CLASS} mb-2 md:hidden`}>
          <LayoutGridIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-start">چیدمان نوار پایین</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[80svh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>نوار پایین صفحه</DialogTitle>
          <DialogDescription>
            تا {toPersianDigits(BOTTOM_NAV_MAX)} صفحه انتخاب کنید. انتخاب‌شده:{" "}
            {toPersianDigits(draft.length)} از {toPersianDigits(BOTTOM_NAV_MAX)}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1">
          {options.map((item) => {
            const Icon = NAV_ICONS[item.href] ?? CircleIcon;
            const picked = draft.includes(item.href);
            const blocked = !picked && full;
            return (
              <li key={item.href}>
                <button
                  type="button"
                  disabled={blocked}
                  aria-pressed={picked}
                  /* A greyed row with no explanation reads as broken; say why. */
                  title={blocked ? `ابتدا یکی از ${toPersianDigits(BOTTOM_NAV_MAX)} انتخاب فعلی را بردارید` : undefined}
                  onClick={() => setDraft((entries) => toggleBottomNavHref(entries, item.href))}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:cursor-not-allowed disabled:opacity-40 ${
                    picked
                      ? "bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-700 dark:text-amber-300"
                      : "text-foreground/80 hover:bg-muted/60"
                  }`}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-start">{item.label}</span>
                  {picked ? <CheckIcon aria-hidden="true" className="size-4 shrink-0" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        <DialogFooter showCloseButton>
          <Button
            onClick={() => {
              onSave(draft);
              setOpen(false);
            }}
          >
            ذخیره
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}



function DashboardSidebarFooter({
  role,
  fullName,
  navItems,
  bottomNavHrefs,
  onSaveBottomNav,
  deploymentProfile,
  canRunShift,
}: {
  role: string;
  fullName: string;
  navItems: NavItem[];
  bottomNavHrefs: string[];
  onSaveBottomNav: (hrefs: string[]) => void;
  deploymentProfile: DeploymentProfile;
  /** Opening a shift requires `orders.create` — an owner at the till opens one too. */
  canRunShift: boolean;
}) {
  const { expandSidebar } = useSidebar();
  const isPinRole = (PIN_ROLES as readonly string[]).includes(role);

  return (
    <SidebarFooter className="border-border/80 bg-card group-data-[state=collapsed]/sidebar:p-2">
      <div className="space-y-2 group-data-[state=collapsed]/sidebar:hidden">
        <DeploymentStatusIndicator profile={deploymentProfile} />
        {/* The branch switcher used to be here. It moved to the rail's header,
            beside the business name: it answers "where am I working", which is
            context for the whole screen rather than one of the account actions
            it was sitting among. */}
        {/* #541's user menu owns the member's identity and the way out. It is
            kept as the one identity control; the truncation below is this
            branch's fix, since a long name used to push the chevron out of the
            rail. */}
        <PlatformUserMenu role={role} fullName={fullName} />
        <div className="md:hidden"><ThemeToggle /></div>
        <BottomNavSettings
          navItems={navItems}
          current={bottomNavHrefs}
          onSave={onSaveBottomNav}
        />
        {(isPinRole || canRunShift) && <ShiftButton />}
        {isPinRole && <BiometricSettingsButton />}
        {isPinRole && <LockButton />}
      </div>

      {/*
        Collapsed, the whole footer used to be `hidden` — and #541's user menu,
        which now owns sign-out, is inside that hidden block, so the exit from a
        locked-down POS rail still meant expanding the rail first and hunting.
        The rail keeps the two things that must never be more than one click
        away: who you are (widens the rail back out) and the exit.
      */}
      {/*
        Collapsed, the whole footer used to be `hidden`, and the identity menu
        with it — so the exit from a locked-down POS rail meant expanding the
        rail first and hunting. The rail now carries the same menu as the
        expanded footer, as an avatar button: one implementation, so «تنظیمات
        پلتفرم» and «خروج» are one click away at either width. It is portalled,
        which is what lets it escape the 4rem rail's clipping instead of being
        cut off by it.
      */}
      <div className="hidden flex-col items-center gap-1 group-data-[state=collapsed]/sidebar:flex">
        <PlatformUserMenu role={role} fullName={fullName} compact />
        <button
          type="button"
          onClick={expandSidebar}
          aria-label="باز کردن نوار کناری"
          title="باز کردن نوار کناری"
          className="flex size-9 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
        >
          <UsersIcon aria-hidden="true" className="size-4" />
        </button>
      </div>
    </SidebarFooter>
  );
}

/**
 * Closes the phone drawer whenever the route actually changes.
 *
 * Every menu wires an `onNavigate` for this, but the ones that forgot (the
 * workspace rail's «دستیار هوشمند» and «میز کار من», an app launcher, a link
 * inside a page rendered under the open drawer) left the sheet sitting over the
 * page the member had just asked for. Watching the pathname covers all of them
 * at once, and it also handles the browser's back button, which no click
 * handler ever sees.
 */
function CloseDrawerOnNavigate({ pathname }: { pathname: string }) {
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}

/**
 * The business app that owns the contextual sidebar slot on this route.
 *
 * Shared platform pages use the compact global launcher and My Workspace has
 * its own contextual nav; only the four business apps resolve through this
 * registry. A registered shell without a renderer is treated as a programming
 * error by falling back to the global launcher rather than a stale flat menu.
 */
function appShellForSlot(
  pathname: string,
): { shell: AppShellDef; nav: (props: AppShellNavProps) => React.ReactElement } | null {
  const shell = appShellForPathname(pathname);
  const nav = shell ? appShellNavFor(shell.app) : undefined;
  return shell && nav ? { shell, nav } : null;
}

/**
 * An app's own main sidebar, in the slot the global launcher otherwise takes.
 *
 * `useSidebar()` is below the provider, so the drawer-closing callback is wired
 * here rather than in every app component — an app owns route data, not shell
 * plumbing.
 */
function AppShellNavigation({
  nav: Nav,
  shell,
  role,
  permissions,
  pathname,
  navItems,
}: {
  nav: (props: AppShellNavProps) => React.ReactElement;
  shell: AppShellDef;
  role: string;
  permissions: readonly string[];
  pathname: string;
  /** The business nav, for an app menu that arranges business pages (Accounting). */
  navItems: NavItem[];
}) {
  const { setOpenMobile } = useSidebar();
  const search = useSearchParams();
  return (
    <Nav
      shell={shell}
      role={role}
      permissions={permissions}
      pathname={pathname}
      search={search.toString()}
      // Flattened, so a child page (لیست قیمت under محصولات) can be adopted by
      // an app's menu as well as its parent.
      navItems={flattenNav(navItems)}
      onNavigate={() => setOpenMobile(false)}
    />
  );
}

function WorkspaceNavigation({
  pathname,
  sections,
}: {
  pathname: string;
  sections: readonly WorkspaceSidebarSection[];
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <WorkspaceAppNav
      pathname={pathname}
      sections={sections}
      onNavigate={() => setOpenMobile(false)}
    />
  );
}

function MobileDashboardHeader({
  navItems,
  pathname,
  deploymentProfile,
  fallbackLabel,
}: {
  /** Already flattened and contextual to the route currently open. */
  navItems: readonly { label: string; href: string }[];
  pathname: string;
  deploymentProfile: DeploymentProfile;
  /**
   * The title when no link matches. Inside an app it is the app's own name:
   * the global launcher only links each app's landing page, so every other
   * section of the app used to be titled «داشبورد» on a phone.
   */
  fallbackLabel?: string;
}) {
  const search = useSearchParams();
  // The longest matching href wins, so a detail page keeps its owning section
  // label instead of falling back to the platform home.
  const active = bestNavMatch([...navItems], (href) => isActive(pathname, href, search));
  const today = toPersianDigits(formatJalali(new Date(), { withMonthName: true }));

  return (
    <header className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-border/80 bg-card/95 px-2 py-1 backdrop-blur md:hidden">
      <SidebarTrigger className="text-muted-foreground" />
      <div className="min-w-0 flex-1 text-start">
        <p className="truncate text-sm font-bold text-foreground">{active?.label ?? fallbackLabel ?? "داشبورد"}</p>
        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
          <CalendarDaysIcon className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{today}</span>
        </p>
      </div>
      {/* On a phone the rail is behind the hamburger, so without this the
          active branch was invisible on every screen until the drawer was
          opened — the one place a mis-set branch does the most damage. */}
      <BranchSwitcher compact />
      <CreditBadge />
      <div className="max-w-36"><DeploymentStatusIndicator profile={deploymentProfile} /></div>
    </header>
  );
}

/**
 * The phone's bottom bar: the pages the member picked, and nothing else.
 *
 * It used to end in a «پروفایل» button that opened the drawer. The drawer is
 * already one tap away from the hamburger in the header on every screen, so
 * that slot was a second door to the same room — and it cost the bar a fifth of
 * its width for a control nobody was looking for down there.
 */
function MobileBottomNavigation({
  navItems,
  pathname,
  hrefs,
}: Pick<SidebarProps, "navItems"> & { pathname: string; hrefs: string[] }) {
  const search = useSearchParams();
  // Sub-sections are pinnable now, so the lookup has to see them: a pinned
  // «لیست قیمت» silently vanished from the bar when only the top level was read.
  const byHref = new Map(flattenNav(navItems).map((item) => [item.href, item]));
  const primaryItems = hrefs.flatMap((href) => {
    const item = byHref.get(href);
    return item ? [item] : [];
  });

  if (primaryItems.length === 0) return null;

  // Exactly one tab lights up: the longest matching href, so pinning both a
  // section and one of its tabs no longer paints two active tabs at once.
  const activeHref =
    bestNavMatch(primaryItems, (href) => isActive(pathname, href, search))?.href ?? null;

  return (
    <nav
      /*
        Height comes from `--app-bottom-nav` (globals.css) rather than from the
        sum of this element's own padding: everything that has to sit on top of
        this bar offsets from that variable, so the bar has to be what the
        variable says it is.
      */
      className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--app-bottom-nav)] gap-0.5 border-t border-border/80 bg-card/95 px-1 pb-[env(safe-area-inset-bottom)] pt-1 shadow-[0_-1px_8px_rgb(41_37_36/0.04)] backdrop-blur md:hidden"
      aria-label="ناوبری اصلی"
    >
      {primaryItems.map((item) => {
        const Icon = NAV_ICONS[item.href] ?? CircleIcon;
        const active = item.href === activeHref;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            title={item.label}
            className={`flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-0.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.98] ${active ? "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            {/*
              A long label used to be truncated to a couple of glyphs plus an
              ellipsis in a quarter of a phone's width («صندوق (فروش)» became
              «صن…»). Two short lines fit the real names instead, and the clamp
              keeps the bar at the height `--app-bottom-nav` promises.
            */}
            <span className="line-clamp-2 w-full text-center leading-tight break-words">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The drag edge of the sidebar: grab it to change the width (the rail and the
 * classic sidebar alike), double-click to snap back to the default, and the
 * arrow keys move it in steps. The width is remembered per device.
 *
 * It is a real `separator` with a value now, so a screen reader says how wide
 * the sidebar is rather than announcing a nameless handle, and the grip only
 * inks on hover/focus — a permanently visible bar down the edge of the nav
 * would compete with the entries beside it.
 */
function SidebarResizeHandle({
  width,
  onWidthChange,
  onDragChange,
  onReset,
}: {
  /** The sidebar's current rendered width, so a drag always starts from the truth. */
  width: number;
  onWidthChange: (width: number) => void;
  onDragChange: (dragging: boolean) => void;
  onReset: () => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button / primary touch only: a right-click used to start a drag
      // that no pointerup would ever end.
      if (event.button !== 0) return;
      start.current = { x: event.clientX, width: widthRef.current };
      onDragChange(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [onDragChange],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!start.current) return;
      // The sidebar sits on the right; pulling the edge left widens it.
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, start.current.width + (start.current.x - event.clientX)),
      );
      onWidthChange(next);
    },
    [onWidthChange],
  );

  const endDrag = useCallback(() => {
    if (!start.current) return;
    start.current = null;
    onDragChange(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }, [onDragChange]);

  // A drag that ends outside the window (the pointer left the viewport, the tab
  // lost focus) never fired pointerup on the handle, so the page stayed
  // unselectable with a resize cursor until the next click.
  useEffect(() => {
    const cancel = () => endDrag();
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [endDrag]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Home/End jump to the bounds and Enter/Space resets, so the width is
      // fully reachable without a pointer — the arrows alone meant up to
      // fourteen presses to cross the range.
      if (event.key === "Home") {
        event.preventDefault();
        onWidthChange(SIDEBAR_MAX_WIDTH);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        onWidthChange(SIDEBAR_MIN_WIDTH);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onReset();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? 1 : -1;
      onWidthChange(
        Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, widthRef.current + direction * SIDEBAR_KEYBOARD_STEP)),
      );
    },
    [onReset, onWidthChange],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="تغییر عرض نوار کناری"
      aria-valuenow={Math.round(width)}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuetext={`${toPersianDigits(String(Math.round(width)))} پیکسل`}
      title="برای تغییر عرض بکشید — دوبار کلیک برای بازگشت به حالت پیش‌فرض"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      /*
        A 1.5px strip was a pixel-hunt to grab. The target is 12px wide with the
        ink still a hairline, which is the standard trick for a resize edge:
        easy to hit, invisible until you mean it.
      */
      className="group/resize absolute inset-y-0 end-0 z-10 hidden w-3 -me-1 cursor-col-resize touch-none items-center justify-center outline-none md:flex"
    >
      <span
        aria-hidden="true"
        className="h-full w-1 rounded-full bg-transparent transition-colors group-hover/resize:bg-amber-300/70 group-focus-visible/resize:bg-amber-400/80 dark:group-hover/resize:bg-amber-500/30 dark:group-focus-visible/resize:bg-amber-400/50"
      />
    </div>
  );
}

export function DashboardSidebar({
  navItems,
  role,
  permissions,
  fullName,
  brandTitle,
  brandSubtitle,
  workspaceSections,
  deploymentProfile,
  account,
}: SidebarProps) {
  const pathname = usePathname();
  const [preference, setPreference] = useState<DashboardSidebarPreference>("expanded");
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [tabletMode, setTabletMode] = useState(false);
  const [tabletExpanded, setTabletExpanded] = useState(false);
  const [bottomNav, setBottomNav] = useState<string[] | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [draggingWidth, setDraggingWidth] = useState(false);
  const mode = tabletMode ? (tabletExpanded ? "expanded" : "collapsed") : resolveSidebarMode(pathname, preference);
  // The assistant surface — the chat home `/dashboard` — pins its composer to
  // the viewport's foot, so the customizable mobile bottom bar stands aside
  // there rather than covering it.
  const assistantRoute = isAssistantSurface(pathname);
  // Sub-sections included, so a pinned child page survives the "is this still
  // visible to me?" filter the bottom bar runs on every render.
  const availableHrefs = flattenNav(navItems).map((item) => item.href);
  // `/projects` is a legacy alias that middleware redirects before this shell
  // renders. The canonical Workspace prefix owns the contextual sidebar.
  const workspaceRoute = isWorkspacePathname(pathname);
  const appShell = appShellForSlot(pathname);
  // Platform home and shared utilities keep the intentionally small launcher;
  // an app or My Workspace replaces it with focused route navigation.
  const workspaceHeaderItems = workspaceSections.map((section) => ({
    label: section.label,
    href: workspaceSectionHref(section.key),
  }));
  const headerNavItems = workspaceRoute ? workspaceHeaderItems : flattenNav(navItems);

  useEffect(() => {
    setPreference(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === "collapsed" ? "collapsed" : "expanded");
    setPreferenceLoaded(true);
    const storedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(storedWidth) && storedWidth >= SIDEBAR_MIN_WIDTH && storedWidth <= SIDEBAR_MAX_WIDTH) {
      setSidebarWidth(storedWidth);
    }
  }, []);

  // Read after mount, not during render: localStorage does not exist on the
  // server, and the first paint has to match what the server sent.
  useEffect(() => {
    setBottomNav(parseBottomNavHrefs(window.localStorage.getItem(BOTTOM_NAV_STORAGE_KEY)));
  }, []);

  const saveBottomNav = useCallback((hrefs: string[]) => {
    setBottomNav(hrefs);
    window.localStorage.setItem(BOTTOM_NAV_STORAGE_KEY, JSON.stringify(hrefs));
  }, []);

  // Medium viewport (issue #844's «no 240px squeeze»): between the mobile
  // Sheet (<768px) and the full desktop sidebar (≥1280px) the rail collapses
  // to the compact icon column instead of stealing 240px from the content.
  // Expanding is a session-local, user-triggered choice — it never rewrites
  // the wide-desktop preference, so a laptop user's collapsed rail doesn't
  // follow them onto an external monitor.
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px) and (max-width: 1279px)");
    const update = () => {
      setTabletMode(media.matches);
      if (media.matches) setTabletExpanded(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (preferenceLoaded) window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, preference);
  }, [preference, preferenceLoaded]);

  // Persist a finished resize; the drag itself just paints.
  useEffect(() => {
    if (draggingWidth || sidebarWidth === null) return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth, draggingWidth]);

  const setExpanded = useCallback((expanded: boolean) => {
    if (tabletMode) {
      setTabletExpanded(expanded);
      return;
    }
    setPreference(expanded ? "expanded" : "collapsed");
  }, [tabletMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "b") return;
      // Ctrl/Cmd+B is "bold" inside a text field or a rich-text editor. The
      // shortcut used to fire anywhere, so bolding a line in the assistant's
      // composer or a note field collapsed the sidebar out from under you.
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        (target instanceof HTMLElement &&
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      if (tabletMode) {
        setTabletExpanded((current) => !current);
      } else {
        setPreference((current) => toggleDashboardSidebarPreference(current));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tabletMode]);

  const resetWidth = useCallback(() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH), []);

  return (
    <SidebarProvider open={mode === "expanded"} onOpenChange={setExpanded}>
      <CloseDrawerOnNavigate pathname={pathname} />
      <MobileDashboardHeader
        navItems={headerNavItems}
        pathname={pathname}
        deploymentProfile={deploymentProfile}
        fallbackLabel={appShell?.shell.label}
      />
      <Sidebar
        side="right"
        className={`border-border/80 bg-card text-foreground ${draggingWidth ? "transition-none" : ""}`}
        style={
          mode === "expanded" && sidebarWidth !== null && sidebarWidth !== SIDEBAR_DEFAULT_WIDTH
            ? { width: sidebarWidth }
            : undefined
        }
      >
        <SidebarBrand title={brandTitle} subtitle={brandSubtitle} account={account} />
        {workspaceRoute ? (
          <WorkspaceNavigation pathname={pathname} sections={workspaceSections} />
        ) : appShell ? (
          <AppShellNavigation
            nav={appShell.nav}
            shell={appShell.shell}
            role={role}
            permissions={permissions}
            pathname={pathname}
            navItems={navItems}
          />
        ) : (
          <WorkspaceRail navItems={navItems} pathname={pathname} />
        )}
        <DashboardSidebarFooter
          role={role}
          fullName={fullName}
          navItems={navItems}
          // The picker always opens on the plain default, never the sell-screen
          // substitution — that swap is a live behaviour of an unconfigured bar,
          // not a saved choice, so offering it as one would silently freeze it.
          bottomNavHrefs={resolveBottomNavHrefs(bottomNav, availableHrefs, false)}
          onSaveBottomNav={saveBottomNav}
          deploymentProfile={deploymentProfile}
          canRunShift={permissions.includes(PERMISSIONS.ordersCreate)}
        />
        {mode === "expanded" ? (
          <SidebarResizeHandle
            width={sidebarWidth ?? SIDEBAR_DEFAULT_WIDTH}
            onWidthChange={setSidebarWidth}
            onDragChange={setDraggingWidth}
            onReset={resetWidth}
          />
        ) : null}
      </Sidebar>
      {!assistantRoute && !workspaceRoute ? (
        <MobileBottomNavigation
          navItems={navItems}
          pathname={pathname}
          hrefs={resolveBottomNavHrefs(bottomNav, availableHrefs, isActive(pathname, ACCOUNTING_WORKSPACE_HREFS.pos))}
        />
      ) : null}
    </SidebarProvider>
  );
}
