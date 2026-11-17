/**
 * Bound and validate XLSX ZIP contents before passing them to ExcelJS. ExcelJS
 * loads a ZIP into memory, so a compressed upload limit alone is insufficient.
 * Repacking ensures ExcelJS reads the exact entries we checked, rather than
 * relying on agreement between two ZIP parsers about ambiguous archives.
 */
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { buf as crc32 } from "crc-32";
import { HistoricalFileError } from "./historical-invoice-file-error";

const MAX_ENTRIES = 1000;
const MAX_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_ENTRY = 32 * 1024 * 1024;

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => fromBuffer(buffer, { lazyEntries: true, autoClose: false, validateEntrySizes: true },
    (error, zip) => error || !zip ? reject(error ?? new Error("invalid_zip")) : resolve(zip)));
}
function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { zip.off("entry", onEntry); zip.off("end", onEnd); zip.off("error", onError); };
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    zip.once("entry", onEntry); zip.once("end", onEnd); zip.once("error", onError);
    zip.readEntry();
  });
}
function readStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => zip.openReadStream(entry,
    (error, stream) => error || !stream ? reject(error ?? new Error("invalid_zip_entry")) : resolve(stream)));
}

type WorkbookStructure = {
  declared: Set<string>;
  relationships: Map<string, { type: string; target: string; external: boolean }>;
  worksheets: Set<string>;
};

/**
 * ExcelJS builds an object model. Bound XML structure before it gets any
 * workbook bytes, including worksheet coordinates and span expansion.
 */
function inspectWorkbookXml(bytes: Buffer, entryName: string, budget: { nodes: number; cells: number; rows: number; sheets: number }, structure: WorkbookStructure) {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0, currentRow = 0, previousRow = 0, previousColumn = 0;
  const sheetIds = new Set<number>();
  const sheetNames = new Set<string>();
  const sheetRelationships = new Set<string>();
  const invalid = () => { throw new HistoricalFileError("invalid_xlsx_archive"); };
  const index = (value: string | undefined, max: number) => {
    if (!value || !/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > max) invalid();
    return Number(value);
  };
  parser.on("doctype", invalid);
  parser.on("error", invalid);
  parser.on("opentag", (tag) => {
    if (++depth > 48 || ++budget.nodes > 1_500_000 || Object.keys(tag.attributes).length > 48) invalid();
    const attribute = (name: string) => tag.attributes[name]?.value;
    switch (tag.local) {
      case "worksheet":
        if (++budget.sheets > 10) throw new HistoricalFileError("too_many_sheets");
        previousRow = 0;
        break;
      case "sheet": {
        if (entryName !== "xl/workbook.xml") break;
        // ExcelJS uses the source sheetId as an array index. A tiny workbook
        // with an enormous or duplicate ID can cause unbounded iteration or
        // overwrite a sheet. The relationship and names must be unique too.
        const id = index(attribute("sheetId"), 1_000);
        const name = attribute("name");
        const relationship = attribute("r:id");
        if (!name || name.length > 31 || !relationship || sheetIds.has(id) ||
            sheetNames.has(name.toLocaleLowerCase("en-US")) || sheetRelationships.has(relationship)) invalid();
        sheetIds.add(id);
        sheetNames.add(name!.toLocaleLowerCase("en-US"));
        sheetRelationships.add(relationship!);
        structure.declared.add(relationship!);
        if (sheetIds.size > 10) throw new HistoricalFileError("too_many_sheets");
        break;
      }
      case "Relationship": {
        if (entryName !== "xl/_rels/workbook.xml.rels") break;
        const id = attribute("Id"), type = attribute("Type"), target = attribute("Target");
        if (!id || !type || !target || structure.relationships.has(id)) invalid();
        structure.relationships.set(id!, { type: type!, target: target!, external: Boolean(attribute("TargetMode") && attribute("TargetMode") !== "Internal") });
        break;
      }
      case "row":
        currentRow = index(attribute("r"), 50_010);
        // ExcelJS stores rows by coordinate and overwrites duplicates. Reject
        // non-increasing coordinates before parsing to avoid losing evidence.
        if (currentRow <= previousRow) invalid();
        previousRow = currentRow;
        previousColumn = 0;
        if (++budget.rows > 50_010) throw new HistoricalFileError("too_many_rows");
        break;
      case "c": {
        if (++budget.cells > 1_000_010) throw new HistoricalFileError("too_many_cells");
        const coordinate = /^([A-Z]{1,2})([1-9][0-9]{0,5})$/.exec(attribute("r") ?? "");
        if (!coordinate) throw new HistoricalFileError("invalid_xlsx_archive");
        const column = [...coordinate[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
        if (column > 512) throw new HistoricalFileError("too_many_columns");
        if (index(coordinate[2], 50_010) !== currentRow || column <= previousColumn) invalid();
        previousColumn = column;
        break;
      }
      case "col": {
        const min = index(attribute("min"), 512);
        const max = index(attribute("max"), 512);
        if (min > max || (budget.nodes += max - min) > 1_500_000) invalid();
        break;
      }
      // These worksheet features can expand ranges or load auxiliary models
      // and aren't part of the invoice evidence format.
      case "mergeCell":
      case "conditionalFormatting":
      case "drawing":
      case "legacyDrawing":
      case "tablePart":
      case "pivotTable":
      // ExcelJS expands validation and defined-name ranges into a per-cell
      // map even when no cells exist in the sheet. A few bytes can describe
      // the entire Excel grid. Neither feature is invoice evidence.
      case "dataValidations":
      case "dataValidation":
      case "definedNames":
      case "definedName":
        throw new HistoricalFileError("xlsx_unsupported_layout");
    }
  });
  parser.on("closetag", (tag) => {
    if (tag.local === "row") currentRow = 0;
    depth--;
  });
  parser.write(xml).close();
}

/** Returns a sanitized, bounded ZIP. Never trusts declared sizes alone. */
export async function boundedHistoricalWorkbook(input: ArrayBuffer): Promise<ArrayBuffer> {
  let zip: ZipFile | undefined;
  try {
    zip = await openZip(Buffer.from(input));
    const result = new JSZip();
    const names = new Set<string>();
    const budget = { nodes: 0, cells: 0, rows: 0, sheets: 0 };
    const structure: WorkbookStructure = { declared: new Set(), relationships: new Map(), worksheets: new Set() };
    let total = 0, count = 0;
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      const components = entry.fileName.replace(/\/$/, "").split("/");
      if (++count > MAX_ENTRIES || entry.fileName.length > 1024 || names.has(entry.fileName) ||
          components.some((part) => !part || part === "." || part === ".." || part.includes("\0")) ||
          (entry.fileName.endsWith("/") && entry.uncompressedSize !== 0)) {
        throw new HistoricalFileError("invalid_xlsx_archive");
      }
      names.add(entry.fileName);
      // ExcelJS uses unanchored worksheet path regexes. Reject alternate paths
      // that it would parse differently than the source workbook relationships.
      if (/xl\/worksheets\/sheet\d+\.xml/i.test(entry.fileName)) {
        if (!/^xl\/worksheets\/sheet[1-9]\d{0,2}\.xml$/.test(entry.fileName)) throw new HistoricalFileError("invalid_xlsx_archive");
        structure.worksheets.add(entry.fileName);
      }
      // yauzl validates paths, encryption and compression when opening entries.
      if (entry.uncompressedSize > MAX_ENTRY || total + entry.uncompressedSize > MAX_UNCOMPRESSED) {
        throw new HistoricalFileError("xlsx_expanded_too_large");
      }
      const stream = await readStream(zip, entry);
      const chunks: Buffer[] = [];
      let size = 0, crc = 0;
      for await (const raw of stream as AsyncIterable<Buffer>) {
        const chunk = Buffer.from(raw);
        size += chunk.length;
        if (size > MAX_ENTRY || total + size > MAX_UNCOMPRESSED) {
          throw new HistoricalFileError("xlsx_expanded_too_large");
        }
        crc = crc32(chunk, crc);
        chunks.push(chunk);
      }
      if (size !== entry.uncompressedSize || (crc >>> 0) !== entry.crc32) throw new HistoricalFileError("invalid_xlsx_archive");
      total += size;
      if (!entry.fileName.endsWith("/")) {
        const bytes = Buffer.concat(chunks, size);
        if (/\.(xml|rels)$/i.test(entry.fileName)) inspectWorkbookXml(bytes, entry.fileName, budget, structure);
        result.file(entry.fileName, bytes, { createFolders: false });
      }
    }
    // ExcelJS silently ignores sheets with missing or unsupported relationships
    // and can map two declared sheets to one model. That would silently drop or
    // relabel invoice evidence, so only accept a bijection with real worksheets.
    const targets = new Set<string>();
    for (const id of structure.declared) {
      const rel = structure.relationships.get(id);
      if (!rel || rel.external || !rel.type.endsWith("/worksheet")) throw new HistoricalFileError("invalid_xlsx_archive");
      const target = rel.target.startsWith("/xl/") ? rel.target.slice(1) : `xl/${rel.target}`;
      if (!/^xl\/worksheets\/sheet[1-9]\d{0,2}\.xml$/.test(target) ||
          !structure.worksheets.has(target) || targets.has(target)) throw new HistoricalFileError("invalid_xlsx_archive");
      targets.add(target);
    }
    if (!structure.declared.size || targets.size !== structure.worksheets.size) throw new HistoricalFileError("invalid_xlsx_archive");
    const safe = await result.generateAsync({ type: "uint8array", compression: "STORE" });
    return Uint8Array.from(safe).buffer;
  } catch (error) {
    if (error instanceof HistoricalFileError) throw error;
    throw new HistoricalFileError("invalid_xlsx");
  } finally {
    zip?.close();
  }
}
