/**
 * Issue #908, phase D — importing an existing document into the contract editor.
 *
 * ## What this is, and what it refuses to be
 *
 * Plenty of real contracts start life as a Word file or a PDF somebody was
 * e-mailed. The epic asks for "import DOCX/PDF", and the honest version of that
 * is: **read the document, produce editable blocks, say exactly what could not
 * be carried over.** Not "convert perfectly", and certainly not a button that
 * uploads a file and pretends.
 *
 * So both readers are deliberately partial, and every partiality is a warning
 * the editor shows:
 *
 *   - **DOCX** — the archive is opened with the same bounded inflation the AI
 *     attachment reader uses (`openBoundedZip`/`inflateBoundedEntry` from
 *     `ai-office-extract.ts`), because a 40 KB upload must not be able to
 *     inflate into gigabytes before a parser sees it. From `word/document.xml`
 *     we read the block structure only: headings (a heading style or an
 *     outline level), paragraphs, bullet and numbered lists (through
 *     `word/numbering.xml`, so a bulleted list does not come back numbered),
 *     tables (first row = header, which is what the block model requires) and
 *     page breaks. Bold/italic runs, colours, images, headers, footnotes,
 *     comments and tracked changes are **dropped**, and the result says so.
 *   - **PDF** — a text-layer reader, not an OCR engine. It unwraps FlateDecode
 *     streams and maps glyph codes through each font's `ToUnicode` CMap, which
 *     is what makes a Persian PDF produced by a modern tool readable at all
 *     (those files are Identity-H: two bytes per glyph, meaningless without the
 *     CMap). A scanned page has no text at all, and then this refuses with
 *     «متن قابل استخراج ندارد» rather than returning an empty document: an
 *     import that silently yields nothing is worse than an error, because the
 *     sender would sign a blank page thinking it was the contract.
 *
 * ## Where the bytes go
 *
 * Nowhere. The file is read in the request, turned into blocks, and dropped —
 * this module returns data and stores nothing. The original is not archived in
 * the Media Library, and that is deliberate rather than an omission: filing it
 * would need object storage to be configured, which would make import fail on a
 * fresh install for a reason that has nothing to do with import. What is signed
 * is the contract's own frozen version, and that is the record.
 *
 * Server-only (`node:crypto`, `node:zlib`, jszip). Nothing here is imported by
 * a component; the editor calls the route and receives blocks.
 */
import { createHash } from "node:crypto";
import { inflateRawSync, inflateSync } from "node:zlib";
import { inflateBoundedEntry, openBoundedZip } from "../ai-office-extract";
import {
  CONTRACT_LIMITS,
  normalizeContractContent,
  type ContractBlock,
  type ContractDocumentContent,
} from "./blocks";

/** A contract body is text; 5 MB of DOCX is already an enormous one. */
export const CONTRACT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** `word/document.xml` and every PDF stream are capped, like the AI reader's caps. */
export const CONTRACT_IMPORT_MAX_INFLATED_BYTES = 20 * 1024 * 1024;

export const CONTRACT_IMPORT_FORMATS = ["docx", "pdf"] as const;
export type ContractImportFormat = (typeof CONTRACT_IMPORT_FORMATS)[number];

export const CONTRACT_IMPORT_FORMAT_LABELS: Record<ContractImportFormat, string> = {
  docx: "Word (.docx)",
  pdf: "PDF",
};

export type ContractImportErrorCode =
  | "file_too_large"
  | "unsupported_format"
  | "docx_unreadable"
  | "pdf_unreadable"
  | "pdf_no_text_layer"
  | "empty_document";

export interface ContractImportStats {
  headings: number;
  paragraphs: number;
  lists: number;
  tables: number;
  pageBreaks: number;
  /** Characters of text carried over, after trimming. */
  characters: number;
}

export interface ContractImportSuccess {
  ok: true;
  content: ContractDocumentContent;
  source: {
    format: ContractImportFormat;
    fileName: string;
    byteSize: number;
    sha256: string;
  };
  stats: ContractImportStats;
  /** Persian, ready to show: what could not be carried over. Never empty. */
  warnings: string[];
}

export interface ContractImportFailure {
  ok: false;
  error: ContractImportErrorCode;
  detail: string;
}

export type ContractImportResult = ContractImportSuccess | ContractImportFailure;

/* ===========================================================================
 * Shared helpers
 * ======================================================================== */

function emptyStats(): ContractImportStats {
  return { headings: 0, paragraphs: 0, lists: 0, tables: 0, pageBreaks: 0, characters: 0 };
}

/**
 * `&amp;` and friends. Word escapes its text aggressively, and a document full
 * of `&amp;` is a document whose clauses read wrong.
 */
function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    return named[entity] ?? match;
  });
}

/** Collapses runs of whitespace the way a printed paragraph would. */
function tidy(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Every block needs an id the normalizer accepts, unique inside the document. */
function makeIds(): () => string {
  let n = 0;
  return () => `imp_${(n += 1).toString(36)}`;
}

/**
 * A generous but finite cap on one text value. Word paragraphs can hold a whole
 * section; the block model caps at 8000 characters, and a silent slice there
 * would lose the end of a clause, so the importer splits instead — see
 * `textBlocks`.
 */
function textBlocks(
  nextId: () => string,
  type: "heading" | "paragraph",
  value: string,
): ContractBlock[] {
  const text = tidy(value);
  if (!text) return [];
  if (text.length <= CONTRACT_LIMITS.textMax) return [{ id: nextId(), type, text }];
  // Split on paragraph boundaries first, then on a space near the limit, so no
  // word is cut in half. The editor shows these as consecutive blocks.
  const parts: string[] = [];
  let rest = text;
  while (rest.length > CONTRACT_LIMITS.textMax) {
    const window = rest.slice(0, CONTRACT_LIMITS.textMax);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > CONTRACT_LIMITS.textMax * 0.6 ? cut : CONTRACT_LIMITS.textMax;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean).map((part) => ({ id: nextId(), type, text: part }));
}

/* ===========================================================================
 * DOCX
 * ======================================================================== */

interface DocxParagraph {
  text: string;
  style: string;
  outlineLevel: number | null;
  numId: string | null;
  numLevel: number;
  pageBreak: boolean;
}

/** `<w:p …>` … `</w:p>` and `<w:tbl …>` … `</w:tbl>` at the body's top level. */
interface DocxElement {
  kind: "p" | "tbl";
  xml: string;
}

/**
 * Walks the body and yields its top-level paragraphs and tables in order.
 *
 * A regex over `<w:p>` cannot do this: a table CONTAINS paragraphs, and a cell's
 * paragraphs are not body paragraphs. Counting nesting as we scan is what keeps
 * table text inside the table.
 */
function topLevelElements(documentXml: string): DocxElement[] {
  const bodyStart = documentXml.indexOf("<w:body");
  const body = bodyStart >= 0 ? documentXml.slice(bodyStart) : documentXml;
  const elements: DocxElement[] = [];
  const tag = /<(\/?)(w:p|w:tbl)(\s[^>]*?)?(\/?)>/g;
  let open: { kind: "p" | "tbl"; start: number; depth: number } | null = null;
  for (let match = tag.exec(body); match; match = tag.exec(body)) {
    const [full, closing, name, , selfClosing] = match;
    const kind = name === "w:p" ? "p" : "tbl";
    if (selfClosing) {
      if (!open) elements.push({ kind, xml: full });
      continue;
    }
    if (!closing) {
      if (!open) open = { kind, start: match.index, depth: 1 };
      else open.depth += 1;
      continue;
    }
    if (!open) continue;
    open.depth -= 1;
    if (open.depth > 0) continue;
    elements.push({ kind: open.kind, xml: body.slice(open.start, match.index + full.length) });
    open = null;
  }
  return elements;
}

function paragraphOf(xml: string): DocxParagraph {
  let text = "";
  let pageBreak = false;
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/?>/g;
  for (let match = token.exec(xml); match; match = token.exec(xml)) {
    if (match[1] !== undefined) text += decodeXml(match[1]);
    else if (match[0].startsWith("<w:tab")) text += " ";
    else if (match[0].includes('w:type="page"')) pageBreak = true;
    else text += "\n";
  }
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(xml)?.[1] ?? "";
  const outline = /<w:outlineLvl\s+w:val="(\d+)"/.exec(xml);
  const numPr = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(xml)?.[1] ?? "";
  const numId = /<w:numId\s+w:val="(\d+)"/.exec(numPr)?.[1] ?? null;
  const numLevel = Number(/<w:ilvl\s+w:val="(\d+)"/.exec(numPr)?.[1] ?? "0");
  return {
    text,
    style,
    outlineLevel: outline ? Number(outline[1]) : null,
    // `numId="0"` is Word's way of saying "not in a list".
    numId: numId && numId !== "0" ? numId : null,
    numLevel: Number.isFinite(numLevel) ? numLevel : 0,
    pageBreak,
  };
}

/** Cells of one `w:tr`, each cell's paragraphs joined with a space. */
function rowCells(rowXml: string): string[] {
  const cells: string[] = [];
  const cell = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
  for (let match = cell.exec(rowXml); match; match = cell.exec(rowXml)) {
    const inner = match[1];
    const paragraphs: string[] = [];
    const p = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
    for (let m = p.exec(inner); m; m = p.exec(inner)) {
      const { text } = paragraphOf(`<w:p>${m[1]}</w:p>`);
      const tidied = tidy(text);
      if (tidied) paragraphs.push(tidied);
    }
    cells.push(paragraphs.join(" "));
  }
  return cells;
}

function tableRows(tableXml: string): string[][] {
  const rows: string[][] = [];
  const row = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  for (let match = row.exec(tableXml); match; match = row.exec(tableXml)) {
    rows.push(rowCells(match[1]));
  }
  return rows;
}

/**
 * `numId` + level → `bullet` or `decimal`, read from `word/numbering.xml`.
 *
 * Without this every list in every Word file would import as numbered, which
 * reads as a different contract: a bulleted list of conditions is not a
 * sequence of steps.
 */
function listFormats(numberingXml: string): Map<string, "bullet" | "number"> {
  const formats = new Map<string, "bullet" | "number">();
  const abstract = new Map<string, Map<number, "bullet" | "number">>();
  const abstractBlock = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g;
  for (let match = abstractBlock.exec(numberingXml); match; match = abstractBlock.exec(numberingXml)) {
    const levels = new Map<number, "bullet" | "number">();
    const levelBlock = /<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g;
    for (let lvl = levelBlock.exec(match[2]); lvl; lvl = levelBlock.exec(match[2])) {
      const fmt = /<w:numFmt\s+w:val="([^"]*)"/.exec(lvl[2])?.[1] ?? "";
      levels.set(Number(lvl[1]), fmt === "bullet" ? "bullet" : "number");
    }
    abstract.set(match[1], levels);
  }
  const numBlock = /<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g;
  for (let match = numBlock.exec(numberingXml); match; match = numBlock.exec(numberingXml)) {
    const abstractId = /<w:abstractNumId\s+w:val="(\d+)"/.exec(match[2])?.[1];
    if (!abstractId) continue;
    const levels = abstract.get(abstractId);
    for (const [level, fmt] of levels ?? []) formats.set(`${match[1]}:${level}`, fmt);
  }
  return formats;
}

/** A heading style, however the file spells it. `Title` counts. */
function isHeadingStyle(style: string, outlineLevel: number | null): boolean {
  // `Heading1` (the style Word actually writes), `heading 1`, or a bare level.
  if (/^(heading\s*[1-9]?|heading\s+[1-9]|[1-9])$/i.test(style.trim())) return true;
  if (/^title$/i.test(style.trim())) return true;
  return outlineLevel !== null && outlineLevel >= 0 && outlineLevel <= 5;
}

async function importDocx(
  bytes: Uint8Array,
  nextId: () => string,
  warnings: string[],
  stats: ContractImportStats,
): Promise<{ blocks: ContractBlock[]; title: string } | null> {
  const zip = await openBoundedZip(bytes);
  if (!zip) return null;
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) return null;
  const documentXml = await inflateBoundedEntry(documentEntry, CONTRACT_IMPORT_MAX_INFLATED_BYTES);
  if (!documentXml) return null;
  const xml = documentXml.toString("utf8");

  const numberingEntry = zip.file("word/numbering.xml");
  const numberingXml = numberingEntry
    ? (await inflateBoundedEntry(numberingEntry, CONTRACT_IMPORT_MAX_INFLATED_BYTES))?.toString("utf8") ?? ""
    : "";
  const formats = listFormats(numberingXml);

  const coreEntry = zip.file("docProps/core.xml");
  const coreXml = coreEntry
    ? (await inflateBoundedEntry(coreEntry, 256 * 1024))?.toString("utf8") ?? ""
    : "";
  const coreTitle = tidy(decodeXml(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(coreXml)?.[1] ?? ""));

  const blocks: ContractBlock[] = [];
  let title = "";
  let openList: { type: "bullets" | "numbered"; items: string[]; block: ContractBlock } | null = null;
  let droppedHeadings = 0;

  const flushList = () => {
    if (!openList) return;
    blocks.push(openList.block);
    stats.lists += 1;
    openList = null;
  };

  for (const element of topLevelElements(xml)) {
    if (element.kind === "tbl") {
      flushList();
      const rows = tableRows(element.xml);
      if (rows.length === 0) continue;
      const columns = rows[0].slice(0, CONTRACT_LIMITS.tableColumnsMax);
      if (rows[0].length > CONTRACT_LIMITS.tableColumnsMax) {
        warnings.push(
          `جدولی با ${rows[0].length} ستون فقط با ${CONTRACT_LIMITS.tableColumnsMax} ستون اول درونریزی شد؛ ستون‌های دیگر را دستی اضافه کنید.`,
        );
      }
      const body = rows
        .slice(1, CONTRACT_LIMITS.tableRowsMax + 1)
        .map((row) => columns.map((_, index) => tidy(row[index] ?? "").slice(0, CONTRACT_LIMITS.cellMax)));
      if (rows.length - 1 > CONTRACT_LIMITS.tableRowsMax) {
        warnings.push(
          `جدولی با ${rows.length - 1} سطر تا ${CONTRACT_LIMITS.tableRowsMax} سطر درونریزی شد؛ بقیه را دستی اضافه کنید.`,
        );
      }
      blocks.push({
        id: nextId(),
        type: "table",
        caption: "",
        columns: columns.map((cell) => tidy(cell).slice(0, CONTRACT_LIMITS.cellMax)),
        rows: body,
      });
      stats.tables += 1;
      continue;
    }

    const paragraph = paragraphOf(element.xml);
    if (paragraph.pageBreak) {
      flushList();
      blocks.push({ id: nextId(), type: "page_break" });
      stats.pageBreaks += 1;
    }
    const text = tidy(paragraph.text);
    if (!text) continue;

    const heading = isHeadingStyle(paragraph.style, paragraph.outlineLevel);
    if (heading) {
      flushList();
      // The document's first heading is its natural title; the rest are blocks.
      if (!title) {
        title = text.slice(0, CONTRACT_LIMITS.titleMax);
        droppedHeadings += 1;
        continue;
      }
      for (const block of textBlocks(nextId, "heading", text)) blocks.push(block);
      stats.headings += 1;
      continue;
    }

    if (paragraph.numId) {
      const kind = formats.get(`${paragraph.numId}:${paragraph.numLevel}`) ?? "number";
      const type = kind === "bullet" ? "bullets" : "numbered";
      if (openList && openList.type === type && openList.items.length < CONTRACT_LIMITS.listItemsMax) {
        openList.items.push(text.slice(0, CONTRACT_LIMITS.itemMax));
        openList.block = { ...openList.block, items: [...openList.items] } as ContractBlock;
      } else {
        flushList();
        const items = [text.slice(0, CONTRACT_LIMITS.itemMax)];
        openList = { type, items, block: { id: nextId(), type, items: [...items] } };
      }
      continue;
    }

    flushList();
    for (const block of textBlocks(nextId, "paragraph", text)) blocks.push(block);
    stats.paragraphs += 1;
  }
  flushList();

  warnings.push(
    "قالب‌بندی متن (ضخیم، ایتالیک، رنگ)، تصاویر، سرصفحه و پانویس، و تغییرات ردگیرى‌شده در درون‌ریزی منتقل نمی‌شوند؛ فقط متن، فهرست‌ها و جدول‌ها می‌آیند.",
  );
  warnings.push(
    "جای امضا به‌طور خودکار ساخته نمی‌شود؛ بلوک «جای امضا» را برای هر طرف اضافه کنید تا پاکت امضا بتواند آن را به یک امضاکننده بدهد.",
  );
  if (droppedHeadings) {
    warnings.push("عنوان نخست سند به‌عنوان عنوان قرارداد برداشته شد و به‌صورت بلوک تکرار نشد.");
  }
  // The first heading is what the document calls itself on the page; `dc:title`
  // is metadata that is often a stale "Document1". So the visible heading wins
  // and the property is only a fallback.
  return { blocks, title: title || coreTitle };
}

/* ===========================================================================
 * PDF
 * ======================================================================== */

interface PdfObject {
  dict: string;
  stream: Buffer | null;
}

/** `N 0 obj … endobj`, with the stream bytes kept aside when there are any. */
function pdfObjects(bytes: Buffer): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const header = /(\d+)\s+\d+\s+obj\b/g;
  for (let match = header.exec(bytes.toString("latin1")); match; match = header.exec(bytes.toString("latin1"))) {
    const start = match.index + match[0].length;
    const end = bytes.indexOf(Buffer.from("endobj"), start, "latin1");
    if (end < 0) continue;
    const chunk = bytes.subarray(start, end);
    const streamAt = chunk.indexOf(Buffer.from("stream"));
    if (streamAt < 0) {
      objects.set(Number(match[1]), { dict: chunk.toString("latin1"), stream: null });
      continue;
    }
    let dataStart = start + streamAt + "stream".length;
    // The keyword is followed by CRLF or LF, per the spec.
    if (bytes[dataStart] === 0x0d) dataStart += 1;
    if (bytes[dataStart] === 0x0a) dataStart += 1;
    const dataEnd = bytes.indexOf(Buffer.from("endstream"), dataStart, "latin1");
    objects.set(Number(match[1]), {
      dict: chunk.subarray(0, streamAt).toString("latin1"),
      stream: dataEnd > dataStart ? bytes.subarray(dataStart, dataEnd) : Buffer.alloc(0),
    });
  }
  return objects;
}

/** The decoded bytes of an object's stream, or null when it is not a stream we can open. */
function decodedStream(object: PdfObject): Buffer | null {
  if (!object.stream) return null;
  if (!/\/FlateDecode/.test(object.dict)) {
    // Only Flate is unwrapped; an image codec or LZW stream is not text anyway.
    return /\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(object.dict)
      ? null
      : object.stream;
  }
  for (const attempt of [inflateSync, inflateRawSync]) {
    try {
      const out = attempt(object.stream);
      if (out.length > CONTRACT_IMPORT_MAX_INFLATED_BYTES) return null;
      return out;
    } catch {
      // Try the rawer variant, then give up on this stream.
    }
  }
  return null;
}

/**
 * A font's `ToUnicode` CMap: glyph code → the character it stands for.
 *
 * Two entries matter: `beginbfchar` (one code at a time) and `beginbfrange`
 * (a contiguous run). This is the difference between readable Persian text and
 * a page of `\u0001\u0002\u0003`, because a Persian PDF's glyph codes are not
 * character codes.
 */
interface CodeMap {
  map: Map<number, string>;
  /** True when the font addresses glyphs with two bytes (Identity-H). */
  twoByte: boolean;
}

function parseToUnicode(cmapText: string): CodeMap {
  const map = new Map<number, string>();
  let twoByte = false;
  const utf16 = (hex: string): string => {
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };
  for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const code = Number.parseInt(pair[1], 16);
      if (pair[1].length >= 4) twoByte = true;
      map.set(code, utf16(pair[2]));
    }
  }
  for (const block of cmapText.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const from = Number.parseInt(range[1], 16);
      const to = Number.parseInt(range[2], 16);
      const base = utf16(range[3]);
      if (range[1].length >= 4) twoByte = true;
      // A range can be long, but only a real text range is; cap the expansion.
      for (let code = from; code <= to && code - from < 4096; code += 1) {
        map.set(code, base.replace(/.$/u, (last) => String.fromCharCode(last.charCodeAt(0) + (code - from))));
      }
    }
  }
  return { map, twoByte };
}

/**
 * Resource name (`/F1`) → CMap, gathered from every `/Font` dictionary in the
 * file. A PDF may declare per-page resources; font names are file-wide in
 * practice (`/F1`, `/F2`), and a name that resolves to two different CMaps is
 * dropped rather than guessed — the text then falls back to the raw bytes and
 * the result fails the legibility check instead of printing invented words.
 */
function pdfFontMaps(objects: Map<number, PdfObject>): Map<string, CodeMap> {
  const byName = new Map<string, CodeMap | "conflict">();
  const cmapOf = (fontObject: PdfObject): CodeMap | null => {
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fontObject.dict)?.[1];
    if (!ref) return null;
    const cmapObject = objects.get(Number(ref));
    if (!cmapObject) return null;
    const text = decodedStream(cmapObject)?.toString("latin1") ?? "";
    const parsed = parseToUnicode(text);
    return parsed.map.size > 0 ? parsed : null;
  };
  for (const object of objects.values()) {
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(object.dict)?.[1];
    if (!fontDict) continue;
    for (const entry of fontDict.matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const font = objects.get(Number(entry[2]));
      if (!font) continue;
      const cmap = cmapOf(font);
      if (!cmap) continue;
      const existing = byName.get(entry[1]);
      if (existing && existing !== "conflict" && JSON.stringify(existing) !== JSON.stringify(cmap)) {
        byName.set(entry[1], "conflict");
      } else {
        byName.set(entry[1], cmap);
      }
    }
  }
  const out = new Map<string, CodeMap>();
  for (const [name, cmap] of byName) if (cmap !== "conflict") out.set(name, cmap);
  return out;
}

/** Decodes a PDF string operand: escapes in a literal, or a hex string. */
function pdfString(operand: string, cmap: CodeMap | null): string {
  const bytes: number[] = [];
  if (operand.startsWith("<")) {
    const hex = operand.replace(/[^0-9a-fA-F]/g, "");
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  } else {
    const body = operand.slice(1, -1);
    for (let i = 0; i < body.length; i += 1) {
      const char = body[i];
      if (char !== "\\") {
        bytes.push(char.charCodeAt(0) & 0xff);
        continue;
      }
      const next = body[(i += 1)];
      if (next === undefined) break;
      if (next === "n") bytes.push(0x0a);
      else if (next === "r") bytes.push(0x0d);
      else if (next === "t") bytes.push(0x09);
      else if (next === "b") bytes.push(0x08);
      else if (next === "f") bytes.push(0x0c);
      else if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(body.slice(i))?.[0] ?? next;
        bytes.push(Number.parseInt(octal, 8));
        i += octal.length - 1;
      } else bytes.push(next.charCodeAt(0) & 0xff);
    }
  }
  if (cmap && cmap.map.size > 0) {
    const step = cmap.twoByte ? 2 : 1;
    let out = "";
    for (let i = 0; i < bytes.length; i += step) {
      const code = step === 2 ? ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0) : (bytes[i] ?? 0);
      const mapped = cmap.map.get(code);
      out += mapped ?? (step === 2 ? "" : String.fromCharCode(code));
    }
    return out;
  }
  return Buffer.from(bytes).toString("latin1");
}

/**
 * Text of one content stream, in reading order.
 *
 * Line positioning (`Td`, `TD`, `T*`, `ET`) becomes a newline: the block model
 * has no coordinates, and a paragraph boundary is the only useful
 * interpretation of "the text moved".
 */
function contentStreamText(stream: string, fonts: Map<string, CodeMap>): string {
  let out = "";
  let cmap: CodeMap | null = null;
  const token = /\/([A-Za-z0-9+._-]+)\s+[\d.]+\s+Tf|\[((?:[^\]\\]|\\.)*)\]\s*TJ|(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]*>)\s*(?:Tj|'|")|(T\*|Td|TD|ET|BT)/g;
  for (let match = token.exec(stream); match; match = token.exec(stream)) {
    if (match[1]) {
      cmap = fonts.get(match[1]) ?? null;
      continue;
    }
    if (match[2] !== undefined) {
      // A TJ array is an alternating list of strings and kerning numbers; the
      // numbers only matter to a typesetter.
      for (const piece of match[2].matchAll(/(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]*>)/g)) {
        out += pdfString(piece[1], cmap);
      }
      continue;
    }
    if (match[3]) {
      out += pdfString(match[3], cmap);
      continue;
    }
    // A `Td`/`T*` moved the cursor inside one text object — a new line. `ET`
    // ended the object — a new paragraph, which is the closest this model gets
    // to the distinction a PDF makes.
    if (match[4] === "T*" || match[4] === "Td" || match[4] === "TD") out += "\n";
    else if (match[4] === "ET") out += "\n\n";
  }
  return out;
}

/** Letters, digits and common punctuation — the test for "did this decode as text". */
function legibilityRatio(value: string): number {
  const sample = value.replace(/\s+/g, "");
  if (!sample) return 0;
  let readable = 0;
  for (const char of sample) {
    const code = char.codePointAt(0) ?? 0;
    const isPersian = code >= 0x0600 && code <= 0x06ff;
    const isLatin = (code >= 0x20 && code <= 0x7e) || (code >= 0x00a0 && code <= 0x024f);
    const isDigitOrPunct = /[\d\s.,;:()«»؛،\-–—/]/.test(char);
    if (isPersian || isLatin || isDigitOrPunct) readable += 1;
  }
  return readable / [...sample].length;
}

function importPdf(
  bytes: Buffer,
  nextId: () => string,
  warnings: string[],
  stats: ContractImportStats,
): ContractBlock[] | "no_text_layer" | null {
  const objects = pdfObjects(bytes);
  if (objects.size === 0) return null;
  const fonts = pdfFontMaps(objects);

  const parts: string[] = [];
  for (const object of objects.values()) {
    if (!object.stream) continue;
    const decoded = decodedStream(object);
    if (!decoded) continue;
    const text = decoded.toString("latin1");
    // Only content streams show text; fonts, CMaps and images do not (and a
    // binary stream decoded this way is noise, filtered by the BT/Tj test).
    if (!/\bBT\b/.test(text) || !/\b(Tj|TJ)\b/.test(text)) continue;
    parts.push(contentStreamText(text, fonts));
  }

  const raw = tidy(parts.join("\n\n"));
  if (!raw) return "no_text_layer";
  if (legibilityRatio(raw) < 0.8) return "no_text_layer";

  warnings.push(
    "از PDF فقط متن قابل استخراج منتقل می‌شود؛ چیدمان، ستون‌بندی، جدول‌ها و سبک‌ها بازسازی نمی‌شوند. ساختار را پس از درون‌ریزی در ویرایشگر مرتب کنید.",
  );
  warnings.push(
    "جای امضا به‌طور خودکار ساخته نمی‌شود؛ بلوک «جای امضا» را برای هر طرف اضافه کنید.",
  );

  const blocks: ContractBlock[] = [];
  for (const chunk of raw.split(/\n{2,}/)) {
    const lines = chunk
      .split("\n")
      .map((line) => tidy(line))
      .filter(Boolean);
    if (lines.length === 0) continue;
    // A short line on its own, in a Persian or Latin letter, reads as a heading;
    // anything longer is body text. Deliberately conservative — a wrong heading
    // is cosmetic, a lost paragraph is not.
    const [first, ...rest] = lines;
    if (rest.length > 0 && first.length <= 80 && !/[.؛,،]$/.test(first)) {
      for (const block of textBlocks(nextId, "heading", first)) blocks.push(block);
      stats.headings += 1;
      blocks.push(...textBlocks(nextId, "paragraph", rest.join(" ")));
      stats.paragraphs += 1;
      continue;
    }
    blocks.push(...textBlocks(nextId, "paragraph", lines.join(" ")));
    stats.paragraphs += 1;
  }
  return blocks;
}

/* ===========================================================================
 * The entry point
 * ======================================================================== */

function baseName(fileName: string): string {
  return tidy(fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
}

/**
 * Reads one uploaded file into an editable contract document.
 *
 * Returns a RESULT rather than throwing for every expected failure (too large,
 * wrong format, unreadable, no text layer, nothing left after parsing), because
 * each of those has a different thing to tell the sender and the route turns
 * the code into a 4xx with a sentence.
 */
export async function importContractDocument(input: {
  bytes: Uint8Array;
  fileName: string;
  /** The multipart type, used only to disagree with the bytes — never to trust them. */
  mimeType?: string;
}): Promise<ContractImportResult> {
  const { bytes, fileName } = input;
  if (bytes.byteLength === 0) {
    return { ok: false, error: "unsupported_format", detail: "فایل خالی است." };
  }
  if (bytes.byteLength > CONTRACT_IMPORT_MAX_BYTES) {
    return {
      ok: false,
      error: "file_too_large",
      detail: `حجم فایل بیش از ${Math.round(CONTRACT_IMPORT_MAX_BYTES / (1024 * 1024))} مگابایت است.`,
    };
  }

  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const isPdf = buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  const format: ContractImportFormat | null = isPdf ? "pdf" : isZip ? "docx" : null;
  if (!format) {
    return {
      ok: false,
      error: "unsupported_format",
      detail: "فقط فایل Word با پسوند .docx یا PDF پذیرفته می‌شود. (فایل‌های .doc قدیمی و متن ساده پشتیبانی نمی‌شوند.)",
    };
  }

  const nextId = makeIds();
  const stats = emptyStats();
  const warnings: string[] = [];

  // The declared type is evidence, never authority: the format above came from
  // the magic bytes, because a file is routinely renamed and a lying header is
  // not a reason to parse ZIP data as PDF. When the two disagree we say so — the
  // sender may have attached the wrong file — and carry on with the real one.
  const declared = (input.mimeType ?? "").toLowerCase();
  const declaredFormat: ContractImportFormat | null = declared.includes("pdf")
    ? "pdf"
    : declared.includes("wordprocessingml") || declared.includes("msword")
      ? "docx"
      : null;
  if (declaredFormat && declaredFormat !== format) {
    warnings.push(
      `نوع اعلام‌شدهٔ فایل (${tidy(input.mimeType ?? "")}) با محتوای واقعی آن یکی نیست؛ سند بر اساس محتوای واقعی به‌صورت ${CONTRACT_IMPORT_FORMAT_LABELS[format]} خوانده شد.`,
    );
  }

  let blocks: ContractBlock[] = [];
  let title = "";
  if (format === "docx") {
    let parsed: { blocks: ContractBlock[]; title: string } | null = null;
    try {
      parsed = await importDocx(bytes, nextId, warnings, stats);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      return {
        ok: false,
        error: "docx_unreadable",
        detail: "این فایل باز نشد؛ ممکن است فایل Word معتبر نباشد یا محافظت‌شده باشد. فایل را در Word باز کنید و با پسوند .docx دوباره ذخیره کنید.",
      };
    }
    blocks = parsed.blocks;
    title = parsed.title;
  } else {
    let parsed: ContractBlock[] | "no_text_layer" | null = null;
    try {
      parsed = importPdf(buffer, nextId, warnings, stats);
    } catch {
      parsed = null;
    }
    if (parsed === "no_text_layer") {
      return {
        ok: false,
        error: "pdf_no_text_layer",
        detail:
          "این PDF متن قابل استخراج ندارد — احتمالاً اسکن تصویری است یا فونت آن‌گونه جاسازی شده که متنش خوانده نمی‌شود. فایل Word را وارد کنید یا سند را در ویرایشگر بنویسید.",
      };
    }
    if (!parsed) {
      return {
        ok: false,
        error: "pdf_unreadable",
        detail: "این PDF باز نشد؛ ممکن است فایل آسیب‌دیده یا رمزگذاری‌شده باشد.",
      };
    }
    blocks = parsed;
    const firstHeading = blocks.find((block) => block.type === "heading");
    title =
      firstHeading && firstHeading.type === "heading"
        ? tidy(firstHeading.text).slice(0, CONTRACT_LIMITS.titleMax)
        : "";
  }

  const content = normalizeContractContent({
    version: 1,
    title: title || baseName(fileName) || "سند درون‌ریزی‌شده",
    headerText: "",
    footerText: "",
    blocks,
    // No invented variables: Word cannot tell us which phrase was meant to be
    // `{{counterparty_name}}`, and a guessed field is a variable a signer would
    // meet as an unresolved blank.
    fields: [],
  });

  if (content.blocks.length === 0) {
    return {
      ok: false,
      error: "empty_document",
      detail: "در این فایل متنی برای درون‌ریزی پیدا نشد.",
    };
  }

  stats.characters = content.blocks.reduce((total, block) => {
    if (block.type === "heading" || block.type === "paragraph") return total + block.text.length;
    if (block.type === "article") return total + block.title.length + block.text.length;
    if (block.type === "bullets" || block.type === "numbered") {
      return total + block.items.join("").length;
    }
    if (block.type === "table") return total + block.rows.flat().join("").length;
    return total;
  }, 0);

  if (content.blocks.length >= CONTRACT_LIMITS.blocksMax) {
    warnings.push(
      `سند بیش از ${CONTRACT_LIMITS.blocksMax} بلوک داشت؛ بقیه درون‌ریزی نشد. سند را به بخش‌هایی تقسیم کنید یا بقیه را دستی اضافه کنید.`,
    );
  }

  return {
    ok: true,
    content,
    source: {
      format,
      fileName: tidy(fileName).slice(0, 200),
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    },
    stats,
    warnings,
  };
}
