import { describe, expect, it, vi } from "vitest";
import { getDocumentProxy } from "unpdf";
import { extractPdfText } from "./ai-attachment";
import { MAX_PDF_PAGES } from "./ai-attachment-limits";
vi.mock("unpdf", () => ({ getDocumentProxy: vi.fn() }));
describe("PDF extraction work bounds", () => {
  it("reads only the allowed pages and flags omitted pages, then releases the parser", async () => {
    const getPage = vi.fn(async () => ({ getTextContent: async () => ({ items: [{ str: "word", hasEOL: true }] }), cleanup: vi.fn() }));
    const destroy = vi.fn();
    vi.mocked(getDocumentProxy).mockResolvedValue({ numPages: 100, getPage, loadingTask: { destroy } } as never);
    const result = await extractPdfText("data:application/pdf;base64,JVBERi0xLjc=");
    expect(result?.text).toContain("word");
    expect(result?.truncated).toBe(true);
    expect(getPage).toHaveBeenCalledTimes(MAX_PDF_PAGES);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
