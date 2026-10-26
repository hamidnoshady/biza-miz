/**
 * Issue #1140 §A3 — Word and Excel attachments, read as text for one turn.
 *
 * A .docx/.xlsx is a ZIP of XML, so the first job is to make the archive safe
 * to open: a small upload must not be able to inflate into gigabytes. Every
 * entry is streamed and counted as it inflates (declared sizes are not
 * trusted), and anything over the caps is refused before a parser sees it.
 * Only then is the text read: Word paragraphs/tables straight from
 * `word/document.xml`, spreadsheets through the existing `xlsxToWorkbook`
 * codec. Nothing is stored, macros and embedded objects are never opened, and
 * every failure returns null so the turn still answers honestly.
 */
import type { Readable } from "node:stream";
import { MAX_PDF_TEXT_CHARS } from "./ai-attachment-limits";
import { xlsxToWorkbook } from "./data-transfer/codecs";
import { formatJalali } from "./jalali";

export const MAX_ZIP_ENTRIES = 500;
export const MAX_ENTRY_INFLATED_BYTES = 20 * 1024 * 1024;
export const MAX_ARCHIVE_INFLATED_BYTES = 40 * 1024 * 1024;
export const MAX_XLSX_SHEETS = 5;
export const MAX_XLSX_ROWS_PER_SHEET = 200;
export const MAX_XLSX_COLUMNS = 30;

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface ExtractedOffice {
  text: string;
  truncated: boolean;
}

type JsZip = import("jszip");
type ZipEntry = import("jszip").JSZipObject;

async function openZip(bytes: Uint8Array): Promise<JsZip | null> {
  const JSZip = (await import("jszip")).default;
  try {
    const zip = await JSZip.loadAsync(bytes);
    return Object.keys(zip.files).length <= MAX_ZIP_ENTRIES ? zip : null;
  } catch {
    return null;
  }
}

/** Inflates one entry, aborting the moment it passes `maxBytes` — whatever its header claims. */
function inflateBounded(entry: ZipEntry, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const stream = entry.nodeStream("nodebuffer") as Readable;
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.pause();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => finish(Buffer.concat(chunks)));
    stream.on("error", () => finish(null));
  });
}

/** True when the whole archive inflates within the per-entry and total caps. */
export async function zipInflatesWithinBounds(bytes: Uint8Array): Promise<boolean> {
  const zip = await openZip(bytes);
  if (!zip) return false;
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const inflated = await inflateBounded(entry, Math.min(MAX_ENTRY_INFLATED_BYTES, MAX_ARCHIVE_INFLATED_BYTES - total));
    if (!inflated) return false;
    total += inflated.length;
  }
  return true;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isSafeInteger(code) && code > 8 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    }
    return XML_ENTITIES[name] ?? match;
  });
}

/** Paragraph, cell and row text of a WordprocessingML body, in reading order. */
export function wordXmlToText(xml: string): string {
  const out: string[] = [];
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
  for (let match = token.exec(xml); match; match = token.exec(xml)) {
    const tag = match[0];
    if (match[1] !== undefined) out.push(decodeXml(match[1]));
    else if (tag.startsWith("<w:tab")) out.push("\t");
    else if (tag === "</w:tc>") out.push(" | ");
    else out.push("\n");
  }
  return out
    .join("")
    .replace(/\n+( \| )/g, "$1")
    .replace(/ \| \n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function capped(text: string, alreadyTruncated = false): ExtractedOffice | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return { text: trimmed.slice(0, MAX_PDF_TEXT_CHARS), truncated: alreadyTruncated || trimmed.length > MAX_PDF_TEXT_CHARS };
}

export async function extractDocxText(bytes: Uint8Array): Promise<ExtractedOffice | null> {
  try {
    const zip = await openZip(bytes);
    const entry = zip?.file("word/document.xml");
    if (!entry) return null;
    const xml = await inflateBounded(entry, MAX_ENTRY_INFLATED_BYTES);
    return xml ? capped(wordXmlToText(xml.toString("utf8"))) : null;
  } catch {
    return null;
  }
}

/** A cell that is an ISO date (what the codec renders a date as) is shown Shamsi, like every date the assistant speaks. */
function cellText(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatJalali(value) : value.replace(/[\t\r\n]+/g, " ");
}

export async function extractXlsxText(bytes: Uint8Array): Promise<ExtractedOffice | null> {
  try {
    if (!(await zipInflatesWithinBounds(bytes))) return null;
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const sheets = await xlsxToWorkbook(copy);
    let truncated = sheets.length > MAX_XLSX_SHEETS;
    const parts: string[] = [];
    for (const sheet of sheets.slice(0, MAX_XLSX_SHEETS)) {
      const table = [sheet.columns, ...sheet.rows];
      if (table.length <= 1 && sheet.columns.every((column) => !column)) continue;
      if (table.length > MAX_XLSX_ROWS_PER_SHEET) truncated = true;
      if (sheet.columns.length > MAX_XLSX_COLUMNS) truncated = true;
      const lines = table
        .slice(0, MAX_XLSX_ROWS_PER_SHEET)
        .map((row) => row.slice(0, MAX_XLSX_COLUMNS).map(cellText).join("\t"));
      parts.push(`[برگه: ${sheet.name}]\n${lines.join("\n")}`);
    }
    return capped(parts.join("\n\n"), truncated);
  } catch {
    return null;
  }
}
