/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CmsConnectionPanel } from "./cms-panel";
import { api } from "@/app/dashboard/ui";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(app)/websites/cms/cms-sections", () => ({ DomainDialog: () => null }));
vi.mock("@/app/dashboard/ui", () => ({
  api: vi.fn(), errorMessageOrRaw: (message: string) => message,
  ErrorBox: ({ children }: { children?: React.ReactNode }) => <div role="alert">{children}</div>,
  InfoBox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Field: () => null, PrimaryButton: () => null, inputClass: "",
}));
const connection = { siteDomain: "store.example.com", baseUrl: "https://cms.example.com", status: "active" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("preserves the connected site and reports failure when DELETE is refused", async () => {
  vi.mocked(api).mockImplementation(async (_path, options) => options?.method === "DELETE"
    ? { ok: false, data: { error: "forbidden" } } as never
    : { ok: true, data: { connection } } as never);
  render(<CmsConnectionPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "قطع اتصال" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("forbidden"));
  expect(toast.success).not.toHaveBeenCalled();
  expect(screen.getByText("store.example.com")).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(2); // failed disconnect does not clear/reload state
});
it("announces success and reloads only after confirmed server deletion", async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ ok: true, data: { connection } } as never)
    .mockResolvedValueOnce({ ok: true, data: {} } as never)
    .mockResolvedValueOnce({ ok: true, data: { connection: null } } as never);
  render(<CmsConnectionPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "قطع اتصال" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText("store.example.com")).toBeNull());
});
