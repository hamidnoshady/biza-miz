import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  append: vi.fn(),
  abandon: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/tenant-backup-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-backup-transport")>();
  return { ...actual, appendUploadChunk: mocks.append, abandonUploadSession: mocks.abandon };
});

import { DELETE, PUT } from "./route";

const TOKEN = "b".repeat(32);
const ctx = { params: Promise.resolve({ token: TOKEN }) };

function put(url: string, body: BodyInit | null = "chunk"): NextRequest {
  return new NextRequest(url, { method: "PUT", body });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({ session: { businessId: "business-a", sub: "user-a" } });
  mocks.append.mockResolvedValue({ ok: true, receivedBytes: 5 });
  mocks.abandon.mockResolvedValue(true);
});

it("requires the restore capability", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await PUT(put("http://app/api/backup/uploads/x?offset=0"), ctx)).status).toBe(403);
  expect(mocks.append).not.toHaveBeenCalled();
});

it("rejects a missing or malformed offset before reading the body", async () => {
  expect((await PUT(put("http://app/api/backup/uploads/x"), ctx)).status).toBe(400);
  expect((await PUT(put("http://app/api/backup/uploads/x?offset=-1"), ctx)).status).toBe(400);
  expect((await PUT(put("http://app/api/backup/uploads/x?offset=abc"), ctx)).status).toBe(400);
  expect(mocks.append).not.toHaveBeenCalled();
});

it("appends the piece for this business and reports the new offset", async () => {
  const response = await PUT(put(`http://app/api/backup/uploads/${TOKEN}?offset=0`), ctx);
  expect(response.status).toBe(200);
  expect((await response.json()).receivedBytes).toBe(5);
  expect(mocks.append).toHaveBeenCalledWith(
    expect.objectContaining({ businessId: "business-a", token: TOKEN, offset: 0 }),
  );
});

it("maps a state disagreement to 409 and an unknown session to 404", async () => {
  mocks.append.mockResolvedValue({ ok: false, error: "upload_state_mismatch" });
  expect((await PUT(put(`http://app/api/backup/uploads/${TOKEN}?offset=0`), ctx)).status).toBe(409);

  mocks.append.mockResolvedValue({ ok: false, error: "upload_not_found" });
  expect((await PUT(put(`http://app/api/backup/uploads/${TOKEN}?offset=0`), ctx)).status).toBe(404);
});

it("rejects an empty piece", async () => {
  const response = await PUT(put(`http://app/api/backup/uploads/${TOKEN}?offset=0`, ""), ctx);
  expect(response.status).toBe(400);
  expect(mocks.append).not.toHaveBeenCalled();
});

it("abandons a session for this business only", async () => {
  const request = new NextRequest(`http://app/api/backup/uploads/${TOKEN}`, { method: "DELETE" });
  const response = await DELETE(request, ctx);
  expect(response.status).toBe(200);
  expect(mocks.abandon).toHaveBeenCalledWith("business-a", TOKEN);

  mocks.abandon.mockResolvedValue(false);
  const missing = await DELETE(request, ctx);
  expect(missing.status).toBe(404);
});
