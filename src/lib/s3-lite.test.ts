import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
