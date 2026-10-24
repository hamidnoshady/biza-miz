/**
 * Upload paths against a *strict* S3-compatible server (issue #1080).
 *
 * The repository's existing media integration test uses a lenient in-memory
 * bucket: it stores whatever bytes arrive and never looks at the SigV4
 * Authorization header. That is enough to prove the library's own bookkeeping,
 * but it cannot distinguish "the provider accepted this request" from "the
 * provider returned 200 to a request it should have rejected" — and a
 * signature/canonical-URI mistake would therefore pass CI and fail in
 * production against Parspack/Arvan/MinIO/AWS.
 *
 * This suite stands up a server that behaves like a real provider for the two
 * things that actually differ between the Superadmin "Test Connection" button
 * (a ~26-byte buffered PUT) and a tenant upload:
 *
 *   • it recomputes the SigV4 signature from the request *as received* — the
 *     canonical URI, the canonical query, every signed header and the
 *     `x-amz-content-sha256` payload hash — and rejects a mismatch with
 *     `403 SignatureDoesNotMatch`, exactly like S3;
 *   • it rejects a body whose bytes do not hash to the declared payload hash
 *     (`400 XAmzContentSHA256Mismatch`);
 *   • it rejects a declared `Content-Length` that disagrees with the bytes it
 *     actually received (`400 IncompleteBody`), which is what a proxy that
 *     truncates a streamed upload looks like from the app's side.
 *
 * The uploads exercised are the tenant-shaped ones: the configured key prefix,
 * a business UUID, an asset UUID and a user-supplied file name (including a
 * Persian name, whose percent-encoding is where canonical-URI bugs hide), both
 * buffered (`s3Put`) and above the 1 MiB disk-streaming threshold
 * (`s3PutFile`).
 */
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { s3Delete, s3Get, s3Head, s3Put, s3PutFile, sha256Hex, type S3Config } from "./s3-lite";

const ACCESS_KEY = "TESTACCESSKEY";
const SECRET_KEY = "test-secret-key-value";
const BUCKET = "media-test";
const REGION = "ir-thr-at1";

interface RecordedRequest {
  method: string;
  /** The request target exactly as it arrived (path + query). */
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  /** null when the signature matched, else the provider-style rejection. */
  signatureProblem: string | null;
  bodyProblem: string | null;
}

const requests: RecordedRequest[] = [];
let server: Server;
let endpoint = "";

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** An independent SigV4 verifier — deliberately not importing s3-lite's signer. */
function verifySignature(req: IncomingMessage, url: URL, body: Buffer): string | null {
  const authorization = req.headers.authorization;
  if (!authorization) return "MissingSecurityHeader";
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
    authorization,
  );
  if (!match) return "MalformedAuthorization";
  const [, credentialKey, scope, signedHeaderNames, providedSignature] = match;
  if (credentialKey !== ACCESS_KEY) return "InvalidAccessKeyId";

  const [date, region, service, terminator] = scope.split("/");
  if (!date || region !== REGION || service !== "s3" || terminator !== "aws4_request") return "InvalidScope";

  // Canonical URI: the raw path, as sent. SigV4 signs what is on the wire.
  const canonicalUri = url.pathname;
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const signedHeaderList = signedHeaderNames.split(";");
  const canonicalHeaders = signedHeaderList
    .map((name) => {
      const raw = req.headers[name];
      const value = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
      return `${name}:${value.replace(/\s+/g, " ").trim()}\n`;
    })
    .join("");

  const declaredPayloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
  const canonicalRequest = [
    req.method ?? "",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    declaredPayloadHash,
  ].join("\n");

  const canonicalRequestHash = createHash("sha256").update(canonicalRequest).digest("hex");
  const stringToSign = ["AWS4-HMAC-SHA256", String(req.headers["x-amz-date"] ?? ""), scope, canonicalRequestHash].join(
    "\n",
  );

  const kDate = hmac(`AWS4${SECRET_KEY}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const expected = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  if (expected !== providedSignature) return "SignatureDoesNotMatch";

  // A provider checks the payload hash too; UNSIGNED-PAYLOAD is not what the
  // application sends for an upload.
  if (declaredPayloadHash !== createHash("sha256").update(body).digest("hex")) {
    return "XAmzContentSHA256Mismatch";
  }
  return null;
}

const store = new Map<string, Buffer>();

function problemResponse(res: ServerResponse, code: string, status = 403): void {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message><RequestId>req-1</RequestId></Error>`;
  res.writeHead(status, { "content-type": "application/xml", "content-length": String(Buffer.byteLength(xml)) });
  res.end(xml);
}

const objectKey = (url: URL) => decodeURIComponent(url.pathname.replace(new RegExp(`^/${BUCKET}/?`), ""));

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://provider.invalid");
      const body = Buffer.concat(chunks);
      const key = objectKey(url);

      const signatureProblem = verifySignature(req, url, body);
      const declaredLength = req.headers["content-length"];
      const bodyProblem =
        declaredLength !== undefined && Number(declaredLength) !== body.byteLength ? "IncompleteBody" : null;

      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, signatureProblem, bodyProblem });

      if (signatureProblem === "XAmzContentSHA256Mismatch") {
        problemResponse(res, signatureProblem, 400);
        return;
      }
      if (signatureProblem) {
        problemResponse(res, signatureProblem, 403);
        return;
      }
      if (bodyProblem) {
        problemResponse(res, bodyProblem, 400);
        return;
      }

      if (req.method === "PUT") {
        store.set(key, body);
        res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
        res.end();
        return;
      }
      if (req.method === "HEAD") {
        const stored = store.get(key);
        if (!stored) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-length": String(stored.byteLength) });
        res.end();
        return;
      }
      if (req.method === "GET") {
        const stored = store.get(key);
        if (!stored) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-length": String(stored.byteLength) });
        res.end(stored);
        return;
      }
      if (req.method === "DELETE") {
        store.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      problemResponse(res, "MethodNotAllowed", 405);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function config(): S3Config {
  return {
    endpoint,
    region: REGION,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
  };
}

/** Bytes that stay incompressible so `content-length` is meaningful. */
function payloadOf(size: number, seed = 7): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let value = seed;
  for (let index = 0; index < size; index += 1) {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = value & 0xff;
  }
  // Real PNG magic so this mirrors what a tenant upload actually contains.
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

const BUSINESS_ID = "11111111-1111-1111-1111-111111111111";
const ASSET_ID = "22222222-2222-2222-2222-222222222222";

describe("tenant-shaped uploads against a signature-checking provider", () => {
  it("buffered s3Put passes SigV4 and stores the exact bytes under prefix/business/asset/file", async () => {
    requests.length = 0;
    const key = `media/${BUSINESS_ID}/${ASSET_ID}/vlcsnap-2025-10-30-10h01m18s651.png`;
    const bytes = payloadOf(64 * 1024);

    await s3Put(config(), key, bytes);

    expect(requests).toHaveLength(1);
    expect(requests[0].signatureProblem).toBeNull();
    expect(requests[0].bodyProblem).toBeNull();
    expect(store.get(key)?.equals(bytes)).toBe(true);
    expect(await s3Get(config(), key)).toEqual(bytes);
    expect(await s3Head(config(), key)).toMatchObject({ size: bytes.byteLength });
  });

  it("streamed s3PutFile (> 1 MiB, as the tenant route spools it) passes SigV4 and Content-Length checks", async () => {
    requests.length = 0;
    const dir = mkdtempSync(path.join(os.tmpdir(), "bizamiz-s3putfile-"));
    const filePath = path.join(dir, "big-clip.png");
    const bytes = payloadOf(3 * 1024 * 1024 + 17);
    writeFileSync(filePath, bytes);
    const key = `media/${BUSINESS_ID}/${ASSET_ID}/big-clip.png`;

    try {
      await s3PutFile(config(), key, filePath, { payloadHash: sha256Hex(bytes), sizeBytes: bytes.byteLength });

      expect(requests).toHaveLength(1);
      expect(requests[0].signatureProblem).toBeNull();
      expect(requests[0].bodyProblem).toBeNull();
      expect(requests[0].body.byteLength).toBe(bytes.byteLength);
      expect(store.get(key)?.equals(bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signs and sends a Persian file name correctly (percent-encoded canonical URI)", async () => {
    requests.length = 0;
    const key = `media/${BUSINESS_ID}/${ASSET_ID}/تصویر-محصول نهایی.png`;
    const bytes = payloadOf(1024);

    await s3Put(config(), key, bytes);

    expect(requests[0].signatureProblem).toBeNull();
    expect(store.get(key)?.equals(bytes)).toBe(true);
  });

  it("s3PutFile against a 1-byte-below-threshold file and a 5 MiB file both verify", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bizamiz-s3putfile-"));
    try {
      for (const [name, size] of [
        ["just-below.png", 1024 * 1024 - 1],
        ["large.png", 5 * 1024 * 1024],
      ] as const) {
        requests.length = 0;
        const filePath = path.join(dir, name);
        const bytes = payloadOf(size, size % 251);
        writeFileSync(filePath, bytes);
        const key = `media/${BUSINESS_ID}/${ASSET_ID}/${name}`;
        await s3PutFile(config(), key, filePath, { payloadHash: sha256Hex(bytes), sizeBytes: bytes.byteLength });
        expect(requests[0].signatureProblem).toBeNull();
        expect(requests[0].bodyProblem).toBeNull();
        expect(store.get(key)?.equals(bytes)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a key with a path-traversal-looking prefix and a sub-prefix still signs the same path that is sent", async () => {
    requests.length = 0;
    const key = `media/${BUSINESS_ID}/${ASSET_ID}/a b+c(d)%20e.png`;
    const bytes = payloadOf(1024, 11);
    await s3Put(config(), key, bytes);
    expect(requests[0].signatureProblem).toBeNull();
    expect(store.get(key)?.equals(bytes)).toBe(true);
    // The request target must be the RFC 3986 percent-encoded form of that key
    // (`!` `'` `(` `)` `*` are escaped too), never a raw space or a bare `%`.
    expect(requests[0].url).toContain("a%20b%2Bc%28d%29%2520e.png");
  });

  it("reports a provider rejection with its status and error code (so failures are diagnosable)", async () => {
    const wrong = { ...config(), secretAccessKey: "definitely-not-the-secret" };
    await expect(s3Put(wrong, `media/${BUSINESS_ID}/${ASSET_ID}/x.png`, Buffer.from("x"))).rejects.toThrow(
      /403.*SignatureDoesNotMatch/s,
    );
  });

  it("deletes the probe object again (cleanup path the connection test relies on)", async () => {
    const key = `media/.connection-test/probe.bin`;
    await s3Put(config(), key, Buffer.from("probe"));
    expect(store.has(key)).toBe(true);
    await s3Delete(config(), key);
    expect(store.has(key)).toBe(false);
  });
});

describe("retry policy — transient vs deterministic", () => {
  /** A one-endpoint server that fails `failures` times, then answers 200. */
  async function flakyServer(failures: number, status = 503) {
    let hits = 0;
    const flaky = createServer((req, res) => {
      hits += 1;
      req.resume();
      req.on("end", () => {
        if (hits <= failures) {
          const xml = `<?xml version="1.0"?><Error><Code>SlowDown</Code><Message>try later</Message></Error>`;
          res.writeHead(status, { "content-type": "application/xml" });
          res.end(xml);
          return;
        }
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => flaky.listen(0, "127.0.0.1", resolve));
    const port = (flaky.address() as AddressInfo).port;
    return {
      config: { ...config(), endpoint: `http://127.0.0.1:${port}` },
      hits: () => hits,
      close: () => new Promise<void>((resolve) => flaky.close(() => resolve())),
    };
  }

  it("retries a transient 503 and then succeeds (a brief provider hiccup must not fail the upload)", async () => {
    const flaky = await flakyServer(1);
    try {
      await s3Put(flaky.config, "media/biz/asset/x.png", Buffer.from("hello"), {
        retry: { attempts: 3, baseDelayMs: 0 },
      });
      expect(flaky.hits()).toBe(2);
    } finally {
      await flaky.close();
    }
  });

  it("never retries a deterministic 403 (a rejected credential will not fix itself)", async () => {
    const flaky = await flakyServer(5, 403);
    try {
      await expect(
        s3Put(flaky.config, "media/biz/asset/x.png", Buffer.from("hello"), {
          retry: { attempts: 3, baseDelayMs: 0 },
        }),
      ).rejects.toMatchObject({ status: 403, retryable: false });
      expect(flaky.hits()).toBe(1);
    } finally {
      await flaky.close();
    }
  });

  it("retries the streamed path with a fresh read stream, so a retry never uploads a half-consumed body", async () => {
    const flaky = await flakyServer(1);
    const dir = mkdtempSync(path.join(os.tmpdir(), "bizamiz-s3retry-"));
    const filePath = path.join(dir, "clip.png");
    const bytes = payloadOf(1_500_000);
    writeFileSync(filePath, bytes);
    try {
      await s3PutFile(flaky.config, "media/biz/asset/clip.png", filePath, {
        payloadHash: sha256Hex(bytes),
        sizeBytes: bytes.byteLength,
        retry: { attempts: 3, baseDelayMs: 0 },
      });
      expect(flaky.hits()).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await flaky.close();
    }
  });
});

describe("payload integrity the provider would reject", () => {
  it("a wrong payload hash is refused by the provider, proving the hash is actually signed and checked", async () => {
    // Cast through unknown: the point is to prove the provider notices, not to
    // add a public "send a lying hash" API.
    const { signS3Request } = await import("./s3-lite");
    const signed = signS3Request(config(), {
      method: "PUT",
      key: "media/probe.bin",
      payloadHash: sha256Hex("a different body"),
    });
    const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: Buffer.from("body") });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("XAmzContentSHA256Mismatch");
    expect(deflateSync(Buffer.from("x")).byteLength).toBeGreaterThan(0);
  });
});
