/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/app/dashboard/ui", () => ({ api, inputClass: "", ErrorBox: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>, InfoBox: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { WpMediaDetailDialog } from "./media-detail-dialog";
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  api.mockResolvedValue({ ok: true, data: { canEdit: true, canTrash: true, jobs: [], attachment: { id: "42", title: "Remote fixture", altText: "Fixture alt", caption: "Existing caption", description: "Existing description", revision: "10", status: "inherit", mimeType: "image/png", url: null, filename: "fixture.png", mappings: [], usage: null } } });
});
it("names populated metadata fields independently of their current values", async () => {
  render(<WpMediaDetailDialog connectionId="site" remoteId="42" siteName="Store" canManage onClose={() => {}} />);
  const title = await screen.findByLabelText("عنوان", { exact: true });
  expect(title.getAttribute("aria-label")).toBe("عنوان");
  expect((title as HTMLTextAreaElement).value).toBe("Remote fixture");
  expect((screen.getByLabelText("متن جایگزین", { exact: true }) as HTMLTextAreaElement).value).toBe("Fixture alt");
  expect((screen.getByLabelText("زیرنویس", { exact: true }) as HTMLTextAreaElement).value).toBe("Existing caption");
  expect((screen.getByLabelText("توضیحات", { exact: true }) as HTMLTextAreaElement).value).toBe("Existing description");
  fireEvent.change(title, { target: { value: "Browser edit" } });
  expect(screen.getByLabelText("عنوان", { exact: true })).toBe(title);
});
