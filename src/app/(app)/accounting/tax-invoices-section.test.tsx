// @vitest-environment jsdom

/**
 * Issue #866 — the taxpayer-invoicing screen, as the browser sees it.
 *
 * The API enforces every capability. These tests hold the other half: a control
 * the member may not use is not drawn at all, and a tab is offered only to a
 * member who holds its capability, and a member without the view capability
 * never reads the register. `fetch` is stubbed, so nothing reaches the network.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaxInvoiceCapabilities } from "./tax-invoice-capabilities";
import { TaxInvoicesSection } from "./tax-invoices-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NONE: TaxInvoiceCapabilities = {
  view: false,
  prepare: false,
  send: false,
  inquire: false,
  amend: false,
  cancel: false,
  exportRegister: false,
  manageSettings: false,
};
const VIEWER: TaxInvoiceCapabilities = { ...NONE, view: true };
const OPERATOR: TaxInvoiceCapabilities = { ...VIEWER, prepare: true, send: true, inquire: true };
const ADMINISTRATOR: TaxInvoiceCapabilities = {
  ...OPERATOR,
  amend: true,
  cancel: true,
  exportRegister: true,
  manageSettings: true,
};

function json(payload: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => payload };
}

/** Answers the two reads the screen makes on open. Anything else is a test failure. */
function stubReads() {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.startsWith("/api/ledger/tax-invoices/settings")) {
      return json({
        profile: {
          enabled: false,
          environment: "sandbox",
          submissionMode: "direct",
          taxpayerId: null,
          taxpayerName: null,
          referencePrefix: "",
          credentialsConfigured: false,
          updatedAt: null,
        },
        units: [],
      });
    }
    if (path.startsWith("/api/ledger/tax-invoices?")) {
      return json({ rows: [], nextCursor: null, counts: { unsent: 0, sent: 0, error: 0, total: 0 } });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const EMPTY_STATE = { count: 0, totalRial: 0, vatRial: 0 };
const EMPTY_RECONCILIATION = {
  rows: [],
  truncated: false,
  totals: {
    sourceCount: 0,
    sourceTotalRial: 0,
    sourceVatRial: 0,
    byState: {
      accepted: EMPTY_STATE,
      pending: EMPTY_STATE,
      error: EMPTY_STATE,
      rejected: EMPTY_STATE,
      cancelled: EMPTY_STATE,
      mismatch: EMPTY_STATE,
      missing: EMPTY_STATE,
      voided: EMPTY_STATE,
    },
    differenceTotalRial: 0,
    differenceVatRial: 0,
    unrecordedTotalRial: 0,
    unrecordedVatRial: 0,
  },
};

/**
 * Every read the administrator's tabs make. The taxpayer's keys are stored, and
 * the settings payload says so without carrying them, as the API does.
 */
function stubAll() {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.startsWith("/api/ledger/tax-invoices/settings")) {
      return json({
        profile: {
          enabled: true,
          environment: "sandbox",
          submissionMode: "direct",
          taxpayerId: "A1B2C3",
          taxpayerName: "شرکت نمونه",
          referencePrefix: "BIZ",
          credentialsConfigured: true,
          updatedAt: null,
        },
        units: [],
      });
    }
    if (path.startsWith("/api/ledger/tax-invoices/item-codes")) return json({ products: [] });
    if (path.startsWith("/api/ledger/tax-invoices/reconciliation?")) return json(EMPTY_RECONCILIATION);
    if (path.startsWith("/api/ledger/tax-invoices/provider-errors?")) return json({ rows: [] });
    if (path.startsWith("/api/ledger/tax-invoices/queue")) return json({ rows: [] });
    if (path.startsWith("/api/ledger/tax-invoices?")) {
      return json({ rows: [], nextCursor: null, counts: { unsent: 0, sent: 0, error: 0, total: 0 } });
    }
    throw new Error(`unexpected fetch ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the taxpayer-invoicing screen", () => {
  it("a viewer sees the register and the reports, and no control that changes what the authority holds", async () => {
    stubReads();
    render(<TaxInvoicesSection refreshKey={0} capabilities={VIEWER} />);

    expect(await screen.findByRole("tab", { name: /گزارش/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /تنظیمات/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /استعلام همه/ })).toBeNull();
  });

  it("an operator who may inquire gets the inquiry control, and still no taxpayer settings", async () => {
    stubReads();
    render(<TaxInvoicesSection refreshKey={0} capabilities={OPERATOR} />);

    expect(await screen.findByRole("button", { name: /استعلام همه/ })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /تنظیمات/ })).toBeNull();
  });

  it("only a member who manages the taxpayer settings is offered the settings tab", async () => {
    stubReads();
    render(<TaxInvoicesSection refreshKey={0} capabilities={ADMINISTRATOR} />);

    expect(await screen.findByRole("tab", { name: /تنظیمات/ })).toBeTruthy();
  });

  it("a member without the view capability gets a refusal, and the register is never read", async () => {
    const fetchMock = stubReads();
    render(<TaxInvoicesSection refreshKey={0} capabilities={NONE} />);

    expect(await screen.findByText(/دسترسی ندارید/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the settings tab shows that keys are stored, and never prefills the key field", async () => {
    stubAll();
    render(<TaxInvoicesSection refreshKey={0} capabilities={ADMINISTRATOR} />);

    fireEvent.click(await screen.findByRole("tab", { name: /تنظیمات/ }));
    expect(await screen.findByText(/کلید ذخیره شده است/)).toBeTruthy();
    const keyField = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(keyField).not.toBeNull();
    expect(keyField!.value).toBe("");
  });

  it("the reports tab reads the reconciliation and shows its totals", async () => {
    const fetchMock = stubAll();
    render(<TaxInvoicesSection refreshKey={0} capabilities={ADMINISTRATOR} />);

    fireEvent.click(await screen.findByRole("tab", { name: /گزارش/ }));
    expect(await screen.findByText(/کامل در بازه/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/ledger/tax-invoices/reconciliation?"))).toBe(true);
  });
});
