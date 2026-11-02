import { describe, expect, it } from "vitest";
import { AI_TOOL_PERMISSION_MAP } from "./ai-capabilities";
import { buildGenUiBlocks, GENUI_MAX_ROWS, GENUI_SOURCES, genUiSource, parseGenUiBlocks } from "./ai-genui";

const aging = (rows: number) => ({
  asOfDate: "2026-10-26",
  rows: Array.from({ length: rows }, (_, i) => ({
    customerId: `c${i}`, customerName: `مشتری ${i}`, current: 1000 * (i + 1), d31_60: 0, d61_90: 0, over90: i === 0 ? 5000 : 0, total: 1000 * (i + 1) + (i === 0 ? 5000 : 0),
  })),
  totals: { current: 9_000_000, d31_60: 1, d61_90: 2, over90: 5000, total: 9_005_003 },
});

describe("GenUI sources", () => {
  it("only names read tools that carry a permission entry", () => {
    for (const source of GENUI_SOURCES) expect(AI_TOOL_PERMISSION_MAP[source.tool], source.id).toBeDefined();
  });

  it("looks a source up by id and refuses anything else", () => {
    expect(genUiSource("ar_aging")?.tool).toBe("get_ar_aging");
    expect(genUiSource("drop table")).toBeNull();
    expect(genUiSource(undefined)).toBeNull();
  });

  it("builds receivables blocks from the real figures, largest debtor first and capped", () => {
    const blocks = buildGenUiBlocks(genUiSource("ar_aging")!, aging(40), "");
    expect(blocks[0]).toMatchObject({ type: "kpi_row" });
    const kpi = blocks[0] as Extract<(typeof blocks)[number], { type: "kpi_row" }>;
    expect(kpi.items[0]).toMatchObject({ kind: "money", value: 9_005_003 });
    expect(kpi.items.find((item) => item.tone === "warn")?.value).toBe(5000);
    const table = blocks[1] as Extract<(typeof blocks)[number], { type: "table" }>;
    expect(table.rows).toHaveLength(GENUI_MAX_ROWS);
    expect(table.rows[0]!.total).toBeGreaterThanOrEqual(table.rows[1]!.total as number);
  });

  it("builds a VAT summary and labels a negative position as refundable", () => {
    const blocks = buildGenUiBlocks(genUiSource("vat_summary")!, {
      outputVat: 100, inputVat: 300, netPayable: -200, vatPayableBalance: 10, vatReceivableBalance: 20,
    }, "");
    const kpi = blocks[0] as Extract<(typeof blocks)[number], { type: "kpi_row" }>;
    expect(kpi.items[2]).toMatchObject({ label: "قابل استرداد", value: 200 });
  });

  it("yields no blocks (not zero-filled ones) when the data has no usable shape", () => {
    expect(buildGenUiBlocks(genUiSource("vat_summary")!, null, "")[0]).toMatchObject({ type: "kpi_row" });
    expect(parseGenUiBlocks("nope")).toEqual([]);
  });
});

describe("parseGenUiBlocks", () => {
  it("drops unknown block types and non-integer money", () => {
    const out = parseGenUiBlocks([
      { type: "html", html: "<script>alert(1)</script>" },
      { type: "kpi_row", items: [{ label: "x", kind: "money", value: 1.5 }, { label: "y", kind: "money", value: 7 }] },
    ]);
    expect(out).toEqual([{ type: "kpi_row", items: [{ label: "y", kind: "money", value: 7 }] }]);
  });

  it("clamps text, rows, columns and block count, and ignores extra keys", () => {
    const long = "ا".repeat(500);
    const out = parseGenUiBlocks([
      {
        type: "table", title: long, href: "javascript:x",
        columns: Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, label: "c", kind: "text" })),
        rows: Array.from({ length: 50 }, () => ({ k0: long })),
      },
      ...Array.from({ length: 10 }, () => ({ type: "bar_list", title: "t", kind: "count", items: [{ label: "a", value: 1 }] })),
    ]);
    expect(out).toHaveLength(4);
    const table = out[0] as Extract<(typeof out)[number], { type: "table" }>;
    expect(table.title.length).toBe(120);
    expect(table.columns).toHaveLength(6);
    expect(table.rows).toHaveLength(GENUI_MAX_ROWS);
    expect(JSON.stringify(table)).not.toContain("javascript");
  });

  it("drops a block whose required parts are missing", () => {
    expect(parseGenUiBlocks([{ type: "table", title: "t", columns: [], rows: [{}] }, { type: "bar_list", title: "t", kind: "money", items: [] }])).toEqual([]);
  });
});
