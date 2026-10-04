/**
 * Streaming file pipelines for backup and restore artifacts (issue #807).
 *
 * The encryption envelope is the one `backup.ts` has always written
 * (`POSBKP1\0 | salt(16) | IV(12) | ciphertext | GCM tag(16)`); what changes
 * here is that a multi-gigabyte database dump is never held in a Node
 * `Buffer`. Every function in this file moves bytes file → transform → file
 * with a bounded amount of memory, so a backup of a large install cannot OOM
 * the process that is supposed to be protecting it.
 *
 * The Buffer-based `encryptBackup`/`decryptBackup` in `backup.ts` remain for
 * the small cases (unit tests, a tiny value) and use the same format
 * constants, so both halves can never drift.
 *
 * Design notes that matter:
 *
 *   • AES-GCM authenticates the *whole* message, so the 16-byte tag arrives
 *     last. Decryption therefore keeps a 16-byte lookback window while
 *     streaming instead of buffering the file; the final bytes are withheld
 *     until the stream ends, and only then is `setAuthTag` + `final()` called
 *     — a truncated file throws exactly like a tampered one.
 *   • Every write is `0o600` and fsynced before the caller renames it into
 *     place, so an interrupted run can never leave a file that looks final.
 *   • A partial output file is removed on any failure path.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** The envelope's constants — shared with `backup.ts`'s Buffer implementation. */
export const BACKUP_MAGIC = Buffer.from("POSBKP1\0", "latin1");
export const BACKUP_SALT_LENGTH = 16;
export const BACKUP_IV_LENGTH = 12;
export const BACKUP_TAG_LENGTH = 16;
export const BACKUP_KEY_LENGTH = 32;
/** scrypt cost — 16 MiB memory, interactive-grade; bump only with a new magic. */
export const BACKUP_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
/** magic + salt + IV — the fixed-size prefix every artifact starts with. */
export const HEADER_LENGTH =
  BACKUP_MAGIC.length + BACKUP_SALT_LENGTH + BACKUP_IV_LENGTH;

export function deriveBackupKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, BACKUP_KEY_LENGTH, { ...BACKUP_SCRYPT_PARAMS });
}

/** A writable that folds every chunk into a running hash. */
function hashingSink(hash: ReturnType<typeof createHash>, onBytes: (n: number) => void): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      onBytes(chunk.byteLength);
      callback();
    },
  });
}

/** Downstream half of `hashingSink` — passes bytes through while counting them. */
function hashingPassThrough(
  hash: ReturnType<typeof createHash>,
  onBytes: (n: number) => void,
): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      onBytes(chunk.byteLength);
      callback(null, chunk);
    },
  });
}

/** Streaming sha256 of a file — the manifest/run-row checksum, no whole-file read. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hashingSink(hash, () => {}));
  return hash.digest("hex");
}

/** fsync a completed file so a rename never exposes unflushed bytes. */
export async function fsyncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface StreamedArtifact {
  sizeBytes: number;
  sha256: string;
}

/**
 * Encrypt `srcPath` onto `destPath` in the POSBKP1 envelope, hashing the
 * ciphertext exactly as it is written (the hash a peer will verify).
 */
export async function encryptFileToFile(
  srcPath: string,
  destPath: string,
  passphrase: string,
): Promise<StreamedArtifact> {
  const salt = randomBytes(BACKUP_SALT_LENGTH);
  const iv = randomBytes(BACKUP_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveBackupKey(passphrase, salt), iv);
  const header = Buffer.concat([BACKUP_MAGIC, salt, iv]);
  const hash = createHash("sha256");
  let sizeBytes = 0;

  // Create the destination ourselves, with `wx`, *before* writing a byte: the
  // cleanup below may only ever delete a file this call created. (A first
  // version passed `flags: "wx"` to createWriteStream and removed the path on
  // any failure — so asking to write over an existing artifact failed with
  // EEXIST and then deleted the artifact that was already there.)
  const handle = await fs.open(destPath, "wx", 0o600);
  const out = handle.createWriteStream();
  try {
    // The header is plaintext and comes first; the cipher only ever sees the
    // dump's bytes. (Passing the header *through* the cipher is the easy
    // mistake here — it produces a file whose first bytes are ciphertext, which
    // every reader then rejects as "not an encrypted backup".)
    hash.update(header);
    sizeBytes += header.byteLength;
    out.write(header);

    const encrypting = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          const enc = cipher.update(chunk);
          hash.update(enc);
          sizeBytes += enc.byteLength;
          callback(null, enc);
        } catch (error) {
          callback(error as Error);
        }
      },
      flush(callback) {
        try {
          const rest = cipher.final();
          const tag = cipher.getAuthTag();
          hash.update(rest);
          hash.update(tag);
          sizeBytes += rest.byteLength + tag.byteLength;
          callback(null, Buffer.concat([rest, tag]));
        } catch (error) {
          callback(error as Error);
        }
      },
    });

    await pipeline(createReadStream(srcPath), encrypting, out);
    await fsyncFile(destPath);
    return { sizeBytes, sha256: hash.digest("hex") };
  } catch (error) {
    out.destroy();
    await handle.close().catch(() => {});
    await fs.rm(destPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Decrypt a POSBKP1 file onto `destPath`. Throws on a wrong passphrase, a
 * truncated file, a bad magic, or any tampering — GCM's authentication tag is
 * verified before the last bytes are written, and the partial output is
 * removed on every failure path.
 */
export async function decryptFileToFile(
  srcPath: string,
  destPath: string,
  passphrase: string,
): Promise<StreamedArtifact> {
  const handle: FileHandle = await fs.open(srcPath, "r");
  let header: Buffer;
  try {
    header = Buffer.alloc(HEADER_LENGTH);
    const { bytesRead } = await handle.read(header, 0, HEADER_LENGTH, 0);
    header = header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (header.byteLength < HEADER_LENGTH || !header.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error("not an encrypted backup (bad magic)");
  }
  const salt = header.subarray(BACKUP_MAGIC.length, BACKUP_MAGIC.length + BACKUP_SALT_LENGTH);
  // Exactly the IV — reading "a nice round 64" here once made the IV 40 bytes
  // long, which silently mis-keyed GCM and turned every decrypt into a
  // "wrong passphrase" even when the passphrase was right.
  const iv = header.subarray(BACKUP_MAGIC.length + BACKUP_SALT_LENGTH, HEADER_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", deriveBackupKey(passphrase, salt), iv);

  const hash = createHash("sha256");
  let sizeBytes = 0;
  let pending: Buffer = Buffer.alloc(0);
  // Skip the envelope header across however many chunks it happens to span —
  // a "first chunk" is not guaranteed to hold all 36 bytes.
  let headerToSkip = HEADER_LENGTH;

  const decrypting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        let data = chunk;
        if (headerToSkip > 0) {
          const consumed = Math.min(headerToSkip, data.byteLength);
          headerToSkip -= consumed;
          data = data.subarray(consumed);
        }
        pending = pending.byteLength === 0 ? Buffer.from(data) : Buffer.concat([pending, data]);
        if (pending.byteLength <= BACKUP_TAG_LENGTH) return callback(null, Buffer.alloc(0));
        const emit = pending.subarray(0, pending.byteLength - BACKUP_TAG_LENGTH);
        pending = Buffer.from(pending.subarray(pending.byteLength - BACKUP_TAG_LENGTH));
        const plain = decipher.update(emit);
        hash.update(plain);
        sizeBytes += plain.byteLength;
        callback(null, plain);
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        if (pending.byteLength < BACKUP_TAG_LENGTH) throw new Error("encrypted backup is truncated");
        decipher.setAuthTag(pending);
        const plain = decipher.final();
        hash.update(plain);
        sizeBytes += plain.byteLength;
        callback(null, plain);
      } catch {
        callback(new Error("decryption failed — wrong passphrase or corrupted file"));
      }
    },
  });

  // Same rule as the encrypting half: only remove the destination when this
  // call is the one that created it.
  const handle2 = await fs.open(destPath, "wx", 0o600);
  try {
    await pipeline(
      createReadStream(srcPath),
      decrypting,
      handle2.createWriteStream(),
    );
    await fsyncFile(destPath);
    return { sizeBytes, sha256: hash.digest("hex") };
  } catch (error) {
    await handle2.close().catch(() => {});
    await fs.rm(destPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Whether the first bytes of a file are the POSBKP1 magic (no full read). */
export async function fileHasBackupMagic(filePath: string): Promise<boolean> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const head = Buffer.alloc(BACKUP_MAGIC.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && head.equals(BACKUP_MAGIC);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Copy a file without loading it, refusing to overwrite an existing destination. */
export async function copyFileToNewPath(srcPath: string, destPath: string): Promise<StreamedArtifact> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const counting = hashingPassThrough(hash, (n) => {
    sizeBytes += n;
  });
  // As in the other two pipelines: `wx` plus a cleanup that only ever deletes
  // what this call created.
  const handle = await fs.open(destPath, "wx", 0o600);
  try {
    await pipeline(createReadStream(srcPath), counting, handle.createWriteStream());
    await fsyncFile(destPath);
    return { sizeBytes, sha256: hash.digest("hex") };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(destPath, { force: true }).catch(() => {});
    throw error;
  }
}

