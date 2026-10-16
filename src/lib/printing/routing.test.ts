import { describe, expect, it } from "vitest";
import {
  DOC_TYPES_FOR_CLASS,
  PAPER_FOR_PURPOSE_DEFAULTS,
  PURPOSE_FOR_DOC_DEFAULTS,
  classAcceptsDocument,
  documentTypeForPurpose,
  isDocType,
  mapWindowsPrinterStatus,
  paperAllowedForPurpose,
  printerAcceptsDocument,
  printerAcceptsPaper,
  printerClassFor,
  purposeForDocument,
  resolvePrinter,
  shouldOpenDrawer,
  type RoutingPrinter,
} from "./routing";

function printer(overrides: Partial<RoutingPrinter> = {}): RoutingPrinter {
  return {
    id: "p1",
    name: "صندوق",
    purpose: "receipt",
    printerClass: "thermal",
    isActive: true,
    isDefault: false,
    needsReconnect: false,
    supportsDrawer: false,
    paper: "thermal80",
    ...overrides,
  };
}

describe("resolvePrinter", () => {
  const receipt = printer({ id: "r", isDefault: true });
  const backup = printer({ id: "b", name: "پشتیبان" });
  const kitchen = printer({ id: "k", name: "آشپزخانه", purpose: "kitchen" });
  const laser = printer({ id: "h", name: "HP", purpose: "document", printerClass: "page" });

  it("prefers the printer the action named", () => {
    const result = resolvePrinter({
      documentType: "receipt",
      printers: [receipt, backup],
      requestedPrinterId: "b",
    });
    expect(result.printer?.id).toBe("b");
    expect(result.reason).toBe("explicit");
  });

  it("uses the document rule before the default", () => {
    const result = resolvePrinter({
      documentType: "receipt",
      printers: [receipt, backup],
      rules: [{ documentType: "receipt", printerId: "b", fallbackPrinterId: null, templateKey: "thermal80-receipt", templateId: null }],
    });
    expect(result.printer?.id).toBe("b");
    expect(result.templateKey).toBe("thermal80-receipt");
    expect(result.reason).toBe("rule");
  });

  it("falls back only to a compatible backup", () => {
    const offline = printer({ id: "r", isActive: false, isDefault: true });
    const result = resolvePrinter({
      documentType: "receipt",
      printers: [offline, backup, kitchen],
      rules: [{ documentType: "receipt", printerId: "r", fallbackPrinterId: "b", templateKey: null, templateId: null }],
    });
    expect(result.printer?.id).toBe("b");
    expect(result.reason).toBe("fallback");
    expect(result.fallbackFrom?.id).toBe("r");
  });

  it("never sends an invoice to a kitchen printer, and says the rule is unusable instead", () => {
    const result = resolvePrinter({
      documentType: "invoice",
      printers: [kitchen, laser],
      rules: [{ documentType: "invoice", printerId: "k", fallbackPrinterId: null, templateKey: null, templateId: null }],
    });
    // A rule names the printer: it is authoritative, so the answer is "this
    // printer cannot take this document" — not a silent trip to another one.
    expect(result.printer).toBeNull();
    expect(result.reason).toBe("unavailable");
  });

  it("still uses the only compatible printer when no rule names anything", () => {
    const result = resolvePrinter({ documentType: "invoice", printers: [kitchen, laser] });
    expect(result.printer?.id).toBe("h");
    expect(result.reason).toBe("only");
  });

  it("falls back to the rule's fallback printer when the primary is gone", () => {
    const result = resolvePrinter({
      documentType: "receipt",
      printers: [backup],
      rules: [{ documentType: "receipt", printerId: "retired", fallbackPrinterId: "b", templateKey: null, templateId: null }],
    });
    expect(result.printer?.id).toBe("b");
    expect(result.reason).toBe("fallback");
    expect(result.fallbackFrom).toBeNull();
  });

  it("asks when nothing compatible is configured", () => {
    const result = resolvePrinter({ documentType: "invoice", printers: [receipt, kitchen] });
    expect(result.printer).toBeNull();
    expect(result.reason).toBe("choose");
  });

  it("uses the only compatible printer", () => {
    expect(resolvePrinter({ documentType: "kitchen", printers: [receipt, kitchen] }).printer?.id).toBe("k");
  });
});

describe("shouldOpenDrawer", () => {
  it("pulses once for a cash sale on a drawer printer", () => {
    expect(shouldOpenDrawer({ paymentIncludesCash: true, isReprint: false, supportsDrawer: true })).toBe(true);
  });

  it("does not pulse on reprint, card, or a printer without a drawer", () => {
    expect(shouldOpenDrawer({ paymentIncludesCash: true, isReprint: true, supportsDrawer: true })).toBe(false);
    expect(shouldOpenDrawer({ paymentIncludesCash: false, isReprint: false, supportsDrawer: true })).toBe(false);
    expect(shouldOpenDrawer({ paymentIncludesCash: true, isReprint: false, supportsDrawer: false })).toBe(false);
  });
});

describe("mapWindowsPrinterStatus", () => {
  it("does not call a queue ready just because it exists", () => {
    expect(mapWindowsPrinterStatus({})).toBe("unknown");
    expect(mapWindowsPrinterStatus({ printerStatus: 3, workOffline: false })).toBe("ready");
    expect(mapWindowsPrinterStatus({ workOffline: true, printerStatus: 3 })).toBe("offline");
    expect(mapWindowsPrinterStatus({ printerStatus: 6 })).toBe("paused");
  });
});

describe("printerAcceptsDocument", () => {
  it("keeps page printers off thermal receipts", () => {
    const laser = printer({ purpose: "document", printerClass: "page", paper: "a4" });
    expect(printerAcceptsDocument(laser, "invoice")).toBe(true);
    expect(printerAcceptsDocument(laser, "receipt")).toBe(false);
    expect(printerAcceptsDocument(printer({ needsReconnect: true }), "receipt")).toBe(false);
    expect(printerAcceptsDocument(printer({ isActive: false }), "receipt")).toBe(false);
  });

  it("matches purpose to document type in both directions", () => {
    expect(purposeForDocument("invoice")).toBe("document");
    expect(documentTypeForPurpose("document")).toBe("invoice");
    expect(documentTypeForPurpose("label")).toBe("label");
    expect(printerAcceptsDocument(printer({ purpose: "label", printerClass: "label", paper: "label57x40" }), "label")).toBe(true);
    expect(printerAcceptsDocument(printer({ purpose: "label", printerClass: "label", paper: "label57x40" }), "invoice")).toBe(false);
  });

  it("lets a label-purpose printer on a thermal roll print labels, but not a receipt printer", () => {
    // A printer whose purpose is «برچسب» may be loaded with a thermal roll —
    // a sticker is just a short raster — and that is the only way a roll
    // meets a label document. A receipt printer never carries labels.
    expect(printerAcceptsDocument(printer({ purpose: "label", printerClass: "thermal", paper: "thermal80" }), "label")).toBe(true);
    expect(printerAcceptsDocument(printer(), "label")).toBe(false);
  });

  it("keeps every class inside its own documents", () => {
    expect(DOC_TYPES_FOR_CLASS.thermal).toEqual(["receipt", "kitchen", "label"]);
    expect(DOC_TYPES_FOR_CLASS.page).toEqual(["invoice"]);
    expect(DOC_TYPES_FOR_CLASS.label).toEqual(["label"]);
    expect(classAcceptsDocument("page", "receipt")).toBe(false);
  });
});

describe("the write-boundary matrix", () => {
  it("accepts exactly the paper a purpose can carry", () => {
    expect(paperAllowedForPurpose("receipt", "thermal80")).toBe(true);
    expect(paperAllowedForPurpose("receipt", "thermal58")).toBe(true);
    expect(paperAllowedForPurpose("receipt", "a4")).toBe(false);
    expect(paperAllowedForPurpose("kitchen", "a4")).toBe(false);
    expect(paperAllowedForPurpose("document", "a4")).toBe(true);
    expect(paperAllowedForPurpose("document", "a5")).toBe(true);
    expect(paperAllowedForPurpose("document", "thermal80")).toBe(false);
    expect(paperAllowedForPurpose("label", "label57x40")).toBe(true);
    expect(paperAllowedForPurpose("label", "a4")).toBe(false);
  });

  it("derives a printer class from purpose and paper", () => {
    expect(printerClassFor("receipt", "thermal80")).toBe("thermal");
    expect(printerClassFor("document", "a5")).toBe("page");
    expect(printerClassFor("label", "label57x40")).toBe("label");
    expect(printerClassFor("label", "thermal58")).toBe("label");
  });

  it("classifies template papers per printer class", () => {
    expect(printerAcceptsPaper("thermal", "thermal58")).toBe(true);
    expect(printerAcceptsPaper("thermal", "label57x40")).toBe(true);
    expect(printerAcceptsPaper("thermal", "a4")).toBe(false);
    expect(printerAcceptsPaper("page", "a4")).toBe(true);
    expect(printerAcceptsPaper("page", "a5")).toBe(true);
    expect(printerAcceptsPaper("page", "thermal80")).toBe(false);
    expect(printerAcceptsPaper("label", "label57x40")).toBe(true);
    expect(printerAcceptsPaper("label", "thermal80")).toBe(false);
  });

  it("recognises the four document types", () => {
    expect(isDocType("invoice")).toBe(true);
    expect(isDocType("document")).toBe(false);
    expect(isDocType("label")).toBe(true);
  });

  it("keeps the exported defaults honest", () => {
    expect(PAPER_FOR_PURPOSE_DEFAULTS.document).toBe("a4");
    expect(PURPOSE_FOR_DOC_DEFAULTS.invoice).toBe("document");
  });
});

describe("stale sending jobs", () => {
  it("sweeps after a bounded window", async () => {
    const { SENDING_STALE_AFTER_SECONDS } = await import("./routing");
    expect(SENDING_STALE_AFTER_SECONDS).toBeLessThanOrEqual(300);
    expect(SENDING_STALE_AFTER_SECONDS).toBeGreaterThan(30);
  });
});

describe("runtime fallback after primary delivery failure", () => {
  it("selects the rule's configured compatible fallback when the primary printer failed delivery", () => {
    const primary = printer({ id: "p-primary", name: "صندوق اصلی" });
    const backup = printer({ id: "p-backup", name: "صندوق پشتیبان" });
    const result = resolvePrinter({
      documentType: "receipt",
      printers: [primary, backup],
      rules: [{ documentType: "receipt", printerId: "p-primary", fallbackPrinterId: "p-backup", templateKey: null, templateId: null }],
      failedPrinterIds: ["p-primary"],
    });
    expect(result.printer?.id).toBe("p-backup");
    expect(result.fallbackFrom?.id).toBe("p-primary");
    expect(result.reason).toBe("fallback");
  });

  it("ignores a leftover fallback when primary is automatic (printerId: null) so default/only routing wins", () => {
    const defaultPrinter = printer({ id: "p-default", name: "صندوق پیش‌فرض", isDefault: true });
    const leftoverFallback = printer({ id: "p-backup", name: "صندوق پشتیبان", isDefault: false });

    const withDefault = resolvePrinter({
      documentType: "receipt",
      printers: [defaultPrinter, leftoverFallback],
      rules: [
        {
          documentType: "receipt",
          printerId: null,
          fallbackPrinterId: "p-backup",
          templateKey: "thermal80-receipt",
          templateId: "tpl-custom",
        },
      ],
    });
    expect(withDefault.printer?.id).toBe("p-default");
    expect(withDefault.reason).toBe("default");
    expect(withDefault.fallbackFrom).toBeNull();
    expect(withDefault.templateKey).toBe("thermal80-receipt");
    expect(withDefault.templateId).toBe("tpl-custom");

    // Even if the leftover fallback printer is offline/inactive, automatic
    // routing still picks the only compatible printer rather than reporting unavailable.
    const offlineFallback = printer({ id: "p-backup", name: "صندوق پشتیبان", isActive: false });
    const onlyPrinter = printer({ id: "p-only", name: "تنها چاپگر", isDefault: false });
    const withOnly = resolvePrinter({
      documentType: "receipt",
      printers: [onlyPrinter, offlineFallback],
      rules: [{ documentType: "receipt", printerId: null, fallbackPrinterId: "p-backup", templateKey: null, templateId: null }],
    });
    expect(withOnly.printer?.id).toBe("p-only");
    expect(withOnly.reason).toBe("only");
    expect(withOnly.fallbackFrom).toBeNull();
  });

  it("preserves failover to the configured fallback when a configured primary is unavailable or removed", () => {
    const inactivePrimary = printer({ id: "p-primary", name: "صندوق اصلی", isActive: false, isDefault: true });
    const backup = printer({ id: "p-backup", name: "صندوق پشتیبان", isDefault: false });

    const whenInactive = resolvePrinter({
      documentType: "receipt",
      printers: [inactivePrimary, backup],
      rules: [{ documentType: "receipt", printerId: "p-primary", fallbackPrinterId: "p-backup", templateKey: null, templateId: null }],
    });
    expect(whenInactive.printer?.id).toBe("p-backup");
    expect(whenInactive.fallbackFrom?.id).toBe("p-primary");
    expect(whenInactive.reason).toBe("fallback");

    const whenRemoved = resolvePrinter({
      documentType: "receipt",
      printers: [backup],
      rules: [{ documentType: "receipt", printerId: "p-removed", fallbackPrinterId: "p-backup", templateKey: null, templateId: null }],
    });
    expect(whenRemoved.printer?.id).toBe("p-backup");
    expect(whenRemoved.fallbackFrom).toBeNull();
    expect(whenRemoved.reason).toBe("fallback");
  });

  it("never falls back to an arbitrary unconfigured printer when the primary fails delivery", () => {
    const primary = printer({ id: "p-primary", isDefault: true });
    const unconfigured = printer({ id: "p-other", isDefault: false });

    // No rule at all:
    expect(
      resolvePrinter({
        documentType: "receipt",
        printers: [primary, unconfigured],
        rules: [],
        failedPrinterIds: ["p-primary"],
      }),
    ).toMatchObject({ printer: null, reason: "unavailable" });

    // Rule without fallback:
    expect(
      resolvePrinter({
        documentType: "receipt",
        printers: [primary, unconfigured],
        rules: [{ documentType: "receipt", printerId: "p-primary", fallbackPrinterId: null, templateKey: null, templateId: null }],
        failedPrinterIds: ["p-primary"],
      }),
    ).toMatchObject({ printer: null, reason: "unavailable" });
  });

  it("stops after the fallback printer also fails delivery (no infinite retries)", () => {
    const primary = printer({ id: "p-primary" });
    const backup = printer({ id: "p-backup" });
    expect(
      resolvePrinter({
        documentType: "receipt",
        printers: [primary, backup],
        rules: [{ documentType: "receipt", printerId: "p-primary", fallbackPrinterId: "p-backup", templateKey: null, templateId: null }],
        failedPrinterIds: ["p-primary", "p-backup"],
      }),
    ).toMatchObject({ printer: null, reason: "unavailable" });
  });
});

