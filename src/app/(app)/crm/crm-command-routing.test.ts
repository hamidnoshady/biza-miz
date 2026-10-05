import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The `?q=` handover from the command field to the directory.
 *
 * Why a source grep rather than a mounted test: the two files below belong to
 * two different screens (the CRM's section router and the shared directory, also
 * used by the store and the team list), and mounting the directory drags its
 * whole API surface, money context and ledger lookups into the test. The regressions
 * that matter here are *lines* — a prop that stops being threaded, a query that
 * stops being applied at once — and those are exactly what a grep can hold.
 *
 * The behaviour those lines produce is asserted where it can be: the command
 * field itself is mounted in `crm-command-field.test.tsx`, and its link is
 * checked to be `/crm/directory?q=…` there.
 */

const DIR = readFileSync(fileURLToPath(new URL("./directory-section.tsx", import.meta.url)), "utf8");
const DIRECTORY = readFileSync(
  fileURLToPath(new URL("../../dashboard/parties/parties-section.tsx", import.meta.url)),
  "utf8",
);

describe("the CRM's ?q= deep link", () => {
  it("reads the query string as the starting search", () => {
    expect(DIR).toContain('searchParams.get("q")');
    expect(DIR).toContain("initialQuery={initialQuery}");
  });

  it("remounts the directory when the word changes", () => {
    // Next re-renders the section in place for a query-string-only change, and
    // state seeded once would keep showing the previous word's results.
    expect(DIR).toMatch(/key=\{initialQuery\}/);
  });

  it("makes a deep-linked search land applied, not pending", () => {
    // «already applied» is the whole point: a `?q=` link that spent the
    // debounce looking ignored would read as a broken link.
    expect(DIRECTORY).toContain("useState(initialQuery ?? \"\")");
    // Both the box and the server query — one initialiser each.
    expect(DIRECTORY.match(/useState\(initialQuery \?\? ""\)/g)).toHaveLength(2);
  });
});
