/**
 * `resolvePrintPlan` — the ONE authoritative answer to "what exactly will this
 * print, and where?".
 *
 * Before this module there were three answers to that question and they
 * disagreed:
 *
 *   - the **designer preview** rendered the template the operator was editing;
 *   - **Settings → Rules** stored `template_id` / `template_key`, and the
 *     rules screen showed them back;
 *   - **actual printing** ignored both and asked `printer.connection
 *     .templateKey`, then fell back to a built-in — so a saved custom
 *     template, chosen, previewed, test-printed and saved, printed as a
 *     built-in receipt at the till.
 *
 * The plan is now the only source of routing truth, and every print entry
 * point — the POS, the order screen, kitchen tickets, labels, the settings
 * test print — resolves it before anything is rendered. It carries the
 * template (built-in *or* saved), the primary and fallback printer, the
 * branding and the version that generated the job, so:
 *
 *   - preview, test print and production print share one template choice;
 *   - `print_jobs` can record exactly which revision produced a receipt;
 *   - the branding a preview shows is the branding production prints.
 *
 * Precedence, highest first (see `resolveTemplateChoice`):
 *
 *   1. an explicit `templateId` on the request (the settings "print sample"
 *      button, a diagnostics re-run of a recorded job);
 *   2. the print rule for the document type — its saved template, else its
 *      built-in key;
 *   3. the branch's saved default template for that document type;
 *   4. the built-in template matching the printer's paper and the document
 *      type.
 *
 * The plan is resolved against the caller's own location: a template or
 * printer id from another branch is not "someone else's row", it is a row
 * that does not exist.
 */
import { query } from "../db";
import { getPrintTemplate, listPrintTemplates, type SavedPrintTemplate } from "../print-templates-service";
import {
  builtInTemplate,
  BUILT_IN_TEMPLATES,
  PAPERS,
  type DocType,
  type PaperKey,
  type PrintTemplate,
} from "../print-template";
import { getSetting, SETTING_KEYS } from "../settings";
import { PRINTER_COLUMNS } from "./printer-columns";
import { isStoredLogo, type BusinessLogo } from "../business-logo";
import type { PrintBranding } from "./document-bridge";
import type { PrinterErrorCode } from "./errors";
import {
  paperOfPrinter,
  printerAcceptsPaper,
  purposeForDocument,
  resolvePrinter,
  type PrintRuleRef,
  type ResolveReason,
  type RoutingPrinter,
} from "./routing";
import {
  legacyBehaviorOf,
  printerClassOf,
  printerSupportsDrawer,
  resolvedPaperOf,
  type PrinterPurpose,
  type StoredPrinter,
} from "./types";

/** A document type as a print rule and a printer purpose both spell it. */
export type PrintDocumentType = DocType;

export type { PrintBranding };

/** A template resolved to something renderable, with its provenance. */
export interface ResolvedTemplate {
  template: PrintTemplate;
  /** The `print_templates` row id, or null for a built-in. */
  templateId: string | null;
  /** Built-in preset key, or the saved row's id for a saved template. */
  templateKey: string;
  /** Revision that produced the job — `print_templates.version`, 1 for built-ins. */
  templateVersion: number;
  saved: boolean;
  /** Why this template won; the settings "test route" shows it. */
  source: "explicit" | "rule" | "default" | "printer" | "builtin";
}

export interface PrintPlan {
  locationId: string;
  documentType: PrintDocumentType;
  printer: StoredPrinter;
  fallbackPrinter: StoredPrinter | null;
  routingPrinter: RoutingPrinter;
  template: PrintTemplate;
  templateId: string | null;
  templateKey: string;
  templateVersion: number;
  templateSource: ResolvedTemplate["source"];
  /** The paper the printer will actually feed — decides raster width and page size. */
  paper: PaperKey;
  branding: PrintBranding;
  /** How the printer was chosen (`rule`, `fallback`, `default`, `explicit`, …). */
  reason: ResolveReason;
}

export type PrintPlanResult = { ok: true; plan: PrintPlan } | { ok: false; error: PrinterErrorCode };

/* ─────────────────────────── pure resolution ─────────────────────────── */

export interface TemplateChoiceInput {
  documentType: PrintDocumentType;
  /** The printer the job will go to; its paper decides the last-resort built-in. */
  printerPaper: PaperKey | null;
  printerClass: ReturnType<typeof printerClassOf>;
  /** A template id the caller asked for explicitly (request/diagnostics). */
  requestedTemplateId?: string | null;
  /** The rule for this document type, if the branch has one. */
  rule?: PrintRuleRef | null;
  /** The branch's saved templates. */
  saved: SavedPrintTemplate[];
  /**
   * A template key that may still be stored on the printer row from the
   * pre-0212 model. Only consulted when nothing else chose a template, and
   * never written by new code — see the removal note in types.ts.
   */
  legacyPrinterTemplateKey?: string | null;
}

export type TemplateChoice =
  | { ok: true; choice: ResolvedTemplate }
  | { ok: false; error: "template_invalid" | "template_not_found" };

function savedToResolved(saved: SavedPrintTemplate, source: ResolvedTemplate["source"]): ResolvedTemplate {
  return {
    template: saved,
    templateId: saved.id,
    templateKey: saved.id,
    templateVersion: saved.version,
    saved: true,
    source,
  };
}

function builtInToResolved(template: PrintTemplate, source: ResolvedTemplate["source"]): ResolvedTemplate {
  return { template, templateId: null, templateKey: template.key, templateVersion: 1, saved: false, source };
}

/** A built-in key may also be a saved row id (legacy rows stored the id in `template_key`). */
function savedById(saved: SavedPrintTemplate[], id: string | null | undefined): SavedPrintTemplate | null {
  if (!id) return null;
  return saved.find((row) => row.id === id) ?? null;
}

/**
 * The built-in a document type falls back to on a given paper.
 *
 * The candidates are always templates **of this document type**: the exact
 * paper first, then another paper of the same physical kind (a 58mm receipt
 * layout on an 80mm roll — the renderer re-widths it), then the type's first
 * built-in. Matching on the paper alone would let a label document on a
 * thermal roll fall back to the *receipt* preset, which is precisely the
 * silent wrong-layout the unified resolver exists to prevent.
 *
 * Never null: there is at least one built-in per document type.
 */
export function builtInFor(documentType: PrintDocumentType, paper: PaperKey | null): PrintTemplate {
  const candidates = BUILT_IN_TEMPLATES.filter((t) => t.docType === documentType);
  const pool = candidates.length > 0 ? candidates : BUILT_IN_TEMPLATES;
  return (
    (paper ? pool.find((t) => t.paper === paper) : null) ??
    (paper ? pool.find((t) => PAPERS[t.paper].kind === PAPERS[paper].kind) : null) ??
    pool[0]
  );
}

/**
 * Choose the template for a job. Pure, so the settings UI, the resolver tests
 * and the doctor/diagnostics route all reason about the same matrix.
 *
 * An explicitly chosen template (request or rule) must match the document
 * type and be renderable on the printer that will receive it — a mismatch is
 * an error the operator must fix, never a silent substitution. A template
 * that only wins by *default* (the branch's saved default, a legacy printer
 * key) is allowed to lose to a paper mismatch, because nothing was chosen
 * explicitly.
 */
export function resolveTemplateChoice(input: TemplateChoiceInput): TemplateChoice {
  const saved = input.saved;

  const explicit = savedById(saved, input.requestedTemplateId);
  if (input.requestedTemplateId) {
    if (!explicit) return { ok: false, error: "template_not_found" };
    if (explicit.docType !== input.documentType) return { ok: false, error: "template_invalid" };
    if (!printerAcceptsPaper(input.printerClass, explicit.paper)) return { ok: false, error: "template_invalid" };
    return { ok: true, choice: savedToResolved(explicit, "explicit") };
  }

  const rule = input.rule ?? null;

  // A rule that names a saved template is authoritative — it is exactly what
  // the operator selected in «قوانین چاپ».
  const ruleSaved = savedById(saved, rule?.templateId);
  if (rule?.templateId) {
    if (!ruleSaved) return { ok: false, error: "template_not_found" };
    if (ruleSaved.docType !== input.documentType) return { ok: false, error: "template_invalid" };
    if (!printerAcceptsPaper(input.printerClass, ruleSaved.paper)) return { ok: false, error: "template_invalid" };
    return { ok: true, choice: savedToResolved(ruleSaved, "rule") };
  }

  if (rule?.templateKey) {
    const builtIn = builtInTemplate(rule.templateKey);
    if (builtIn) {
      if (builtIn.docType !== input.documentType) return { ok: false, error: "template_invalid" };
      if (!printerAcceptsPaper(input.printerClass, builtIn.paper)) return { ok: false, error: "template_invalid" };
      return { ok: true, choice: builtInToResolved(builtIn, "rule") };
    }
    // Legacy: the rule's `template_key` held a saved row id.
    const legacySaved = savedById(saved, rule.templateKey);
    if (legacySaved) {
      if (legacySaved.docType !== input.documentType) return { ok: false, error: "template_invalid" };
      if (!printerAcceptsPaper(input.printerClass, legacySaved.paper)) return { ok: false, error: "template_invalid" };
      return { ok: true, choice: savedToResolved(legacySaved, "rule") };
    }
    return { ok: false, error: "template_not_found" };
  }

  // The branch's saved default for this document type — what the template
  // gallery calls «پیشفرض» — as long as the printer can render it.
  const savedDefault = saved.find((row) => row.docType === input.documentType && row.isDefault);
  if (savedDefault && printerAcceptsPaper(input.printerClass, savedDefault.paper)) {
    return { ok: true, choice: savedToResolved(savedDefault, "default") };
  }

  // The pre-0212 `printer.connection.templateKey`, kept alive only so an
  // un-migrated row still prints what it used to. Remove with legacyBehaviorOf.
  if (input.legacyPrinterTemplateKey) {
    const legacyBuiltIn = builtInTemplate(input.legacyPrinterTemplateKey);
    if (legacyBuiltIn && legacyBuiltIn.docType === input.documentType) {
      return { ok: true, choice: builtInToResolved(legacyBuiltIn, "printer") };
    }
    const legacySaved = savedById(saved, input.legacyPrinterTemplateKey);
    if (legacySaved && legacySaved.docType === input.documentType && printerAcceptsPaper(input.printerClass, legacySaved.paper)) {
      return { ok: true, choice: savedToResolved(legacySaved, "printer") };
    }
  }

  // Anything the saved default could not serve falls back to the built-in for
  // the printer's own paper — the precedence the whole product documents:
  // rule → saved default → built-in.
  return { ok: true, choice: builtInToResolved(builtInFor(input.documentType, input.printerPaper), "builtin") };
}

/* ─────────────────────────── database loading ─────────────────────────── */

export function normalizePrinterRow(row: StoredPrinter): StoredPrinter {
  return { ...row, connection: row.connection ?? {} };
}

/**
 * A saved printer as the routing layer sees it. The relational columns are
 * the source of truth; `legacyBehaviorOf` only fills blanks on a row written
 * before migration 0211 backfilled them.
 */
export function toRoutingPrinter(printer: StoredPrinter): RoutingPrinter {
  const legacy = legacyBehaviorOf(printer.connection ?? {});
  const paper = paperOfPrinterOrLegacy(printer, legacy);
  const purpose: PrinterPurpose = printer.kind;
  return {
    id: String(printer.id),
    name: String(printer.name),
    purpose,
    printerClass: printerClassOf({ ...printer, paper }),
    isActive: printer.is_active !== false,
    isDefault: printer.is_default === true || (printer.is_default == null && legacy.isDefault === true),
    needsReconnect: (printer.connection as { needsReconnect?: boolean })?.needsReconnect === true,
    supportsDrawer: printerSupportsDrawer(printer) || (printer.supports_drawer == null && legacy.openDrawer === true),
    paper,
  };
}

function paperOfPrinterOrLegacy(
  printer: StoredPrinter,
  legacy: ReturnType<typeof legacyBehaviorOf>,
): PaperKey | null {
  const stored = paperOfPrinterIfSet(printer);
  if (stored) return stored;
  if (legacy.paper) return legacy.paper;
  if (legacy.paperWidthMm === 58) return "thermal58";
  if (legacy.paperWidthMm === 80) return "thermal80";
  return null;
}

function paperOfPrinterIfSet(printer: StoredPrinter): PaperKey | null {
  const value = printer.paper;
  if (typeof value === "string" && value in PAPERS) return value as PaperKey;
  const width = Number(printer.paper_width_mm);
  if (width === 58) return "thermal58";
  if (width === 80) return "thermal80";
  return null;
}

/** Every printer of a branch, in the routing shape. */
export async function loadRoutablePrinters(locationId: string): Promise<{ printers: StoredPrinter[]; routable: RoutingPrinter[] }> {
  const { rows } = await query<StoredPrinter>(
    `SELECT ${PRINTER_COLUMNS} FROM printers WHERE location_id = $1`,
    [locationId],
  );
  const printers = rows.map(normalizePrinterRow);
  return { printers, routable: printers.map(toRoutingPrinter) };
}

/** The branch's print rules. A missing table (older deployment) reads as no rules. */
export async function loadPrintRules(locationId: string): Promise<PrintRuleRef[]> {
  try {
    const { rows } = await query<{
      document_type: string;
      printer_id: string | null;
      fallback_printer_id: string | null;
      template_key: string | null;
      template_id: string | null;
    }>(
      "SELECT document_type, printer_id, fallback_printer_id, template_key, template_id FROM print_rules WHERE location_id = $1",
      [locationId],
    );
    return rows
      .filter((row) => row.document_type === "receipt" || row.document_type === "invoice" || row.document_type === "kitchen" || row.document_type === "label")
      .map((row) => ({
        documentType: row.document_type as DocType,
        printerId: row.printer_id,
        fallbackPrinterId: row.fallback_printer_id,
        templateKey: row.template_key,
        templateId: row.template_id,
      }));
  } catch (err) {
    console.error("print rules unavailable", err);
    return [];
  }
}

interface BusinessProfileSetting {
  legalName?: string;
  taxId?: string;
  email?: string;
  website?: string;
  receiptFooter?: string;
}

/**
 * The branding every print job carries, loaded server-side from the
 * authenticated location — the same identity the settings preview shows:
 * business name, legal name, tax id, contact details, receipt footer, the
 * uploaded logo and this branch's address/phone.
 *
 * Production printing used to receive no branding at all, so a preview with a
 * logo and a legal footer printed a bare receipt. Loading it here is what
 * makes "it looked right in the preview" a true statement about the paper.
 *
 * Every read is individually forgiving: a branch with no address, a business
 * whose profile setting was never filled in, or an unreadable logo must never
 * stop a receipt — the identity simply prints with what is known.
 */
export async function loadPrintBranding(locationId: string): Promise<PrintBranding> {
  const branding: PrintBranding = { name: "" };
  let businessId: string | null = null;
  try {
    const { rows } = await query<{ business_id: string; name: string; address: string | null; phone: string | null }>(
      `SELECT business_id, name, address, phone FROM locations WHERE id = $1`,
      [locationId],
    );
    const location = rows[0];
    if (location) {
      businessId = location.business_id;
      branding.address = location.address ?? null;
      branding.phone = location.phone ?? null;
    }
  } catch {
    // A branch row that cannot be read leaves the identity to the profile below.
  }
  if (!businessId) return branding;

  try {
    const { rows } = await query<{ name: string | null }>(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
    branding.name = rows[0]?.name?.trim() ?? "";
  } catch {
    // The trade name is the one line a receipt cannot invent; leave it empty.
  }
  try {
    const profile = await getSetting<BusinessProfileSetting>(businessId, SETTING_KEYS.businessProfile);
    branding.legalName = profile?.legalName?.trim() || null;
    branding.taxId = profile?.taxId?.trim() || null;
    branding.email = profile?.email?.trim() || null;
    branding.website = profile?.website?.trim() || null;
    branding.footer = profile?.receiptFooter?.trim() || null;
  } catch {
    // Profile columns differ across deployment ages; identity degrades to name + branch.
  }
  try {
    const logo = await getSetting<unknown>(businessId, SETTING_KEYS.businessLogo);
    if (isStoredLogo(logo)) branding.logoDataUrl = (logo as BusinessLogo).dataUrl;
  } catch {
    // A logo that cannot be read must never stop a receipt.
  }
  return branding;
}

export interface ResolvePrintPlanInput {
  locationId: string;
  documentType: PrintDocumentType;
  /** An explicit printer id from the caller; must belong to this location. */
  requestedPrinterId?: string | null;
  /** An explicit template id from the caller; must belong to this location. */
  requestedTemplateId?: string | null;
  /** Test prints and diagnostics may want the fallback recorded but not used. */
  includeBranding?: boolean;
}

/**
 * Resolve everything a print job needs, or the canonical reason it cannot be
 * printed. This is the single entry point every route uses; nothing else may
 * load a printer for a job.
 */
export async function resolvePrintPlan(input: ResolvePrintPlanInput): Promise<PrintPlanResult> {
  const { printers, routable } = await loadRoutablePrinters(input.locationId);
  const rules = await loadPrintRules(input.locationId);

  // An explicit printer is a statement about hardware, so it is answered with
  // a precise refusal instead of being quietly replaced by a default: "that
  // printer is inactive" is actionable, "printed somewhere else" is not.
  if (input.requestedPrinterId) {
    const requested = routable.find((printer) => printer.id === input.requestedPrinterId);
    if (!requested) return { ok: false, error: "printer_not_found" };
    if (!requested.isActive) return { ok: false, error: "printer_inactive" };
    if (requested.needsReconnect) return { ok: false, error: "reconnect_required" };
    if (requested.purpose !== purposeForDocument(input.documentType)) {
      return { ok: false, error: "incompatible_printer" };
    }
  }

  const resolved = resolvePrinter({
    documentType: input.documentType,
    printers: routable,
    rules,
    requestedPrinterId: input.requestedPrinterId ?? null,
  });

  if (!resolved.printer) {
    if (resolved.reason === "unavailable") return { ok: false, error: "printer_unavailable" };
    return { ok: false, error: "printer_not_configured" };
  }

  const printerRow = printers.find((printer) => String(printer.id) === resolved.printer!.id) ?? null;
  if (!printerRow) return { ok: false, error: "printer_not_found" };

  const fallbackRow = resolved.fallbackFrom
    ? printers.find((printer) => String(printer.id) === resolved.fallbackFrom!.id) ?? null
    : null;

  const rule = rules.find((item) => item.documentType === input.documentType) ?? null;
  const saved = await listPrintTemplates(input.locationId);

  // The pre-0212 template key, read only as the resolver's last resort.
  const legacyTemplateKey =
    typeof (printerRow.connection as { templateKey?: unknown })?.templateKey === "string"
      ? ((printerRow.connection as { templateKey: string }).templateKey)
      : null;

  const choice = resolveTemplateChoice({
    documentType: input.documentType,
    printerPaper: resolved.printer.paper,
    printerClass: resolved.printer.printerClass,
    requestedTemplateId: input.requestedTemplateId ?? null,
    rule,
    saved,
    legacyPrinterTemplateKey: legacyTemplateKey,
  });
  if (!choice.ok) return { ok: false, error: choice.error };

  const branding = input.includeBranding === false ? { name: "" } : await loadPrintBranding(input.locationId);

  return {
    ok: true,
    plan: {
      locationId: input.locationId,
      documentType: input.documentType,
      printer: printerRow,
      fallbackPrinter: fallbackRow,
      routingPrinter: resolved.printer,
      template: choice.choice.template,
      templateId: choice.choice.templateId,
      templateKey: choice.choice.templateKey,
      templateVersion: choice.choice.templateVersion,
      templateSource: choice.choice.source,
      paper: resolvedPaperOf({ ...printerRow, kind: printerRow.kind }),
      branding,
      reason: resolved.reason,
    },
  };
}

/**
 * Every template the branch can print a document type with: its saved
 * templates (filtered to the ones this printer can render) and the built-ins.
 * The rules screen and the diagnostics route both list from here, so the
 * choices an operator sees are exactly the choices the resolver accepts.
 */
export function selectableTemplates(
  saved: SavedPrintTemplate[],
  documentType: PrintDocumentType,
  printerClass: ReturnType<typeof printerClassOf>,
): { saved: SavedPrintTemplate[]; builtIns: PrintTemplate[] } {
  return {
    saved: saved.filter((row) => row.docType === documentType && printerAcceptsPaper(printerClass, row.paper)),
    builtIns: BUILT_IN_TEMPLATES.filter((t) => t.docType === documentType && printerAcceptsPaper(printerClass, t.paper)),
  };
}

/** The saved default template of a document type, if the branch has one. */
export async function defaultSavedTemplate(locationId: string, documentType: PrintDocumentType): Promise<SavedPrintTemplate | null> {
  const saved = await listPrintTemplates(locationId);
  return saved.find((row) => row.docType === documentType && row.isDefault) ?? null;
}

/** One saved template, validated to belong to this branch. */
export { getPrintTemplate };
export type { SavedPrintTemplate };
