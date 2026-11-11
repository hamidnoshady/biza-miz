/**
 * Bound and validate XLSX ZIP contents before passing them to ExcelJS. ExcelJS
 * loads a ZIP into memory, so a compressed upload limit alone is insufficient.
 * Repacking ensures ExcelJS reads the exact entries we checked, rather than
 * relying on agreement between two ZIP parsers about ambiguous archives.
 */
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import JSZip from "jszip";
import { buf as crc32 } from "crc-32";
import { HistoricalFileError } from "./historical-invoice-file";

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

/** Returns a sanitized, bounded ZIP. Never trusts declared sizes alone. */
export async function boundedHistoricalWorkbook(input: ArrayBuffer): Promise<ArrayBuffer> {
  let zip: ZipFile | undefined;
  try {
    zip = await openZip(Buffer.from(input));
    const result = new JSZip();
    const names = new Set<string>();
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
      if (!entry.fileName.endsWith("/")) result.file(entry.fileName, Buffer.concat(chunks, size), { createFolders: false });
    }
    const safe = await result.generateAsync({ type: "uint8array", compression: "STORE" });
    return Uint8Array.from(safe).buffer;
  } catch (error) {
    if (error instanceof HistoricalFileError) throw error;
    throw new HistoricalFileError("invalid_xlsx");
  } finally {
    zip?.close();
  }
}
