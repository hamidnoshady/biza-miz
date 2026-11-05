import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ query, getPool: vi.fn(), withTenant: vi.fn(), withoutTenantScope: vi.fn() }));

import {
  getMediaAssetUsage,
  mediaAssetUsageIsEmpty,
  mediaAssetUsageIsProtected,
} from "./media-service";

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM contract_final_pdfs")) {
      return { rows: [{ id: "final-pdf-1", version: 7 }] };
    }
    return { rows: [] };
  });
});

describe("contract final PDF media protection", () => {
  it("surfaces final-PDF assets as protected usage so trash, purge and bulk deletion refuse them", async () => {
    const usage = await getMediaAssetUsage("asset-final-1");
    expect(usage.workspaceDocuments).toContainEqual(expect.objectContaining({
      id: "final-pdf-1",
      name: "نسخهٔ نهایی قرارداد · 7",
      protected: true,
      protectedReason: "contract_final_pdf",
    }));
    expect(usage.protectedItems).toContainEqual(expect.objectContaining({
      id: "final-pdf-1",
      reason: "contract_final_pdf",
    }));
    expect(mediaAssetUsageIsProtected(usage)).toBe(true);
    expect(mediaAssetUsageIsEmpty(usage)).toBe(false);
  });
});
