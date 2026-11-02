/**
 * Issue #1140 §A4 — controlled Generative UI.
 *
 * The assistant never writes UI. It picks a registered *source* by id; the
 * server runs that source's existing read tool as the signed-in member (so the
 * tool's own permission check applies), and a pure builder here turns the real
 * result into a small, closed set of blocks the browser knows how to draw. A
 * model therefore cannot invent a total, a column, a link or any markup: it
 * supplies a source id and at most a short title.
 *
 * This module is client-safe on purpose (no database, no `node:` imports): the
 * server builds blocks with it and the browser re-validates them with
 * `parseGenUiBlocks` before drawing, so a malformed or tampered payload renders
 * nothing rather than something unexpected.
 */

export type GenUiValueKind = "money" | "count" | "text";

export type GenUiBlock =
  | { type: "kpi_row"; items: Array<{ label: string; kind: GenUiValueKind; value: number | string; tone?: "default" | "warn" }> }
  | {
      type: "table";
      title: string;
      columns: Array<{ key: string; label: string; kind: GenUiValueKind }>;
      rows: Array<Record<string, number | string>>;
    }
  | { type: "bar_list"; title: string; kind: GenUiValueKind; items: Array<{ label: string; value: number }> };

export const GENUI_MAX_BLOCKS = 4;
export const GENUI_MAX_ROWS = 15;
export const GENUI_MAX_COLUMNS = 6;
export const GENUI_MAX_KPIS = 6;
export const GENUI_MAX_BARS = 8;
const MAX_TEXT = 120;

export interface GenUiSource {
  id: string;
  label: string;
  /** The existing read tool that supplies the data; its permission applies. */
  tool: string;
  build: (data: unknown, title: string) => GenUiBlock[];
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const rialOf = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) ? n : 0;
};
const textOf = (value: unknown): string => (typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "");

const AGING_BUCKETS = [
  { key: "current", label: "جاری" },
  { key: "d31_60", label: "۳۱ تا ۶۰ روز" },
  { key: "d61_90", label: "۶۱ تا ۹۰ روز" },
  { key: "over90", label: "بیش از ۹۰ روز" },
] as const;

function agingBlocks(data: unknown, title: string, nameKey: "customerName" | "supplierName", rowsKey: "rows" | "suppliers"): GenUiBlock[] {
  const root = obj(data);
  const totals = obj(root.totals);
  const rows = Array.isArray(root[rowsKey]) ? (root[rowsKey] as unknown[]) : [];
  const blocks: GenUiBlock[] = [{
    type: "kpi_row",
    items: [
      { label: "جمع مانده", kind: "money", value: rialOf(totals.total) },
      ...AGING_BUCKETS.map((bucket) => ({
        label: bucket.label, kind: "money" as const, value: rialOf(totals[bucket.key]),
        ...(bucket.key === "over90" && rialOf(totals.over90) > 0 ? { tone: "warn" as const } : {}),
      })),
    ],
  }];
  const top = rows
    .map(obj)
    .filter((row) => rialOf(row.total) > 0)
    .sort((a, b) => rialOf(b.total) - rialOf(a.total))
    .slice(0, GENUI_MAX_ROWS);
  if (top.length) {
    blocks.push({
      type: "table",
      title,
      columns: [
        { key: "name", label: nameKey === "customerName" ? "مشتری" : "تأمین‌کننده", kind: "text" },
        { key: "current", label: "جاری", kind: "money" },
        { key: "over90", label: "بیش از ۹۰ روز", kind: "money" },
        { key: "total", label: "جمع", kind: "money" },
      ],
      rows: top.map((row) => ({
        name: textOf(row[nameKey]) || "—",
        current: rialOf(row.current),
        over90: rialOf(row.over90),
        total: rialOf(row.total),
      })),
    });
  }
  return blocks;
}

/** The closed catalogue. Adding a source means a read tool that already exists plus a builder here. */
export const GENUI_SOURCES: readonly GenUiSource[] = [
  {
    id: "ar_aging",
    label: "قدمت مطالبات",
    tool: "get_ar_aging",
    build: (data, title) => agingBlocks(data, title || "بدهکارترین مشتریان", "customerName", "rows"),
  },
  {
    id: "ap_aging",
    label: "قدمت بدهی‌ها به تأمین‌کنندگان",
    tool: "get_ap_upcoming",
    build: (data, title) => agingBlocks(data, title || "بیشترین بدهی به تأمین‌کنندگان", "supplierName", "suppliers"),
  },
  {
    id: "vat_summary",
    label: "خلاصهٔ مالیات بر ارزش افزوده",
    tool: "get_vat_liability",
    build: (data) => {
      const report = obj(data);
      const net = rialOf(report.netPayable);
      return [
        {
          type: "kpi_row",
          items: [
            { label: "مالیات فروش", kind: "money", value: rialOf(report.outputVat) },
            { label: "مالیات خرید", kind: "money", value: rialOf(report.inputVat) },
            { label: net >= 0 ? "قابل پرداخت" : "قابل استرداد", kind: "money", value: Math.abs(net), ...(net > 0 ? { tone: "warn" as const } : {}) },
          ],
        },
        {
          type: "bar_list",
          title: "مانده حساب‌های مالیاتی",
          kind: "money",
          items: [
            { label: "مالیات پرداختنی", value: rialOf(report.vatPayableBalance) },
            { label: "مالیات دریافتنی", value: rialOf(report.vatReceivableBalance) },
          ],
        },
      ];
    },
  },
];

export const GENUI_SOURCE_IDS = GENUI_SOURCES.map((source) => source.id);

export function genUiSource(id: unknown): GenUiSource | null {
  return typeof id === "string" ? GENUI_SOURCES.find((source) => source.id === id) ?? null : null;
}

/** Builds and validates in one step; what leaves the server has passed the same gate the browser applies. */
export function buildGenUiBlocks(source: GenUiSource, data: unknown, rawTitle: unknown): GenUiBlock[] {
  return parseGenUiBlocks(source.build(data, textOf(rawTitle)));
}

const KINDS = new Set<GenUiValueKind>(["money", "count", "text"]);
const kindOf = (value: unknown): GenUiValueKind | null => (KINDS.has(value as GenUiValueKind) ? (value as GenUiValueKind) : null);
const cellOf = (value: unknown): number | string | null => {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string") return value.slice(0, MAX_TEXT);
  return null;
};

/**
 * Strict allowlist parse. Unknown block types, unknown keys, over-long text,
 * non-integer money and oversize lists are dropped (a whole block is dropped
 * rather than half-drawn). Returns only blocks that are safe to render.
 */
export function parseGenUiBlocks(raw: unknown): GenUiBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: GenUiBlock[] = [];
  for (const candidate of raw.slice(0, GENUI_MAX_BLOCKS)) {
    const block = obj(candidate);
    if (block.type === "kpi_row" && Array.isArray(block.items)) {
      const items: Extract<GenUiBlock, { type: "kpi_row" }>["items"] = [];
      for (const entry of block.items.slice(0, GENUI_MAX_KPIS)) {
        const item = obj(entry);
        const kind = kindOf(item.kind);
        const value = cellOf(item.value);
        const label = textOf(item.label);
        if (!kind || value === null || !label) continue;
        items.push({ label, kind, value, ...(item.tone === "warn" ? { tone: "warn" as const } : {}) });
      }
      if (items.length) out.push({ type: "kpi_row", items });
    } else if (block.type === "table" && Array.isArray(block.columns) && Array.isArray(block.rows)) {
      const columns: Extract<GenUiBlock, { type: "table" }>["columns"] = [];
      for (const entry of block.columns.slice(0, GENUI_MAX_COLUMNS)) {
        const column = obj(entry);
        const kind = kindOf(column.kind);
        const key = textOf(column.key);
        const label = textOf(column.label);
        if (kind && key && label) columns.push({ key, label, kind });
      }
      const rows = block.rows.slice(0, GENUI_MAX_ROWS).map((rowRaw) => {
        const row = obj(rowRaw);
        const clean: Record<string, number | string> = {};
        for (const column of columns) {
          const cell = cellOf(row[column.key]);
          clean[column.key] = cell ?? (column.kind === "text" ? "—" : 0);
        }
        return clean;
      });
      const title = textOf(block.title);
      if (columns.length && rows.length && title) out.push({ type: "table", title, columns, rows });
    } else if (block.type === "bar_list" && Array.isArray(block.items)) {
      const kind = kindOf(block.kind);
      const title = textOf(block.title);
      const items = block.items.slice(0, GENUI_MAX_BARS).flatMap((entry) => {
        const item = obj(entry);
        const label = textOf(item.label);
        const value = typeof item.value === "number" && Number.isSafeInteger(item.value) ? item.value : null;
        return label && value !== null ? [{ label, value }] : [];
      });
      if (kind && title && items.length) out.push({ type: "bar_list", title, kind, items });
    }
  }
  return out;
}
