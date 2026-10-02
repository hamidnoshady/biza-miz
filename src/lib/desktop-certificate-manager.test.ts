import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
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
