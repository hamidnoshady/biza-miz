// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiCrossLibraryPicker } from "./ai-cross-library-picker";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("cross-library picker", () => {
  it("keeps a selected source usable on repeated activation and closes with Escape", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("?source=")
      ? { items: [{ id: "one", name: "تصویر یک", url: "/api/cms/website/media/one/preview", source: "cms", mimeType: "image/png" }] }
      : { sources: [{ key: "cms", label: "کتابخانه سایت" }] } })));
    const onClose = vi.fn();
    render(<AiCrossLibraryPicker onPick={vi.fn()} onClose={onClose} />);
    await screen.findByRole("img", { name: "تصویر یک" });
    fireEvent.click(screen.getByRole("button", { name: "کتابخانه سایت" }));
    expect(screen.getByRole("img", { name: "تصویر یک" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
  it("offers recovery after an HTTP failure instead of claiming the library is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    render(<AiCrossLibraryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("ممکن نشد"));
    expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy();
  });
});
