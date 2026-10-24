/**
 * «آزمایش اتصال» — what the Superadmin button actually proves (issue #1080).
 *
 * The previous probe wrote a 25-byte object through `s3Put` and deleted it. It
 * reported success while tenant uploads were failing, because the two paths are
 * not the same request:
 *
 *   • a tenant upload keys the object as `{prefix}{businessId}/{assetId}/{file}`
 *     (tenant-shaped, percent-encoded, user-named) rather than
 *     `{prefix}connection-test/{ts}.txt`;
 *   • every upload above 1 MiB is spooled to a temp file and streamed from disk
 *     (`s3PutFile`) instead of sent as an in-memory buffer;
 *   • an upload must be readable back, not merely accepted.
 *
 * So a probe that only writes a tiny buffer can be green while the deployment
 * cannot upload anything a tenant actually picks. This check exercises the real
 * capabilities in order — spool to disk, buffered write, read-back with a
 * SHA-256 comparison, a >1 MiB streamed write, streamed read-back, and delete
 * with a HEAD that confirms the object is gone — and it does so without
 * creating or touching any tenant media record.
 *
 * It always uses the SAVED configuration (the same `platform_media_config` row
 * every tenant request reads); the console tells the operator to save first
 * rather than silently testing an unsaved draft.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeKeyPrefix, type MediaStorageConfig } from "./media";
import {
  classifyMediaFailure,
  mediaFailureMessage,
  MediaStorageFailure,
  type MediaFailureStage,
} from "./media-errors";
import { s3Delete, s3Get, s3Head, s3Put, s3PutFile } from "./s3-lite";

/** Above the tenant route's 1 MiB spool threshold, so the streamed path runs. */
export const HEALTH_STREAM_PROBE_BYTES = 1_250_000;

const BUFFERED_PROBE_TEXT = "biza-miz media health probe — buffered path";

export type MediaHealthStepId =
  | "config"
  | "temp_file"
  | "buffered_write"
  | "buffered_read"
  | "streamed_write"
  | "streamed_read"
  | "cleanup";

export interface MediaHealthStep {
  id: MediaHealthStepId;
  /** Persian label shown next to the tick/cross. */
  label: string;
  ok: boolean;
  durationMs: number;
  providerStatus: number | null;
  providerCode: string | null;
  /** Redacted, safe to display. */
  detail: string | null;
}

export interface MediaStorageHealthResult {
  ok: boolean;
  /** Always true: the check reads the stored `platform_media_config` row. */
  testedSavedConfiguration: true;
  enabled: boolean;
  /** Host only — never credentials, never a signed URL. */
  endpointHost: string | null;
  bucket: string;
  keyPrefix: string;
  steps: MediaHealthStep[];
  capabilities: {
    write: boolean;
    readBack: boolean;
    integrity: boolean;
    streamedUpload: boolean;
    delete: boolean;
  };
  /** Probe keys the check could not delete (operators can remove them by hand). */
  leftoverKeys: string[];
  failure: { code: string; stage: MediaFailureStage; message: string } | null;
}

/** Injectable I/O so every failure path is unit-testable without a network. */
export interface MediaStorageHealthDeps {
  put: (key: string, body: Buffer, contentType?: string) => Promise<void>;
  putFile: (key: string, filePath: string, opts: { payloadHash: string; sizeBytes: number }) => Promise<void>;
  get: (key: string) => Promise<Buffer>;
  head: (key: string) => Promise<{ size: number; etag: string | null } | null>;
  delete: (key: string) => Promise<void>;
  writeTempFile: (bytes: Buffer) => Promise<string>;
  removeTempFile: (filePath: string) => Promise<void>;
}

export interface MediaStorageHealthOptions {
  now?: number;
  /** Random but stable within one run; tests pin it. */
  probeId?: string;
  streamProbeBytes?: number;
  deps?: Partial<MediaStorageHealthDeps>;
}

const STEP_LABELS: Record<MediaHealthStepId, string> = {
  config: "خواندن پیکربندی ذخیره‌شده",
  temp_file: "ساخت فایل موقت روی سرور (مسیر بارگذاری‌های بزرگ)",
  buffered_write: "نوشتن آزمایشی حجم کوچک در باکت",
  buffered_read: "خواندن مجدد و مقایسهٔ دقیق محتوا (SHA-256)",
  streamed_write: "بارگذاری جریانی بیش از ۱ مگابایت از دیسک",
  streamed_read: "خواندن مجدد فایل جریانی و مقایسهٔ محتوا",
  cleanup: "پاکسازی فایل‌های آزمایشی و تأیید حذف",
};

function defaultDeps(config: MediaStorageConfig): MediaStorageHealthDeps {
  const s3 = {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
  return {
    put: (key, body, contentType) => s3Put(s3, key, body, { contentType }),
    putFile: (key, filePath, opts) => s3PutFile(s3, key, filePath, opts),
    get: (key) => s3Get(s3, key),
    head: (key) => s3Head(s3, key),
    delete: (key) => s3Delete(s3, key),
    writeTempFile: async (bytes) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "bizamiz-media-health-"));
      const filePath = path.join(dir, "probe.bin");
      await writeFile(filePath, bytes, { mode: 0o600 });
      return filePath;
    },
    removeTempFile: async (filePath) => {
      await rm(path.dirname(filePath), { recursive: true, force: true });
    },
  };
}

function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).host || null;
  } catch {
    return null;
  }
}

/** A tenant-shaped key: UUID business folder / UUID asset folder / file. */
export function healthProbeKey(prefix: string, probeId: string, name: string): string {
  const businessShape = "00000000-0000-4000-8000-000000000000";
  const assetShape = `00000000-0000-4000-8000-${probeId.padStart(12, "0").slice(-12)}`;
  // The leading `.` keeps the orphan scanner (`runMediaOrphanReconcileScan`)
  // away from a probe that is mid-flight, exactly as it skips `.migration-probe-*`.
  return `${normalizeKeyPrefix(prefix)}.health/${businessShape}/${assetShape}/${name}`;
}

/**
 * Run the full capability check. Never throws: every failure is reported as a
 * step plus one classified `failure` so the console renders one clear sentence.
 */
export async function runMediaStorageHealthCheck(
  config: MediaStorageConfig,
  options: MediaStorageHealthOptions = {},
): Promise<MediaStorageHealthResult> {
  const deps = { ...defaultDeps(config), ...(options.deps ?? {}) };
  const now = options.now ?? Date.now();
  const probeId = options.probeId ?? String(now % 1_000_000_000);
  const streamBytes = options.streamProbeBytes ?? HEALTH_STREAM_PROBE_BYTES;
  const steps: MediaHealthStep[] = [];
  const leftoverKeys: string[] = [];
  let failure: MediaStorageHealthResult["failure"] = null;

  const result = (): MediaStorageHealthResult => ({
    ok: steps.length > 0 && steps.every((step) => step.ok) && failure === null,
    testedSavedConfiguration: true,
    enabled: config.enabled,
    endpointHost: hostOf(config.endpoint),
    bucket: config.bucket,
    keyPrefix: normalizeKeyPrefix(config.keyPrefix),
    steps,
    capabilities: {
      write: Boolean(steps.find((s) => s.id === "buffered_write")?.ok),
      readBack: Boolean(steps.find((s) => s.id === "buffered_read")?.ok),
      integrity: Boolean(steps.find((s) => s.id === "buffered_read")?.ok),
      streamedUpload: Boolean(steps.find((s) => s.id === "streamed_write")?.ok && steps.find((s) => s.id === "streamed_read")?.ok),
      delete: Boolean(steps.find((s) => s.id === "cleanup")?.ok),
    },
    leftoverKeys,
    failure,
  });

  /** Runs one step, records it, and reports whether the check should continue. */
  async function step(
    id: MediaHealthStepId,
    run: () => Promise<{ detail?: string | null } | void>,
  ): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const outcome = await run();
      steps.push({
        id,
        label: STEP_LABELS[id],
        ok: true,
        durationMs: Date.now() - startedAt,
        providerStatus: null,
        providerCode: null,
        detail: (outcome as { detail?: string | null } | void)?.detail ?? null,
      });
      return true;
    } catch (error) {
      const classified = classifyMediaFailure(error);
      steps.push({
        id,
        label: STEP_LABELS[id],
        ok: false,
        durationMs: Date.now() - startedAt,
        providerStatus: classified.providerStatus,
        providerCode: classified.providerCode,
        detail: classified.detail || null,
      });
      // The FIRST failure is what the operator needs to fix; later steps that
      // fail as a consequence must not overwrite it.
      if (!failure) {
        failure = {
          code: classified.code,
          stage: classified.stage,
          message: mediaFailureMessage(classified.code),
        };
      }
      return false;
    }
  }

  const incomplete =
    !config.endpoint.trim() || !config.bucket.trim() || !config.accessKeyId.trim() || !config.secretAccessKey;
  const configOk = await step("config", async () => {
    if (incomplete) {
      throw new MediaStorageFailure({ stage: "config", code: "incomplete_config", status: 400 });
    }
    if (!config.enabled) {
      throw new MediaStorageFailure({ stage: "config", code: "storage_disabled", status: 409 });
    }
    return { detail: `ناحیه: ${config.region} — باکت: ${config.bucket}` };
  });
  if (!configOk) return result();

  const bufferedKey = healthProbeKey(config.keyPrefix, probeId, `probe-${probeId}.bin`);
  const streamedKey = healthProbeKey(config.keyPrefix, probeId, `probe-${probeId}-stream.bin`);
  const bufferedBody = Buffer.from(`${BUFFERED_PROBE_TEXT}:${probeId}`);
  const bufferedSha = createHash("sha256").update(bufferedBody).digest("hex");
  const streamBody = Buffer.alloc(streamBytes);
  for (let index = 0; index < streamBody.length; index += 1) streamBody[index] = (index * 31 + 7) & 0xff;
  const streamSha = createHash("sha256").update(streamBody).digest("hex");

  let tempFilePath: string | null = null;
  const tempOk = await step("temp_file", async () => {
    tempFilePath = await deps.writeTempFile(streamBody);
    return { detail: `فایل آزمایشی ${(streamBytes / 1024).toFixed(0)} کیلوبایتی روی دیسک ساخته شد.` };
  });
  if (!tempOk) {
    // Without a spool file the streamed path cannot be measured; still clean up.
    await cleanup(bufferedKey, streamedKey, null);
    return result();
  }

  const writeOk = await step("buffered_write", async () => {
    await deps.put(bufferedKey, bufferedBody, "application/octet-stream");
    return { detail: `کلید: ${bufferedKey}` };
  });

  if (writeOk) {
    await step("buffered_read", async () => {
      const readBack = await deps.get(bufferedKey);
      const readSha = createHash("sha256").update(readBack).digest("hex");
      if (readBack.byteLength !== bufferedBody.byteLength || readSha !== bufferedSha) {
        throw new MediaStorageFailure({ stage: "s3_read", code: "probe_content_mismatch", status: 502 });
      }
      const head = await deps.head(bufferedKey);
      if (!head || head.size !== bufferedBody.byteLength) {
        throw new MediaStorageFailure({ stage: "s3_read", code: "probe_head_mismatch", status: 502 });
      }
      return { detail: "محتوا و اندازه دقیقاً یکسان بود." };
    });
  }

  const streamWriteOk = await step("streamed_write", async () => {
    if (!tempFilePath) {
      throw new MediaStorageFailure({ stage: "temp_file", code: "temp_file_unreadable", status: 507 });
    }
    await deps.putFile(streamedKey, tempFilePath, { payloadHash: streamSha, sizeBytes: streamBody.byteLength });
    return { detail: `کلید: ${streamedKey}` };
  });

  if (streamWriteOk) {
    await step("streamed_read", async () => {
      const readBack = await deps.get(streamedKey);
      const readSha = createHash("sha256").update(readBack).digest("hex");
      if (readBack.byteLength !== streamBody.byteLength || readSha !== streamSha) {
        throw new MediaStorageFailure({ stage: "s3_read", code: "stream_probe_content_mismatch", status: 502 });
      }
      return { detail: `${(streamBody.byteLength / 1024).toFixed(0)} کیلوبایت جریانی سالم خوانده شد.` };
    });
  }

  await cleanup(bufferedKey, streamedKey, tempFilePath);
  return result();

  /**
   * Delete both probes and *prove* they are gone. A failed cleanup is a real
   * result — it means the deployment cannot delete objects, which turns every
   * future failed upload into an unreferenced object — so it fails the check
   * even when every read succeeded.
   */
  async function cleanup(buffered: string, streamed: string, temp: string | null): Promise<void> {
    await step("cleanup", async () => {
      const problems: string[] = [];
      for (const key of [buffered, streamed]) {
        try {
          await deps.delete(key);
        } catch (error) {
          leftoverKeys.push(key);
          const classified = classifyMediaFailure(error);
          problems.push(`${classified.code}`);
          continue;
        }
        try {
          const head = await deps.head(key);
          if (head) {
            leftoverKeys.push(key);
            problems.push("probe_still_present");
          }
        } catch (error) {
          const classified = classifyMediaFailure(error);
          problems.push(`head_after_delete_failed:${classified.code}`);
        }
      }
      if (temp) await deps.removeTempFile(temp).catch(() => {});
      if (problems.length > 0) {
        throw new MediaStorageFailure({
          stage: "s3_upload",
          code: "cleanup_failed",
          status: 502,
          message: `cleanup_failed:${problems.join(",")}`,
        });
      }
      return { detail: "هر دو فایل آزمایشی حذف و نبودشان با HEAD تأیید شد." };
    });
    if (temp) await deps.removeTempFile(temp).catch(() => {});
  }
}

/** Fresh probe identifiers are random per run; exported for the console's retry. */
export function newHealthProbeId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}
