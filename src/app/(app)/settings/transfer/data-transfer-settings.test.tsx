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
