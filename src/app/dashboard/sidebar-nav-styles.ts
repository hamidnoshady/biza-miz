/**
 * One button skin for every entry in the dashboard's navigation column — the
 * workspace rail, the classic flat nav, and an app's own main sidebar.
 *
 * It lives apart from `dashboard-sidebar.tsx` because an app's nav component
 * (e.g. `growth/growth-app-nav.tsx`) has to wear it too, and importing the shell
 * that imports the app would close a cycle. Amber is selection
 * (docs/design-system.md §Colour roles), so all three menus agree on what
 * "you are here" looks like.
 *
 * Every amber shade is paired with a dark one. The selected entry's fill and
 * text used to have no dark counterpart, which painted a light chip on the
 * dark rail — the one place in the sidebar where "you are here" was harder to
 * read than a plain hover.
 */
export const APP_NAV_BUTTON_CLASS =
  "min-h-12 rounded-xl text-foreground/80 hover:bg-amber-50 dark:hover:bg-amber-500/15 hover:text-amber-700 dark:hover:text-amber-300 data-[active=true]:bg-amber-100 dark:data-[active=true]:bg-amber-500/20 data-[active=true]:font-semibold data-[active=true]:text-amber-700 dark:data-[active=true]:text-amber-200";

/**
 * The «بازگشت به میز کار» / «بازگشت به داشبورد» button — the one exit an app's
 * sidebar offers, drawn *differently* from the flat menu entries so it reads as
 * a control rather than as another section. Bordered and elevated (the one warm
 * 1px shadow the design system allows), bold, with an arrow — and always the
 * first thing in the menu.
 */
export const BACK_TO_WORKSPACE_BUTTON_CLASS =
  "min-h-12 rounded-xl border border-border bg-muted/50 font-bold text-foreground shadow-[0_1px_2px_rgb(41_37_36/0.035)] hover:border-amber-300/70 hover:bg-amber-50 hover:text-amber-700 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/15 dark:hover:text-amber-300";

/**
 * The label inside a nav button. At the 4rem icon rail the label is visually
 * hidden with `sr-only`, not `display:none`: the link's accessible name is its
 * text content, so a `hidden` label left every collapsed row (including
 * «فضای کار حسابداری») nameless for a screen reader. The row's tooltip shows
 * the words on hover and focus. Using one shared class also means a menu never
 * has to remember the incantation — an app nav that forgot it (the website
 * menu did) let its labels spill out of the 4rem rail.
 */
export const NAV_LABEL_CLASS =
  "min-w-0 flex-1 truncate text-start group-data-[state=collapsed]/sidebar:sr-only";

/**
 * One skin for the stacked controls in the sidebar footer — شیفت، قفل صفحه و
 * ورود بیومتریک. They are separate components (`shift-panel.tsx`,
 * `lock-screen.tsx`, `biometric-settings.tsx`), and each used to spell its
 * own `py-1.5` button: the result was a stack of controls that were nearly,
 * but not quite, the same height and never tall enough for a thumb on a POS
 * tablet. Sign-out itself lives entirely in `platform-user-menu.tsx` now — a
 * second, dead `logout-button.tsx` implementation that duplicated it (unused
 * anywhere in the sidebar) was removed rather than kept beside it.
 *
 * `min-h-10` (44px on the phone drawer via the touch bump below) with an icon
 * slot at the start and the label pushed to the inline start, so the column
 * reads as one list of actions.
 */
export const SIDEBAR_FOOTER_BUTTON_CLASS =
  "flex min-h-10 w-full items-center gap-2 rounded-lg border border-input px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:pointer-events-none disabled:opacity-50";

/** The same control, in the accent that says "this one is currently on" (an open shift). */
export const SIDEBAR_FOOTER_BUTTON_ACTIVE_CLASS =
  "flex min-h-10 w-full items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 text-sm text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45";
