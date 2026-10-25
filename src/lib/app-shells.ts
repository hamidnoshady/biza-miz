/**
 * The dashboard apps that own their own main sidebar.
 *
 * Phase 35 grouped the flat nav entries into apps (`apps.ts`) and Phase 35
 * Wave 2 made the workspace rail a *launcher* for them; Phase 36b gave Growth &
 * Marketing its own routes and its own menu. What none of that did was say who
 * renders the sidebar *inside* an app: the shell kept drawing the business's
 * flat nav, so opening `/dashboard/growth` showed the accounting pages in the
 * app slot and tucked the app's real menu inside the page — a sub-menu of a
 * page inside the accounting sidebar, which is exactly what made the app look
 * like a folder of accounting rather than a product.
 *
 * A *shell* is the answer to that question: an app whose routes replace the
 * business nav with the app's own main menu, and which is launched from the
 * rail as a peer of حسابداری. `apps.ts` still answers "which app owns this
 * module" and `industry-profile.ts` "does this trade have it"; this answers
 * only "whose menu is this route". Three separate questions, each with one
 * place to look — the same split `bottom-nav.ts` and `sidebar-state.ts` keep.
 *
 * Framework-free like those, so the rule is unit-testable and the sidebar can
 * import it without pulling in a client component. What an app's menu *contains*
 * stays with the app (`growth/growth-nav.ts`); this registry only says which
 * routes belong to an app's own menu, and what the app is called there.
 *
 * Adding a shell means three things, and only three:
 * 1. an entry here, naming the route prefix the app owns;
 * 2. the app's nav component, registered in `app-shell-nav.ts`;
 * 3. its entry in the workspace rail, so the app is launched beside حسابداری
 *    rather than from inside it.
 */
import type { AppKey } from "./apps";

export interface AppShellDef {
  /** The app from the registry that this shell belongs to. */
  app: AppKey;
  /**
   * The dashboard route prefix whose pages the shell owns. Every route under
   * it — its nested pages included — gets the app's own main menu.
   */
  prefix: string;
  /** The app's name, as the rail and the page header already call it. */
  label: string;
  /** One line under the app's name in its own sidebar. */
  description: string;
}

export const APP_SHELLS: readonly AppShellDef[] = [
  {
    // Accounting owns a shell too, now that it has a public prefix of its own.
    // It was the one app left drawing the business's flat nav, which is what
    // made «حسابداری» read as *the* product and every other app as a folder
    // inside it. Its sections are the same list the flat «حسابداری» group used
    // (`accounting-nav.ts`), so nothing about the app's contents changes —
    // only which menu draws them while a member is inside the app.
    app: "accounting",
    prefix: "/accounting",
    label: "حسابداری",
    description: "دفتر کل، اسناد، اشخاص، دریافت و پرداخت و گزارش‌های مالی.",
  },
  {
    app: "growth",
    prefix: "/growth",
    label: "رشد و بازاریابی",
    description: "میز کار، کمپین‌ها و کارت هدیه، وفاداری و پورسانت.",
  },
  {
    app: "crm",
    prefix: "/crm",
    label: "ارتباط با مشتری",
    description: "پرونده و بخش‌بندی مشتری، قیف فروش، کارها و تیکت‌ها.",
  },
  {
    // One shell for both website managers: the app's menu lists the CMS
    // sections and the WordPress sections as two groups, so «مدیریت وب‌سایت»
    // is one door with two rooms rather than two apps in the rail. The
    // WordPress pages moved under this prefix with it (/dashboard/website/wp).
    app: "website",
    prefix: "/websites",
    label: "مدیریت وب‌سایت",
    description: "سایت‌ساز بیزامیز و مدیریت وردپرس و ووکامرس، هرکدام جدا.",
  },
];

/**
 * Which app's shell owns a dashboard path, or null when the business nav does.
 *
 * Longest prefix wins, so a shell nested under another app's routes answers for
 * its own pages only. Matched on path *segments*, never on a raw prefix: a
 * route that merely starts with the same letters (`/dashboard/growthlab`) is
 * not inside the app.
 */
export function appShellForPathname(pathname: string): AppShellDef | null {
  let found: AppShellDef | null = null;
  for (const shell of APP_SHELLS) {
    const inside = pathname === shell.prefix || pathname.startsWith(`${shell.prefix}/`);
    if (!inside) continue;
    if (!found || shell.prefix.length > found.prefix.length) found = shell;
  }
  return found;
}

/**
 * Whether a nav-item href points inside an app's own menu. The flat business
 * sidebar must not list such an entry: a page reachable from two menus is a page
 * whose active state disagrees with itself, and «رشد و بازاریابی» sitting among
 * حسابداری and گزارش‌ها is what made the app read as a section of accounting.
 */
export function isInsideAnyAppShell(href: string): boolean {
  return APP_SHELLS.some(
    (shell) => href === shell.prefix || href.startsWith(`${shell.prefix}/`),
  );
}
