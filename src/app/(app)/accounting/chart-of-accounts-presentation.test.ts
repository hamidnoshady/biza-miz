import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Issue #824 review item 4 — the presentation rules the chart of accounts has
 * to keep, checked on the sources (the approach `accounting-nav-rtl.test.ts`
 * and `design-lint.test.ts` already use, since this file runs in Node).
 *
 * What broke before and is pinned here:
 *   * physical left/right utilities, which mirror wrongly under `dir="rtl"`;
 *   * colours written without a `dark:` counterpart, which leave the row text
 *     unreadable in the dark theme;
 *   * a desktop-only layout with no card fallback for narrow screens;
 *   * a chart screen drawing its own raw `<button>`/`<dialog>` chrome instead
 *     of the design-system primitives (which is what carries focus handling,
 *     the destructive confirmation and the RTL-safe button styles).
 */

const SECTION = readFileSync(
  fileURLToPath(new URL("./chart-of-accounts-section.tsx", import.meta.url)),
  "utf8",
);
const STATEMENT = readFileSync(
  fileURLToPath(new URL("./account-statement-panel.tsx", import.meta.url)),
  "utf8",
);
const HISTORY = readFileSync(
  fileURLToPath(new URL("./account-history-panel.tsx", import.meta.url)),
  "utf8",
);
const SETTINGS = readFileSync(
  fileURLToPath(new URL("../settings/accounts-settings.tsx", import.meta.url)),
  "utf8",
);

const SOURCES = { SECTION, STATEMENT, HISTORY, SETTINGS };

/** Physical-direction utilities, which mirror wrongly under `dir="rtl"`. */
const PHYSICAL =
  /(?<![\w-])(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-[\w./[\]]+/g;
const PHYSICAL_BARE = /(?<![\w-])(?:text-left|text-right)(?![\w-])/g;

function physicalIn(source: string): string[] {
  return [...(source.match(PHYSICAL) ?? []), ...(source.match(PHYSICAL_BARE) ?? [])];
}

describe("chart of accounts — RTL", () => {
  for (const [name, source] of Object.entries(SOURCES)) {
    it(`${name} uses logical insets, never physical left/right ones`, () => {
      expect(physicalIn(source)).toEqual([]);
    });
  }

  it("writes the account code in an explicit LTR island inside the Persian row", () => {
    // A bare `6100` inside an RTL line can render as `0061`-looking runs once
    // adjacent punctuation is involved; the code is an identifier, not prose.
    expect(SECTION).toMatch(/dir="ltr"/);
  });
});

describe("chart of accounts — dark mode", () => {
  it("pairs every semantic colour utility with a dark: counterpart", () => {
    // The *fixed* palette does not follow the theme, so every fixed colour it
    // uses needs an explicit dark counterpart. (Theme tokens — `destructive`,
    // `primary`, `muted`, `border`, … — resolve through CSS variables that
    // already flip with the theme, so they are dark-aware by construction and
    // are deliberately not required to repeat themselves under `dark:`.)
    const fixedPalette = ["amber", "emerald", "red", "rose", "sky", "blue", "green", "yellow"];
    for (const [name, source] of Object.entries(SOURCES)) {
      for (const family of fixedPalette) {
        const light = new RegExp(`(?<![\\w:-])(?:bg|text|border|ring)-${family}(?:-|/|\\b)`);
        const dark = new RegExp(`dark:[\\w./\\[\\]-]*${family}`);
        if (light.test(source)) {
          expect(dark.test(source), `${name} uses ${family}-* without a dark: variant`).toBe(true);
        }
      }
    }
  });

  it("pairs each hand-picked state shade with its dark counterpart", () => {
    // The success notice and the disabled-archive chip are the two places the
    // section leaves the token palette; both must state the dark form too.
    expect(SECTION).toContain("text-emerald-900");
    expect(SECTION).toContain("dark:text-emerald-200");
    expect(SECTION).toContain("dark:border-emerald-500/30");
    // The destructive confirm uses the primitive, which owns its own theming.
    expect(SECTION).toMatch(/variant="destructive"/);
  });

  it("uses theme tokens rather than fixed grays", () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(/(?<![\w-])text-(?:gray|slate|zinc|neutral|stone)-\d{3}/.test(source), name).toBe(false);
      expect(/(?<![\w-])bg-white(?![\\w-])/.test(source), name).toBe(false);
    }
  });
});

describe("chart of accounts — desktop and mobile", () => {
  it("ships a card list for narrow screens alongside the desktop table", () => {
    // The tree used to be a `min-w-[…]` table only: on a phone the account
    // name and its actions were off-screen with no way to reach them.
    expect(SECTION).toMatch(/hidden lg:block|hidden md:block|hidden sm:block/);
    expect(SECTION).toMatch(/lg:hidden|md:hidden|sm:hidden/);
  });

  it("keeps the statement's desktop table and mobile cards in step", () => {
    expect(STATEMENT).toMatch(/hidden lg:block/);
    expect(STATEMENT).toMatch(/lg:hidden/);
  });

  it("reflows the toolbars and dialogs instead of overflowing", () => {
    expect(SECTION).toMatch(/flex-wrap|grid-cols-1|sm:grid-cols|md:grid-cols/);
    expect(SECTION).toMatch(/max-h-\[8\dvh\]|max-h-\[7\dvh\]|max-w-md/);
    expect(STATEMENT).toMatch(/sm:max-h-\[8\dvh\]|max-h-\[88vh\]/);
  });
});

describe("chart of accounts — design-system reuse", () => {
  it("draws its chrome from the shared primitives", () => {
    expect(SECTION).toMatch(/from "@\/app\/dashboard\/page-chrome"/);
    expect(SECTION).toMatch(/SectionCard/);
    expect(SECTION).toMatch(/SearchableSelect/);
    expect(SECTION).toMatch(/OverlayDialog/);
    // The destructive account delete goes through a real confirmed dialog
    // (`DeleteAccountPanel` + `OverlayDialog`), not a native confirm — the
    // whole reason the panel exists is to show the server's own refusal text
    // in place. (`window.confirm` elsewhere in the file is the *unsaved
    // changes* guard, which is the repo-wide convention for that case and is
    // deliberately not asserted against here.)
    expect(SECTION).toMatch(/function DeleteAccountPanel/);
    expect(SECTION).toMatch(/onRemove|setDeleting/);
    expect(SECTION).toMatch(/OverlayDialog/);
  });

  it("labels every icon-only control for screen readers", () => {
    // An icon-only button with no accessible name is invisible to a screen
    // reader and to the RTL keyboard user alike.
    const iconButtons = SECTION.match(/<button[^>]*>\s*<[A-Z]\w*Icon/g) ?? [];
    for (const btn of iconButtons) {
      expect(btn).toMatch(/aria-label=|title=/);
    }
  });

  it("keeps the settings shortcut inside the design system too", () => {
    expect(SETTINGS).toMatch(/InfoBox/);
    expect(SETTINGS).toMatch(/SectionCard/);
    expect(SETTINGS).not.toMatch(/<table/);
    expect(physicalIn(SETTINGS)).toEqual([]);
  });
});
