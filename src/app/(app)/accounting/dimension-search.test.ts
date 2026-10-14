import { describe, expect, it } from "vitest";
import { chunkSelectedIds } from "./dimension-search";

describe("chunkSelectedIds", () => {
  it("returns no batches for empty input", () => {
    expect(chunkSelectedIds([])).toEqual([]);
  });

  it("keeps a small list in one batch", () => {
    expect(chunkSelectedIds(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("splits a long list into bounded batches (40)", () => {
    const ids = Array.from({ length: 85 }, (_, i) => `id-${i}`);
    const batches = chunkSelectedIds(ids);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(40);
    expect(batches[1]).toHaveLength(40);
    expect(batches[2]).toHaveLength(5);
    expect(batches.flat()).toEqual(ids);
  });

  it("filters falsy ids before batching", () => {
    expect(chunkSelectedIds(["", "a", undefined as unknown as string, null as unknown as string, "b"])).toEqual([
      ["a", "b"],
    ]);
  });
});
