import { describe, expect, it } from "vitest";
import { parseSubledgerWindow, subledgerNextOffset, validateSubledgerWindow } from "./subledger-pagination";

describe("subledger windows", () => {
  it("preserves unbounded legacy reads, but treats search/offset as window requests", () => {
    expect(parseSubledgerWindow(new URLSearchParams())).toBeNull();
    expect(parseSubledgerWindow(new URLSearchParams("q=Ali"))).toEqual({ limit: 25, offset: 0 });
    expect(parseSubledgerWindow(new URLSearchParams("limit=200&offset=50001"))).toEqual({ limit: 200, offset: 50001 });
    expect(parseSubledgerWindow(new URLSearchParams("offset=2147483648"))?.offset).toBe(2147483648);
  });
  it.each(["offset=-1", "offset=1.5", "offset=NaN", "offset=Infinity", "offset=9007199254740992", "offset=", "limit=0", "limit=201", "limit=1e2"])("rejects %s, never silently clamps it", (query) => {
    expect(() => parseSubledgerWindow(new URLSearchParams(query))).toThrow("invalid_pagination");
  });
  it("validates direct service callers too and terminates empty/end windows", () => {
    expect(() => validateSubledgerWindow(25, -1)).toThrow("invalid_pagination");
    expect(subledgerNextOffset(50000, 25, 60000)).toBe(50025);
    expect(subledgerNextOffset(50000, 0, 60000)).toBeNull();
    expect(subledgerNextOffset(10, 1, 11)).toBeNull();
  });
});
