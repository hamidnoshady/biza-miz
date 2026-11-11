// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LegacyWeightPatterns } from "./legacy-weight-patterns";
const apiMock = vi.fn();
vi.mock("../ui", async (original) => ({ ...await original<typeof import("../ui")>(), api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("./barcode-templates-section", () => ({ BarcodeTemplatesSection: ({ canEdit }: { canEdit: boolean }) => <div>legacy {canEdit ? "edit" : "read"}</div> }));
beforeEach(() => apiMock.mockReset());
afterEach(cleanup);
describe("previous weight patterns", () => {
  it("does not advertise scale settings for branches without patterns", async () => {
    apiMock.mockResolvedValue({ ok: true, data: { templates: [] } });
    const { container } = render(<LegacyWeightPatterns canEdit />);
    await vi.waitFor(() => expect(container.childElementCount).toBe(0));
    expect(apiMock).toHaveBeenCalled();
  });
  it("preserves existing patterns as a separately labelled read-only workflow", async () => {
    apiMock.mockResolvedValue({ ok: true, data: { templates: [{ id: "old" }] } });
    render(<LegacyWeightPatterns canEdit={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "مدیریت الگوهای وزنی قبلی" }));
    expect(screen.getByText("legacy read")).toBeTruthy();
    expect(screen.getByText(/قالب چاپ برچسب کالا نیستند/)).toBeTruthy();
  });
  it("reports failures and retries instead of hiding existing data", async () => {
    apiMock.mockResolvedValueOnce({ ok: false, data: {} }).mockResolvedValueOnce({ ok: true, data: { templates: [{ id: "old" }] } });
    render(<LegacyWeightPatterns canEdit />);
    fireEvent.click(await screen.findByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByRole("button", { name: "مدیریت الگوهای وزنی قبلی" })).toBeTruthy();
  });
});
