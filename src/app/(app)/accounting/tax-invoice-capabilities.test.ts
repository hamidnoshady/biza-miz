/**
 * Issue #866 — the screen's capability map. The buttons a member sees must be the
 * ones the API will accept, so this maps the same permission keys the routes check
 * and pins the three presets the product ships.
 */
import { describe, expect, it } from "vitest";
import { PERMISSIONS, roleBasePermissions } from "@/lib/permissions";
import { taxInvoiceCapabilitiesFor } from "./tax-invoice-capabilities";

describe("taxInvoiceCapabilitiesFor", () => {
  it("grants nothing to a member with no taxpayer keys", () => {
    expect(taxInvoiceCapabilitiesFor([])).toEqual({
      view: false,
      prepare: false,
      send: false,
      inquire: false,
      amend: false,
      cancel: false,
      exportRegister: false,
      manageSettings: false,
    });
  });

  it("maps each key to its own capability and nothing else", () => {
    const only = (key: string) => taxInvoiceCapabilitiesFor([key]);
    expect(only(PERMISSIONS.taxView)).toMatchObject({ view: true, send: false, cancel: false });
    expect(only(PERMISSIONS.taxSend)).toMatchObject({ send: true, view: false });
    expect(only(PERMISSIONS.taxCancel)).toMatchObject({ cancel: true, amend: false });
    expect(only(PERMISSIONS.taxManageSettings)).toMatchObject({ manageSettings: true, exportRegister: false });
    expect(only(PERMISSIONS.taxExport)).toMatchObject({ exportRegister: true });
  });

  it("gives the manager the operational half: view, prepare, send and inquire", () => {
    expect(taxInvoiceCapabilitiesFor(roleBasePermissions("manager"))).toEqual({
      view: true,
      prepare: true,
      send: true,
      inquire: true,
      amend: false,
      cancel: false,
      exportRegister: false,
      manageSettings: false,
    });
  });

  it("gives the accountant the record actions and the export, but not the credentials", () => {
    expect(taxInvoiceCapabilitiesFor(roleBasePermissions("accountant"))).toMatchObject({
      amend: true,
      cancel: true,
      exportRegister: true,
      manageSettings: false,
    });
  });

  it("gives the administrator everything", () => {
    expect(Object.values(taxInvoiceCapabilitiesFor(roleBasePermissions("admin"))).every(Boolean)).toBe(true);
  });
});
