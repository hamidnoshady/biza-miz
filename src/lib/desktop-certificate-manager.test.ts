import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCertificateManager } = require("../../electron/certificate-manager.js");

const logger = { info() {}, warn() {}, error() {} };
const dirs: string[] = [];
function manager() {
  const dir = mkdtempSync(path.join(tmpdir(), "bs-certs-"));
  dirs.push(dir);
  return createCertificateManager(dir, logger);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function leafOf(meta: { leafCertPath: string; caCertPath: string; leafKeyPath: string }) {
  return {
    leaf: new X509Certificate(readFileSync(meta.leafCertPath)),
    ca: new X509Certificate(readFileSync(meta.caCertPath)),
    key: createPrivateKey(readFileSync(meta.leafKeyPath)),
  };
}

describe("desktop gateway certificates", () => {
  it("issues a server leaf for the LAN addresses, chained to its own local CA, under the 398-day cap", async () => {
    const meta = await manager().ensureLeaf(["192.168.1.20", "127.0.0.1"]);
    const { leaf, ca, key } = leafOf(meta);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkPrivateKey(key)).toBe(true);
    expect(leaf.subjectAltName).toBe("DNS:business-suite.local, IP Address:127.0.0.1, IP Address:192.168.1.20");
    expect(new Date(leaf.validTo).getTime() - Date.now()).toBeLessThanOrEqual(398 * 24 * 60 * 60_000);
  });

  it("reuses a current leaf, and regenerating keeps the CA phones already trust", async () => {
    const certificates = manager();
    const first = await certificates.ensureLeaf(["127.0.0.1"]);
    expect((await certificates.ensureLeaf(["127.0.0.1"])).fingerprint).toBe(first.fingerprint);
    const again = await certificates.regenerate(["127.0.0.1"]);
    expect(again.fingerprint).not.toBe(first.fingerprint);
    expect(again.caFingerprint).toBe(first.caFingerprint);
  });

  it("still signs with a CA key an older build stored as PKCS#1", async () => {
    const certificates = manager();
    const first = await certificates.ensureLeaf(["127.0.0.1"]);
    const caKeyPath = path.join(path.dirname(first.caCertPath), "local-ca-key.pem");
    const pkcs1 = createPrivateKey(readFileSync(caKeyPath)).export({ type: "pkcs1", format: "pem" });
    writeFileSync(caKeyPath, pkcs1);
    const again = await certificates.regenerate(["127.0.0.1"]);
    const { leaf, ca } = leafOf(again);
    expect(again.caFingerprint).toBe(first.caFingerprint);
    expect(leaf.checkIssued(ca) && leaf.verify(ca.publicKey)).toBe(true);
  });
});

it("creates a constrained two-year CA and migrates its key to OS-encrypted storage", async () => {
  const certificates = manager();
  const first = await certificates.ensureLeaf(["192.168.1.20"]);
  const ca = new X509Certificate(readFileSync(first.caCertPath));
  expect(new Date(ca.validTo).getTime() - Date.now()).toBeLessThanOrEqual(2 * 365 * 24 * 60 * 60_000);
  const x509 = require("@peculiar/x509");
  const parsed = new x509.X509Certificate(readFileSync(first.caCertPath));
  expect(parsed.getExtension("2.5.29.30").critical).toBe(true);
  const dir = dirs[dirs.length - 1];
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text).reverse(),
    decryptString: (bytes: Buffer) => Buffer.from(bytes).reverse().toString(),
  };
  const protectedManager = createCertificateManager(dir, logger, { safeStorage });
  const again = await protectedManager.ensureLeaf(["192.168.1.20"]);
  expect(again.fingerprint).toBe(first.fingerprint);
  expect(again.caFingerprint).toBe(first.caFingerprint);
  const keyPath = path.join(path.dirname(first.caCertPath), "local-ca-key.pem");
  expect(() => readFileSync(keyPath)).toThrow();
  expect(readFileSync(keyPath + ".encrypted").toString()).not.toContain("PRIVATE KEY");
  expect((await protectedManager.regenerate(["192.168.1.21"])).caFingerprint).toBe(first.caFingerprint);
});


it("rejects a chain containing a public IPv4 SAN under the constrained CA", async () => {
  const certificates = manager();
  const meta = await certificates.ensureLeaf(["127.0.0.1", "8.8.8.8"]);
  const server = https.createServer(certificates.tlsOptions(), (_request, response) => response.end("unexpected"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = new Promise<void>((resolve, reject) => {
      const request = https.get(`https://127.0.0.1:${(server.address() as AddressInfo).port}`, {
        ca: readFileSync(meta.caCertPath),
      }, (response) => { response.resume(); resolve(); });
      request.on("error", reject);
    });
    await expect(result).rejects.toThrow(/subtree|constraint/i);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
