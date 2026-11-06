/** Real HTTP/stream/signature fixture, not a substitute for provider staging. */
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "undici";
import { DEFAULT_MEDIA_CONFIG } from "./media";
import { runMediaStorageHealthCheck } from "./media-storage-health";
import { s3Delete, s3Get, s3Put, s3PutFile, sha256Hex } from "./s3-lite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

// Independent server-side SigV4 check over the actual URI, Host and payload.
function validSignature(req: IncomingMessage, body: Buffer): boolean {
  const auth = req.headers.authorization ?? "";
  const match = /Credential=test-key\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)/.exec(auth);
  if (!match || req.headers["x-amz-content-sha256"] !== hash(body)) return false;
  const [, scope, signedNames, signature] = match;
  const canonicalHeaders = signedNames.split(";").map((name) => `${name}:${String(req.headers[name]).trim()}\n`).join("");
  const canonical = [req.method, req.url, "", canonicalHeaders, signedNames, hash(body)].join("\n");
  const [date, region] = scope.split("/");
  const signingKey = hmac(hmac(hmac(hmac("AWS4test-secret", date), region), "s3"), "aws4_request");
  return hmac(signingKey, `AWS4-HMAC-SHA256\n${req.headers["x-amz-date"]}\n${scope}\n${hash(canonical)}`).toString("hex") === signature;
}

afterEach(() => vi.unstubAllGlobals());

it("rejects path-style then passes the complete saved-config probe and tenant-shaped uploads using virtual-host style", async () => {
  const objects = new Map<string, Buffer>();
  const accepted: { method: string; key: string; size: number }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (!req.headers.host?.startsWith("media-bucket.storage.test:")) {
      res.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    if (!validSignature(req, body)) {
      res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
      return;
    }
    const key = req.url!;
    accepted.push({ method: req.method!, key, size: body.length });
    if (req.method === "PUT") {
      if (Number(req.headers["content-length"]) !== body.length) { res.writeHead(400).end(); return; }
      objects.set(key, body);
      res.writeHead(200).end();
    } else if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      const stored = objects.get(key);
      if (!stored) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-length": stored.length });
      res.end(req.method === "HEAD" ? undefined : stored);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Only DNS is substituted: all fetches really send signed bytes over HTTP.
  const agent = new Agent({ connect: { lookup: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) } });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => realFetch(url, { ...init, dispatcher: agent } as RequestInit));
  const dir = await mkdtemp(join(tmpdir(), "media-virtual-host-"));
  try {
    const config = { ...DEFAULT_MEDIA_CONFIG, enabled: true, endpoint: `http://storage.test:${(server.address() as AddressInfo).port}`,
      bucket: "media-bucket", accessKeyId: "test-key", secretAccessKey: "test-secret", forcePathStyle: false };
    await expect(s3Put({ ...config, forcePathStyle: true }, "media/tenant/file.png", Buffer.from("x"), { retry: { attempts: 1 } })).rejects.toMatchObject({ providerCode: "AccessDenied" });
    const health = await runMediaStorageHealthCheck(config);
    expect(health.ok, JSON.stringify(health.failure)).toBe(true);
    expect(health.steps.every((step) => step.ok)).toBe(true);
    expect(objects.size).toBe(0);

    for (const size of [1024 * 1024 - 1, 1024 * 1024 + 1, 4 * 1024 * 1024]) {
      const bytes = Buffer.alloc(size, 42);
      const key = `media/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/تصویر ${size}.png`;
      if (size < 1024 * 1024) await s3Put(config, key, bytes, { contentType: "image/png" });
      else {
        const file = join(dir, String(size));
        await writeFile(file, bytes);
        await s3PutFile(config, key, file, { sizeBytes: size, payloadHash: sha256Hex(bytes), contentType: "image/png" });
      }
      expect(sha256Hex(await s3Get(config, key))).toBe(sha256Hex(bytes));
      await s3Delete(config, key);
    }
    expect(objects.size).toBe(0);
    expect(accepted.some((r) => r.method === "PUT" && r.size > 1024 * 1024)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    await agent.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
