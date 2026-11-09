import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeTransportFailure,
  parseListObjectsXml,
  presignS3Get,
  s3CopyObject,
  s3GetStream,
  s3Head,
  s3PutFile,
  sha256Hex,
  signS3Request,
  type S3Config,
} from "./s3-lite";

// The pinned signatures below were cross-checked against botocore's
// S3SigV4Auth (the reference implementation) with the same fixed clock,
// credentials, and requests — byte-for-byte identical Authorization headers.
const config: S3Config = {
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "cafe-backups",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2026-07-21T03:30:05Z");

describe("signS3Request", () => {
  it("signs a PUT exactly like the AWS reference implementation", () => {
    const signed = signS3Request(config, {
      method: "PUT",
      key: "pos-backups/pos-backup-20260721-033005.dump.enc",
      payloadHash: sha256Hex(Buffer.from("hello")),
      now,
    });
    expect(signed.url).toBe(
      "https://s3.example.com/cafe-backups/pos-backups/pos-backup-20260721-033005.dump.enc",
    );
    expect(signed.headers["x-amz-date"]).toBe("20260721T033005Z");
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(signed.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260721/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=7b8174c2ad3e9b95e2eb7413993a38dff167826baed42aabf88cfe196bdfe81e",
    );
  });

  it("signs a bucket-level list with sorted, encoded query params", () => {
    const signed = signS3Request(config, {
      method: "GET",
      key: "",
      query: { prefix: "pos-backups/", "list-type": "2" },
      payloadHash: sha256Hex(""),
      now,
    });
    expect(signed.url).toBe("https://s3.example.com/cafe-backups?list-type=2&prefix=pos-backups%2F");
    expect(signed.headers.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260721/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=d27fe8eee2e058d484e8529e818421cfb10a08d384ff7a8d20c27303bd866e20",
    );
  });

  it("percent-encodes key segments but keeps slashes", () => {
    const signed = signS3Request(config, {
      method: "GET",
      key: "a b/c(d)'e*.dump",
      payloadHash: sha256Hex(""),
      now,
    });
    expect(signed.url).toBe("https://s3.example.com/cafe-backups/a%20b/c%28d%29%27e%2A.dump");
  });

  it("changes the signature when the secret changes", () => {
    const a = signS3Request(config, { method: "GET", key: "x", payloadHash: sha256Hex(""), now });
    const b = signS3Request(
      { ...config, secretAccessKey: "other-secret" },
      { method: "GET", key: "x", payloadHash: sha256Hex(""), now },
    );
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });
});

describe("presignS3Get", () => {
  // Cross-checked against boto3's `generate_presigned_url("get_object", ...)`
  // with the same fixed clock, credentials and key — same query params in
  // the same order, byte-for-byte identical X-Amz-Signature.
  it("matches boto3's presigned GET URL exactly", () => {
    const url = presignS3Get(config, "media/business-1/photo.png", 600, now);
    expect(url).toBe(
      "https://s3.example.com/cafe-backups/media/business-1/photo.png?" +
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
        "X-Amz-Credential=AKIDEXAMPLE%2F20260721%2Fus-east-1%2Fs3%2Faws4_request&" +
        "X-Amz-Date=20260721T033005Z&" +
        "X-Amz-Expires=600&" +
        "X-Amz-SignedHeaders=host&" +
        "X-Amz-Signature=606c421ddbca37ebfd4a86e1b12922b2d4e462e28241f906e00f8940e7fe0ca1",
    );
  });

  it("clamps a non-positive expiry to 1 second rather than signing a negative one", () => {
    const url = presignS3Get(config, "k.png", 0, now);
    expect(url).toContain("X-Amz-Expires=1");
  });

  it("floors a fractional expiry", () => {
    const url = presignS3Get(config, "k.png", 599.9, now);
    expect(url).toContain("X-Amz-Expires=599");
  });

  it("percent-encodes the key but keeps its slash", () => {
    const url = presignS3Get(config, "a b/c(d)'e*.png", 60, now);
    expect(url).toContain("/cafe-backups/a%20b/c%28d%29%27e%2A.png?");
  });

  it("changes the signature when the clock moves", () => {
    const later = new Date(now.getTime() + 1000);
    const url = presignS3Get(config, "media/business-1/photo.png", 600, later);
    expect(url).not.toContain("X-Amz-Signature=606c421ddbca37ebfd4a86e1b12922b2d4e462e28241f906e00f8940e7fe0ca1");
  });
});

describe("parseListObjectsXml", () => {
  it("extracts keys, sizes, and continuation tokens", () => {
    const xml = `<?xml version="1.0"?>
      <ListBucketResult>
        <IsTruncated>true</IsTruncated>
        <NextContinuationToken>token&amp;1</NextContinuationToken>
        <Contents>
          <Key>pos-backups/pos-backup-20260720-033001.dump.enc</Key>
          <LastModified>2026-07-20T03:30:10.000Z</LastModified>
          <Size>12345</Size>
        </Contents>
        <Contents>
          <Key>pos-backups/pos-backup-20260721-033001.dump.enc</Key>
          <LastModified>2026-07-21T03:30:11.000Z</LastModified>
          <Size>23456</Size>
        </Contents>
      </ListBucketResult>`;
    expect(parseListObjectsXml(xml)).toEqual({
      objects: [
        {
          key: "pos-backups/pos-backup-20260720-033001.dump.enc",
          size: 12345,
          lastModified: "2026-07-20T03:30:10.000Z",
        },
        {
          key: "pos-backups/pos-backup-20260721-033001.dump.enc",
          size: 23456,
          lastModified: "2026-07-21T03:30:11.000Z",
        },
      ],
      continuationToken: "token&1",
    });
  });

  it("returns no token when the listing is complete", () => {
    expect(parseListObjectsXml("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      objects: [],
      continuationToken: null,
    });
  });
});

describe("streaming S3 operations — s3PutFile, s3GetStream, s3Head, s3CopyObject", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams a file from disk with its precomputed sha256 payload hash", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "s3lite-test-"));
    const filePath = path.join(tmpDir, "video.bin");
    const content = Buffer.from("streamed-video-bytes-0123456789");
    writeFileSync(filePath, content);

    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response("", { status: 200 });
      }),
    );

    try {
      const hash = sha256Hex(content);
      await s3PutFile(config, "media/vid.mp4", filePath, {
        payloadHash: hash,
        sizeBytes: content.byteLength,
        contentType: "video/mp4",
      });
      expect(capturedHeaders["x-amz-content-sha256"]).toBe(hash);
      expect(capturedHeaders["content-length"]).toBe(String(content.byteLength));
      expect(capturedHeaders["content-type"]).toBe("video/mp4");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends Range header on s3GetStream and parses 206 Partial Content metadata", async () => {
    let seenHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 206,
          headers: {
            "content-length": "4",
            "content-range": "bytes 10-13/100",
          },
        });
      }),
    );

    const stream = await s3GetStream(config, "media/clip.mp4", { range: { start: 10, end: 13 } });
    expect(seenHeaders["Range"] ?? seenHeaders["range"]).toBe("bytes=10-13");
    expect(stream).not.toBeNull();
    expect(stream?.status).toBe(206);
    expect(stream?.contentLength).toBe(4);
    expect(stream?.contentRange).toBe("bytes 10-13/100");
  });

  it("reads HEAD size/etag and signs x-amz-copy-source for server-side copies", async () => {
    const calls: Array<{ method?: string; headers?: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ method: init?.method, headers: init?.headers as Record<string, string> });
        if (init?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": "512", etag: '"abc123"' },
          });
        }
        return new Response("<CopyObjectResult><ETag>\"abc123\"</ETag></CopyObjectResult>", { status: 200 });
      }),
    );

    const head = await s3Head(config, "media/a.jpg");
    expect(head).toEqual({ size: 512, etag: "abc123" });

    await s3CopyObject(config, "source-bucket", "media/فایل ۱.jpg", "media/a.jpg");
    expect(calls[1].headers?.["x-amz-copy-source"]).toContain("/source-bucket/media/");
  });
});

describe("virtual-host addressing", () => {
  it("signs the bucket host and tenant URI, preserving endpoint port and base path", () => {
    const signed = signS3Request({ ...config, endpoint: "https://s3.example.com:9443/api", forcePathStyle: false }, {
      method: "PUT", key: "media/business/asset/تصویر 1.png", payloadHash: sha256Hex("png"), now,
    });
    const url = new URL(signed.url);
    expect(url.host).toBe("cafe-backups.s3.example.com:9443");
    expect(signed.headers.host).toBe(url.host);
    expect(url.pathname).toBe(`/api/media/business/asset/${encodeURIComponent("تصویر 1.png")}`);
    expect(signed.headers.Authorization).toContain("SignedHeaders=host;");
  });

  it("uses virtual-host addressing for presigned reads and bucket-level lists too", () => {
    const virtual = { ...config, forcePathStyle: false };
    const read = new URL(presignS3Get(virtual, "media/tenant/asset.png", 60, now));
    expect(read.host).toBe("cafe-backups.s3.example.com");
    expect(read.pathname).toBe("/media/tenant/asset.png");
    const list = new URL(signS3Request(virtual, {
      method: "GET", key: "", query: { "list-type": "2", prefix: "media/" }, payloadHash: sha256Hex(""), now,
    }).url);
    expect(list.pathname).toBe("/");
    expect(list.host).toBe(read.host);
  });

  it("keeps legacy signatures when path-style is explicitly enabled", () => {
    const input = { method: "PUT" as const, key: "media/tenant/file.png", payloadHash: sha256Hex("png"), now };
    expect(signS3Request({ ...config, forcePathStyle: true }, input)).toEqual(signS3Request(config, input));
  });
});

describe("transport failure classification (issue #1296)", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "s3lite-classify-"));
  const bodyPath = path.join(tmpRoot, "artifact.bin");
  const body = Buffer.from("encrypted-dump-bytes");
  writeFileSync(bodyPath, body);

  const cases: Array<{ name: string; error: unknown; code: string | null; label?: string; retryable: boolean }> = [
    {
      // The production failure: Undici's own class carries no code; the reason
      // is one level down. This used to collapse to the label "NetworkError"
      // and be marked non-retryable, so the bounded retries never ran.
      name: "bare `TypeError: fetch failed` with a reset underneath",
      error: new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) }),
      code: "ECONNRESET",
      retryable: true,
    },
    {
      name: "`fetch failed` with nothing recognised underneath",
      error: new TypeError("fetch failed", { cause: new Error("other side closed") }),
      code: null,
      retryable: true,
    },
    {
      name: "`fetch failed` whose cause is itself a wrapper (TLS)",
      error: new TypeError("fetch failed", {
        cause: Object.assign(new Error("tls"), { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }),
      }),
      code: "ECONNRESET",
      retryable: true,
    },
    {
      name: "undici headers timeout",
      error: Object.assign(new Error("timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
      code: "UND_ERR_HEADERS_TIMEOUT",
      retryable: true,
    },
    {
      name: "the client's own AbortSignal.timeout firing",
      error: Object.assign(new Error("aborted"), { name: "AbortError" }),
      code: "TimeoutError",
      // a timeout keeps the human label the tenant UI already shows
      label: "timeout",
      retryable: true,
    },
    {
      // A typo'd host is deterministic at this layer; the bounded ladder is for
      // failures that can succeed unchanged, and this one cannot until the
      // destination is fixed.
      name: "an unknown hostname",
      error: Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
      code: "ENOTFOUND",
      retryable: false,
    },
    {
      name: "a happy-eyeballs AggregateError",
      error: new AggregateError([
        Object.assign(new Error("net"), { code: "ENETUNREACH" }),
        Object.assign(new Error("other"), { code: "EHOSTUNREACH" }),
      ]),
      code: "ENETUNREACH",
      retryable: true,
    },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const entry of cases) {
    it(`classifies ${entry.name} as ${entry.label ?? entry.code ?? "NetworkError"} (retryable=${entry.retryable})`, async () => {
      const reported: Array<{ attempt: number; code: string | null; retryable: boolean; delayMs: number | null }> = [];
      const sleeps: number[] = [];
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw entry.error;
      }));
      await expect(
        s3PutFile(config, "platform-backups/x.dump.enc", bodyPath, {
          payloadHash: sha256Hex(body),
          sizeBytes: body.byteLength,
          retry: {
            attempts: 3,
            baseDelayMs: 10,
            sleep: async (ms) => {
              sleeps.push(ms);
            },
            random: () => 0.5,
            onAttemptFailed: (info) => reported.push(info),
          },
        }),
      ).rejects.toMatchObject({
        name: "S3RequestError",
        providerCode: entry.label ?? entry.code ?? "NetworkError",
        status: null,
        retryable: entry.retryable,
      });
      // A retryable failure walks the whole ladder with a growing delay; a
      // deterministic one stops after the first attempt.
      expect(reported).toHaveLength(entry.retryable ? 3 : 1);
      expect(reported.every((info) => info.code === (entry.label ?? entry.code ?? "NetworkError"))).toBe(true);
      expect(sleeps).toHaveLength(entry.retryable ? 2 : 0);
      if (entry.retryable) expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
    });
  }

  it("describes the chain without leaking a message", () => {
    const description = describeTransportFailure(
      new TypeError("fetch failed: connect to https://user:secret@host refused", {
        cause: Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
      }),
    );
    expect(description).toEqual({ code: "ECONNREFUSED", name: "TypeError", depth: 2 });
    expect(JSON.stringify(description)).not.toContain("secret");
  });

  it("fails fast on a deterministic provider rejection while retrying a 503", async () => {
    const forbidden = vi.fn(async () =>
      new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 }),
    );
    vi.stubGlobal("fetch", forbidden);
    await expect(
      s3PutFile(config, "platform-backups/x.dump.enc", bodyPath, {
        payloadHash: sha256Hex(body),
        sizeBytes: body.byteLength,
        retry: { attempts: 4, sleep: async () => {} },
      }),
    ).rejects.toMatchObject({ status: 403, providerCode: "SignatureDoesNotMatch", retryable: false });
    expect(forbidden).toHaveBeenCalledTimes(1);

    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 });
      return new Response("", { status: 200 });
    }));
    await expect(
      s3PutFile(config, "platform-backups/x.dump.enc", bodyPath, {
        payloadHash: sha256Hex(body),
        sizeBytes: body.byteLength,
        retry: { attempts: 4, sleep: async () => {} },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("reopens the file for every attempt instead of re-sending a consumed stream", async () => {
    const seen: number[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      const bodyInit = init?.body as unknown as { getReader?: () => unknown } | undefined;
      // The body must be a fresh stream each time, not a spent one.
      expect(typeof bodyInit?.getReader).toBe("function");
      if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      seen.push(calls);
      return new Response("", { status: 200 });
    }));
    await s3PutFile(config, "platform-backups/x.dump.enc", bodyPath, {
      payloadHash: sha256Hex(body),
      sizeBytes: body.byteLength,
      retry: { attempts: 2, sleep: async () => {} },
    });
    expect(seen).toEqual([2]);
  });
});
