import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  owner: { businessId: "business-1", actorUserId: "actor-1" },
  workspaceOwner: vi.fn(),
  requireContract: vi.fn(),
  resolveWorkspaceSubject: vi.fn(),
  generateOrReadFinalContractPdf: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler }));
vi.mock("@/lib/contracts/final-pdf", () => ({ generateOrReadFinalContractPdf: mocks.generateOrReadFinalContractPdf }));
vi.mock("@/lib/contracts/service", () => ({ requireContract: mocks.requireContract }));
vi.mock("@/lib/workspace", () => ({ resolveWorkspaceSubject: mocks.resolveWorkspaceSubject }));
vi.mock("../../../guard", () => ({
  PERMISSIONS: { workspaceContractsManage: "workspace.contracts_manage" },
  workspaceOwner: mocks.workspaceOwner,
  handleWorkspaceError: (error: unknown) => NextResponse.json({ error: error instanceof Error ? error.message : "failure" }, { status: 500 }),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceOwner.mockResolvedValue({ owner: mocks.owner, error: null });
  mocks.resolveWorkspaceSubject.mockResolvedValue(undefined);
  mocks.requireContract.mockResolvedValue({ id: "contract-1", title: "قرارداد" });
  mocks.generateOrReadFinalContractPdf.mockResolvedValue({
    bytes: Buffer.from("%PDF-1.7 test"),
    fileName: "contract.pdf",
    version: 3,
    contentHash: "a".repeat(64),
    pdfSha256: "b".repeat(64),
    createdAt: "2026-10-20T10:00:00.000Z",
  });
});

describe("POST /api/workspace/contracts/[id]/final-pdf", () => {
  it("authorizes contract edit and streams the persisted PDF with integrity headers", async () => {
    const request = new NextRequest("https://example.test/api/workspace/contracts/contract-1/final-pdf", { method: "POST" });
    const response = await POST(request, { params: Promise.resolve({ id: "contract-1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("contract.pdf");
    expect(response.headers.get("x-contract-version")).toBe("3");
    expect(response.headers.get("x-contract-content-sha256")).toBe("a".repeat(64));
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-1.7 test");
    expect(mocks.resolveWorkspaceSubject).toHaveBeenCalledWith(mocks.owner, "contract", "contract-1", "edit");
    expect(mocks.generateOrReadFinalContractPdf).toHaveBeenCalledWith(
      mocks.owner,
      { id: "contract-1", title: "قرارداد" },
      request.url,
      request.headers,
    );
  });

  it("returns the permission response without generating a PDF", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    mocks.workspaceOwner.mockResolvedValue({ owner: null, error: denied });
    const request = new NextRequest("https://example.test/api/workspace/contracts/contract-1/final-pdf", { method: "POST" });
    const response = await POST(request, { params: Promise.resolve({ id: "contract-1" }) });
    expect(response.status).toBe(403);
    expect(mocks.generateOrReadFinalContractPdf).not.toHaveBeenCalled();
  });
});
