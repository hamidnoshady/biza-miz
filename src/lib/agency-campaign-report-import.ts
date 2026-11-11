import {
  readCampaignReport,
  type CampaignReportInput,
} from "./agency-campaign-report";

export const CAMPAIGN_IMPORT_FIELDS = [
  "spendRial",
  "impressions",
  "clicks",
  "leadsGenerated",
  "conversions",
  "reach",
  "revenueRial",
] as const;
export type CampaignImportField = (typeof CAMPAIGN_IMPORT_FIELDS)[number];
export type CampaignImportMapping = Partial<
  Record<CampaignImportField, string>
>;
export interface CampaignCsv {
  headers: string[];
  rows: string[][];
}
export const CAMPAIGN_CSV_MAX_BYTES = 1024 * 1024;
export class CampaignImportError extends Error {
  constructor() {
    super("invalid_campaign_csv");
  }
}
/** Strict bounded comma-separated UTF-8 CSV. No guessing locale, delimiter or currency.
 * Quoted commas/newlines and escaped quotes are supported; formulas never execute.
 */
export function parseCampaignCsv(text: string): CampaignCsv {
  if (
    text.includes("\0") ||
    new TextEncoder().encode(text).length > CAMPAIGN_CSV_MAX_BYTES
  )
    throw new CampaignImportError();
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const endCell = () => {
    row.push(cell);
    if (row.length > 100) throw new CampaignImportError();
    cell = "";
    closed = false;
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === "")) records.push(row);
    row = [];
    if (records.length > 1001) throw new CampaignImportError();
  };
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === ",") endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      endRow();
    } else if (ch === '"' && cell === "" && !closed) quoted = true;
    else {
      if (closed || ch === '"' || ch === "\0") throw new CampaignImportError();
      cell += ch;
    }
  }
  if (quoted) throw new CampaignImportError();
  if (cell !== "" || closed || row.length) endRow();
  const headers = records.shift()?.map((h) => h.trim()) ?? [];
  if (
    headers.length === 0 ||
    headers.length > 100 ||
    headers.some((h) => !h || h.length > 200) ||
    new Set(headers).size !== headers.length ||
    records.length === 0 ||
    records.some((r) => r.length !== headers.length)
  )
    throw new CampaignImportError();
  return { headers, rows: records };
}
function integer(
  value: string,
  money: boolean,
  unit: "rial" | "toman",
): number {
  const normalized = value
    .trim()
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632));
  if (!/^\d+$/.test(normalized) || normalized.length > 16)
    throw new CampaignImportError();
  const amount = BigInt(normalized) * (money && unit === "toman" ? 10n : 1n);
  if (amount > 9000000000000000n) throw new CampaignImportError();
  return Number(amount);
}
/** One chosen row only. Never adds overlapping periods or carries CSV attestations/IDs. */
export function mapCampaignCsvRow(
  csv: CampaignCsv,
  rowIndex: number,
  mapping: CampaignImportMapping,
  unit: "rial" | "toman",
  context: Pick<
    CampaignReportInput,
    "periodStart" | "periodEnd" | "evidenceReference" | "attributionNote"
  >,
): CampaignReportInput {
  if (
    !Number.isInteger(rowIndex) ||
    !csv.rows[rowIndex] ||
    !["rial", "toman"].includes(unit)
  )
    throw new CampaignImportError();
  const columns = CAMPAIGN_IMPORT_FIELDS.map((k) => mapping[k]).filter(Boolean);
  if (new Set(columns).size !== columns.length) throw new CampaignImportError();
  const values: Record<string, number | null> = {};
  for (const field of CAMPAIGN_IMPORT_FIELDS) {
    const header = mapping[field];
    const optional = field === "reach" || field === "revenueRial";
    if (!header) {
      if (!optional) throw new CampaignImportError();
      values[field] = null;
      continue;
    }
    const column = csv.headers.indexOf(header);
    if (column < 0) throw new CampaignImportError();
    const raw = csv.rows[rowIndex][column];
    values[field] =
      optional && raw.trim() === ""
        ? null
        : integer(raw, field === "spendRial" || field === "revenueRial", unit);
  }
  return readCampaignReport({
    ...values,
    ...context,
    attributionConfirmed: false,
    supersedesId: null,
  });
}
