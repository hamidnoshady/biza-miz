import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The RTL and structural rules the Accounting menu and the party form have to
 * keep.
 *
 * This suite greps the sources — the approach `design-lint.test.ts` and
 * `app-shell-nav-doors.test.ts` already use — because the repo's vitest runs in
 * Node with no jsdom and no `@testing-library`, so a client component cannot be
 * mounted here. Grepping is not as good as rendering, but it holds the exact
 * lines that broke before: a physical `left`/`right` inset that mirrors wrongly
 * in Persian, a chevron that points the wrong way, a ledger disclosure bolted
 * onto the menu («فضای کار حسابداری» is ONE ordinary link now — these tests
 * keep it that way), a dialog whose only exit discards a filled form without
 * asking. (The rendered-menu half — one workspace link, no disclosure button,
 * tooltip at the icon rail, `onNavigate` closing the drawer — is mounted in
 * `accounting-app-nav.test.tsx`.)
 */

const NAV_SOURCE = readFileSync(
  fileURLToPath(new URL("./accounting-app-nav.tsx", import.meta.url)),
  "utf8",
);
/**
 * The groups themselves are drawn by the shared component now, so the rules
 * about rows, tooltips and selection state are checked there — the menu file
 * only composes it.
 */
const GROUP_SOURCE = readFileSync(
  fileURLToPath(new URL("../../dashboard/sidebar-nav-group.tsx", import.meta.url)),
  "utf8",
);
/**
 * The «بازگشت» control is shared by every app sidebar (`app-section-nav.tsx`)
 * rather than respelled in each one, so the rule about its arrow is checked
 * where the arrow is drawn.
 */
const BACK_SOURCE = readFileSync(
  fileURLToPath(new URL("../../dashboard/app-section-nav.tsx", import.meta.url)),
  "utf8",
);
const FORM_SOURCE = readFileSync(
  fileURLToPath(new URL("../../dashboard/parties/party-form.tsx", import.meta.url)),
  "utf8",
);
const SECTION_SOURCE = readFileSync(
  fileURLToPath(new URL("../../dashboard/parties/parties-section.tsx", import.meta.url)),
  "utf8",
);

/** Physical-direction utilities, which mirror wrongly under `dir="rtl"`. */
const PHYSICAL_CLASSES =
  /(?<![\w-])(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-[\w./[\]]+/g;

/** The same idea for the bare positional ones. */
const PHYSICAL_BARE = /(?<![\w-])(?:text-left|text-right)(?![\w-])/g;

function physicalClassesIn(source: string): string[] {
  return [...(source.match(PHYSICAL_CLASSES) ?? []), ...(source.match(PHYSICAL_BARE) ?? [])];
}

/** Code only — comments may *name* the removed disclosure; code may not use it. */
function withoutComments(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"));
}

describe("the Accounting menu is written for RTL", () => {
  it("uses logical insets, never physical left/right ones", () => {
    // `ms`/`me`/`ps`/`pe`/`border-s`/`text-start` flip with the document
    // direction; `ml`/`pr`/`text-left` do not, and are how a Persian sidebar
    // ends up with its rule on the wrong edge.
    expect(physicalClassesIn(NAV_SOURCE)).toEqual([]);
    expect(physicalClassesIn(GROUP_SOURCE)).toEqual([]);
    expect(physicalClassesIn(BACK_SOURCE)).toEqual([]);
  });

  it("draws «فضای کار حسابداری» as one ordinary link — no disclosure, no chevron, no panel", () => {
    // The regression: the ledger was a collapsible group — a bespoke 11px/600
    // disclosure header with a chevron over a nested panel, and the only item
    // in the menu that expanded at all. It is one ordinary row now, so none of
    // that machinery may come back — not in the menu, not in the shared drawer.
    expect(withoutComments(NAV_SOURCE).join("\n")).not.toMatch(/NavCollapsibleGroup|useOpenNavGroups|onToggle|aria-expanded|aria-controls|Chevron/i);
    expect(withoutComments(GROUP_SOURCE).join("\n")).not.toMatch(/NavCollapsibleGroup|aria-expanded|aria-controls|onToggle|Chevron/i);
    // The row is drawn through the same `SidebarMenuButton`/`Link` pair as
    // «فروش و فاکتور», wearing the shared skins — never a custom heading
    // typography (the old 11px/600 toggle) or a button-with-panel.
    expect(GROUP_SOURCE).toMatch(/<SidebarMenuButton asChild/);
    expect(GROUP_SOURCE).toMatch(/APP_NAV_BUTTON_CLASS/);
    expect(GROUP_SOURCE).toMatch(/NAV_LABEL_CLASS/);
    expect(withoutComments(GROUP_SOURCE).join("\n")).not.toMatch(/<button[\s\S]{0,200}aria-expanded/);
  });

  it("flips the «بازگشت» arrow for RTL", () => {
    // An arrow drawn for LTR points the wrong way in Persian.
    expect(BACK_SOURCE).toMatch(/rtl:rotate-180/);
  });

  it("labels every entry in text, never by glyph alone", () => {
    // A core operation hidden behind an ambiguous icon is not discoverable.
    // Both the label span and the collapsed-rail tooltip carry the words.
    expect(GROUP_SOURCE).toMatch(/tooltip=\{entry\.label\}/);
    expect(GROUP_SOURCE).toMatch(/\{entry\.label\}/);
    // A group with a heading carries its name in words; the workspace door
    // group carries none because its row *is* the name.
    expect(GROUP_SOURCE).toMatch(/\{group\.label\}/);
  });

  it("names the menu for a screen reader", () => {
    expect(NAV_SOURCE).toMatch(/aria-label="منوی حسابداری"/);
  });

  it("marks the current page for assistive tech, not only in colour", () => {
    expect(GROUP_SOURCE).toMatch(/aria-current=\{active \? "page" : undefined\}/);
    // …and the selected skin is the shared one (`data-[active=true]` through
    // `APP_NAV_BUTTON_CLASS`), the same «you are here» as «فروش و فاکتور».
    expect(GROUP_SOURCE).toMatch(/isActive=\{active\}/);
  });

  it("keeps the group heading in the shared metadata type, not a new spelling", () => {
    expect(GROUP_SOURCE).toMatch(/text-\[11px\] font-semibold tracking-wide text-muted-foreground/);
  });

  it("hides labels, not entries, when the rail collapses to icons", () => {
    expect(GROUP_SOURCE).toMatch(/group-data-\[state=collapsed\]\/sidebar:hidden/);
    // At 4rem the rows stay listed (with their tooltips) and only the hairline
    // separates groups — an icon rail must never hide a destination.
    expect(GROUP_SOURCE).toMatch(/hidden[^"]*group-data-\[state=collapsed\]\/sidebar:block/);
  });
});

describe("the party form is accessible and hard to lose work in", () => {
  it("protects unsaved changes on the way out", () => {
    // Both exits: the dialog's own close (Escape, the backdrop, «انصراف») and
    // the browser's (refresh, closed tab).
    expect(FORM_SOURCE).toMatch(/requestClose/);
    expect(FORM_SOURCE).toMatch(/partyFormHasUnsavedChanges/);
    expect(FORM_SOURCE).toMatch(/beforeunload/);
    expect(FORM_SOURCE).not.toMatch(/onClick=\{onClose\}/);
  });

  it("sends a validation error to its tab and focuses the field", () => {
    expect(FORM_SOURCE).toMatch(/setTab\(tabForField\(first\)\)/);
    expect(FORM_SOURCE).toMatch(/setFocusField\(first\)/);
    expect(FORM_SOURCE).toMatch(/data-field=/);
  });

  it("offers roles as a multi-select group, not a single-value picker", () => {
    expect(FORM_SOURCE).toMatch(/role="checkbox"/);
    expect(FORM_SOURCE).toMatch(/aria-checked=\{checked\}/);
    expect(FORM_SOURCE).toMatch(/togglePartyRole/);
    // The old single-role `<select>` must not come back.
    expect(FORM_SOURCE).not.toMatch(/value=\{state\.role\}[\s\S]{0,200}<option/);
  });

  it("names the role group for a screen reader", () => {
    expect(FORM_SOURCE).toMatch(/role="group"/);
    expect(FORM_SOURCE).toMatch(/aria-label="نقش‌های این شخص"/);
  });

  it("uses logical insets throughout", () => {
    expect(physicalClassesIn(FORM_SOURCE)).toEqual([]);
  });
});

describe("the directory is one screen with filters", () => {
  it("drives its list from the view, not from a per-role scope", () => {
    expect(SECTION_SOURCE).toMatch(/partyDirectoryView/);
    expect(SECTION_SOURCE).toMatch(/listedRoles/);
    /*
     * The roles asked of the API are the *narrowed* set, so a hand-typed
     * `?view=` cannot widen what a scope is allowed to list.
     *
     * The request carries `rolesParam`, which exists only so the loader's
     * dependency list compares a string rather than a fresh array on every
     * render; what matters here is unchanged — that the value handed to the
     * API is `listedRoles` joined, and nothing else.
     */
    expect(SECTION_SOURCE).toMatch(/const rolesParam = listedRoles\.join\(","\)/);
    expect(SECTION_SOURCE).toMatch(/params\.set\("roles", rolesParam\)/);
  });

  it("draws the views with the shared tab primitive, not a bespoke strip", () => {
    expect(SECTION_SOURCE).toMatch(/<TabBar/);
  });

  it("opens a new person with the current view's role ticked", () => {
    expect(SECTION_SOURCE).toMatch(/defaultRoles=\{activeView\.defaultRoles\}/);
  });

  it("uses logical insets throughout", () => {
    expect(physicalClassesIn(SECTION_SOURCE)).toEqual([]);
  });
});
