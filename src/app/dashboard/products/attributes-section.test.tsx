// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttributesSection } from "./attributes-section";
import type { AttributeDefinition } from "@/lib/product-attributes-service";

const definition: AttributeDefinition = {
  id: "5b04a6c7-df35-4f35-b26b-1534bce6b391",
  locationId: "branch-a",
  name: "رنگ",
  options: ["قرمز"],
  isActive: true,
  version: 3,
  usageCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fetchMock = vi.fn<typeof fetch>();

class ResizeObserverMock implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function listResponse(rows: AttributeDefinition[] = [definition]): Response {
  return jsonResponse({ definitions: rows });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AttributesSection", () => {
  it("renders definitions without edit affordances for a view-only member", async () => {
    fetchMock.mockResolvedValueOnce(listResponse());
    render(<AttributesSection canEdit={false} />);

    expect(await screen.findByText("رنگ")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "منوی رنگ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "افزودن ویژگی" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ویرایش" })).toBeNull();
  });

  it("offers a page-specific retry after an initial load failure", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "network_error" }, 503))
      .mockResolvedValueOnce(listResponse());
    const user = userEvent.setup();
    render(<AttributesSection canEdit={false} />);

    expect(await screen.findByText(/بارگیری نشد/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByText("رنگ")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("commits a pending typed option and the editor version on save", async () => {
    fetchMock
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(jsonResponse({ definition: { ...definition, options: ["قرمز", "مشکی"], version: 4 } }))
      .mockResolvedValueOnce(listResponse([{ ...definition, options: ["قرمز", "مشکی"], version: 4 }]));
    const user = userEvent.setup();
    render(<AttributesSection canEdit />);

    await user.click(await screen.findByRole("button", { name: "منوی رنگ" }));
    await user.click(await screen.findByRole("menuitem", { name: "ویرایش" }));
    await user.type(screen.getByLabelText("افزودن مقدار (اختیاری)"), "مشکی");
    await user.click(screen.getByRole("button", { name: "ذخیرهٔ تغییرها" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, patch] = fetchMock.mock.calls[1];
    expect(patch?.method).toBe("PATCH");
    expect(JSON.parse(String(patch?.body))).toMatchObject({
      name: "رنگ",
      options: ["قرمز", "مشکی"],
      version: 3,
    });
    expect(await screen.findByRole("status")).toBeTruthy();
  });

  it("keeps local edits on a version conflict and makes the reload/merge choice explicit", async () => {
    const remote = { ...definition, name: "طیف رنگ", options: ["آبی"], version: 4 };
    fetchMock
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(jsonResponse({ error: "edit_conflict", current: remote }, 409))
      .mockResolvedValueOnce(jsonResponse({ definition: { ...remote, name: "رنگ محلی", version: 5 } }))
      .mockResolvedValueOnce(listResponse());
    const user = userEvent.setup();
    render(<AttributesSection canEdit />);

    await user.click(await screen.findByRole("button", { name: "منوی رنگ" }));
    await user.click(await screen.findByRole("menuitem", { name: "ویرایش" }));
    const nameField = screen.getByLabelText("عنوان ویژگی *");
    await user.clear(nameField);
    await user.type(nameField, "رنگ محلی");
    await user.click(screen.getByRole("button", { name: "ذخیرهٔ تغییرها" }));

    await user.click(await screen.findByRole("button", { name: "ادغام تغییرهای من با نسخهٔ جدید" }));
    await user.click(screen.getByRole("button", { name: "ذخیرهٔ تغییرها" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [, retry] = fetchMock.mock.calls[2];
    expect(JSON.parse(String(retry?.body))).toMatchObject({
      name: "رنگ محلی",
      options: ["آبی"],
      version: 4,
    });
  });

  it("explains in-use deletion and directs the user to deactivate instead", async () => {
    const used = { ...definition, usageCount: 2 };
    fetchMock.mockResolvedValueOnce(listResponse([used]));
    const user = userEvent.setup();
    render(<AttributesSection canEdit />);

    await user.click(await screen.findByRole("button", { name: "منوی رنگ" }));
    await user.click(await screen.findByRole("menuitem", { name: "حذف ویژگی" }));
    expect(await screen.findByText(/در ۲ تنوع استفاده شده است/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "ویرایش و غیرفعال‌سازی" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "حذف ویژگی" })).toBeNull();
  });
});
