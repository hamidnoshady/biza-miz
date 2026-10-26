import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db", () => ({ query: mocks.query }));
vi.mock("./audit", () => ({ writeIntegrationAudit: vi.fn() }));
vi.mock("./secrets", () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn(), resolveEncryptionKey: vi.fn() }));
vi.mock("./woocommerce-client", () => ({ createWooCommerceClient: vi.fn() }));

import { updateConnection } from "./connections-service";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "c1", business_id: "b1", provider: "woocommerce", link_mode: "plugin", status: "active",
  push_stock: true, push_prices: true, source_of_truth: "two_way", manage_stock_opt_in: false,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
});

function stub(existing: Record<string, unknown>) {
  const statements: { sql: string; params: unknown[] }[] = [];
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    return { rows: [row(existing)], rowCount: 1 };
  });
  return statements;
}

describe("turning a push off closes its queued jobs in the same statement (issue #1149, C6)", () => {
  it("switching stock off skips pending stock jobs only", async () => {
    const statements = stub({});
    await updateConnection("b1", "c1", { pushStock: false });
    const update = statements.find((s) => s.sql.includes("UPDATE integration_connections"))!;
    expect(update.sql).toContain("UPDATE integration_outbox_events");
    expect(update.sql).toContain("'push_switch_off'");
    expect(update.params.at(-1)).toEqual(["stock"]);
  });

  it("handing the authority to the store closes both axes", async () => {
    const statements = stub({});
    await updateConnection("b1", "c1", { sourceOfTruth: "store" });
    const update = statements.find((s) => s.sql.includes("UPDATE integration_connections"))!;
    expect(update.params.at(-1)).toEqual(["stock", "price"]);
  });

  it("an unrelated edit, or a switch turned ON, closes nothing", async () => {
    let statements = stub({});
    await updateConnection("b1", "c1", { name: "Renamed" });
    expect(statements.find((s) => s.sql.includes("UPDATE integration_connections"))!.sql).not.toContain("integration_outbox_events");

    statements = stub({ push_stock: false });
    await updateConnection("b1", "c1", { pushStock: true });
    expect(statements.find((s) => s.sql.includes("UPDATE integration_connections"))!.sql).not.toContain("integration_outbox_events");
  });

  it("refuses an unknown source of truth", async () => {
    stub({});
    expect(await updateConnection("b1", "c1", { sourceOfTruth: "both" as never })).toEqual({ ok: false, error: "invalid_source_of_truth" });
  });
});
