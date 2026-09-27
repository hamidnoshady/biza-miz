// @vitest-environment jsdom

/**
 * The document register audit found a real gap this test pins shut: a
 * document's `mediaAssetId` was stored and round-tripped correctly (the
 * bytes always were the Media Library's, never a second store), but nothing
 * in the screen ever let anyone actually open the file again — the row
 * rendered the file name as inert text, and the edit dialog's picker only
 * let you change *which* asset was linked, never look at the current one.
 * A document register nobody can open a document from is not fixed by
 * storing the reference correctly; it has to be reachable too.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsSection, type DocumentRow } from "./documents-section";
import { EMPTY_LOOKUPS } from "./use-workspace-lookups";

afterEach(cleanup);

function documentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "doc-1",
    title: "نقشهٔ فاز یک",
    description: "",
    mediaAssetId: "asset-1",
    fileName: "phase-one.pdf",
    projectId: null,
    projectName: null,
    contractId: null,
    contractTitle: null,
    partyId: null,
    partyName: null,
    status: "draft",
    version: 1,
    tags: [],
    commentCount: 0,
    createdAt: "1403-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function stubFetch(documents: DocumentRow[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/workspace/documents")) {
      return { ok: true, status: 200, json: async () => ({ documents }) };
    }
    if (url === "/api/workspace/contracts") {
      return { ok: true, status: 200, json: async () => ({ contracts: [] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection(documents: DocumentRow[]) {
  stubFetch(documents);
  return render(
    <DocumentsSection lookups={EMPTY_LOOKUPS} canManage canRequestApproval={false} />,
  );
}

describe("DocumentsSection — reaching the file a document points at", () => {
  it("renders a document's file name as a link to the Media Library file route, not inert text", async () => {
    renderSection([documentRow()]);
    const link = await screen.findByRole("link", { name: /phase-one\.pdf/ });
    expect(link.getAttribute("href")).toBe("/api/media/asset-1/file");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("shows the file name as plain text, not a link, when a document has no linked asset", async () => {
    renderSection([documentRow({ mediaAssetId: null, fileName: "قدیمی.pdf" })]);
    await screen.findByText("قدیمی.pdf");
    expect(screen.queryByRole("link", { name: /قدیمی\.pdf/ })).toBeNull();
  });

  it("opens the file link directly without also opening the edit dialog", async () => {
    renderSection([documentRow()]);
    const link = await screen.findByRole("link", { name: /phase-one\.pdf/ });
    // jsdom does not implement navigation; the assertion that matters here is
    // that the click never bubbles up into the row's own onClick, which is
    // what used to force a metadata dialog open in front of the new tab.
    await act(async () => {
      fireEvent.click(link);
    });
    expect(screen.queryByRole("heading", { name: "ویرایش سند" })).toBeNull();
  });

  it("still opens the edit dialog when the row itself (not the link) is clicked", async () => {
    renderSection([documentRow()]);
    const row = (await screen.findByText("نقشهٔ فاز یک")).closest("tr");
    expect(row).not.toBeNull();
    const user = userEvent.setup();
    await user.click(row as HTMLElement);
    await screen.findByRole("heading", { name: "ویرایش سند" });
  });

  it("offers a 'view current file' link inside the edit dialog for a document that already has one", async () => {
    renderSection([documentRow()]);
    const row = (await screen.findByText("نقشهٔ فاز یک")).closest("tr") as HTMLElement;
    const user = userEvent.setup();
    await user.click(row);
    const dialog = await screen.findByRole("heading", { name: "ویرایش سند" });
    const panel = dialog.closest("div")?.parentElement as HTMLElement;
    const viewLink = await within(panel).findByRole("link", { name: /مشاهدهٔ فایل فعلی/ });
    expect(viewLink.getAttribute("href")).toBe("/api/media/asset-1/file");
  });

  it("offers no 'view current file' link in the create dialog before any asset is picked", async () => {
    renderSection([]);
    await waitFor(() => screen.getByText("سندی ثبت نشده است"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /ثبت سند/ }));
    await screen.findByRole("heading", { name: "ثبت سند" });
    expect(screen.queryByRole("link", { name: /مشاهدهٔ فایل فعلی/ })).toBeNull();
  });
});
