/**
 * Keeps `docs/accounting-workspace-ia.md` honest about the divisions it draws.
 *
 * That document is where a reader learns how the ledger's tools are arranged,
 * and its divisions table is a **hand-written copy** of
 * `LEDGER_WORKSPACE_SUBGROUPS` — the one list the workspace page, the in-page
 * chip rail and the permission helper are all derived from. A copy can only rot
 * one way: quietly. The table had already drifted before this guard existed
 * (voucher numbering, opening balances and the taxpayer register were missing,
 * and two rows quoted labels the app no longer shows), and nothing failed.
 *
 * So this test compares the two, in both directions:
 *
 *  - every division in the code is a row in the table, quoting that division's
 *    sections **by the app's own labels, in the app's own order**, so a screen
 *    and the document that describes it cannot disagree about what a tool is
 *    called;
 *  - the table holds no division the code does not have, so a removed division
 *    cannot stay documented as if it still existed.
 *
 * It deliberately reads the document rather than the source: the risk here is a
 * false claim in the canon, not a bad constant.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCOUNTING_SECTIONS } from "./accounting-nav";
import { LEDGER_WORKSPACE_SUBGROUPS, LEDGER_WORKSPACE_SECTION_KEYS } from "./accounting-workspace";

const REPO_DIR = join(fileURLToPath(new URL("./", import.meta.url)), "..", "..", "..", "..");
const DOC_PATH = join(REPO_DIR, "docs", "accounting-workspace-ia.md");

/** The label the app itself shows for a ledger tool. */
function labelOf(key: string): string {
  const section = ACCOUNTING_SECTIONS.find((candidate) => candidate.key === key);
  if (!section) throw new Error(`unknown accounting section: ${key}`);
  return section.label;
}

/** The `| division | sections |` table's body rows, as trimmed cells. */
function divisionRows(): string[][] {
  const lines = readFileSync(DOC_PATH, "utf8").replaceAll("\r\n", "\n").split("\n");
  const header = lines.findIndex((line) => line.trim() === "| division | sections |");
  expect(header, "docs/accounting-workspace-ia.md no longer has a divisions table").toBeGreaterThan(-1);

  const body: string[] = [];
  for (const line of lines.slice(header + 1)) {
    // The table ends at the first line that is not a row — the document has
    // other tables further down, and they are not this one's business.
    if (!line.trim().startsWith("|")) break;
    body.push(line);
  }

  return body
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    // The `| --- | --- |` rule under the header is not a division.
    .filter((cells) => cells.some((cell) => !/^-{2,}$/.test(cell)));
}

describe("the accounting workspace document's divisions", () => {
  it("quotes every division, and every tool in it, by the labels the app shows", () => {
    const rows = divisionRows();
    const documented = new Map(rows.map((cells) => [cells[0], cells[1]?.split("،").map((tool) => tool.trim())]));

    for (const subGroup of LEDGER_WORKSPACE_SUBGROUPS) {
      const tools = documented.get(subGroup.label);
      expect(tools, `«${subGroup.label}» is missing from the divisions table`).toBeDefined();
      expect(tools, `«${subGroup.label}» lists the wrong tools`).toEqual(subGroup.keys.map(labelOf));
    }

    // …and nothing else: a division removed from the code must leave the table.
    expect(rows.map((cells) => cells[0])).toEqual(LEDGER_WORKSPACE_SUBGROUPS.map((subGroup) => subGroup.label));
  });

  it("names every ledger tool somewhere, so a new one is never invisible", () => {
    // Weaker than the table, and deliberately so: this only asks that the
    // document mentions the tool at all. It catches the tool that is added,
    // shipped and never written down.
    const doc = readFileSync(DOC_PATH, "utf8").replaceAll("\r\n", "\n");
    const unnamed = LEDGER_WORKSPACE_SECTION_KEYS.filter((key) => !doc.includes(labelOf(key)));
    expect(unnamed, `ledger tools missing from the document: ${unnamed.join(", ")}`).toEqual([]);
  });
});
