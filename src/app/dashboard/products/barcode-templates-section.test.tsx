// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BarcodeTemplatesSection } from "./barcode-templates-section";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function response(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

describe("weight template state and permissions", () => {
  it("hides mutation controls from read-only members", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ templates: [{ id: "1", prefix: "20", weightUnit: "grams" }] })));
    render(<BarcodeTemplatesSection canEdit={false} />);
    await screen.findByText("الگوی شمارهٔ ۱");
    expect(screen.queryByRole("button", { name: /حذف الگو|افزودن الگو|ثبت الگو/ })).toBeNull();
  });
  it("offers a retry rather than leaving a skeleton after a read failure", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "server_error" }, false)).mockResolvedValue(response({ templates: [] }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<BarcodeTemplatesSection canEdit />);
    await screen.findByText("خواندن الگوها ناموفق بود.");
    await user.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await screen.findByText(/الگویی ثبت نشده/);
  });
  it("removes only confirmed saves from drafts after a partial failure", async () => {
    let posts = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return ++posts === 1 ? response({ ok: true }) : response({ error: "duplicate_prefix" }, false);
      return response({ templates: posts ? [{ id: "1", prefix: "20", weightUnit: "grams" }] : [] });
    });
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    render(<BarcodeTemplatesSection canEdit />);
    await screen.findByText(/الگویی ثبت نشده/);
    await user.click(screen.getByRole("button", { name: "افزودن الگو" }));
    await user.click(screen.getByRole("button", { name: "افزودن الگو" }));
    await user.click(screen.getByRole("button", { name: "ثبت الگو" }));
    await screen.findByText(/۱ الگو ثبت شد/);
    expect(screen.getAllByRole("button", { name: "حذف پیش‌نویس الگو" })).toHaveLength(1);
    await waitFor(() => expect(screen.getByText("الگوی شمارهٔ ۱")).toBeTruthy());
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
});
