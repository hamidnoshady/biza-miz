// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataTransferSettings } from "./data-transfer-settings";
import { CATALOGUE_IMPORT_ENTITY_KEY } from "./import-section";

const mockEntities = [
  {
    key: "crm.customers",
    module: "crm",
    moduleLabel: "مدیریت مشتریان",
    label: "مشتریان",
    description: "ورود و خروج مشتریان",
    locationScoped: false,
    canImport: true,
    canExport: true,
    defaultExportFields: ["name"],
    fields: [],
    duplicateRules: [],
  },
];

describe("DataTransferSettings & Catalogue Import (#1335)", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/settings/data-transfer");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/data/entities") {
          return new Response(JSON.stringify({ entities: mockEntities, canImport: true }), { status: 200 });
        }
        if (url === "/api/data/historical-invoices") {
          return new Response(JSON.stringify({ jobs: [], hasMore: false }), { status: 200 });
        }
        if (url.startsWith("/api/data/reconciliation")) {
          return new Response(JSON.stringify({ runs: [] }), { status: 200 });
        }
        if (url === "/api/data/catalogue") {
          return new Response(
            JSON.stringify({ runs: [], stores: [], target: "watch", localOnly: false }),
            { status: 200 },
          );
        }
        if (url === "/api/data/providers/holoo") {
          return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
        }
        if (url.startsWith("/api/data/schedules")) {
          return new Response(JSON.stringify({ schedules: [] }), { status: 200 });
        }
        if (url.startsWith("/api/data/templates")) {
          return new Response(JSON.stringify({ templates: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("exposes product catalogue inside the Import type selector without a separate tab or Omax checkbox", async () => {
    render(<DataTransferSettings />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "ورود اطلاعات" })).toBeTruthy();
    });

    expect(screen.queryByRole("tab", { name: "کاتالوگ محصولات" })).toBeNull();
    expect(screen.getByRole("tab", { name: "خروجی گرفتن" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "تاریخچه" })).toBeTruthy();

    const selector = await screen.findByLabelText(/^نوع داده/) as HTMLSelectElement;
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "کاتالوگ محصولات" })).toBeTruthy();
    });
    const option = screen.getByRole("option", { name: "کاتالوگ محصولات" }) as HTMLOptionElement;
    expect(option.value).toBe(CATALOGUE_IMPORT_ENTITY_KEY);

    fireEvent.change(selector, { target: { value: CATALOGUE_IMPORT_ENTITY_KEY } });

    await waitFor(() => {
      expect(screen.getByText("ورود کاتالوگ محصولات از اکسل")).toBeTruthy();
    });
    expect(screen.queryByText(/Omax/i)).toBeNull();
    expect(screen.queryByText(/برند تأییدشده/)).toBeNull();
  });

  it("keeps historical invoices, catalogue import and reconciliation accessible together", async () => {
    render(<DataTransferSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "حسابداری: فاکتورهای فروش قبلی" }));
    expect(await screen.findByText("فاکتورهای فروش قدیمی")).toBeTruthy();
    expect(await screen.findByText("فایلی برای نمایش نیست.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "بازگشت به ورود اطلاعات دیگر" }));
    const selector = await screen.findByLabelText(/^نوع داده/) as HTMLSelectElement;
    await waitFor(() => expect(screen.getByRole("option", { name: "کاتالوگ محصولات" })).toBeTruthy());
    fireEvent.change(selector, { target: { value: CATALOGUE_IMPORT_ENTITY_KEY } });
    expect(await screen.findByText("ورود کاتالوگ محصولات از اکسل")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "تطبیق پیش از اعمال" }));
    expect(await screen.findByText("بازبینی و تطبیق پیش از ورود اطلاعات")).toBeTruthy();
  });

  it("does not expose historical import or reconciliation without import permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/data/entities") {
        return new Response(JSON.stringify({ entities: mockEntities, canImport: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }));
    render(<DataTransferSettings />);
    expect(await screen.findByRole("tab", { name: "خروجی گرفتن" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "ورود اطلاعات" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "تطبیق پیش از اعمال" })).toBeNull();
    expect(screen.queryByRole("button", { name: "حسابداری: فاکتورهای فروش قبلی" })).toBeNull();
  });

  it("preselects product catalogue inside Import when ?import=catalogue is in the URL", async () => {
    window.history.replaceState({}, "", "/settings/data-transfer?import=catalogue");
    render(<DataTransferSettings />);

    await waitFor(() => {
      expect(screen.getByText("ورود کاتالوگ محصولات از اکسل")).toBeTruthy();
    });
    const selector = screen.getByLabelText(/^نوع داده/) as HTMLSelectElement;
    expect(selector.value).toBe(CATALOGUE_IMPORT_ENTITY_KEY);
  });
});
