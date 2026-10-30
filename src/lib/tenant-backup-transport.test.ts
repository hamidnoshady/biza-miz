import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolveOwnedArtifact: vi.fn(),
  resolveTenantStorage: vi.fn(),
  presignS3Get: vi.fn(),
  s3GetToFile: vi.fn(),
}));

vi.mock("./db", () => ({ query: mocks.query }));
vi.mock("./master-key", () => ({ getMasterKey: () => null }));
vi.mock("./tenant-backup-artifacts-service", () => ({
  resolveOwnedArtifact: mocks.resolveOwnedArtifact,
  recordTenantArtifact: vi.fn(),
  markArtifactStateByRef: vi.fn(),
  installedSchemaVersion: vi.fn(async () => 268),
}));
vi.mock("./tenant-backup-storage", () => ({
  resolveTenantStorage: mocks.resolveTenantStorage,
  ensureStagingDir: vi.fn(async () => "/tmp/staging"),
  cleanupStagingDir: vi.fn(),
  tenantStagingDir: (businessId: string, suffix: string) => `/tmp/staging/${businessId}/${suffix}`,
}));
vi.mock("./s3-lite", () => ({
  presignS3Get: mocks.presignS3Get,
  s3GetToFile: mocks.s3GetToFile,
}));

import {
  DOWNLOAD_TICKET_TTL_SECONDS,
  planArtifactDownload,
  checkChunk,
  checkCompletion,
  isTransportableState,
  openDownloadTicket,
  sealDownloadTicket,
  UPLOAD_MAX_BYTES,
} from "./tenant-backup-transport";

const masterKey = randomBytes(32);
const now = new Date("2026-10-28T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("download tickets", () => {
  function ticket(overrides: Partial<Parameters<typeof sealDownloadTicket>[0]> = {}) {
    return sealDownloadTicket(
      {
        businessId: "11111111-1111-4111-8111-111111111111",
        ref: "abc",
        destination: "local",
        expiresAt: Math.floor(now.getTime() / 1000) + DOWNLOAD_TICKET_TTL_SECONDS,
        ...overrides,
      },
      masterKey,
    )!;
  }

  it("round-trips its claims", () => {
    const opened = openDownloadTicket(ticket(), masterKey, now);
    expect(opened).toEqual({
      ok: true,
      claims: {
        businessId: "11111111-1111-4111-8111-111111111111",
        ref: "abc",
        destination: "local",
        expiresAt: Math.floor(now.getTime() / 1000) + DOWNLOAD_TICKET_TTL_SECONDS,
      },
    });
  });

  it("refuses a ticket minted with another key", () => {
    expect(openDownloadTicket(ticket(), randomBytes(32), now)).toEqual({
      ok: false,
      error: "invalid_download_ticket",
    });
  });

  it("refuses a tampered payload", () => {
    const [payload, signature] = ticket().split(".");
    const forged = Buffer.from(
      JSON.stringify({ v: 1, b: "99999999-9999-4999-8999-999999999999", r: "abc", d: "local", e: 9_999_999_999 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(openDownloadTicket(`${forged}.${signature}`, masterKey, now)).toEqual({
      ok: false,
      error: "invalid_download_ticket",
    });
    expect(payload).toBeTruthy();
  });

  it("expires rather than staying valid forever", () => {
    const expired = ticket({ expiresAt: Math.floor(now.getTime() / 1000) });
    expect(openDownloadTicket(expired, masterKey, now)).toEqual({ ok: false, error: "expired_download_ticket" });
  });

  it("cannot be minted at all without a platform key", () => {
    expect(
      sealDownloadTicket(
        { businessId: "b", ref: "r", destination: "local", expiresAt: 1 },
        null,
      ),
    ).toBeNull();
    expect(openDownloadTicket(ticket(), null, now)).toEqual({ ok: false, error: "invalid_download_ticket" });
  });

  it.each(["", "one-part", "a.b.c", "!!!.???"])("refuses the malformed token %j", (token) => {
    expect(openDownloadTicket(token, masterKey, now).ok).toBe(false);
  });
});

describe("checkChunk", () => {
  const base = { expectedBytes: 10, receivedBytes: 4, offset: 4, chunkLength: 3 };

  it("accepts the next piece in order", () => {
    expect(checkChunk(base)).toEqual({ ok: true, nextOffset: 7 });
  });

  it("rejects a retried piece instead of duplicating it", () => {
    expect(checkChunk({ ...base, offset: 0 })).toEqual({ ok: false, error: "invalid_offset" });
  });

  it("rejects a piece that would overshoot the declared size", () => {
    expect(checkChunk({ ...base, receivedBytes: 9, offset: 9, chunkLength: 5 })).toEqual({
      ok: false,
      error: "invalid_offset",
    });
  });

  it("rejects an oversized piece and an oversized upload", () => {
    expect(checkChunk({ ...base, chunkLength: 9 * 1024 * 1024 })).toEqual({ ok: false, error: "chunk_too_large" });
    expect(checkChunk({ ...base, expectedBytes: UPLOAD_MAX_BYTES + 1 })).toEqual({
      ok: false,
      error: "upload_too_large",
    });
  });

  it("rejects a negative or non-integer offset", () => {
    expect(checkChunk({ ...base, offset: -1, receivedBytes: -1 })).toEqual({ ok: false, error: "invalid_offset" });
    expect(checkChunk({ ...base, offset: 1.5, receivedBytes: 1.5 })).toEqual({ ok: false, error: "invalid_offset" });
  });

  it("refuses to append to a complete upload", () => {
    expect(checkChunk({ ...base, expectedBytes: 4, receivedBytes: 4, offset: 4 })).toEqual({
      ok: false,
      error: "upload_complete",
    });
  });
});

describe("checkCompletion", () => {
  const digest = "a".repeat(64);

  it("accepts an exact size and digest", () => {
    expect(
      checkCompletion({ expectedBytes: 5, receivedBytes: 5, expectedSha256: digest, actualSha256: digest.toUpperCase() }),
    ).toEqual({ ok: true });
  });

  it("refuses a short upload, an empty one and a digest mismatch", () => {
    expect(
      checkCompletion({ expectedBytes: 5, receivedBytes: 4, expectedSha256: digest, actualSha256: digest }),
    ).toEqual({ ok: false, error: "upload_incomplete" });
    expect(
      checkCompletion({ expectedBytes: 0, receivedBytes: 0, expectedSha256: digest, actualSha256: digest }),
    ).toEqual({ ok: false, error: "size_mismatch" });
    expect(
      checkCompletion({ expectedBytes: 5, receivedBytes: 5, expectedSha256: digest, actualSha256: "b".repeat(64) }),
    ).toEqual({ ok: false, error: "checksum_mismatch" });
  });
});

describe("isTransportableState", () => {
  it("only a ready artifact may be downloaded or restored", () => {
    expect(isTransportableState("ready")).toBe(true);
    for (const state of ["verifying", "uploading", "pending_upload", "failed", "expired", "superseded"]) {
      expect(isTransportableState(state)).toBe(false);
    }
  });
});

describe("planArtifactDownload — where a local artifact actually lives", () => {
  const businessId = "11111111-1111-4111-8111-111111111111";

  async function localRow(storageRef: string) {
    const { promises: fs } = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "download-plan-"));
    return { fs, nodePath, root, storageRef };
  }

  it("resolves into the tenant's own subdirectory on central", async () => {
    const { fs, nodePath, root, storageRef } = await localRow("a.dump.enc");
    const { logicalSnapshotScopeTag } = await import("./backup-policy");
    const tenantDir = nodePath.join(root, "tenants", logicalSnapshotScopeTag(businessId));
    await fs.mkdir(tenantDir, { recursive: true });
    await fs.writeFile(nodePath.join(tenantDir, storageRef), "ciphertext");
    // A same-named file at the flat root must not be what the tenant receives.
    await fs.writeFile(nodePath.join(root, storageRef), "someone-else");

    const previous = process.env.DEPLOYMENT_ROLE;
    process.env.DEPLOYMENT_ROLE = "central";
    try {
      mocks.resolveOwnedArtifact.mockResolvedValue({
        destination: "local",
        state: "ready",
        storageRef,
        encryption: "managed_envelope_v1",
      });

      const plan = await planArtifactDownload({
        businessId,
        ref: "ref-1",
        destination: "local",
        profile: "cloud",
        role: "central",
        directory: root,
      });

      expect(plan.kind).toBe("stream");
      if (plan.kind === "stream") expect(plan.path).toBe(nodePath.join(tenantDir, storageRef));
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_ROLE;
      else process.env.DEPLOYMENT_ROLE = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
