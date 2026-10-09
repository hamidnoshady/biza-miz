/**
 * The `printers` write boundary — one parser, shared by POST /api/settings/printers
 * and PATCH /api/settings/printers/[id]. Pure: everything it needs arrives as
 * arguments, so it is testable as plain data.
 *
 * Only the canonical hardware model passes: `windows` (queue name) or
 * `network` (IPv4 + port). The legacy transports (`usb`, `webusb`,
 * `browser`, and the old `transport` spelling) are rejected outright — new
 * writes must never create rows the new architecture cannot print.
 *
 * Capability validation happens HERE, once, for all four purposes: an
 * invoice printer must be a Windows queue loaded with A4/A5, a label printer
 * must take labels, a receipt/kitchen printer is a thermal roll. The rules
 * API and the UI read the very same matrix (`routing.ts`), so a combination
 * the operator can pick is a combination that prints.
 *
 * The payload carries purpose, paper, drawer, cut, active and default as
 * themselves — they are stored as relational columns. A printer no longer
 * names a template: **the print rule (or the branch's default template for a
 * document type) decides appearance, and the printer decides paper and
 * hardware.** Keeping a template inside a printer row is what let the
 * settings screen and the till disagree.
 */
import { isPaperKey, type PaperKey } from "../print-template";
import { paperAllowedForPurpose, printerClassFor } from "./routing";
import { isValidPrinterConnection, type PrinterClass, type PrinterConnection, type PrinterPurpose } from "./types";

export interface PrinterInput {
  name: string;
  kind: PrinterPurpose;
  connection: PrinterConnection;
  paper: PaperKey;
  paperWidthMm: 58 | 80 | null;
  printerClass: PrinterClass;
  openDrawer: boolean;
  supportsCut: boolean;
  isActive: boolean;
  isDefault: boolean;
}

export interface ExistingPrinter {
  name: string;
  kind: PrinterPurpose;
  connection: Record<string, unknown>;
  is_active: boolean;
  paper?: string | null;
  paper_width_mm?: number | null;
  supports_drawer?: boolean | null;
  supports_cut?: boolean | null;
  is_default?: boolean | null;
}

/** The thermal roll widths a roll printer can be loaded with. */
export function isRollPaper(paper: PaperKey): boolean {
  return paper === "thermal58" || paper === "thermal80";
}

/**
 * Normalise a printer payload into the stored shape. Returns null when the
 * payload cannot describe a printer the pipeline can actually print to — a
 * missing queue name, a hostname instead of an IP, an A4 tray on a roll
 * printer, a label printer with sheet paper.
 */
export function parsePrinterInput(body: Record<string, unknown>, fallback?: ExistingPrinter): PrinterInput | null {
  // Strip control characters before anything is stored: printer descriptor
  // strings and pasted names can carry NUL bytes, and PostgreSQL rejects
  // \u0000 in jsonb outright (error 22P05).
  const stripControls = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "");

  const nameValue = body.name ?? fallback?.name;
  const name = typeof nameValue === "string" ? stripControls(nameValue).trim() : "";
  const kindValue = body.kind ?? fallback?.kind;
  const kind: PrinterPurpose | null =
    kindValue === "kitchen" || kindValue === "receipt" || kindValue === "document" || kindValue === "label"
      ? kindValue
      : null;
  if (!name || name.length > 200 || !kind) return null;

  const existing = (fallback?.connection ?? {}) as Record<string, unknown>;
  const text = (value: unknown, previous: unknown) =>
    stripControls(typeof value === "string" ? value.trim() : typeof previous === "string" ? previous.trim() : "").slice(0, 255);

  // ── the hardware target ──
  const connectionBody = body.connection && typeof body.connection === "object" ? (body.connection as Record<string, unknown>) : body;
  const typeValue = connectionBody.type ?? body.type;
  const type = typeValue === "windows" ? "windows" : typeValue === "network" ? "network" : null;
  if (!type) return null; // includes every legacy transport spelling — refused

  // A cut sheet only prints through an installed Windows queue: raw TCP to a
  // page printer would mean speaking a page-description language we do not.
  if (kind === "document" && type !== "windows") return null;

  const systemName = text(connectionBody.systemName ?? body.systemName, null);
  const ip = text(connectionBody.ip ?? body.ip, null);
  const portNumber = Number(connectionBody.port ?? body.port ?? 9100);

  const connection: PrinterConnection =
    type === "windows"
      ? { type, systemName: systemName || undefined }
      : { type, ip: ip || undefined, port: Number.isInteger(portNumber) ? portNumber : 9100 };

  if (!isValidPrinterConnection(connection)) return null;
  if (type === "windows" && connection.systemName) connection.systemName = connection.systemName.slice(0, 255);
  if (type === "network" && connection.ip) connection.ip = connection.ip.trim().slice(0, 64);

  // ── the paper ──
  // A partial edit keeps whatever the row already has: the columns first,
  // then the legacy jsonb keys of a row written before migration 0212.
  const paperValue = body.paper ?? fallback?.paper ?? existing.paper;
  const widthValue = Number(body.paperWidthMm ?? fallback?.paper_width_mm ?? existing.paperWidthMm);
  // The purpose's own default is the fallback: a payload that says "receipt
  // printer" and nothing else means an 80mm roll, which is what the wizard
  // and every pre-existing caller mean by it.
  const defaultPaper: PaperKey = kind === "document" ? "a4" : kind === "label" ? "label57x40" : "thermal80";
  const paper: PaperKey | null = isPaperKey(paperValue)
    ? paperValue
    : widthValue === 58
      ? "thermal58"
      : widthValue === 80
        ? "thermal80"
        : paperValue == null && !Number.isFinite(widthValue)
          ? defaultPaper
          : null;
  if (!paper || !paperAllowedForPurpose(kind, paper)) return null;

  const printerClass = printerClassFor(kind, paper);

  // ── the behaviour ──
  // A drawer hangs off a thermal roll printer's kick pin; a page or label
  // printer has none, so the flag is not just hidden — it is not stored.
  const requestedDrawer =
    typeof body.openDrawer === "boolean"
      ? body.openDrawer
      : fallback?.supports_drawer === true || existing.openDrawer === true;
  const openDrawer = requestedDrawer && printerClass === "thermal";
  const supportsCut =
    typeof body.supportsCut === "boolean"
      ? body.supportsCut
      : fallback?.supports_cut != null
        ? fallback.supports_cut
        : existing.supportsCut !== false;
  const isActive = typeof body.isActive === "boolean" ? body.isActive : (fallback?.is_active ?? true);
  const isDefault =
    (typeof body.isDefault === "boolean"
      ? body.isDefault
      : fallback?.is_default != null
        ? fallback.is_default
        : existing.isDefault === true) && isActive;

  return {
    name,
    kind,
    connection,
    paper,
    paperWidthMm: isRollPaper(paper) ? (paper === "thermal58" ? 58 : 80) : null,
    printerClass,
    openDrawer,
    supportsCut,
    isActive,
    isDefault,
  };
}
