/**
 * printer-input.ts — the printers write boundary. What must never regress:
 *
 *  - only the canonical hardware model passes: `windows` (queue name) or
 *    `network` (IPv4 + port). Every legacy transport spelling is refused, so
 *    new rows can only ever be ones the new architecture can print;
 *  - all FOUR purposes pass, each with the paper it can actually carry — and
 *    a purpose/paper pair that cannot print is refused (an A4 tray on a roll
 *    printer, a label roll on a receipt printer's document type, a page
 *    printer on raw TCP);
 *  - behaviour is normalised from the caller's own fields (paper, drawer,
 *    cut, active, default) and never blanked by a partial edit;
 *  - a printer no longer names a template: appearance belongs to the rule and
 *    the template, and a `templateKey` in the payload is simply not stored;
 *  - the NUL bytes printer firmware pads its descriptors with cannot reach
 *    PostgreSQL (it rejects \u0000 in jsonb).
 */
import { describe, expect, it } from "vitest";
import { parsePrinterInput } from "./printer-input";
import { connectionJsonOf } from "./types";

describe("parsePrinterInput — the canonical model only", () => {
  it("accepts a windows printer with just a queue name", () => {
    const input = parsePrinterInput({ name: "چاپگر صندوق", kind: "receipt", connection: { type: "windows", systemName: "EPSON TM-T20III" } });
    expect(input).not.toBeNull();
    expect(input!.connection).toEqual({ type: "windows", systemName: "EPSON TM-T20III" });
    expect(input!.paper).toBe("thermal80");
    expect(input!.paperWidthMm).toBe(80);
    expect(input!.printerClass).toBe("thermal");
  });

  it("accepts a network printer, defaulting the port to 9100", () => {
    const input = parsePrinterInput({ name: "چاپگر شبکه", kind: "kitchen", connection: { type: "network", ip: "192.168.1.45" } });
    expect(input!.connection).toEqual({ type: "network", ip: "192.168.1.45", port: 9100 });
  });

  it("accepts a 58mm roll", () => {
    const input = parsePrinterInput({ name: "x", kind: "receipt", paper: "thermal58", connection: { type: "windows", systemName: "E" } });
    expect(input!.paper).toBe("thermal58");
    expect(input!.paperWidthMm).toBe(58);
  });

  it("rejects a network printer without a valid IPv4", () => {
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "network", ip: "" } })).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "network", ip: "printer.lan" } })).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "network", ip: "10.0.0.9", port: 99999 } })).toBeNull();
  });

  it("rejects a windows printer without a queue name", () => {
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "windows" } })).toBeNull();
  });

  it("refuses every legacy transport spelling — no new usb/webusb/browser rows", () => {
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "usb", devicePath: "USB001" } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "webusb", usbVendorId: 0x04b8 } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "browser" } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "system", systemName: "EPSON" } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "network", ip: "10.0.0.1" } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "usb", devicePath: "USB001" } as never })).toBeNull();
  });

  it("rejects a missing name, an unknown kind and an unknown paper", () => {
    expect(parsePrinterInput({ name: "", kind: "receipt", connection: { type: "windows", systemName: "EPSON" } })).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "scanner", connection: { type: "windows", systemName: "EPSON" } } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", paper: "thermal62", connection: { type: "windows", systemName: "E" } })).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", paperWidthMm: 62, connection: { type: "windows", systemName: "EPSON" } })).toBeNull();
  });
});

describe("parsePrinterInput — purpose and paper compatibility", () => {
  it("accepts an A4 invoice printer on a Windows queue", () => {
    const input = parsePrinterInput({
      name: "چاپگر فاکتور",
      kind: "document",
      paper: "a4",
      connection: { type: "windows", systemName: "HP LaserJet M404" },
    });
    expect(input!.printerClass).toBe("page");
    expect(input!.paper).toBe("a4");
    expect(input!.paperWidthMm).toBeNull();
  });

  it("accepts an A5 invoice printer", () => {
    const input = parsePrinterInput({ name: "x", kind: "document", paper: "a5", connection: { type: "windows", systemName: "HP" } });
    expect(input!.printerClass).toBe("page");
  });

  it("refuses a page printer on the network — page jobs go through the Windows driver", () => {
    expect(
      parsePrinterInput({ name: "x", kind: "document", paper: "a4", connection: { type: "network", ip: "10.0.0.9" } }),
    ).toBeNull();
  });

  it("refuses a receipt printer loaded with a sheet", () => {
    expect(
      parsePrinterInput({ name: "x", kind: "receipt", paper: "a4", connection: { type: "windows", systemName: "E" } }),
    ).toBeNull();
    expect(
      parsePrinterInput({ name: "x", kind: "kitchen", paper: "a5", connection: { type: "windows", systemName: "E" } }),
    ).toBeNull();
  });

  it("accepts a label printer on the label roll, and a thermal roll used as one", () => {
    const label = parsePrinterInput({ name: "x", kind: "label", paper: "label57x40", connection: { type: "network", ip: "10.0.0.7" } });
    expect(label!.printerClass).toBe("label");

    const roll = parsePrinterInput({ name: "x", kind: "label", paper: "thermal80", connection: { type: "windows", systemName: "E" } });
    expect(roll!.printerClass).toBe("label");
  });

  it("refuses a label printer loaded with a cut sheet", () => {
    expect(parsePrinterInput({ name: "x", kind: "label", paper: "a4", connection: { type: "windows", systemName: "E" } })).toBeNull();
  });

  it("refuses an invoice printer loaded with a roll", () => {
    expect(parsePrinterInput({ name: "x", kind: "document", paper: "thermal80", connection: { type: "windows", systemName: "E" } })).toBeNull();
  });
});

describe("parsePrinterInput — behaviour fields", () => {
  it("derives the paper from the chosen roll width", () => {
    expect(parsePrinterInput({ name: "x", kind: "receipt", paperWidthMm: 58, connection: { type: "windows", systemName: "E" } })!.paper).toBe("thermal58");
    expect(parsePrinterInput({ name: "x", kind: "receipt", paperWidthMm: 80, connection: { type: "windows", systemName: "E" } })!.paper).toBe("thermal80");
  });

  it("never marks an inactive printer as the default for its purpose", () => {
    const input = parsePrinterInput({ name: "x", kind: "receipt", isActive: false, isDefault: true, connection: { type: "windows", systemName: "E" } });
    expect(input!.isActive).toBe(false);
    expect(input!.isDefault).toBe(false);
  });

  it("keeps the stored drawer/cut/default/paper when a partial edit omits them", () => {
    const input = parsePrinterInput(
      { name: "نام جدید", kind: "receipt", connection: { type: "network", ip: "10.0.0.9" } },
      {
        name: "old",
        kind: "receipt",
        connection: { type: "network", ip: "10.0.0.9", port: 9100 },
        is_active: true,
        paper: "thermal58",
        supports_drawer: true,
        supports_cut: false,
        is_default: true,
      },
    );
    expect(input!.openDrawer).toBe(true);
    expect(input!.supportsCut).toBe(false);
    expect(input!.isDefault).toBe(true);
    expect(input!.paper).toBe("thermal58");
    expect(input!.paperWidthMm).toBe(58);
  });

  it("never stores a drawer on a printer that cannot have one", () => {
    const page = parsePrinterInput({
      name: "x",
      kind: "document",
      paper: "a4",
      openDrawer: true,
      connection: { type: "windows", systemName: "HP" },
    });
    expect(page!.openDrawer).toBe(false);

    const label = parsePrinterInput({
      name: "x",
      kind: "label",
      paper: "label57x40",
      openDrawer: true,
      connection: { type: "network", ip: "10.0.0.7" },
    });
    expect(label!.openDrawer).toBe(false);
  });

  it("ignores a templateKey in the payload — the printer does not own appearance", () => {
    const input = parsePrinterInput({
      name: "x",
      kind: "receipt",
      templateKey: "compact58",
      connection: { type: "network", ip: "10.0.0.9", port: 9101 },
    });
    expect(input).not.toBeNull();
    expect(input as unknown as Record<string, unknown>).not.toHaveProperty("templateKey");
    expect(JSON.stringify(connectionJsonOf(input!.connection))).not.toContain("templateKey");
  });

  it("strips NUL padding printer firmware reports in its strings (Postgres rejects \\u0000 in jsonb)", () => {
    const input = parsePrinterInput({
      name: "EPSON\u0000\u0000",
      kind: "receipt",
      connection: { type: "windows", systemName: "TM-T20\u0000\u0000" },
    });
    expect(input!.name).toBe("EPSON");
    expect(input!.connection.systemName).toBe("TM-T20");
    expect(JSON.stringify(connectionJsonOf(input!.connection))).not.toContain("\\u0000");
  });

  it("produces the stored jsonb shape: the hardware target and nothing else", () => {
    const input = parsePrinterInput({
      name: "x",
      kind: "receipt",
      paperWidthMm: 58,
      openDrawer: true,
      isDefault: true,
      templateKey: "kitchen80",
      connection: { type: "network", ip: "10.0.0.9", port: 9101 },
    });
    expect(connectionJsonOf(input!.connection)).toEqual({
      type: "network",
      ip: "10.0.0.9",
      port: 9101,
    });
  });
});
