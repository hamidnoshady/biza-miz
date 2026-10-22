// @vitest-environment node

/**
 * The segment is prerendered on the server. The draft mirror reads
 * `localStorage`, so the render must survive a runtime that has no `window` at
 * all — a guard that only exists on the client would 500 the first paint.
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PriceListsSection } from "./price-lists-section";

describe("PriceListsSection server render", () => {
  it("draws the first paint without a window or storage", () => {
    expect(typeof window).toBe("undefined");
    const html = renderToString(<PriceListsSection apiBase="/api/accessories" draftScope="biz-1:loc-a" />);
    expect(html).toContain("نمایش لیست قیمت‌های کالا");
    expect(html).toContain("در حال بارگذاری اطلاعات");
  });
});
