import { describe, expect, it } from "vitest";
import { parseChatAttachments, parsePdfDataUrl, parseTextDataUrl } from "./ai-attachment";

describe("chat attachment trust boundary", () => {
  it("rejects scripts disguised as supported image or PDF types", () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "application/pdf"]) {
      const dataUrl = `data:${mime};base64,${Buffer.from("<script>bad()</script>").toString("base64")}`;
      expect(parseChatAttachments("dashboard", [{ dataUrl }]).error).toBe(true);
    }
  });

  it("accepts the PDF signature and rejects fake PDF bytes", () => {
    expect(parsePdfDataUrl(`data:application/pdf;base64,${Buffer.from("%PDF-1.7\n").toString("base64")}`)).not.toBeNull();
    expect(parsePdfDataUrl("data:application/pdf;base64,eA==")).toBeNull();
  });

  it("rejects noncanonical base64 and binary control bytes in text", () => {
    expect(parseTextDataUrl("data:text/plain;base64,YQ===")).toBeNull();
    expect(parseTextDataUrl(`data:text/plain;base64,${Buffer.from("a\u000b\u000c").toString("base64")}`)).toBeNull();
  });
});
