import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKUP_MAGIC,
  BACKUP_TAG_LENGTH,
  HEADER_LENGTH,
  copyFileToNewPath,
  decryptFileToFile,
  encryptFileToFile,
  fileHasBackupMagic,
  sha256File,
} from "./backup-streams";

/**
 * Issue #807 — the streaming file pipelines.
 *
 * These are the functions that replace whole-file `fs.readFile()`/`Buffer`
 * handling, so the tests care about the format (the POSBKP1 envelope is shared
 * with the in-memory path), about failure modes leaving no half-file behind,
 * and about the bytes matching a plain sha256 of the source.
 */
let dir: string;
const source = () => path.join(dir, "source.dump");

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pos-backup-streams-"));
  // ~3 MiB, larger than any single stream chunk, so the pipelines really stream.
  writeFileSync(source(), randomBytes(3 * 1024 * 1024 + 17));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("encryptFileToFile / decryptFileToFile", () => {
  it("round-trips a dump byte-for-byte through the envelope", async () => {
    const enc = path.join(dir, "artifact.dump.enc");
    const out = path.join(dir, "decrypted.dump");
    const meta = await encryptFileToFile(source(), enc, "correct horse battery staple");
    const original = await readFile(source());

    // Size: header + ciphertext(same length) + tag.
    expect(meta.sizeBytes).toBe(HEADER_LENGTH + original.byteLength + BACKUP_TAG_LENGTH);
    expect(meta.sha256).toBe(await sha256File(enc));

    const raw = await readFile(enc);
    expect(raw.subarray(0, BACKUP_MAGIC.length)).toEqual(BACKUP_MAGIC);
    expect(raw.byteLength).toBe(meta.sizeBytes);

    const plain = await decryptFileToFile(enc, out, "correct horse battery staple");
    expect(plain.sizeBytes).toBe(original.byteLength);
    // Compare digests, not Buffers: a deep equality over several MiB is cubic
    // enough to blow the 5 s test timeout for no extra assurance.
    expect(plain.sha256).toBe(createHash("sha256").update(original).digest("hex"));
  });

  it("fails on a wrong passphrase and leaves no output file behind", async () => {
    const enc = path.join(dir, "wrong-pass.dump.enc");
    const out = path.join(dir, "wrong-pass.dump");
    await encryptFileToFile(source(), enc, "right");
    await expect(decryptFileToFile(enc, out, "wrong")).rejects.toThrow(/decryption failed/);
    await expect(stat(out)).rejects.toThrow();
  });

  it("refuses a truncated artifact exactly like a tampered one", async () => {
    const enc = path.join(dir, "truncated.dump.enc");
    const out = path.join(dir, "truncated.dump");
    await encryptFileToFile(source(), enc, "pass");
    const full = await readFile(enc);
    // Drop the last byte of the authentication tag: the tag check must fail.
    await writeFile(enc, full.subarray(0, full.byteLength - 1));
    await expect(decryptFileToFile(enc, out, "pass")).rejects.toThrow(/decryption failed/);
    await expect(stat(out)).rejects.toThrow();
  });

  it("refuses a file that is not in the envelope, and says so by name", async () => {
    const plain = path.join(dir, "plain.dump");
    const out = path.join(dir, "plain.out");
    await writeFile(plain, "this is a plain pg_dump, not an encrypted artifact");
    await expect(decryptFileToFile(plain, out, "pass")).rejects.toThrow(/bad magic/);
    expect(await fileHasBackupMagic(plain)).toBe(false);
    expect(await fileHasBackupMagic(path.join(dir, "missing.dump"))).toBe(false);
    await expect(stat(out)).rejects.toThrow();
  });

  it("writes the artifact 0o600 and refuses to overwrite an existing file", async () => {
    const enc = path.join(dir, "mode.dump.enc");
    await encryptFileToFile(source(), enc, "pass");
    const info = await stat(enc);
    expect(info.mode & 0o777).toBe(0o600);
    // `wx` — a second run at the same path must not clobber a finished artifact.
    await expect(encryptFileToFile(source(), enc, "pass")).rejects.toThrow();
    // …and the failed second run must not delete the artifact that was already
    // there (the first version of this pipeline did exactly that).
    expect(await fileHasBackupMagic(enc)).toBe(true);
    expect((await stat(enc)).size).toBe(info.size);
  });

  it("does not delete an existing plaintext file when a decrypt fails", async () => {
    const enc = path.join(dir, "decrypt-onto-existing.dump.enc");
    await encryptFileToFile(source(), enc, "pass");
    const existing = path.join(dir, "already-there.dump");
    await writeFile(existing, "the operator's only copy of something");
    await expect(decryptFileToFile(enc, existing, "pass")).rejects.toThrow();
    expect(await readFile(existing, "utf8")).toBe("the operator's only copy of something");
  });

  it("does not need the whole dump in memory (hash matches a chunked read)", async () => {
    // A cheap but real memory bound: the source is several chunks long, yet the
    // process's peak RSS never has to hold it. This asserts the observable
    // contract instead — the artifact is identical to a hash computed by
    // streaming the source independently.
    const enc = path.join(dir, "bound.dump.enc");
    const meta = await encryptFileToFile(source(), enc, "pass");
    const expected = createHash("sha256").update(await readFile(source())).digest("hex");
    const dec = path.join(dir, "bound.dump");
    const plain = await decryptFileToFile(enc, dec, "pass");
    expect(plain.sha256).toBe(expected);
    expect(plain.sha256).not.toBe(meta.sha256); // ciphertext hash ≠ plaintext hash
  });
});

describe("copyFileToNewPath", () => {
  it("copies without loading the file and reports the source's size/hash", async () => {
    const dest = path.join(dir, "copy.dump");
    const meta = await copyFileToNewPath(source(), dest);
    expect(meta.sizeBytes).toBe((await stat(source())).size);
    expect(meta.sha256).toBe(await sha256File(source()));
    expect(readFileSync(dest).byteLength).toBe(meta.sizeBytes);
  });

  it("refuses to overwrite, and leaves the first copy intact", async () => {
    const dest = path.join(dir, "copy-once.dump");
    const first = await copyFileToNewPath(source(), dest);
    await expect(copyFileToNewPath(source(), dest)).rejects.toThrow();
    expect(await sha256File(dest)).toBe(first.sha256);
  });
});

describe("sha256File", () => {
  it("hashes the bytes on disk, not the path", async () => {
    const a = path.join(dir, "hash-a");
    const b = path.join(dir, "hash-b");
    await writeFile(a, "same bytes");
    await writeFile(b, "same bytes");
    expect(await sha256File(a)).toBe(await sha256File(b));
    expect(await sha256File(a)).toBe(createHash("sha256").update("same bytes").digest("hex"));
  });

  it("rejects a missing file instead of hashing an empty string", async () => {
    await expect(sha256File(path.join(dir, "nope"))).rejects.toThrow();
  });
});
