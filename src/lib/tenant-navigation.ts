/**
 * Tenant navigation registry shared by the workspace shell and AI navigation.
 * A single source of truth: features/role/industry filtering happens here.
 */
import type { Role } from "@/lib/auth-edge";
import { isProductWorkspaceIndustry, PRODUCT_WORKSPACE_SECTIONS } from "@/lib/product-workspace";
import { ACCOUNTING_SECTIONS } from "@/app/(app)/accounting/accounting-nav";
import { PARTY_DIRECTORY_NAV_VIEWS, partyDirectoryHref } from "@/lib/party-directory";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";
import { ACCOUNTING_WORKSPACE_HREFS, PLATFORM_BILLING_HREF, PLATFORM_SETTINGS_HOME } from "@/lib/app-routes";
import { settingsTabHref } from "@/lib/settings-routes";
import { REPORTS_TABS, reportsTabHref } from "@/app/dashboard/reports/reports-nav";
import { REPORT_CAPABILITY_PERMISSIONS } from "@/lib/report-permissions";
import { isLockableFeature } from "@/lib/features";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import { hasModule, labelFor } from "@/lib/industry-profile";
import { POS_REQUIRED_PERMISSIONS, type Permission } from "@/lib/permissions";
import { GROWTH_APP_PERMISSIONS } from "@/lib/growth-access";
import type { NavItem } from "@/app/dashboard/dashboard-sidebar";
import type { ResolvedSettingsTab } from "@/lib/settings-tabs";

interface NavContext {
  /** The settings tabs this member may open (already role/permission/feature-filtered). */
  settingsTabs: ResolvedSettingsTab[];
}

export function navItemsFor(industry: Industry, ctx: NavContext): NavItem[] {
  return [
    {
      label: labelFor(industry, "saleDocumentPlural"),
      module: "orders",
      href: "/accounting/orders",
      requiredAnyPermission: ["orders.view"],
    },
    {
      label: labelFor(industry, "sellScreen"),
      module: "pos",
      href: ACCOUNTING_WORKSPACE_HREFS.pos,
      // The till is both an order editor and a money-taking surface. Requiring
      // both keeps a waiter with orders.create out and honours either explicit
      // revocation for custom/system roles.
      requiredAllPermissions: [...POS_REQUIRED_PERMISSIONS],
    },
    // The canonical menu manager (issue #844) — «مدیریت منو», right after the
    // till it stocks. Gated on the canonical read capability; the page and the
    // workspace composer take their gate from this same entry, and mutations
    // are separately gated `menu.edit` on every route.
    {
      label: "مدیریت منو",
      module: "menu",
      href: ACCOUNTING_WORKSPACE_HREFS.menu,
      requiredAnyPermission: ["menu.view"],
    },
    // The CRM app's door (Phase 36 — it is its own app, not a section of any
    // other). It is anchored on the `customers` module — core for every trade,
    // so a business that has customers has a CRM — and points at the app's own
    // home (`/crm/overview`), the same way «رشد و بازاریابی» points at
    // `/growth/overview` and «مدیریت وب‌سایت» at `/websites/overview`. The old
    // flat href `/crm/directory` is kept only as a redirect page for
    // saved bookmarks; using it here made two things go wrong at once:
    //   1. the workspace rail's CRM launcher (which looks for `/crm/overview`)
    //      never matched, so «ارتباط با مشتری» was missing from the rail's
    //      «برنامه‌ها» list while Growth and the Website app were present; and
    //   2. because the href was not inside any app shell prefix, the entry was
    //      not filtered out of the flat business nav in the workspace shell, so
    //      it kept surfacing (as «مشتریان», redirecting into the CRM directory)
    //      while the member was inside another app such as حسابداری — the CRM
    //      leaking into Accounting instead of Accounting keeping its own
    //      «اشخاص»/«مشتریان» sections.
    // The accountant is deliberately not here: the CRM app does not admit them
    // (see `canOpenCrm`); they manage the shared customer record from
    // Accounting's own «اشخاص» and «مشتریان» sections, and `/crm/directory`
    // still redirects an accountant there for any old bookmark.
    {
      label: "ارتباط با مشتری",
      module: "customers",
      href: "/crm/overview",
      roles: ["owner", "manager", "cashier"],
    },
    // Phase 36b — loyalty, campaigns/gift cards and commission are one app
    // now («رشد و بازاریابی», /growth), with its own dashboard the
    // way accounting has one. The entry is anchored on the `loyalty` module —
    // core for every trade — and the app's own main sidebar restricts its
    // sections by role (src/lib/app-shells.ts hands that sidebar over): a cashier
    // lands on loyalty, the surface the old flat page gave them, and never sees
    // commission or the KPIs. The old routes redirect.
    {
      label: "رشد و بازاریابی",
      module: "loyalty",
      // The door's permission is the union of the section gates (issue #764);
      // a member without the overview is forwarded by its page to the first
      // section they may open (`growthFallbackHref`).
      href: "/growth/overview",
      requiredAnyPermission: [...GROWTH_APP_PERMISSIONS],
    },
    // Its own app (issue #378) — an integration with an external system of
    // record (eshobe-cms), not a Growth engine. Owner/manager only, the same
    // line the connections app draws for its own machine credentials.
    {
      label: "وب‌سایت",
      module: "website",
      href: "/websites/overview",
      roles: ["owner", "manager"],
    },
    {
      label: "خرید و انبار",
      module: "stock",
      href: ACCOUNTING_WORKSPACE_HREFS.inventory,
      roles: ["owner", "manager"],
    },
    { label: "میزها", module: "tables", href: ACCOUNTING_WORKSPACE_HREFS.floor, roles: ["owner", "manager", "cashier", "waiter"], flag: "reservations" },
    { label: "میزهای من", module: "waiter", href: "/accounting/waiter", roles: ["cashier", "waiter"], flag: "reservations" },
    { label: "آشپزخانه", module: "kitchen", href: ACCOUNTING_WORKSPACE_HREFS.kitchen, roles: ["owner", "manager", "kitchen"] },
    { label: "رزروها", module: "reservations", href: ACCOUNTING_WORKSPACE_HREFS.reservations, roles: ["owner", "manager", "cashier", "waiter"], flag: "reservations" },
    { label: "ارسال و پیک", module: "delivery", href: ACCOUNTING_WORKSPACE_HREFS.delivery, roles: ["owner", "manager", "cashier"], flag: "delivery" },
    { label: "انبار", module: "inventory", href: ACCOUNTING_WORKSPACE_HREFS.inventory, roles: ["owner", "manager"], flag: "inventory" },
    { label: INDUSTRY_LABELS.jewelry, module: "jewelry", href: "/accounting/jewelry", roles: ["owner", "manager"] },
    { label: INDUSTRY_LABELS.watch, module: "watch", href: "/accounting/watch", roles: ["owner", "manager"] },
    // Issue #839 — the automotive manager. Same shape as the two above: one
    // trade-titled entry that the module gate (and therefore the industry
    // profile) removes entirely for every other business.
    {
      label: INDUSTRY_LABELS.automotive,
      module: "automotive",
      href: ACCOUNTING_WORKSPACE_HREFS.automotive,
      roles: ["owner", "manager"],
    },
    // Phase 42 — the retail trade-goods trades manage their catalogue in the
    // shared products workspace: a collapsible sidebar group — افزودن محصول،
    // لیست محصولات، لیست قیمت، ویژگی محصول، الگوی بارکد وزنی and the trade's
    // own گزارش‌ها — instead of five flat trade entries. The old trade pages
    // forward into the workspace; cosmetics alone keeps its own entry for the
    // sections only it has (بچ‌ها و انقضا، برند و ماتریس).
    ...(isProductWorkspaceIndustry(industry)
      ? [
          {
            label: "محصولات",
            module: industry,
            iconKey: ACCOUNTING_WORKSPACE_HREFS.products,
            roles: ["owner", "manager"],
            children: PRODUCT_WORKSPACE_SECTIONS.map((section) => ({
              label: section.label,
              module: industry,
              href: section.href,
              roles: ["owner", "manager"],
            })),
          },
        ]
      : []),
    ...(industry === "cosmetics"
      ? [{ label: INDUSTRY_LABELS.cosmetics, module: "cosmetics" as const, href: ACCOUNTING_WORKSPACE_HREFS.cosmetics, roles: ["owner", "manager"] }]
      : []),
    // The «حسابداری» sub-menu — the Accounting app's sections, each a real
    // route under the app's own prefix (`/accounting/…`). This tree is the
    // href *registry* the flattened-nav consumers read (the mobile header's
    // page title, the bottom bar's picker and pin filter, the app launcher's
    // landing resolver); the app's own sidebar is composed in
    // `accounting-workspace.ts` and draws «فضای کار حسابداری» as ONE ordinary
    // link to its workspace page (`/accounting/ledger`), not as a disclosure
    // over these rows. The parent keeps its href so the overview is still one
    // tap away and still pinnable to the bottom bar; the app's old
    // `/dashboard/ledger?tab=…` addresses forward to these routes.
    {
      label: "حسابداری",
      module: "ledger",
      href: "/accounting/overview",
      roles: ["owner", "admin", "manager", "accountant"],
      flag: "ledger",
      children: [
        ...ACCOUNTING_SECTIONS.map((section) => ({
          label: section.label,
          module: "ledger" as const,
          href: accountingSectionHref(section.key),
          roles: ["owner", "admin", "manager", "accountant"],
        })),
        // The directory's two most-asked-for views. They are filters of
        // «اشخاص» above, listed here for the two surfaces that read this tree
        // by href rather than by section: the mobile bottom bar (a member can
        // pin «مشتریان» to it) and the mobile header, which titles the page
        // from the longest matching nav entry. Without them a filtered
        // directory would be titled «اشخاص» and could not be pinned at all.
        ...PARTY_DIRECTORY_NAV_VIEWS.map((view) => ({
          label: view.label,
          module: "ledger" as const,
          href: partyDirectoryHref(view.key),
          roles: ["owner", "admin", "manager", "accountant"],
        })),
      ],
    },
    // «کتابخانهٔ رسانه» (migration 0149) — the business's shared library of
    // images, videos and documents. Shell infrastructure like the connections
    // hub: its module is core for every trade and unassigned in `apps.ts`,
    // so the door is never badged and never gated; every app's image picker
    // (menu items, inventory items, the website) opens the same library.
    {
      label: "کتابخانهٔ رسانه",
      module: "media",
      href: "/media",
      roles: ["owner", "manager"],
      // Issue #1128 §E — the agency's side of client review, as a child of the
      // library it reviews from. Same shape as «گزارش‌ها» above: the parent keeps
      // its own href and the child names the permission its route enforces.
      //
      // The child is `media.view`, which is what the *page* requires, and not
      // `media.manage`: a member who may look at rounds should be able to open
      // the list, and the screen then offers mutations only to a manager. Every
      // mutation re-checks its own permission server side, so this is about what
      // is offered, never about what is allowed — navigation hiding is not
      // authorization, which the issue lists as an explicit non-goal.
      //
      // Not industry-gated, matching §E's decision 32: the library is core shell
      // infrastructure for every trade, and a jeweller sending a custom design
      // proof to a customer for approval is this feature as much as an agency
      // sending a campaign.
      children: [
        {
          label: "بررسی کارفرما",
          module: "media" as const,
          href: "/media/review",
          requiredAnyPermission: ["media.view"],
        },
      ],
    },
    // Issue #819 — the reports door and its tabs are gated by the *reporting
    // capabilities*, not by a role list: the entry's old
    // `roles: ["owner","manager","accountant"]` both hid «گزارش‌ها» from an
    // admin who holds `reports.view` and, because the `roles` field is only
    // consulted for the industry catalogue modules, did not actually restrict
    // the children — «مقایسهٔ شعب» rendered for anyone with `reports.view`
    // while the branch-comparison API claimed to be owner-only. Each child now
    // names the same permission its route enforces.
    {
      label: "گزارش‌ها",
      module: "reports",
      href: ACCOUNTING_WORKSPACE_HREFS.reports,
      requiredAnyPermission: [REPORT_CAPABILITY_PERMISSIONS.canViewReports],
      flag: "reporting",
      children: REPORTS_TABS.map((tab) => ({
        label: tab.label,
        module: "reports" as const,
        href: reportsTabHref(tab.key),
        requiredAnyPermission: [REPORT_CAPABILITY_PERMISSIONS[tab.capability]],
      })),
    },
    // The assistant itself is not an entry: it IS the dashboard (`/dashboard`
    // is the chat home), and the workspace rail names the home in its own
    // toolbar. The «اتصال‌های فنی» hub is likewise no longer a nav group here
    // — the feature is untouched at `/settings/connections`, but its door is
    // the platform user menu, which is where a shell utility belongs, and the
    // contextual links (Website → WooCommerce/CMS, Holoo, MCP/API) still hand a
    // member over from the app that uses the connection.
    // Wallet/credits & plans — platform-owned, so the door is the platform
    // settings area's billing page, never an app's. The small credit badge in
    // the chrome links to the same URL.
    { label: "اعتبار و پرداخت‌ها", module: "settings", href: PLATFORM_BILLING_HREF, roles: ["owner", "manager"] },
    // Settings tabs are already role/permission/feature-filtered server-side
    // (`visibleSettingsTabs`), so they carry no further gate here.
    {
      label: "تنظیمات",
      module: "settings",
      href: PLATFORM_SETTINGS_HOME,
      // Each settings section is a route of its own now, so the sub-menu links
      // to real URLs rather than to `?tab=` variations of one page — which is
      // what lets a member bookmark «تیم» and what lets the active state be
      // decided by the pathname alone.
      children: ctx.settingsTabs.map((tab) => ({
        label: tab.label,
        module: "settings" as const,
        href: settingsTabHref(tab.key),
      })),
    },
    // Migration 0131 — the in-product knowledge base («مرکز آموزش»): every
    // member learns the platform here, so like the support desk it has no
    // role gate; the `settings` module anchors it because every trade has it.
    { label: "مرکز آموزش", module: "settings", href: "/knowledge" },
    // Migration 0130 — the support desk. Every member may open a ticket
    // (asking for help is not a privileged act), so there is no `roles` gate;
    // the `settings` module anchors it because every industry has settings.
    // Owners and managers see the whole business queue, the rest only their
    // own tickets — enforced server-side in src/lib/support-service.ts.
    { label: "پشتیبانی", module: "settings", href: "/support" },
  ];
}

function modulePermissions(module: NavItem["module"]): Permission[] {
  const map: Partial<Record<NavItem["module"], Permission[]>> = {
    orders: ["orders.create"], pos: ["orders.create"], customers: ["crm.view", "crm.manage"],
    loyalty: [...GROWTH_APP_PERMISSIONS], website: ["website.view"], stock: ["inventory.view"],
    tables: ["tables.manage"], kitchen: ["kitchen.view"], reservations: ["reservations.manage"],
    delivery: ["delivery.manage"], inventory: ["inventory.view"], jewelry: ["inventory.view"],
    watch: ["inventory.view"], cosmetics: ["inventory.view"], ledger: ["ledger.view"],
    media: ["media.view"], reports: ["reports.view"],
  };
  return map[module] ?? [];
}

function canSee(
  item: NavItem,
  role: Role,
  permissions: Set<Permission>,
  features: Record<string, boolean>,
  industry: Industry,
): boolean {
  // Industry first: a module this trade does not have is not merely switched
  // off, it does not exist here, and its route refuses too (auth.ts).
  if (!hasModule(industry, item.module)) return false;
  // A disabled flag hides its entry — unless the feature is lockable, in which
  // case the entry stays and is marked with a padlock instead (see
  // LOCKABLE_FEATURES in features.ts). Its page renders a read-only preview
  // rather than redirecting, so the link goes somewhere real either way.
  if (item.flag && !features[item.flag] && !isLockableFeature(item.flag)) return false;
  // `waiter` is intentionally identity-shaped: this is the shared-terminal,
  // assigned-table board, not a general business capability. Every ordinary
  // application door is permission-derived, regardless of the preset's name.
  if (item.module === "waiter" && item.roles && !item.roles.includes(role)) return false;
  if (item.requiredAllPermissions?.some((permission) => !permissions.has(permission))) return false;
  const required = item.requiredAnyPermission ?? modulePermissions(item.module);
  if (required.length > 0) return required.some((permission) => permissions.has(permission));
  // Industry-specific catalogue modules historically carried owner/manager
  // role lists; their canonical capability is inventory viewing.
  if (item.roles) return permissions.has("inventory.view");
  return true;
}

/**
 * Build the member-accessible navigation once. Consumers such as the shell and
 * permission-aware app-root redirects use this same result; neither repeats
 * role or permission decisions.
 */
export function accessibleNavItemsFor(
  industry: Industry,
  ctx: NavContext,
  role: Role,
  permissions: Set<Permission>,
  features: Record<string, boolean>,
): NavItem[] {
  return navItemsFor(industry, ctx)
    .map((item) =>
      item.children
        ? { ...item, children: item.children.filter((child) => canSee(child, role, permissions, features, industry)) }
        : item,
    )
    .filter((item) => !item.children || item.children.length > 0)
    .filter((item) => canSee(item, role, permissions, features, industry))
    .filter((item) => item.href !== "/settings" || ctx.settingsTabs.length > 0);
}

