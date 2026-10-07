/**
 * The canonical printer model — ONE hardware question, two answers.
 *
 * A restaurant employee should never have to understand print agents,
 * WebUSB, driver modes, device paths, port numbers or spoolers. The product
 * asks exactly one question — «چاپگر کجاست؟» — and accepts exactly two
 * answers:
 *
 *   `windows` — a printer already installed in Windows' own
 *     «Bluetooth & devices → Printers & scanners» list. USB thermal printers
 *     belong here: Windows owns the cable, and the Cafe POS Windows connector
 *     prints through the native RAW spooler. No IP, no driver choice.
 *   `network` — a LAN/Wi-Fi/Ethernet ESC/POS printer with its own address,
 *     listening on the de-facto raw-print port 9100. The same local
 *     connector discovers it and delivers bytes over TCP.
 *
 * **One source of truth for behaviour.** The hardware target lives in this
 * module's `PrinterConnection` (the `printers.connection` jsonb column) and
 * nothing else does: paper, purpose, drawer, cut and defaultness are
 * relational columns on the `printers` row (migration 0173, consolidated in
 * migration 0211). Reading them back out of `connection` is what made the
 * settings screen and production printing disagree; the one exception is the
 * documented legacy normaliser below, which exists only for rows written
 * before the backfill ran and is slated for removal.
 *
 * Legacy rows written by the old five-transport model are normalised here,
 * never re-written by new code: `system` and `network` map cleanly, and
 * anything else (`usb`, `webusb`, `browser`, or a pre-transport stub) is
 * flagged `needsReconnect` so the settings UI can ask for one new pairing
 * instead of guessing where the printer went.
 */
import { isPaperKey, PAPERS, type PaperKey } from "../print-template";

/** The two hardware connection types exposed to users. */
export type PrinterConnectionType = "windows" | "network";

/**
 * What a printer is for. This is the canonical purpose vocabulary shared by
 * the database enum (`printer_kind`), the routing layer, the settings UI and
 * the print pipeline — a printer's purpose and the document type it serves
 * are the same four words:
 *
 *   receipt  → thermal58 / thermal80 roll, customer receipts
 *   kitchen  → thermal58 / thermal80 roll, kitchen tickets
 *   document → A4 / A5 sheet, Windows queue only (invoices)
 *   label    → label57x40 (or a thermal roll used as a label printer)
 */
export type PrinterPurpose = "receipt" | "kitchen" | "document" | "label";

export const PRINTER_PURPOSES: PrinterPurpose[] = ["receipt", "kitchen", "document", "label"];

export const PRINTER_PURPOSE_LABELS: Record<PrinterPurpose, string> = {
  receipt: "رسید فروش",
  kitchen: "فیش آشپزخانه",
  document: "فاکتور (کاغذ A4/A5)",
  label: "برچسب",
};

/** How a printer physically marks paper — derived, never hand-set. */
export type PrinterClass = "thermal" | "page" | "label";

export function isPrinterPurpose(value: unknown): value is PrinterPurpose {
  return value === "receipt" || value === "kitchen" || value === "document" || value === "label";
}

/**
 * The hardware half of a stored printer — where the bytes physically go.
 * This is the ONLY shape normal print code may construct; POS/order/kitchen
 * callers pass a saved printer ID and the server resolves this from the
 * database for the authenticated tenant + branch.
 */
export interface PrinterConnection {
  type: PrinterConnectionType;
  /** `windows`: the queue name exactly as Windows' Printers & scanners shows it. */
  systemName?: string;
  /** `network`: the printer's IPv4 address on the café LAN. */
  ip?: string;
  /** `network`: raw-print port, 9100 by convention. */
  port?: number;
}

/**
 * The wire shape the browser sends to the local Cafe POS connector — the
 * connection stripped of every behavioural field, because the connector
 * moves bytes and nothing else.
 */
export type PrinterTarget = PrinterConnection;

/**
 * A `printers` row as the application reads it: hardware (`connection`) plus
 * the relational capability columns. Everything a print decision needs is a
 * property here — nothing reads behaviour back out of the jsonb.
 */
export interface StoredPrinter extends Record<string, unknown> {
  id: string;
  name: string;
  /** The printer's purpose — the same vocabulary as a document type. */
  kind: PrinterPurpose;
  connection: StoredPrinterConnection;
  is_active: boolean;
  /** Derived from purpose + paper at the write boundary; NULL on pre-0173 rows until backfilled. */
  printer_class?: PrinterClass | null;
  paper?: PaperKey | null;
  paper_width_mm?: number | null;
  supports_drawer?: boolean | null;
  supports_cut?: boolean | null;
  is_default?: boolean | null;
  last_seen_at?: Date | string | null;
  last_tested_at?: Date | string | null;
  last_test_result?: string | null;
}

/**
 * What actually sits in the `printers.connection` jsonb column: the hardware
 * target, plus the identifying fields of a legacy row that could not be
 * mapped to the canonical model (so an operator can still tell which physical
 * printer needs re-pairing).
 *
 * Behavioural keys (`paper`, `paperWidthMm`, `openDrawer`, `isDefault`,
 * `templateKey`, `supportsCut`) are NEVER written here by new code and are
 * never read for a decision — see `legacyBehaviorOf` for the one documented
 * transition read.
 */
export interface StoredPrinterConnection {
  type?: PrinterConnectionType;
  systemName?: string | null;
  ip?: string | null;
  port?: number | null;
  /** Set on legacy rows that could not be mapped to the canonical model. */
  needsReconnect?: boolean;
  /** The legacy transport a `needsReconnect` row was saved with. */
  legacyTransport?: string;
  /** The pre-migration transport spelling — read by the normaliser, never written by new code. */
  transport?: string | null;
  /** Legacy fields preserved for identification only; never written by new code. */
  devicePath?: string | null;
  usbProductName?: string | null;
  usbVendorId?: number | null;
  /**
   * Behavioural keys left over from the pre-0211 model. Typed only so the
   * transition helper below can be honest about what it reads; nothing else
   * in the app touches them.
   */
  paper?: unknown;
  paperWidthMm?: unknown;
  openDrawer?: unknown;
  isDefault?: unknown;
  templateKey?: unknown;
  supportsCut?: unknown;
}

/* ────────────────────────── normalisation ────────────────────────── */

const TRANSPORT_KEY = "transport";

/**
 * Read any stored connection — including rows written by the old
 * five-transport model — into the canonical model. Pure, best-effort and
 * total: every input yields either a usable target or `needsReconnect`.
 *
 *   `system`                → windows (queue name)
 *   `network` / ip-only     → network (ip, port)
 *   `usb` / `webusb` / `browser` / stub rows → needsReconnect, with the
 *   identifying information preserved so the operator recognises the printer.
 *
 * Behavioural keys that may still sit in the jsonb are carried through
 * untouched (so a later write does not silently destroy them) but are never
 * the source of a decision — `printerPaper`, `printerSupportsDrawer` and
 * friends read the relational columns only.
 */
export function normalizeStoredConnection(raw: unknown): StoredPrinterConnection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { needsReconnect: true, legacyTransport: "unknown" };
  }
  const c = raw as Record<string, unknown> & StoredPrinterConnection;

  const legacyTransport =
    typeof c[TRANSPORT_KEY] === "string" && c[TRANSPORT_KEY] !== "" ? (c[TRANSPORT_KEY] as string) : null;

  // Canonical rows (written after the migration): trust the type field.
  if (c.type === "windows" || c.type === "network") {
    return stripUndefined({
      ...c,
      type: c.type,
      systemName: typeof c.systemName === "string" && c.systemName.trim() !== "" ? c.systemName : null,
      ip: typeof c.ip === "string" && c.ip.trim() !== "" ? c.ip.trim() : null,
      port: Number.isInteger(c.port) && (c.port as number) > 0 ? (c.port as number) : null,
    });
  }

  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;

  if (legacyTransport === "system") {
    const systemName = text(c.systemName);
    if (systemName) return { ...c, type: "windows", [TRANSPORT_KEY]: undefined, systemName, needsReconnect: undefined, legacyTransport: undefined };
    return { ...c, needsReconnect: true, legacyTransport: "system", [TRANSPORT_KEY]: undefined };
  }

  if (legacyTransport === "network" || (!legacyTransport && text(c.ip))) {
    const ip = text(c.ip);
    if (ip) {
      return {
        ...c,
        type: "network",
        [TRANSPORT_KEY]: undefined,
        systemName: null,
        ip,
        port: Number.isInteger(c.port) && (c.port as number) > 0 ? (c.port as number) : null,
        needsReconnect: undefined,
        legacyTransport: undefined,
      };
    }
  }

  // `usb`, `webusb`, `browser`, or a pre-transport stub with no address:
  // not safely convertible — ask for one new pairing, keep the identity.
  return stripUndefined({
    ...c,
    [TRANSPORT_KEY]: undefined,
    needsReconnect: true,
    legacyTransport: legacyTransport ?? "unknown",
  });
}

/** Drop `undefined` keys jsonb round-trips would not have kept anyway. */
function stripUndefined(c: StoredPrinterConnection): StoredPrinterConnection {
  const next = { ...c };
  if (next.needsReconnect === undefined) delete next.needsReconnect;
  if (next.legacyTransport === undefined) delete next.legacyTransport;
  if (next[TRANSPORT_KEY] === undefined) delete next[TRANSPORT_KEY];
  return next;
}

/** The jsonb a new write stores: the hardware target, and nothing else. */
export function connectionJsonOf(connection: PrinterConnection): Record<string, unknown> {
  if (connection.type === "windows") return { type: "windows", systemName: connection.systemName ?? null };
  return { type: "network", ip: connection.ip ?? null, port: connection.port ?? 9100 };
}

/* ────────────────────────── capability reads ────────────────────────── */

/** The printer's loaded paper, or null when the row predates the backfill. */
export function printerPaper(printer: {
  paper?: PaperKey | null;
  paper_width_mm?: number | null;
  kind?: PrinterPurpose;
}): PaperKey | null {
  if (isPaperKey(printer.paper)) return printer.paper;
  const width = Number(printer.paper_width_mm);
  if (width === 58) return "thermal58";
  if (width === 80) return "thermal80";
  return null;
}

/** The paper a printer will actually feed; the purpose's sensible default when unset. */
export function resolvedPaperOf(printer: {
  paper?: PaperKey | null;
  paper_width_mm?: number | null;
  kind?: PrinterPurpose;
}): PaperKey {
  const stored = printerPaper(printer);
  if (stored) return stored;
  if (printer.kind === "document") return "a4";
  if (printer.kind === "label") return "label57x40";
  return printer.paper_width_mm === 58 ? "thermal58" : "thermal80";
}

/** How a printer marks paper: the label roll, a cut sheet, or a thermal roll. */
export function printerClassOf(printer: {
  printer_class?: PrinterClass | null;
  paper?: PaperKey | null;
  paper_width_mm?: number | null;
  kind?: PrinterPurpose;
}): PrinterClass {
  if (printer.printer_class === "page" || printer.printer_class === "label" || printer.printer_class === "thermal") {
    return printer.printer_class;
  }
  const paper = resolvedPaperOf(printer);
  if (PAPERS[paper].kind === "sheet") return "page";
  if (PAPERS[paper].kind === "label") return "label";
  return "thermal";
}

/** Does this printer have a cash drawer wired to its kick pin? */
export function printerSupportsDrawer(printer: { supports_drawer?: boolean | null }): boolean {
  return printer.supports_drawer === true;
}

/** Should a finished job cut the roll? Defaults to yes — every receipt printer cuts. */
export function printerSupportsCut(printer: { supports_cut?: boolean | null }): boolean {
  return printer.supports_cut !== false;
}

/** True when the row still has no usable hardware target and needs re-pairing. */
export function printerNeedsReconnect(printer: { connection?: unknown }): boolean {
  return normalizeStoredConnection(printer.connection).needsReconnect === true;
}

/**
 * Transition read for rows written before migration 0211 backfilled the
 * relational columns. Isolated on purpose: **remove once no deployment can
 * still hold a printer row with NULL `paper`/`supports_drawer`** (i.e. after
 * every environment has run 0211 and had one deploy cycle). New code never
 * writes these keys.
 */
export function legacyBehaviorOf(connection: StoredPrinterConnection): {
  paper?: PaperKey;
  paperWidthMm?: 58 | 80;
  openDrawer?: boolean;
  isDefault?: boolean;
} {
  const out: { paper?: PaperKey; paperWidthMm?: 58 | 80; openDrawer?: boolean; isDefault?: boolean } = {};
  if (isPaperKey(connection.paper)) out.paper = connection.paper;
  const width = Number(connection.paperWidthMm);
  if (width === 58 || width === 80) out.paperWidthMm = width;
  if (connection.openDrawer === true) out.openDrawer = true;
  if (connection.isDefault === true) out.isDefault = true;
  return out;
}

/* ────────────────────────── validation ────────────────────────── */

/**
 * Does a connection name a usable hardware target? Windows needs the queue
 * name; network needs an IPv4 address. Used at the settings write boundary
 * and by anything about to hand a target to the connector.
 */
export function isValidPrinterConnection(conn: unknown): conn is PrinterConnection {
  if (!conn || typeof conn !== "object") return false;
  const c = conn as Record<string, unknown>;
  if (c.type === "windows") return typeof c.systemName === "string" && c.systemName.trim() !== "";
  if (c.type === "network") {
    if (typeof c.ip !== "string" || !isValidIpv4(c.ip.trim())) return false;
    if (c.port != null && (!Number.isInteger(c.port) || (c.port as number) < 1 || (c.port as number) > 65535)) return false;
    return true;
  }
  return false;
}

/** Strict IPv4 — the connector dials this, so no hostnames and no surprises. */
export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

/** ESC/POS network printers listen on 9100 unless configured otherwise. */
export function resolvedPort(conn: { port?: number | null }): number {
  return Number.isInteger(conn.port) && (conn.port as number) > 0 ? (conn.port as number) : 9100;
}

/** The one-line answer to «this printer is where?» for a card or a list. */
export function describeConnection(conn: StoredPrinterConnection): string {
  const normalized = normalizeStoredConnection(conn);
  if (normalized.needsReconnect) return legacyDescription(normalized);
  if (normalized.type === "windows") return normalized.systemName ?? "—";
  return normalized.ip ?? "—";
}

/** Human words for a legacy transport, so the reconnect card can say what it was. */
export function legacyTransportLabel(transport: string | undefined): string {
  switch (transport) {
    case "usb":
      return "USB مستقیم (قدیمی)";
    case "webusb":
      return "USB از طریق مرورگر (قدیمی)";
    case "browser":
      return "چاپ با مرورگر (قدیمی)";
    default:
      return "اتصال نامشخص (قدیمی)";
  }
}

function legacyDescription(conn: StoredPrinterConnection): string {
  const where =
    conn.usbProductName ? conn.usbProductName : conn.systemName ? conn.systemName : conn.devicePath ? conn.devicePath : conn.ip ? conn.ip : null;
  return where ?? legacyTransportLabel(conn.legacyTransport);
}

/** The target a connection resolves to, or null when it needs reconnection. */
export function printerTargetOf(conn: StoredPrinterConnection): PrinterTarget | null {
  const normalized = normalizeStoredConnection(conn);
  if (normalized.needsReconnect || !isValidPrinterConnection(normalized)) return null;
  if (normalized.type === "windows") return { type: "windows", systemName: normalized.systemName };
  return { type: "network", ip: normalized.ip!.trim(), port: resolvedPort(normalized) };
}
