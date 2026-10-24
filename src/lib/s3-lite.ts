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
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  /** object key, or "" for bucket-level requests (list) */
  key: string;
  query?: Record<string, string>;
  /** hex sha-256 of the request body ("" body = sha of empty string) */
  payloadHash: string;
  extraHeaders?: Record<string, string>;
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
  if (input.extraHeaders) {
    for (const [k, v] of Object.entries(input.extraHeaders)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
    }
  }
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

// ---------------------------------------------------------------------------
// Typed failures, redaction, retries (issue #1080)
// ---------------------------------------------------------------------------
//
// Everything below exists because a failed tenant upload used to reach the
// tenant UI as one generic «ذخیره در فضای ابری ناموفق بود» with no way to tell a
// wrong key from a rejected signature, a 503 from a truncated stream, or a
// provider timeout from a full disk. A caller now gets a typed error with the
// HTTP status, the provider's own `<Code>`, the operation and key, and whether
// retrying could possibly help — while the message stays free of anything that
// must not reach a log or a screen.

export type S3Operation = "put" | "get" | "delete" | "head" | "list" | "copy";

export class S3RequestError extends Error {
  readonly operation: S3Operation;
  /** HTTP status from the provider, or null for a transport/timeout failure. */
  readonly status: number | null;
  /** The provider's `<Code>` (or a transport code such as `NetworkError`). */
  readonly providerCode: string | null;
  /** Object key (never credentials, never signed headers). */
  readonly key: string;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    operation: S3Operation;
    status: number | null;
    providerCode: string | null;
    key: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "S3RequestError";
    this.operation = input.operation;
    this.status = input.status;
    this.providerCode = input.providerCode;
    this.key = input.key;
    this.retryable = input.retryable;
  }
}

/**
 * Strip request-signing material from text that is about to be logged or
 * returned as a diagnostic. Provider error bodies are usually harmless, but a
 * misconfigured gateway can echo the Authorization header or a signed query
 * back — and those are exactly the strings that must never be stored.
 */
export function redactS3Detail(text: string): string {
  return text
    .replace(/AWS4-HMAC-SHA256[^,"'<>\n]*/gi, "AWS4-HMAC-SHA256 [redacted]")
    .replace(/Signature=[0-9a-f]{8,}/gi, "Signature=[redacted]")
    .replace(/X-Amz-Signature=[0-9a-f]{8,}/gi, "X-Amz-Signature=[redacted]")
    .replace(/X-Amz-Credential=[^&"'\s]+/gi, "X-Amz-Credential=[redacted]")
    .replace(/AWSAccessKeyId=[^&"'\s]+/gi, "AWSAccessKeyId=[redacted]")
    .replace(/(Authorization|authorization)(["']?\s*[:=]\s*)["']?[^"',\n]+/g, "$1$2[redacted]");
}

/** Status codes that are worth retrying: the request may succeed unchanged. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Transport failures that can be transient (a dropped socket, not a typo'd host). */
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "TimeoutError",
]);

function transportCodeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; name?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return "TimeoutError";
  if (candidate.cause && typeof candidate.cause === "object") {
    const cause = candidate.cause as { code?: unknown; name?: unknown };
    if (typeof cause.code === "string") return cause.code;
    if (cause.name === "TimeoutError") return "TimeoutError";
  }
  return null;
}

/** The provider's `<Code>…</Code>` from an S3 XML error body, when present. */
export function providerCodeFromXml(text: string): string | null {
  return /<Code>([\s\S]{1,80}?)<\/Code>/.exec(text)?.[1]?.trim() || null;
}

/**
 * Read the failing response into a typed `S3RequestError`. The body is read at
 * most once and truncated; the message keeps the status and the provider code
 * so a support engineer can tell 403 `SignatureDoesNotMatch` from 503
 * `SlowDown` at a glance.
 */
async function toS3Error(
  res: Response,
  input: { what: string; operation: S3Operation; key: string },
): Promise<S3RequestError> {
  const raw = (await res.text().catch(() => "")).slice(0, 400);
  const detail = redactS3Detail(raw).replace(/\s+/g, " ").trim();
  const providerCode = providerCodeFromXml(raw);
  const retryable = RETRYABLE_STATUS.has(res.status);
  const statusPart = `HTTP ${res.status}${providerCode ? ` ${providerCode}` : ""}`;
  return new S3RequestError({
    message: `${input.what}: ${statusPart}${detail ? ` — ${detail}` : ""}`,
    operation: input.operation,
    status: res.status,
    providerCode,
    key: input.key,
    retryable,
  });
}

/**
 * Classify anything thrown by one attempt. A response-shaped failure already
 * carries its provider status/code and must be passed through untouched —
 * re-wrapping it as a transport error is how a 403 `SignatureDoesNotMatch`
 * turns into an unhelpful "NetworkError" in the tenant UI.
 */
function classifyS3Failure(
  error: unknown,
  input: { what: string; operation: S3Operation; key: string },
): S3RequestError {
  if (error instanceof S3RequestError) return error;
  return toTransportError(error, input);
}

function toTransportError(
  error: unknown,
  input: { what: string; operation: S3Operation; key: string },
): S3RequestError {
  const code = transportCodeOf(error);
  const isTimeout = code === "TimeoutError";
  const retryable = code !== null && RETRYABLE_TRANSPORT_CODES.has(code);
  const label = isTimeout ? "timeout" : (code ?? "NetworkError");
  return new S3RequestError({
    message: `${input.what}: ${label}`,
    operation: input.operation,
    status: null,
    providerCode: label,
    key: input.key,
    retryable,
    cause: error,
  });
}

export interface S3RetryOptions {
  /** Total attempts including the first. Default 3 (two retries). */
  attempts?: number;
  /** First backoff in ms; doubles per attempt. Default 250. */
  baseDelayMs?: number;
  /** Injected in tests so a retry does not cost real time. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run one signed S3 request, retrying only failures that can actually succeed
 * on a second attempt.
 *
 * Deterministic rejections — a wrong access key (403), a missing permission, a
 * 404 on a key we just wrote, an unsupported operation — are returned to the
 * caller on the first attempt. Retrying those only multiplies a permanent
 * failure and slows the tenant's error down; that distinction is what the
 * upload UI's "try again" advice hangs off.
 */
export async function withS3Retry<T>(
  run: (attempt: number) => Promise<T>,
  classify: (error: unknown) => S3RequestError,
  options: S3RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = Math.max(0, options.baseDelayMs ?? 250);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: S3RequestError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      const classified = classify(error);
      lastError = classified;
      if (!classified.retryable || attempt >= attempts) throw classified;
      await sleep(baseDelay * 2 ** (attempt - 1));
    }
  }
  throw lastError ?? new Error("s3_retry_exhausted");
}

async function s3Fetch(
  config: S3Config,
  input: S3RequestInput,
  body?: Buffer,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const signed = signS3Request(config, input);
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? S3_REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(signed.url, {
    method: input.method,
    headers: signed.headers,
    body: body as BodyInit | undefined,
    signal,
  });
  return res;
}

async function throwOnError(
  res: Response,
  input: { what: string; operation: S3Operation; key: string },
): Promise<void> {
  if (res.ok) return;
  throw await toS3Error(res, input);
}

/**
 * Upload time budget. A 25-byte probe and a 200 MiB video cannot share one flat
 * deadline: the fixed 120 s was already tight for a large video on a slow
 * upstream link, and a timeout there is indistinguishable (to the tenant) from a
 * broken connection. The budget therefore grows by one second per MiB on top of
 * the base.
 */
export const S3_UPLOAD_TIMEOUT_BASE_MS = 120 * 1000;

export function s3UploadTimeoutMs(sizeBytes: number): number {
  const perMiB = Math.ceil(Math.max(0, sizeBytes) / (1024 * 1024)) * 1000;
  return S3_UPLOAD_TIMEOUT_BASE_MS + perMiB;
}

export async function s3Put(
  config: S3Config,
  key: string,
  body: Buffer,
  options: { contentType?: string; retry?: S3RetryOptions } = {},
): Promise<void> {
  const payloadHash = sha256Hex(body);
  const extraHeaders = options.contentType ? { "content-type": options.contentType } : undefined;
  const what = `upload ${key}`;
  await withS3Retry(
    async () => {
      const res = await s3Fetch(
        config,
        { method: "PUT", key, payloadHash, extraHeaders },
        body,
        { timeoutMs: s3UploadTimeoutMs(body.byteLength) },
      );
      await throwOnError(res, { what, operation: "put", key });
    },
    (error) => classifyS3Failure(error, { what, operation: "put", key }),
    options.retry,
  );
}

export async function s3Get(
  config: S3Config,
  key: string,
  options: { retry?: S3RetryOptions } = {},
): Promise<Buffer> {
  const what = `download ${key}`;
  return await withS3Retry(
    async () => {
      const res = await s3Fetch(config, { method: "GET", key, payloadHash: sha256Hex("") });
      await throwOnError(res, { what, operation: "get", key });
      return Buffer.from(await res.arrayBuffer());
    },
    (error) => classifyS3Failure(error, { what, operation: "get", key }),
    options.retry,
  );
}

function sliceByteStream(
  source: ReadableStream<Uint8Array>,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let offset = 0;
  let doneReading = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!doneReading) {
        const { done, value } = await reader.read();
        if (done || !value) {
          doneReading = true;
          controller.close();
          return;
        }
        const chunkStart = offset;
        const chunkEnd = offset + value.byteLength - 1;
        offset += value.byteLength;
        if (chunkEnd < start) continue;
        const sliceFrom = Math.max(0, start - chunkStart);
        const sliceTo = Math.min(value.byteLength, end - chunkStart + 1);
        if (sliceFrom < sliceTo) {
          controller.enqueue(value.subarray(sliceFrom, sliceTo));
        }
        if (chunkEnd >= end) {
          doneReading = true;
          await reader.cancel().catch(() => {});
          controller.close();
          return;
        }
        return;
      }
    },
    async cancel(reason) {
      doneReading = true;
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/**
 * Stream an object (or byte range) from object storage without loading the entire
 * file into RAM. Returns `null` when the object does not exist (`404`).
 * Propagates caller aborts cleanly so disconnected clients stop upstream reads.
 */
export async function s3GetStream(
  config: S3Config,
  key: string,
  options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
): Promise<{
  stream: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentRange: string | null;
  status: number;
} | null> {
  const signed = signS3Request(config, { method: "GET", key, payloadHash: sha256Hex("") });
  const headers: Record<string, string> = { ...signed.headers };
  if (options.range) {
    headers.Range = `bytes=${options.range.start}-${options.range.end}`;
  }
  const timeoutSignal = AbortSignal.timeout(S3_REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(signed.url, {
    method: "GET",
    headers,
    signal,
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  await throwOnError(res, { what: `download ${key}`, operation: "get", key });
  if (!res.body) {
    return {
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      contentLength: 0,
      contentRange: res.headers.get("content-range"),
      status: res.status,
    };
  }
  // If a minimal S3 mock ignores the `Range` header and answers `200`, slice the
  // exact requested byte window on the fly and cancel the remainder immediately.
  if (options.range && res.status === 200) {
    const expected = options.range.end - options.range.start + 1;
    return {
      stream: sliceByteStream(res.body, options.range.start, options.range.end),
      contentLength: expected,
      contentRange: null,
      status: 206,
    };
  }
  const declared = res.headers.get("content-length");
  const contentLength = declared !== null && /^\d+$/.test(declared) ? Number(declared) : null;
  return {
    stream: res.body,
    contentLength,
    contentRange: res.headers.get("content-range"),
    status: res.status,
  };
}

export async function s3Head(
  config: S3Config,
  key: string,
  options: { retry?: S3RetryOptions } = {},
): Promise<{ size: number; etag: string | null } | null> {
  const what = `head ${key}`;
  return await withS3Retry(
    async () => {
      const res = await s3Fetch(config, { method: "HEAD", key, payloadHash: sha256Hex("") });
      if (res.status === 404) return null;
      await throwOnError(res, { what, operation: "head", key });
      const size = Number(res.headers.get("content-length") ?? "0");
      const rawEtag = res.headers.get("etag");
      return {
        size: Number.isFinite(size) ? size : 0,
        etag: rawEtag ? rawEtag.replace(/^"+|"+$/g, "") : null,
      };
    },
    (error) => classifyS3Failure(error, { what, operation: "head", key }),
    options.retry,
  );
}

export async function s3CopyObject(
  config: S3Config,
  sourceBucket: string,
  sourceKey: string,
  destKey: string,
): Promise<void> {
  const encodedSource = `/${encodeURIComponent(sourceBucket)}/${sourceKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  const what = `copy ${sourceBucket}/${sourceKey} -> ${destKey}`;
  await withS3Retry(
    async () => {
      const res = await s3Fetch(config, {
        method: "PUT",
        key: destKey,
        payloadHash: sha256Hex(""),
        extraHeaders: { "x-amz-copy-source": encodedSource },
      });
      await throwOnError(res, { what, operation: "copy", key: destKey });
    },
    (error) => classifyS3Failure(error, { what, operation: "copy", key: destKey }),
  );
}

/**
 * Upload a file without loading it (issue #807 + #926). Signs the real SHA-256
 * payload hash already computed while spooling the upload to disk, and streams
 * the file body with an explicit `Content-Length`.
 */
export async function s3PutFile(
  config: S3Config,
  key: string,
  filePath: string,
  opts: { payloadHash: string; sizeBytes: number; contentType?: string; retry?: S3RetryOptions },
): Promise<void> {
  const extraHeaders: Record<string, string> = {};
  if (opts.contentType) extraHeaders["content-type"] = opts.contentType;
  const { createReadStream } = await import("node:fs");
  const { stat } = await import("node:fs/promises");
  const { Readable } = await import("node:stream");
  const what = `upload ${key}`;

  // The spooled file is the payload: if it is not the size the hash was
  // computed over, the signature would be right and the object would still be
  // wrong. Fail here, before the network, with a local (not provider) code so
  // the caller does not blame the bucket.
  let actualSize: number;
  try {
    actualSize = (await stat(filePath)).size;
  } catch (error) {
    throw new S3RequestError({
      message: `${what}: LocalFileUnreadable`,
      operation: "put",
      status: null,
      providerCode: "LocalFileUnreadable",
      key,
      retryable: false,
      cause: error,
    });
  }
  if (actualSize !== opts.sizeBytes) {
    throw new S3RequestError({
      message: `${what}: LocalFileSizeMismatch (${actualSize} != ${opts.sizeBytes})`,
      operation: "put",
      status: null,
      providerCode: "LocalFileSizeMismatch",
      key,
      retryable: false,
    });
  }

  await withS3Retry(
    async () => {
      // A fresh read stream per attempt: a retried request cannot reuse a body
      // that the previous attempt already consumed half of.
      const signed = signS3Request(config, {
        method: "PUT",
        key,
        payloadHash: opts.payloadHash,
        extraHeaders,
      });
      const res = await fetch(signed.url, {
        method: "PUT",
        headers: { ...signed.headers, "content-length": String(opts.sizeBytes) },
        body: Readable.toWeb(createReadStream(filePath)) as unknown as BodyInit,
        duplex: "half",
        signal: AbortSignal.timeout(s3UploadTimeoutMs(opts.sizeBytes)),
      } as RequestInit & { duplex: "half" });
      await throwOnError(res, { what, operation: "put", key });
    },
    (error) => classifyS3Failure(error, { what, operation: "put", key }),
    opts.retry,
  );
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
  await throwOnError(res, { what: `download ${key}`, operation: "get", key });
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

export async function s3Delete(
  config: S3Config,
  key: string,
  options: { retry?: S3RetryOptions } = {},
): Promise<void> {
  const what = `delete ${key}`;
  await withS3Retry(
    async () => {
      const res = await s3Fetch(config, { method: "DELETE", key, payloadHash: sha256Hex("") });
      await throwOnError(res, { what, operation: "delete", key });
    },
    (error) => classifyS3Failure(error, { what, operation: "delete", key }),
    options.retry,
  );
}

/** All objects under a prefix (follows continuation tokens). */
export async function s3List(config: S3Config, prefix: string): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let continuationToken: string | null = null;
  do {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const res = await s3Fetch(config, { method: "GET", key: "", query, payloadHash: sha256Hex("") });
    await throwOnError(res, { what: `list ${prefix}`, operation: "list", key: prefix });
    const page = parseListObjectsXml(await res.text());
    objects.push(...page.objects);
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return objects;
}
