import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  owner: vi.fn(),
  aec: vi.fn(),
  agency: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
  archive: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ withTenantScope: (fn: unknown) => fn }));
vi.mock("@/lib/aec-service", () => ({ readAecOperatingProfile: m.aec }));
vi.mock("@/lib/agency-service", () => ({
  readAgencyOperatingProfiles: m.agency,
}));
vi.mock("@/lib/workspace", () => ({
  listTemplates: m.list,
  saveTemplate: m.save,
  archiveTemplate: m.archive,
}));
vi.mock("../guard", () => ({
  PERMISSIONS: {
    workspaceView: "workspace.view",
    workspaceManage: "workspace.manage",
  },
  workspaceOwner: m.owner,
  readBody: (r: Request) => r.json(),
  handleWorkspaceError: (err: unknown) => {
    throw err;
  },
}));
import { GET, POST, DELETE } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  m.owner.mockResolvedValue({ owner: { businessId: "tenant" }, error: null });
  m.aec.mockResolvedValue(null);
  m.agency.mockResolvedValue(["outdoor_print", "content_video"]);
  m.list.mockResolvedValue([]);
});
describe("combined blueprint choices on every response", () => {
  it("GET/POST/DELETE resolve the same stored agency profile union", async () => {
    await GET(new NextRequest("http://test/api/workspace/templates"));
    await POST(
      new NextRequest("http://test/api/workspace/templates", {
        method: "POST",
        body: JSON.stringify({ key: "custom" }),
      }),
    );
    await DELETE(
      new NextRequest("http://test/api/workspace/templates?key=custom", {
        method: "DELETE",
      }),
    );
    expect(m.list).toHaveBeenCalledTimes(3);
    for (const args of m.list.mock.calls)
      expect(args).toEqual([
        "tenant",
        { profile: "outdoor_print", additionalProfiles: ["content_video"] },
      ]);
  });
  it("keeps AEC on its existing single-profile path", async () => {
    m.aec.mockResolvedValue("contractor");
    await GET(new NextRequest("http://test/api/workspace/templates"));
    expect(m.agency).not.toHaveBeenCalled();
    expect(m.list).toHaveBeenCalledWith("tenant", { profile: "contractor" });
  });
  it("preserves generic-only ordering when neither trade supplies profiles", async () => {
    m.agency.mockResolvedValue([]);
    await GET(new NextRequest("http://test/api/workspace/templates"));
    expect(m.list).toHaveBeenCalledWith("tenant", {
      profile: null,
      additionalProfiles: [],
    });
  });
});
