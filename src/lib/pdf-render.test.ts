import { describe, expect, it } from "vitest";
import { isAllowedStaticPdfRequest } from "./pdf-render";

describe("server PDF render network boundary", () => {
  it("allows only the inline document, its data resources and about:blank", () => {
    expect(isAllowedStaticPdfRequest("about:blank")).toBe(true);
    expect(isAllowedStaticPdfRequest("data:image/png;base64,abc")).toBe(true);
    expect(isAllowedStaticPdfRequest("https://example.test/track")).toBe(false);
    expect(isAllowedStaticPdfRequest("file:///etc/passwd")).toBe(false);
  });
});
