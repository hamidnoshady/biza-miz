import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockQuery,
  mockAdapterWrite,
  mockOpenRun,
  mockStageProducts,
  mockCompleteProductDiscovery,
  mockPartyWriteAudience,
  mockRecordAudit,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockAdapterWrite: vi.fn(),
  mockOpenRun: vi.fn(),
  mockStageProducts: vi.fn(),
  mockCompleteProductDiscovery: vi.fn(),
  mockPartyWriteAudience: vi.fn(),
  mockRecordAudit: vi.fn(),
}));

vi.mock("../db", () => ({
  query: mockQuery,
  withoutTenantScope: vi.fn(),
  withTenant: vi.fn(),
}));
vi.mock("../member-access", () => ({
  partyWriteAudienceForActor: mockPartyWriteAudience,
}));
vi.mock("../service-activation/app-gate-service", () => ({
  serviceActivationState: vi.fn().mockResolvedValue({ state: "active" }),
}));
vi.mock("./entities", () => ({
  ensureAdaptersRegistered: vi.fn(),
}));
vi.mock("./adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters")>();
  return {
    ...actual,
    requireAdapter: vi.fn().mockReturnValue({
      entity: "inventory.items",
      read: vi.fn(),
      write: mockAdapterWrite,
    }),
  };
});
vi.mock("./audit", () => ({
  recordDataTransferAudit: mockRecordAudit,
}));
vi.mock("../import-reconciliation/service", () => ({
  openRun: mockOpenRun,
  stageProducts: mockStageProducts,
  completeProductDiscovery: mockCompleteProductDiscovery,
  stageParties: vi.fn(),
  completePartyDiscovery: vi.fn(),
}));

import { finalizeReconciledImportJob, runImportJob, stageImportJobToReconciliation } from "./import-service";

const bizId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const locId = "44444444-4444-4444-8444-444444444444";
const canonicalInvId = "55555555-5555-4555-8555-555555555555";
const createdInvId = "66666666-6666-4666-8666-666666666666";

describe("Data Transfer reconciliation scope and decision preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPartyWriteAudience.mockResolvedValue(undefined);
  });

  it("stages food_service inventory.items onto inventory_items canonicalTable scope", async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM data_import_jobs j") && sql.includes("WHERE j.business_id = $1 AND j.id = $2") && sql.includes("JOIN businesses")) {
        return { rows: [{ location_id: locId, industry: "food_service" }] };
      }
      if (sql.includes("FROM data_import_jobs")) {
        return {
          rows: [
            {
              id: jobId,
              entity_key: "inventory.items",
              status: "pending",
              file_name: "raw.csv",
              file_format: "csv",
              file_size_bytes: 120,
              provider_metadata: null,
              source_columns: ["name", "unit"],
              mapping: { columns: [] },
              options: { duplicateStrategy: "skip" },
              total_rows: 1,
              valid_rows: 1,
              warning_rows: 0,
              error_rows: 0,
              created_rows: 0,
              updated_rows: 0,
              skipped_rows: 0,
              failed_rows: 0,
              duplicate_rows: 0,
              error: null,
              reconciliation_run_id: null,
              created_at: new Date(),
              started_at: null,
              finished_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM data_import_rows")) {
        return { rows: [{ row_number: 1, mapped: { name: "آرد سفید", unit: "kg", avgCost: 500000 } }] };
      }
      return { rows: [] };
    });
    mockOpenRun.mockResolvedValueOnce({ id: runId, domain: "product" });
    mockStageProducts.mockResolvedValueOnce({ staged: 1, unchanged: 0, changed: 0 });
    mockCompleteProductDiscovery.mockResolvedValueOnce({ run: { id: runId }, gate: { path: "review" }, counts: { read: 1 } });

    await stageImportJobToReconciliation(bizId, jobId, { userId: null, name: "اپراتور" });

    expect(mockOpenRun).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "product",
        scope: { entityKey: "inventory.items", canonicalTable: "inventory_items" },
      }),
    );
    expect(mockStageProducts).toHaveBeenCalledWith(
      bizId,
      runId,
      [
        expect.objectContaining({
          name: "آرد سفید",
          unit: "kg",
          fields: expect.objectContaining({ average_cost: "500000" }),
        }),
      ],
    );
  });

  it("runImportJob honors skip, already-applied create, canonical authority, and selective source overrides", async () => {
    let rowFetchCount = 0;
    const rowStatusUpdates: Array<{ id: string; status: string; targetId?: string | null }> = [];
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM data_import_jobs") && sql.includes("WHERE business_id = $1 AND id = $2")) {
        return {
          rows: [
            {
              id: jobId,
              entity_key: "inventory.items",
              status: "queued",
              file_name: "raw.csv",
              file_format: "csv",
              file_size_bytes: 200,
              provider_metadata: null,
              source_columns: ["name", "unit", "sku"],
              mapping: { columns: [] },
              options: { duplicateStrategy: "update" },
              total_rows: 4,
              valid_rows: 4,
              warning_rows: 0,
              error_rows: 0,
              created_rows: 0,
              updated_rows: 0,
              skipped_rows: 0,
              failed_rows: 0,
              duplicate_rows: 0,
              error: null,
              reconciliation_run_id: runId,
              created_at: new Date(),
              started_at: null,
              finished_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM import_reconciliation_runs")) {
        return {
          rows: [{ status: "applied", source_key: `job:${jobId}`, domain: "product", location_id: locId }],
        };
      }
      if (sql.includes("FROM import_reconciliation_items i")) {
        return {
          rows: [
            { row_number: 1, external_key: "row:1", outcome: "create_new", status: "skipped", effect: "skip", resolved_canonical_id: null, authority_overrides: null },
            { row_number: 2, external_key: "row:2", outcome: "create_new", status: "applied", effect: "create", resolved_canonical_id: createdInvId, authority_overrides: null },
            { row_number: 3, external_key: "SKU-CAN", outcome: "field_conflict", status: "applied", effect: "link", resolved_canonical_id: canonicalInvId, authority_overrides: { name: "canonical", unit: "canonical" } },
            { row_number: 4, external_key: "SKU-SRC", outcome: "field_conflict", status: "applied", effect: "link", resolved_canonical_id: canonicalInvId, authority_overrides: { name: "canonical", unit: "source" } },
          ],
        };
      }
      if (sql.includes("FROM import_reconciliation_rejected_edits")) return { rows: [] };
      if (sql.includes("FROM data_import_rows") && sql.includes("status IN ('valid', 'warning')")) {
        rowFetchCount += 1;
        if (rowFetchCount > 1) return { rows: [] };
        return {
          rows: [
            { id: "r1", row_number: 1, status: "valid", mapped: { name: "ردیف نادیده‌گرفته‌شده", unit: "kg" }, messages: [] },
            { id: "r2", row_number: 2, status: "valid", mapped: { name: "مادهٔ اولیه جدید", unit: "kg" }, messages: [] },
            { id: "r3", row_number: 3, status: "valid", mapped: { name: "نام جدید غیرمجاز", sku: "SKU-CAN", unit: "g" }, messages: [] },
            { id: "r4", row_number: 4, status: "valid", mapped: { name: "نام جدید غیرمجاز", sku: "SKU-SRC", unit: "g" }, messages: [] },
          ],
        };
      }
      if (sql.includes("SELECT industry FROM businesses")) {
        return { rows: [{ industry: "food_service" }] };
      }
      if (sql.includes("FROM inventory_items")) {
        return { rows: [{ name: "آرد رسمی سیستم", sku: "SKU-SRC", unit: "kg" }] };
      }
      if (sql.includes("UPDATE data_import_rows")) {
        rowStatusUpdates.push({
          id: String(params?.[0]),
          status: sql.includes("status = 'skipped'") ? "skipped" : sql.includes("status = 'created'") ? "created" : String(params?.[1]),
          targetId: params?.[2] as string | null | undefined,
        });
        return { rows: [] };
      }
      return { rows: [] };
    });

    mockAdapterWrite.mockResolvedValue({ status: "updated", id: canonicalInvId });

    const summary = await runImportJob(bizId, jobId, { locationId: locId, actorUserId: null, actorName: "اپراتور" });

    expect(summary).toEqual({ created: 1, updated: 1, skipped: 2, failed: 0 });
    // Only row 4 (explicit `source` override on `unit`) may reach adapter.write, and `name` stays canonical!
    expect(mockAdapterWrite).toHaveBeenCalledTimes(1);
    expect(mockAdapterWrite).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        name: "آرد رسمی سیستم",
        sku: "SKU-SRC",
        unit: "g",
      }),
      expect.objectContaining({ duplicateStrategy: "update" }),
    );
    expect(rowStatusUpdates.find((u) => u.id === "r1")?.status).toBe("skipped");
    expect(rowStatusUpdates.find((u) => u.id === "r2")?.status).toBe("created");
    expect(rowStatusUpdates.find((u) => u.id === "r3")?.status).toBe("skipped");
    expect(rowStatusUpdates.find((u) => u.id === "r4")?.status).toBe("updated");
  });

  it("finalizes a 'ready' data_import_jobs row linked to a reconciliation run when apply finishes", async () => {
    let rowFetchCount = 0;
    const queries: string[] = [];
    mockQuery.mockImplementation(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT id FROM data_import_jobs") && sql.includes("status IN ('pending', 'ready', 'queued', 'running')")) {
        return { rows: [{ id: jobId }] };
      }
      if (sql.includes("FROM data_import_jobs") && sql.includes("WHERE business_id = $1 AND id = $2")) {
        return {
          rows: [
            {
              id: jobId,
              business_id: bizId,
              location_id: locId,
              entity_key: "inventory.items",
              status: "ready",
              file_name: "ready-materials.csv",
              file_format: "csv",
              file_size_bytes: 120,
              provider_metadata: null,
              source_columns: ["name", "unit"],
              mapping: { columns: [] },
              options: { duplicateStrategy: "skip" },
              total_rows: 1,
              valid_rows: 1,
              warning_rows: 0,
              error_rows: 0,
              created_rows: 0,
              updated_rows: 0,
              skipped_rows: 0,
              failed_rows: 0,
              duplicate_rows: 0,
              error: null,
              reconciliation_run_id: runId,
              created_at: new Date(),
              started_at: null,
              finished_at: null,
            },
          ],
        };
      }
      if (sql.includes("FROM import_reconciliation_runs")) {
        return { rows: [{ status: "applied", source_key: `job:${jobId}`, domain: "product", location_id: locId }] };
      }
      if (sql.includes("FROM import_reconciliation_items i")) {
        return {
          rows: [
            { row_number: 1, external_key: "row:1", outcome: "create_new", status: "applied", effect: "create", resolved_canonical_id: createdInvId, authority_overrides: null },
          ],
        };
      }
      if (sql.includes("FROM import_reconciliation_rejected_edits")) return { rows: [] };
      if (sql.includes("FROM data_import_rows") && sql.includes("status IN ('valid', 'warning')")) {
        rowFetchCount += 1;
        if (rowFetchCount > 1) return { rows: [] };
        return { rows: [{ id: "r1", row_number: 1, status: "valid", mapped: { name: "نمک", unit: "kg" }, messages: [] }] };
      }
      return { rows: [] };
    });

    const summary = await finalizeReconciledImportJob(bizId, runId, {
      locationId: locId,
      actorUserId: null,
      actorName: "اپراتور",
    });

    expect(summary).toEqual({ created: 1, updated: 0, skipped: 0, failed: 0 });
    expect(queries.some((q) => q.includes("status IN ('pending', 'ready', 'queued', 'running')"))).toBe(true);
    expect(mockAdapterWrite).not.toHaveBeenCalled();
  });
});
