/**
 * Issue #972 — the console's tour routes at the boundary a reviewer cares about.
 *
 * The authoring rules are unit-tested in `src/lib/tour-studio.test.ts`; what
 * this file asserts is the HTTP contract the console depends on:
 *
 *  - reading is admin-only and every write needs `knowledge.manage`, and a
 *    denied write never reaches the service;
 *  - the actor recorded on the row and in the audit is the signed-in admin;
 *  - a malformed payload is a 400 with the sentence the panel shows, and no
 *    call is made;
 *  - a stale `expectedVersion` is a 409 (not a silent overwrite), and an
 *    unknown lifecycle action is refused rather than guessed;
 *  - a draft can be deleted, while anything members have seen is archived.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  requirePlatformCapability: vi.fn(),
  audit: vi.fn(async () => {}),
  list: vi.fn(),
  save: vi.fn(),
  get: vi.fn(),
  revisions: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
  requirePlatformCapability: mocks.requirePlatformCapability,
  withPlatformScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
  platformAudit: mocks.audit,
}));

// Keep the real validation and error mapping; replace only the database work.
vi.mock("@/lib/tour-studio-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tour-studio-service")>();
  return {
    ...actual,
    listStudioTours: mocks.list,
    saveStudioTour: mocks.save,
    getStudioTour: mocks.get,
    listStudioTourRevisions: mocks.revisions,
    publishStudioTour: mocks.publish,
    rollbackStudioTour: mocks.rollback,
    archiveStudioTour: mocks.archive,
    deleteStudioTourDraft: mocks.remove,
  };
});

import { GET, POST } from "./route";
import { DELETE, GET as GET_ONE, POST as ACT } from "./[tourId]/route";
import { StudioTourServiceError } from "@/lib/tour-studio-service";

const ADMIN = { session: { padmin: "admin-1", role: "owner" }, error: null };
const DENIED = { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOUR = {
  id: ID,
  tourKey: "studio.crm.audit",
  pageKey: "page:/crm/audit",
  route: "/crm/audit",
  title: "سابقهٔ تصمیم‌ها",
  description: "",
  eligibility: {},
  steps: [
    { id: "intro", kind: "explain", title: "شروع", body: "." },
    { id: "header", kind: "spotlight", anchor: "page.header", title: "سرصفحه", body: "." },
  ],
  status: "draft",
  version: 2,
  publishedVersion: null,
  updatedBy: "admin-1",
  updatedAt: "2026-11-06T10:00:00.000Z",
  publishedAt: null,
};

const VALID_BODY = {
  tourKey: TOUR.tourKey,
  pageKey: TOUR.pageKey,
  title: TOUR.title,
  description: "",
  eligibility: {},
  steps: TOUR.steps,
};

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://admin.example.test${url}`, init);
}
function jsonRequest(url: string, body: unknown) {
  return request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const ctx = (tourId: string) => ({ params: Promise.resolve({ tourId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue(ADMIN);
  mocks.requirePlatformCapability.mockResolvedValue(ADMIN);
  mocks.list.mockResolvedValue([]);
  mocks.get.mockResolvedValue(TOUR);
  mocks.revisions.mockResolvedValue([]);
});

describe("GET /api/platform/knowledge/tours", () => {
  it("requires a signed-in platform admin", async () => {
    mocks.requirePlatformAdmin.mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const res = await GET(request("/api/platform/knowledge/tours"));
    expect(res.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists the catalogue for any admin", async () => {
    mocks.list.mockResolvedValue([TOUR]);
    const res = await GET(request("/api/platform/knowledge/tours"));
    expect(res.status).toBe(200);
    expect((await res.json()).tours).toHaveLength(1);
  });
});

describe("POST /api/platform/knowledge/tours", () => {
  it("refuses a write without knowledge.manage, before any parsing or storage", async () => {
    mocks.requirePlatformCapability.mockResolvedValue(DENIED);
    const res = await POST(jsonRequest("/api/platform/knowledge/tours", VALID_BODY));
    expect(res.status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves what the server validated, as the signed-in admin, and audits it", async () => {
    mocks.save.mockResolvedValue({ id: ID, version: 3, created: false });
    const res = await POST(jsonRequest("/api/platform/knowledge/tours", { ...VALID_BODY, expectedVersion: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: ID, version: 3, created: false });
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        tourKey: TOUR.tourKey,
        pageKey: TOUR.pageKey,
        route: "/crm/audit",
        steps: TOUR.steps,
      }),
      "admin-1",
      2,
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: "admin-1", action: "knowledge_tour.save", entityId: ID }),
    );
  });

  it("reports the validation sentence and stores nothing", async () => {
    const res = await POST(
      jsonRequest("/api/platform/knowledge/tours", {
        ...VALID_BODY,
        steps: [{ id: "go", kind: "spotlight", anchor: ".made-up", title: "x", body: "." }],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_steps");
    expect(body.detail).toContain("not registered");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("turns a stale editor into a 409 instead of overwriting", async () => {
    mocks.save.mockRejectedValue(new StudioTourServiceError("version_conflict"));
    const res = await POST(jsonRequest("/api/platform/knowledge/tours", { ...VALID_BODY, expectedVersion: 1 }));
    expect(res.status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("creates a new tour under the create action", async () => {
    mocks.save.mockResolvedValue({ id: ID, version: 1, created: true });
    await POST(jsonRequest("/api/platform/knowledge/tours", VALID_BODY));
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "knowledge_tour.create", entityId: ID }),
    );
  });
});

describe("/api/platform/knowledge/tours/[tourId]", () => {
  it("returns a tour with its revision history", async () => {
    const res = await GET_ONE(request(`/api/platform/knowledge/tours/${ID}`), ctx(ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tour.id).toBe(ID);
    expect(Array.isArray(body.revisions)).toBe(true);
  });

  it("answers 404 for a tour the console does not have", async () => {
    mocks.get.mockResolvedValue(null);
    const res = await GET_ONE(request(`/api/platform/knowledge/tours/${ID}`), ctx(ID));
    expect(res.status).toBe(404);
  });

  it("publishes the version the editor read, and audits it", async () => {
    mocks.publish.mockResolvedValue({ ...TOUR, status: "published", publishedVersion: 2 });
    const res = await ACT(
      jsonRequest(`/api/platform/knowledge/tours/${ID}`, { action: "publish", version: 2 }),
      ctx(ID),
    );
    expect(res.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith(ID, "admin-1", 2);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "knowledge_tour.publish", entityId: ID }),
    );
  });

  it("rolls back to a named revision, and refuses a rollback without one", async () => {
    mocks.rollback.mockResolvedValue({ ...TOUR, version: 4, publishedVersion: 4, status: "published" });
    const ok = await ACT(
      jsonRequest(`/api/platform/knowledge/tours/${ID}`, { action: "rollback", toVersion: 2 }),
      ctx(ID),
    );
    expect(ok.status).toBe(200);
    expect(mocks.rollback).toHaveBeenCalledWith(ID, 2, "admin-1");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "knowledge_tour.rollback", entityId: ID }),
    );

    const bad = await ACT(
      jsonRequest(`/api/platform/knowledge/tours/${ID}`, { action: "rollback" }),
      ctx(ID),
    );
    expect(bad.status).toBe(400);
  });

  it("archives, and never guesses an unknown action", async () => {
    mocks.archive.mockResolvedValue({ ...TOUR, status: "archived" });
    expect(
      (await ACT(jsonRequest(`/api/platform/knowledge/tours/${ID}`, { action: "archive" }), ctx(ID))).status,
    ).toBe(200);
    expect(
      (await ACT(jsonRequest(`/api/platform/knowledge/tours/${ID}`, { action: "delete-everything" }), ctx(ID)))
        .status,
    ).toBe(400);
    expect(mocks.archive).toHaveBeenCalledTimes(1);
  });

  it("needs the capability for every action too", async () => {
    mocks.requirePlatformCapability.mockResolvedValue(DENIED);
    expect(
      (await ACT(jsonRequest(`/api/platform/knowledge/tours/${ID}`, { action: "publish" }), ctx(ID))).status,
    ).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("deletes a never-published draft and reports a published one as not a draft", async () => {
    mocks.remove.mockResolvedValue(undefined);
    expect(
      (await DELETE(request(`/api/platform/knowledge/tours/${ID}`, { method: "DELETE" }), ctx(ID))).status,
    ).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "knowledge_tour.delete_draft", entityId: ID }),
    );

    mocks.remove.mockRejectedValue(new StudioTourServiceError("not_draft"));
    expect(
      (await DELETE(request(`/api/platform/knowledge/tours/${ID}`, { method: "DELETE" }), ctx(ID))).status,
    ).toBe(409);
  });
});
