/**
 * Phase 10 — minimal S3-compatible client for cloud backups.
 *
 * Deliberately not the AWS SDK: backups need exactly four operations (PUT,
 * GET, DELETE, ListObjectsV2) against any S3-compatible endpoint (AWS S3,
 * ArvanCloud, Backblaze B2, a LAN MinIO on a NAS, …), and the whole SigV4
 * dance fits in this file. Requests are path-style (`endpoint/bucket/key`)
 * because that's the form every compatible provider accepts.
 *
 * The signing half is pure (deterministic given a fixed clock) and unit
 * tested in s3-lite.test.ts; only the four `s3*` functions do network I/O.
 */
import { createHash, createHmac } from "node:crypto";

export interface S3Config {
  /** https://host[:port] — no trailing slash, no bucket */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const S3_REQUEST_TIMEOUT_MS = 120 * 1000;

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Object keys keep their `/` separators; every segment is encoded. */
function encodeKeyPath(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}

/** 20260721T033005Z */
function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface S3RequestInput {
  method: "GET" | "PUT" | "DELETE";
  /** object key, or "" for bucket-level requests (list) */
  key: string;
  query?: Record<string, string>;
  /** hex sha-256 of the request body ("" body = sha of empty string) */
  payloadHash: string;
  now?: Date;
}

export interface SignedS3Request {
  url: string;
  headers: Record<string, string>;
}

/**
 * AWS Signature Version 4 over a path-style S3 request. Exposed (rather than
 * inlined into the fetch helpers) so the test can pin the exact canonical
 * request and signature for a fixed clock.
 */
export function signS3Request(config: S3Config, input: S3RequestInput): SignedS3Request {
  const now = input.now ?? new Date();
  const dateTime = amzDate(now); // 20260721T033005Z
  const date = dateTime.slice(0, 8);

  const url = new URL(config.endpoint);
  const host = url.host;
  const basePath = url.pathname.replace(/\/+$/, "");
  const path = `${basePath}/${rfc3986(config.bucket)}${input.key ? `/${encodeKeyPath(input.key)}` : ""}`;

  const canonicalQuery = Object.entries(input.query ?? {})
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": dateTime,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", dateTime, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    url: `${url.protocol}//${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * A time-limited GET URL an unrelated third party can fetch directly from
 * the bucket — no Authorization header, no server round-trip. SigV4's
 * "presigned URL" variant: the same signature, but the pieces that normally
 * live in headers (`x-amz-date`, `x-amz-content-sha256`, the credential
 * scope) move into the query string instead, because the caller issuing the
 * eventual GET (a WordPress site's `media_sideload_image`, not this app)
 * cannot be handed custom headers to send.
 *
 * The one difference from `signS3Request`'s canonical request: the payload
 * hash is the literal string `UNSIGNED-PAYLOAD` (SigV4's documented value
 * for a presigned request with no body to hash), and `host` is the only
 * signed header.
 */
export function presignS3Get(config: S3Config, key: string, expiresSeconds: number, now: Date = new Date()): string {
  const dateTime = amzDate(now);
  const date = dateTime.slice(0, 8);
  const scope = `${date}/${config.region}/s3/aws4_request`;

  const url = new URL(config.endpoint);
  const host = url.host;
  const basePath = url.pathname.replace(/\/+$/, "");
  const path = `${basePath}/${rfc3986(config.bucket)}/${encodeKeyPath(key)}`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": dateTime,
    "X-Amz-Expires": String(Math.max(1, Math.floor(expiresSeconds))),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = ["GET", path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", dateTime, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return `${url.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function unescapeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => XML_ENTITIES[m] ?? m);
}

/**
 * Just enough ListObjectsV2 XML parsing for backup keys (which we name
 * ourselves — no exotic characters). Pure, unit tested.
 */
export function parseListObjectsXml(xml: string): { objects: S3Object[]; continuationToken: string | null } {
  const objects: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1];
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (!key) continue;
    objects.push({
      key: unescapeXml(key),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
      lastModified: /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? "",
    });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, continuationToken: truncated && token ? unescapeXml(token) : null };
}

async function s3Fetch(config: S3Config, input: S3RequestInput, body?: Buffer): Promise<Response> {
  const signed = signS3Request(config, input);
  const res = await fetch(signed.url, {
    method: input.method,
    headers: signed.headers,
    body: body as BodyInit | undefined,
    signal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS),
  });
  return res;
}

async function throwOnError(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const text = (await res.text().catch(() => "")).slice(0, 300);
  throw new Error(`${what}: HTTP ${res.status}${text ? ` — ${text}` : ""}`);
}

export async function s3Put(config: S3Config, key: string, body: Buffer): Promise<void> {
  const res = await s3Fetch(config, { method: "PUT", key, payloadHash: sha256Hex(body) }, body);
  await throwOnError(res, `upload ${key}`);
}

export async function s3Get(config: S3Config, key: string): Promise<Buffer> {
  const res = await s3Fetch(config, { method: "GET", key, payloadHash: sha256Hex("") });
  await throwOnError(res, `download ${key}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload a file without loading it (issue #807). The payload hash SigV4 signs
 * is still the sha256 of the whole object — computed by the caller while it
 * wrote the file — but the body is a stream, so a multi-gigabyte artifact costs
 * a socket buffer rather than that much RAM. `Content-Length` is sent
 * explicitly so the request is not chunked (S3's plain chunked PUT would
 * require aws-chunked signing).
 */
export async function s3PutFile(
  config: S3Config,
  key: string,
  filePath: string,
  opts: { payloadHash: string; sizeBytes: number },
): Promise<void> {
  const signed = signS3Request(config, { method: "PUT", key, payloadHash: opts.payloadHash });
  const { createReadStream } = await import("node:fs");
  const { Readable } = await import("node:stream");
  const res = await fetch(signed.url, {
    method: "PUT",
    headers: { ...signed.headers, "content-length": String(opts.sizeBytes) },
    body: Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit,
    // undici requires this explicitly for a streamed request body.
    duplex: "half",
    signal: AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS),
  } as RequestInit & { duplex: "half" });
  await throwOnError(res, `upload ${key}`);
}

/**
 * Download an object straight to a file, enforcing a size cap *while* the bytes
 * arrive (a lying or absent content-length cannot fill the disk). Returns the
 * received byte count and its sha256 — computed over what actually landed, not
 * what the header claimed.
 */
export async function s3GetToFile(
  config: S3Config,
  key: string,
  filePath: string,
  opts: { maxBytes?: number } = {},
): Promise<{ sizeBytes: number; sha256: string }> {
  const res = await s3Fetch(config, { method: "GET", key, payloadHash: sha256Hex("") });
  await throwOnError(res, `download ${key}`);
  const maxBytes = opts.maxBytes ?? PLATFORM_S3_DOWNLOAD_LIMIT;
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`download ${key}: artifact_too_large`);
  if (!res.body) throw new Error(`download ${key}: empty_body`);

  const { createHash } = await import("node:crypto");
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const hash = createHash("sha256");
  let total = 0;
  const counting = new (await import("node:stream")).Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maxBytes) return callback(new Error(`download ${key}: artifact_too_large`));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    res.body as unknown as NodeJS.ReadableStream,
    counting,
    createWriteStream(filePath, { mode: 0o600 }),
  );
  return { sizeBytes: total, sha256: hash.digest("hex") };
}

/** Ceiling for a streamed object download; overridable per call. */
export const PLATFORM_S3_DOWNLOAD_LIMIT = 8 * 1024 * 1024 * 1024;

export async function s3Delete(config: S3Config, key: string): Promise<void> {
  const res = await s3Fetch(config, { method: "DELETE", key, payloadHash: sha256Hex("") });
  await throwOnError(res, `delete ${key}`);
}

/** All objects under a prefix (follows continuation tokens). */
export async function s3List(config: S3Config, prefix: string): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let continuationToken: string | null = null;
  do {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const res = await s3Fetch(config, { method: "GET", key: "", query, payloadHash: sha256Hex("") });
    await throwOnError(res, `list ${prefix}`);
    const page = parseListObjectsXml(await res.text());
    objects.push(...page.objects);
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return objects;
}
