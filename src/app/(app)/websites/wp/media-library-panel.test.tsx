/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/app/dashboard/ui", () => ({ api, errorMessageOrRaw: (message: string) => message, ErrorBox: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div> }));
vi.mock("@/app/dashboard/media/media-picker", () => ({ MediaPickerDialog: ({ onPickMultiple }: { onPickMultiple: (assets: unknown[]) => void }) => <button onClick={() => onPickMultiple([{ id: "one", fileName: "one.png" }, { id: "two", fileName: "two.png" }])}>pick fixtures</button> }));
import { WpMediaLibraryPanel } from "./media-library-panel";
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  api.mockImplementation(async (path: string) => path.includes("/queue?") ? { ok: true, data: { summary: { pending: 2, failed: 0, dead: 0 } } } : path.includes("/one/") ? { ok: true, data: { mapping: { status: "pending" } } } : { ok: false, data: { error: "unsupported_kind" } });
});
describe("embedded canonical media workflow", () => {
  it("reuses canonical selection and reports per-file partial push errors without creating another upload store", async () => {
    render(<WpMediaLibraryPanel connectionId="site" siteName="Store" canPush />);
    fireEvent.click(screen.getByRole("button", { name: "انتخاب یا بارگذاری در کتابخانهٔ اصلی" }));
    fireEvent.click(screen.getByText("pick fixtures"));
    fireEvent.click(screen.getByRole("button", { name: "ارسال انتخاب‌ها به Store" }));
    await screen.findByText("unsupported_kind");
    expect(screen.getByText("در صف تأیید وردپرس")).toBeTruthy();
    const pushes = api.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(pushes.map(([path]) => path)).toEqual(["/api/media/one/wordpress", "/api/media/two/wordpress"]);
    expect(pushes.every(([, options]) => JSON.parse(options.body).connectionId === "site")).toBe(true);
    expect(api.mock.calls.some(([path]) => path === "/api/integrations/wp-manager/media")).toBe(false);
  });
  it("clears canonical selection and messages when the destination changes", async () => {
    const view = render(<WpMediaLibraryPanel connectionId="site" siteName="Store" canPush />);
    fireEvent.click(screen.getByRole("button", { name: "انتخاب یا بارگذاری در کتابخانهٔ اصلی" }));
    fireEvent.click(screen.getByText("pick fixtures"));
    expect(screen.getByText("one.png")).toBeTruthy();
    view.rerender(<WpMediaLibraryPanel connectionId="other" siteName="Other" canPush />);
    await waitFor(() => expect(screen.queryByText("one.png")).toBeNull());
  });
  it("shows queue status to a remote-view user without offering canonical actions", async () => {
    render(<WpMediaLibraryPanel connectionId="site" siteName="Store" canPush={false} allowCanonical={false} />);
    await screen.findByText(/صف این سایت/);
    expect(screen.queryByRole("button", { name: "انتخاب یا بارگذاری در کتابخانهٔ اصلی" })).toBeNull();
  });
});
