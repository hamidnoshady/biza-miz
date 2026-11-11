import { beforeEach, expect, it, vi } from "vitest";
import { query } from "./db";
import { deleteWeightBarcodeTemplate } from "./weight-barcode-templates-service";

vi.mock("./db", () => ({ query: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("deletes a barcode pattern only in the selected location", async () => {
  vi.mocked(query).mockResolvedValue({ rowCount: 0, rows: [] } as never);
  expect(await deleteWeightBarcodeTemplate("template", "branch-a")).toBe(false);
  expect(query).toHaveBeenCalledWith(expect.stringMatching(/location_id\s*=\s*\$2/), ["template", "branch-a"]);
  vi.mocked(query).mockResolvedValue({ rowCount: 1, rows: [] } as never);
  expect(await deleteWeightBarcodeTemplate("template", "branch-b")).toBe(true);
});
