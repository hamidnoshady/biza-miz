/**
 * «آزمایش اتصال» must be able to fail (issue #1080).
 *
 * The old probe could only ever say "wrote a 25-byte object and deleted it",
 * which is why it was green while tenant uploads failed. This suite drives the
 * new capability check through every way it can go red — incomplete config,
 * a disabled library, an unwritable temp directory, a rejected credential, a
 * read-back whose bytes differ, a broken streamed path, and a bucket that
 * accepts writes but refuses deletes — using injected I/O so each path is
 * provable without a network.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_CONFIG, type MediaStorageConfig } from "./media";
import { HEALTH_STREAM_PROBE_BYTES, healthProbeKey, runMediaStorageHealthCheck } from "./media-storage-health";
import { S3RequestError } from "./s3-lite";

function config(over: Partial<MediaStorageConfig> = {}): MediaStorageConfig {
  return {
    ...DEFAULT_MEDIA_CONFIG,
    enabled: true,
    endpoint: "https://s3.parspack.com",
    region: "ir-thr-at1",
    bucket: "media-bucket",
    keyPrefix: "media/",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret-value",
    ...over,
  };
}

function s3(status: number, providerCode: string, operation: "put" | "get" | "delete" | "head" = "put") {
  return new S3RequestError({
    message: `op: HTTP ${status} ${providerCode}`,
    operation,
    status,
    providerCode,
    key: "media/probe.bin",
    retryable: status >= 500 || status === 429,
  });
}

/** An in-memory bucket with just enough behaviour to prove the steps. */
function fakeBucket(overrides: {
  failPut?: (key: string) => unknown;
  failPutFile?: (key: string) => unknown;
  failGet?: (key: string) => unknown;
  failDelete?: (key: string) => unknown;
  tamperRead?: boolean;
  tempError?: unknown;
} = {}) {
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    deps: {
      put: async (key: string, body: Buffer) => {
        if (overrides.failPut) throw overrides.failPut(key);
        objects.set(key, body);
      },
      putFile: async (key: string, _filePath: string, opts: { payloadHash: string; sizeBytes: number }) => {
        if (overrides.failPutFile) throw overrides.failPutFile(key);
        // Stand-in for the disk stream: the same bytes the temp file holds.
        const stashed = objects.get("__temp__");
        if (!stashed || stashed.byteLength !== opts.sizeBytes) throw new Error("temp_missing");
        objects.set(key, stashed);
      },
      get: async (key: string) => {
        if (overrides.failGet) throw overrides.failGet(key);
        const stored = objects.get(key);
        if (!stored) throw s3(404, "NoSuchKey", "get");
        return overrides.tamperRead ? Buffer.concat([stored, Buffer.from("tampered")]) : stored;
      },
      head: async (key: string) => {
        const stored = objects.get(key);
        return stored ? { size: stored.byteLength, etag: null } : null;
      },
      delete: async (key: string) => {
        if (overrides.failDelete) throw overrides.failDelete(key);
        deleted.push(key);
        objects.delete(key);
      },
      writeTempFile: async (bytes: Buffer) => {
        if (overrides.tempError) throw overrides.tempError;
        objects.set("__temp__", bytes);
        return "/tmp/fake-probe.bin";
      },
      removeTempFile: async () => {
        objects.delete("__temp__");
      },
    },
  };
}

const OPTIONS = { now: 1_700_000_000_000, probeId: "abcdef123456", streamProbeBytes: 1_100_000 };

describe("runMediaStorageHealthCheck", () => {
  it("proves write, read-back with SHA-256, the >1 MiB streamed path, and delete-with-confirmation", async () => {
    const bucket = fakeBucket();
    const result = await runMediaStorageHealthCheck(config(), { ...OPTIONS, deps: bucket.deps });

    expect(result.ok).toBe(true);
    expect(result.testedSavedConfiguration).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.capabilities).toEqual({
      write: true,
      readBack: true,
      integrity: true,
      streamedUpload: true,
      delete: true,
    });
    expect(result.steps.map((step) => step.id)).toEqual([
      "config",
      "temp_file",
      "buffered_write",
      "buffered_read",
      "streamed_write",
      "streamed_read",
      "cleanup",
    ]);
    // Both probes are gone and the temp file is removed — nothing left behind.
    expect(bucket.objects.size).toBe(0);
    expect(result.leftoverKeys).toEqual([]);
    // Nothing in the report is a secret or a signed URL.
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("AKIA_TEST");
  });

  it("uses tenant-shaped keys under the configured prefix (business UUID / asset UUID / file)", async () => {
    const bucket = fakeBucket();
    await runMediaStorageHealthCheck(config({ keyPrefix: "tenant-media/" }), { ...OPTIONS, deps: bucket.deps });
    const keys = [...bucket.deleted];
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key.startsWith("tenant-media/.health/")).toBe(true);
      // {business}/{asset}/{file}, each segment in the same shape a real upload uses.
      const [owner, asset, file] = key.slice("tenant-media/.health/".length).split("/");
      expect(owner).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(asset).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(file).toMatch(/\.bin$/);
    }
    expect(healthProbeKey("media/", "1", "x.bin")).toBe(
      "media/.health/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001/x.bin",
    );
  });

  it("fails, with an actionable message, when the saved configuration is incomplete", async () => {
    const bucket = fakeBucket();
    const result = await runMediaStorageHealthCheck(config({ secretAccessKey: "" }), { ...OPTIONS, deps: bucket.deps });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe("incomplete_config");
    expect(result.failure?.message).toContain("کامل نیست");
    expect(result.steps.map((step) => step.id)).toEqual(["config"]);
    // Nothing was written to the bucket for a configuration that cannot work.
    expect(bucket.objects.size).toBe(0);
  });

  it("reports a stored-but-disabled library instead of a false green", async () => {
    const bucket = fakeBucket();
    const result = await runMediaStorageHealthCheck(config({ enabled: false }), { ...OPTIONS, deps: bucket.deps });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe("storage_disabled");
    expect(result.enabled).toBe(false);
  });

  it("fails at the temp-file step when the deployment cannot spool an upload", async () => {
    const bucket = fakeBucket({ tempError: Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }) });
    const result = await runMediaStorageHealthCheck(config(), { ...OPTIONS, deps: bucket.deps });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatchObject({ code: "temp_file_unwritable", stage: "temp_file" });
    expect(result.capabilities.write).toBe(false);
    expect(result.steps.find((step) => step.id === "temp_file")).toMatchObject({ ok: false });
  });

  it("distinguishes a rejected credential (403) from an outage (503)", async () => {
    const rejected = await runMediaStorageHealthCheck(config(), {
      ...OPTIONS,
      deps: fakeBucket({ failPut: () => s3(403, "SignatureDoesNotMatch") }).deps,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.failure).toMatchObject({ code: "storage_credentials_rejected", stage: "s3_upload" });
    expect(rejected.steps.find((step) => step.id === "buffered_write")).toMatchObject({
      ok: false,
      providerStatus: 403,
      providerCode: "SignatureDoesNotMatch",
    });
    // Because the write never landed, no read/stream step is claimed.
    expect(rejected.capabilities.readBack).toBe(false);

    const outage = await runMediaStorageHealthCheck(config(), {
      ...OPTIONS,
      deps: fakeBucket({ failPut: () => s3(503, "SlowDown") }).deps,
    });
    expect(outage.failure?.code).toBe("storage_unavailable");
  });

  it("fails verification when read-back bytes differ from what was written", async () => {
    const result = await runMediaStorageHealthCheck(config(), {
      ...OPTIONS,
      deps: fakeBucket({ tamperRead: true }).deps,
    });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe("probe_content_mismatch");
    expect(result.capabilities.write).toBe(true);
    expect(result.capabilities.integrity).toBe(false);
  });

  it("fails the streamed write while leaving the buffered capabilities proven", async () => {
    const result = await runMediaStorageHealthCheck(config(), {
      ...OPTIONS,
      deps: fakeBucket({ failPutFile: () => s3(400, "MalformedChunkedBody") }).deps,
    });
    expect(result.ok).toBe(false);
    expect(result.capabilities).toMatchObject({ write: true, readBack: true, streamedUpload: false });
    expect(result.steps.find((step) => step.id === "streamed_write")).toMatchObject({ ok: false });
  });

  it("does not report success when the probes cannot be deleted", async () => {
    const bucket = fakeBucket({ failDelete: () => s3(403, "AccessDenied", "delete") });
    const result = await runMediaStorageHealthCheck(config(), { ...OPTIONS, deps: bucket.deps });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe("cleanup_failed");
    expect(result.capabilities.delete).toBe(false);
    // The operator is told exactly which keys to remove by hand.
    expect(result.leftoverKeys).toHaveLength(2);
    for (const key of result.leftoverKeys) expect(key.startsWith("media/.health/")).toBe(true);
  });

  it("exercises a streamed probe larger than the tenant route's 1 MiB spool threshold", () => {
    expect(HEALTH_STREAM_PROBE_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
