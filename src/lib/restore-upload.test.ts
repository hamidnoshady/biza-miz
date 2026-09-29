import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendRestoreChunk,
  discardRestoreUpload,
  isRestoreUploadId,
  parseChunkParams,
  readRestoreUpload,
  RESTORE_UPLOAD_MAX_CHUNK_BYTES,
  RESTORE_UPLOAD_TTL_MS,
  sweepStaleRestoreUploads,
  uploadSourceName,
} from "./restore-upload";

const ID = "3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const BIZ = "11111111-2222-3333-4444-555555555555";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "restore-upload-test-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("parseChunkParams", () => {
  it("accepts a uuid and a non-negative integer offset", () => {
    expect(parseChunkParams(ID, "0")).toEqual({ ok: true, id: ID, offset: 0 });
    expect(parseChunkParams(ID, "4194304")).toEqual({ ok: true, id: ID, offset: 4194304 });
  });

  it("refuses anything that could become a path or a negative offset", () => {
    expect(parseChunkParams("../../etc/passwd", "0")).toEqual({ ok: false, error: "invalid_upload_id" });
    expect(parseChunkParams(null, "0")).toEqual({ ok: false, error: "invalid_upload_id" });
    expect(parseChunkParams(ID, "-1")).toEqual({ ok: false, error: "invalid_offset" });
    expect(parseChunkParams(ID, "1.5")).toEqual({ ok: false, error: "invalid_offset" });
    expect(parseChunkParams(ID, null)).toEqual({ ok: false, error: "invalid_offset" });
  });

  it("isRestoreUploadId only accepts a lowercase uuid", () => {
    expect(isRestoreUploadId(ID)).toBe(true);
    expect(isRestoreUploadId(ID.toUpperCase())).toBe(false);
    expect(isRestoreUploadId(42)).toBe(false);
  });
});

describe("uploadSourceName", () => {
  it("keeps only the base name and safe characters", () => {
    expect(uploadSourceName("C:\\Backups\\pos-backup-20260901-033000.dump.enc")).toBe(
      "pos-backup-20260901-033000.dump.enc",
    );
    expect(uploadSourceName("../x/<evil>.dump")).toBe("evil.dump");
    expect(uploadSourceName(undefined)).toBe("uploaded-backup.dump");
  });
});

describe("appendRestoreChunk", () => {
  it("assembles pieces in order and reads them back", async () => {
    expect(await appendRestoreChunk(BIZ, ID, 0, Buffer.from("abc"), root)).toEqual({ ok: true, size: 3 });
    expect(await appendRestoreChunk(BIZ, ID, 3, Buffer.from("def"), root)).toEqual({ ok: true, size: 6 });
    expect((await readRestoreUpload(BIZ, ID, root))?.toString()).toBe("abcdef");
  });

  it("refuses an out-of-order piece and reports where to resume", async () => {
    await appendRestoreChunk(BIZ, ID, 0, Buffer.from("abc"), root);
    expect(await appendRestoreChunk(BIZ, ID, 0 + 10, Buffer.from("x"), root)).toEqual({
      ok: false,
      error: "offset_mismatch",
      size: 3,
    });
    expect((await readRestoreUpload(BIZ, ID, root))?.toString()).toBe("abc");
  });

  it("restarts cleanly when offset 0 is sent again", async () => {
    await appendRestoreChunk(BIZ, ID, 0, Buffer.from("old-bytes"), root);
    await appendRestoreChunk(BIZ, ID, 0, Buffer.from("new"), root);
    expect((await readRestoreUpload(BIZ, ID, root))?.toString()).toBe("new");
  });

  it("refuses empty and oversized pieces", async () => {
    expect(await appendRestoreChunk(BIZ, ID, 0, new Uint8Array(0), root)).toEqual({ ok: false, error: "empty_chunk" });
    expect(
      await appendRestoreChunk(BIZ, ID, 0, new Uint8Array(RESTORE_UPLOAD_MAX_CHUNK_BYTES + 1), root),
    ).toEqual({ ok: false, error: "chunk_too_large" });
  });

  it("keeps scopes apart: one business cannot read another's upload", async () => {
    await appendRestoreChunk(BIZ, ID, 0, Buffer.from("secret"), root);
    expect(await readRestoreUpload("setup", ID, root)).toBeNull();
  });

  it("discard removes the upload", async () => {
    await appendRestoreChunk(BIZ, ID, 0, Buffer.from("abc"), root);
    await discardRestoreUpload(BIZ, ID, root);
    expect(await readRestoreUpload(BIZ, ID, root)).toBeNull();
  });
});

describe("sweepStaleRestoreUploads", () => {
  it("removes only uploads older than the TTL", async () => {
    await appendRestoreChunk(BIZ, ID, 0, Buffer.from("abc"), root);
    expect(await sweepStaleRestoreUploads(Date.now(), root)).toBe(0);
    expect(await sweepStaleRestoreUploads(Date.now() + RESTORE_UPLOAD_TTL_MS + 60_000, root)).toBe(1);
    expect(await readRestoreUpload(BIZ, ID, root)).toBeNull();
  });
});
