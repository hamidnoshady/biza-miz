/**
 * The executable half of docs/design-system.md's "Checking your work".
 *
 * The dashboard's look is its primitives (`page-chrome.tsx`, `section-nav.tsx`,
 * `ui.tsx`, `components/ui`) plus a short list of banned patterns — cool
 * neutrals, heavy shadows, hand-rolled page shells and card skins, spinners
 * where a skeleton belongs, a bare `<h1>`, and light-only colour classes (dark
 * mode IS supported: colours come from the theme tokens, which flip, plus
 * paired `dark:` shades — a hardcoded light colour with no token/no `dark:`
 * counterpart is the thing that must not drift back). Prose alone didn't hold
 * the line: this test greps every non-test file under `src/app/dashboard` on
 * every `npm test` run, so drift fails the suite instead of waiting for a
 * review to catch it.
 *
 * There is no baseline any more: every rule below passes on every file, so a
 * violation anywhere fails the run. (The sister test `src/app/design-lint.test.ts`
 * holds the same line for the tenant-facing realms outside the dashboard —
 * login, welcome, setup, invite, consent and the shared `src/components` — so
 * a business type's screens cannot drift from حسابداری's look either.)
 *
 * Rules and recipes: docs/design-system.md. Composition rules:
 * docs/ui-conventions.md.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const DASHBOARD_DIR = fileURLToPath(new URL("./", import.meta.url));
const APP_DIR = resolve(DASHBOARD_DIR, "..");

interface Rule {
  id: string;
  /** What the ban is, and what to write instead. */
  why: string;
  pattern: RegExp;
  /** Restrict the rule to certain files (e.g. only `page.tsx` routes). */
  fileFilter?: (relPath: string) => boolean;
  /**
   * Files exempt from the rule: the primitive that *defines* the pattern.
   * Drift baselines are gone — an entry here must be a definition, not a use.
   */
  allowed: readonly string[];
  /**
   * Colour rules for dark mode: a light class only violates on a line that has
   * no `dark:` counterpart (a properly paired light+dark flips correctly), and
   * QR-code images are allowed to keep `bg-white` for scannability.
   */
  darkMode?: boolean;
}

/**
 * The exact card skin from `cardClass` (`rounded-2xl border border-border/80 …
 * bg-card`, with or without the interleaved shadow — or its borderless
 * `rounded-2xl bg-card` shorthand), restated instead of composing
 * `cardClass`/`SectionCard`. Tinted surfaces that rearrange the pieces (amber
 * banners, dashed panels) are bespoke layout, not this rule.
 */
const CARD_SKIN =
  /rounded-2xl border border-border\/80(?: shadow-\[0_1px_2px_rgb\(41_37_36\/0\.035\)\])? bg-card|(?<![\w-])rounded-2xl bg-card\b/;

const RULES: readonly Rule[] = [
  {
    id: "cool neutrals",
    why: "Neutrals are the warm stone scale; gray/slate/zinc/neutral read as a different product. Use stone-* or the tokens (docs/design-system.md §Colour roles).",
    pattern: /[a-z:-]-(?:gray|slate|zinc|neutral)-\d{2,3}/,
    allowed: [],
  },
  {
    id: "heavy shadows",
    why: "Cards carry exactly one warm 1px shadow (cardClass's 0 1px 2px rgb(41 37 36/0.035)); a floating panel composes overlayPanelClass/popoverPanelClass instead of shadow-sm/md/lg. See docs/design-system.md §Weight, §Floating surfaces.",
    pattern: /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl)\b/,
    allowed: [
      // Defines overlayPanelClass/popoverPanelClass and names the banned
      // spellings in its doc comments.
      "page-chrome.tsx",
      // The actual definitions, split out of page-chrome.tsx (which
      // re-exports them) so tab-bar.tsx's "use client" module and
      // page-chrome.tsx's server-safe module can both import cardClass
      // without an import cycle.
      "page-chrome-styles.ts",
    ],
  },
  {
    id: "hand-rolled page shell",
    why: "The page canvas is <PageShell>; a second `mx-auto w-full max-w-[…]` spelling drifts the column. docs/design-system.md §Page frame.",
    pattern: /mx-auto w-full max-w-\[/,
    allowed: [
      // Defines PageShell.
      "page-chrome.tsx",
    ],
  },
  {
    id: "hand-rolled card chrome",
    why: "The card skin is cardClass/<SectionCard>; restating `rounded-2xl border border-border/80 … bg-card` forks it, and a restyle then misses the fork. Compose cardClass instead (docs/design-system.md §Page frame, §Weight).",
    pattern: CARD_SKIN,
    allowed: [
      // Defines cardClass.
      "page-chrome.tsx",
      // The actual definition — see the "heavy shadows" rule above for why
      // it moved out of page-chrome.tsx.
      "page-chrome-styles.ts",
    ],
  },
  {
    id: "bare <h1> on a page route",
    why: "A page's title is <PageHeader>; a bare <h1> forks the header's spacing and rule. docs/design-system.md §Page frame.",
    pattern: /<h1/,
    fileFilter: (relPath) => relPath.endsWith("/page.tsx"),
    allowed: [],
  },
  {
    id: "light-only warm neutrals (dark mode)",
    why: "Dark mode is supported: stone-* neutrals must use the theme tokens (bg-card, text-foreground, border-border, muted, …) which flip automatically. A residual hardcoded stone-* class with no token/dark: counterpart renders a light chip on a dark surface. Convert it to a token or add a dark: pair (docs/ui-conventions.md §Dark mode).",
    pattern:
      /(?:(?:[a-z-]+:)*!?)(?:bg|text|border|ring|divide|from|to|via|decoration|caret)-stone-\d{2,3}/,
    allowed: [],
    darkMode: true,
  },
  {
    id: "light-only accent/status colours (dark mode)",
    why: "Dark mode is supported: amber (brand) and emerald/rose/red/sky status colours keep their hue but need a light-on-dark shade. A hardcoded amber/emerald/rose/red/sky colour class with no dark: counterpart is unreadable in dark mode. Pair it with a dark: shade (docs/ui-conventions.md §Dark mode). A solid amber fill intentionally keeps dark amber text (text-amber-950) in both themes.",
    pattern:
      /(?:(?:[a-z-]+:)*!?)(?:text|bg|border|ring|divide)-(?:amber|emerald|rose|red|sky)-(?:50|100|200|300|400|500|600|700|800|900|950)(?![\w/-])/,
    allowed: [],
    darkMode: true,
  },
  {
    id: "raw hex colours",
    why: "Hex classes are the old dialect's spelling of the tokens — they dodge restyles and drift from the palette. Write the stone/amber/emerald/destructive tokens instead (mapping table: docs/design-system.md §The old look).",
    pattern: /[a-z]+-\[#(?:[0-9a-fA-F]{3,8})\]|(?:fill|stroke)="#[0-9a-fA-F]{3,8}"/,
    allowed: [],
  },
  {
    id: "raw bg-white surfaces",
    why: "bg-card is the token for a surface; a raw bg-white spelled outside the theme misses it. Use bg-card (it flips to dark). Washes may stay (bg-white/80); solid surfaces must not. The only intentional exception is a TOTP/QR image, which stays white in both themes so it stays scannable.",
    pattern: /\bbg-white\b(?!\/)/,
    allowed: [],
    darkMode: true,
  },
  {
    id: "rgba shadow spelling",
    why: "The shadow ink is written `rgb(41_37_36/…)` (and `rgb(120_53_15/…)` for the amber pill); a comma-rgba spelling is the same colour in a private dialect. Write the token spelling or compose cardClass.",
    pattern: /rgba\((?:37,\s*37,\s*34|41,\s*37,\s*36|120,\s*53,\s*15),/,
    allowed: [],
  },
  {
    id: "spinner loading",
    why: "Loading is a skeleton (LoadingSkeleton/SectionCardSkeleton/KpiRowSkeleton for regions) and a busy label («در حال ثبت…») for actions; animate-spin is not part of the motion budget (docs/design-system.md §Charts and loading).",
    pattern: /animate-spin/,
    allowed: [],
  },
  {
    id: "bare loading copy",
    why: "Data-loading regions reserve their final shape with LoadingSkeleton/SectionCardSkeleton instead of showing a lone progress sentence (docs/design-system.md §Charts and loading). A spoken label belongs on the skeleton's aria-label, not on a visible sentence.",
    pattern: /<(?:p|div|span)\b[^>]*>\s*در حال (?:بارگذاری|خواندن|جستجو|جست‌وجو|محاسبه|آماده‌سازی پیش‌نمایش)[^<{]*</,
    allowed: [],
  },
];

/** relPath (posix) of every non-test .ts/.tsx file under src/app/dashboard. */
function collectFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry) || entry.includes(".test.")) continue;
      files.push(relative(DASHBOARD_DIR, full).split(sep).join("/"));
    }
  }
  walk(DASHBOARD_DIR);
  return files.sort();
}

interface Violation {
  relPath: string;
  line: number;
  matched: string;
}

function scan(rule: Rule, relPath: string, content: string): Violation[] {
  if (rule.fileFilter && !rule.fileFilter(relPath)) return [];
  const violations: Violation[] = [];
  if (rule.darkMode) {
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const match of line.matchAll(new RegExp(rule.pattern.source, "g"))) {
        // A properly paired light+dark class flips correctly, so a line that
        // already carries a dark: counterpart is fine.
        if (line.includes("dark:")) continue;
        // QR-code images keep bg-white in both themes for scannability (the
        // <img src={…totpQr}> sits a couple of lines above the class).
        if (/bg-white/.test(match[0])) {
          const nearby = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
          if (/totpQr/.test(nearby)) continue;
        }
        violations.push({ relPath, line: i + 1, matched: match[0] });
      }
    });
    return violations;
  }
  for (const match of content.matchAll(new RegExp(rule.pattern.source, "g"))) {
    violations.push({
      relPath,
      line: content.slice(0, match.index).split("\n").length,
      matched: match[0],
    });
  }
  return violations;
}

function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `  ${v.relPath}:${v.line}  ${v.matched}`).join("\n");
}

/**
 * Does this file, or any dashboard file it imports (4 hops deep), mention
 * `PageShell`? The page frame may live in the manager a route delegates to
 * (`overview/page.tsx` → `dashboard-overview.tsx`) — but it must exist
 * somewhere in the route's own import graph, or the page is a frameless sheet
 * that no longer looks like the rest of the product.
 */
function frameProviderInImportGraph(absPath: string): boolean {
  const queue: { file: string; depth: number }[] = [{ file: absPath, depth: 0 }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    if (/PageShell/.test(source)) return true;
    if (depth >= 4) continue;
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      const spec = match[1];
      let base: string | null = null;
      if (spec.startsWith(".")) base = resolve(dirname(file), spec);
      else if (spec.startsWith("@/app/dashboard/")) base = join(APP_DIR, "dashboard", spec.slice("@/app/dashboard/".length));
      if (!base || base.includes(`${sep}components${sep}`)) continue;
      for (const ext of ["", ".tsx", ".ts"]) {
        if (existsSync(base + ext)) queue.push({ file: base + ext, depth: depth + 1 });
      }
    }
  }
  return false;
}

describe("design lint — docs/design-system.md banned patterns in src/app/dashboard", () => {
  const files = collectFiles();
  const contents = new Map(files.map((relPath) => [relPath, readFileSync(join(DASHBOARD_DIR, relPath), "utf8")]));

  it("scans a plausible number of files (guards against a broken walk)", () => {
    // The dashboard holds several hundred .ts/.tsx files; a walk that finds a
    // handful means the glob broke and every rule below would silently pass.
    expect(files.length).toBeGreaterThan(50);
  });

  for (const rule of RULES) {
    it(`bans ${rule.id}`, () => {
      const violations = files
        .filter((relPath) => !rule.allowed.includes(relPath))
        .flatMap((relPath) => scan(rule, relPath, contents.get(relPath)!));

      const detail = formatViolations(violations);
      expect(
        detail,
        [
          `Design-system violation: ${rule.id} in ${violations.length} place(s).`,
          `Why: ${rule.why}`,
          "Violations:",
          detail || "  (none)",
          "",
          "Fix the classes per docs/design-system.md — the dashboard's design",
          "lint keeps no baseline, so every file must pass every rule.",
        ].join("\n"),
      ).toBe("");
    });
  }

  it("every page route carries the design-system frame", () => {
    const frameless: string[] = [];
    for (const relPath of files.filter((f) => f.endsWith("/page.tsx"))) {
      const source = contents.get(relPath)!;
      // Legacy URLs that only forward somewhere else have nothing to frame.
      if (/redirect\(/.test(source)) continue;
      if (/PageShell/.test(source)) continue;
      if (!frameProviderInImportGraph(join(DASHBOARD_DIR, relPath))) {
        frameless.push(relPath);
      }
    }

    expect(
      frameless.join("\n"),
      [
        "Dashboard pages without the design-system frame:",
        frameless.join("\n"),
        "",
        "A realm-1 page composes <PageShell>/<PageHeader> (page-chrome.tsx),",
        "directly or through the manager it renders. A full-screen operational",
        "surface (POS, KDS) still mounts <PageShell> around its dense chrome.",
        "See docs/design-system.md §Realms and §Page frame.",
      ].join("\n"),
    ).toBe("");
  });
});
