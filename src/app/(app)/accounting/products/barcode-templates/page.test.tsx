import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const gate = vi.fn();
vi.mock("@/app/dashboard/products/workspace-context", () => ({ requireRetailLabels: () => gate() }));
vi.mock("@/app/dashboard/knowledge-help", () => ({ KnowledgeHelpButton: () => null }));
vi.mock("@/app/dashboard/products/legacy-weight-patterns", () => ({ LegacyWeightPatterns: () => null }));
vi.mock("@/app/dashboard/products/label-template-gallery", () => ({ ReadOnlyLabelGallery: () => <div>gallery</div> }));
vi.mock("@/app/(app)/settings/printing/printing-manager", () => ({ PrintingManager: () => <div>printing settings</div> }));
vi.mock("@/app/dashboard/products/specialist-label-printer", () => ({ SpecialistLabelPrinter: () => <div>specialist printer</div> }));
import Page from "./page";
const context = { industry: "watch", canManage: false, canPrint: false, canAssignBarcode: false, locationId: "branch", canViewLegacyWeight: false, canEditLegacyWeight: false };
describe("label page print permissions", () => {
  it("does not offer real printing to a read-only viewer", async () => {
    gate.mockResolvedValue(context);
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("gallery"); expect(html).not.toContain("specialist printer");
  });
  it("offers the existing-code printer with printing.execute, without requiring settings access", async () => {
    gate.mockResolvedValue({ ...context, canPrint: true });
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("gallery"); expect(html).toContain("specialist printer"); expect(html).not.toContain("printing settings");
  });
  it("offers barcode assignment separately from printing permission", async () => {
    gate.mockResolvedValue({ ...context, canAssignBarcode: true });
    expect(renderToStaticMarkup(await Page())).toContain("specialist printer");
  });
  it("does not misrepresent a vehicle model barcode as a unit label", async () => {
    gate.mockResolvedValue({ ...context, industry: "automotive", canPrint: true });
    const html = renderToStaticMarkup(await Page());
    expect(html).not.toContain("specialist printer");
  });
});
