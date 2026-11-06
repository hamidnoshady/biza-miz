/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WpFeaturedImagePicker } from "./content-featured-image";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/app/dashboard/ui", () => ({
  api,
  errorMessageOrRaw: (message: string) => message,
}));

const ROWS = [
  { remoteId: "501", title: "قاب اول", thumbnailUrl: "https://shop.test/501-150x150.jpg", mediaUrl: "https://shop.test/501.jpg" },
  { remoteId: "502", title: "قاب دوم", thumbnailUrl: null, mediaUrl: "https://shop.test/502.jpg" },
];

beforeEach(() => {
  api.mockImplementation(async (path: string) =>
    path.includes("/content?") ? { ok: true, data: { rows: ROWS } } : { ok: false, data: {} },
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("#1215 featured image picker", () => {
  it("reads the site's own image mirror rather than a second upload store", async () => {
    render(<WpFeaturedImagePicker connectionId="site" value={null} currentUrl={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "انتخاب تصویر شاخص" }));

    await screen.findByText("قاب اول");
    const [path] = api.mock.calls[0];
    const params = new URLSearchParams(path.split("?")[1]);
    expect(path.startsWith("/api/integrations/wp-manager/content?")).toBe(true);
    expect(params.get("connectionId")).toBe("site");
    expect(params.get("type")).toBe("attachment");
    expect(params.get("kind")).toBe("image");
    // The picker never uploads: it only reads what the store already has.
    expect(api.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  });

  it("hands back the attachment id, not a URL", async () => {
    const onChange = vi.fn();
    render(<WpFeaturedImagePicker connectionId="site" value={null} currentUrl={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "انتخاب تصویر شاخص" }));
    fireEvent.click(await screen.findByRole("button", { name: /قاب دوم/ }));

    expect(onChange).toHaveBeenCalledWith(502);
    // Picking closes the list, so the editor keeps its shape.
    await waitFor(() => expect(screen.queryByText("قاب اول")).toBeNull());
  });

  it("clears the field with null and shows the saved mirror URL before a new pick", async () => {
    const onChange = vi.fn();
    const view = render(
      <WpFeaturedImagePicker connectionId="site" value={501} currentUrl="https://shop.test/501.jpg" onChange={onChange} />,
    );
    expect(screen.getByAltText("پیش‌نمایش تصویر شاخص").getAttribute("src")).toBe("https://shop.test/501.jpg");

    fireEvent.click(screen.getByRole("button", { name: /حذف تصویر شاخص/ }));
    expect(onChange).toHaveBeenCalledWith(null);

    view.rerender(
      <WpFeaturedImagePicker connectionId="site" value={null} currentUrl="https://shop.test/501.jpg" onChange={onChange} />,
    );
    expect(screen.queryByAltText("پیش‌نمایش تصویر شاخص")).toBeNull();
    expect(screen.getByText("بدون تصویر شاخص")).toBeTruthy();
  });

  it("says so when the store has no images instead of showing an empty grid", async () => {
    api.mockImplementation(async () => ({ ok: true, data: { rows: [] } }));
    render(<WpFeaturedImagePicker connectionId="site" value={null} currentUrl={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "انتخاب تصویر شاخص" }));
    await screen.findByText(/تصویری در کتابخانهٔ همین سایت پیدا نشد/);
  });

  it("surfaces a read failure with the raw reason", async () => {
    api.mockImplementation(async () => ({ ok: false, data: { error: "connection_paused" } }));
    render(<WpFeaturedImagePicker connectionId="site" value={null} currentUrl={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "انتخاب تصویر شاخص" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("connection_paused");
  });
});
