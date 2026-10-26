import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.hoisted(() => vi.fn());
const resolveActiveLocationMock = vi.hoisted(() => vi.fn(async () => ({ id: "location-1" })));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return { ...actual, query: queryMock };
});

vi.mock("./setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup-state")>();
  return { ...actual, resolveActiveLocation: resolveActiveLocationMock };
});

import { AUTOPILOT_EXECUTORS } from "./ai-autopilot-executors";

const CONTEXT = {
  businessId: "00000000-0000-4000-8000-000000000001",
  authorizedByUserId: "00000000-0000-4000-8000-000000000002",
};

describe("AI print writes — live WooCommerce permission", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({
      rows: [{ role: "cashier", permissions: null, is_active: true, custom_role_permissions: null }],
      rowCount: 1,
    });
  });

  it("refuses a WooCommerce print rule when the current authorizer lacks woocommerce.view", async () => {
    const result = await AUTOPILOT_EXECUTORS.settingsPrintRulesSave({
      ...CONTEXT,
      payload: { documentType: "woo_invoice", templateKey: "woo-a4-invoice" },
    });

    expect(result).toMatchObject({ ok: false, errorCode: "permission_denied" });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain("FROM users u");
  });

  it("refuses creating a WooCommerce template through the AI executor without that permission", async () => {
    const result = await AUTOPILOT_EXECUTORS.printTemplateSave({
      ...CONTEXT,
      payload: {
        template: {
          key: "",
          name: "Woo invoice",
          docType: "woo_invoice",
          paper: "a4",
          options: { fontScale: 1, lineHeight: 1.5, marginMm: 3, bodyWeight: 400, showUnit: true, copies: 1 },
          blocks: [{ id: "title", type: "title", visible: true }],
        },
      },
    });

    expect(result).toMatchObject({ ok: false, errorCode: "permission_denied" });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain("FROM users u");
  });
});
