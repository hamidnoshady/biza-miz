"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
// @peculiar/x509 resolves its algorithm providers through tsyringe, which needs this first.
require("reflect-metadata");
const x509 = require("@peculiar/x509");
const { computePaths } = require("./app-paths");

// Certificates are built with @peculiar/x509 over Node's own WebCrypto. It
// replaced node-forge (GHSA-86w9-cpqp-85rv, no fix available upstream). A CA
// an older build wrote — PKCS#1 key, forge-encoded certificate — is still read
// and still signs: rotation requires explicit device re-onboarding, never a silent replacement.
x509.cryptoProvider.set(crypto.webcrypto);
const { subtle } = crypto.webcrypto;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };

function pemFingerprint(pem) {
  const der = Buffer.from(pem.replace(/-----(?:BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
  return crypto.createHash("sha256").update(der).digest("hex").match(/.{2}/g).join(":").toUpperCase();
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

/** A positive 128-bit serial (the leading 01 keeps the DER INTEGER's sign bit clear). */
function serial() {
  return `01${crypto.randomBytes(15).toString("hex")}`;
}

async function generateKeys() {
  return subtle.generateKey(RSA, true, ["sign", "verify"]);
}

async function privateKeyPem(key) {
  return x509.PemConverter.encode(await subtle.exportKey("pkcs8", key), "PRIVATE KEY");
}

/** Any PEM private key (PKCS#1 from forge, or PKCS#8) as a WebCrypto signing key. */
async function importPrivateKey(pem) {
  const der = crypto.createPrivateKey(pem).export({ type: "pkcs8", format: "der" });
  return subtle.importKey("pkcs8", der, RSA, false, ["sign"]);
}

// RFC 5280 GeneralSubtrees: constrain DNS and IPv4 names in newly created CAs.
function nameConstraints() {
  const tlv = (tag, bytes) => Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
  const subtree = (tag, bytes) => tlv(0x30, tlv(tag, bytes));
  const entries = [subtree(0x82, Buffer.from("business-suite.local")),
    ...[[10,0,0,0,255,0,0,0], [172,16,0,0,255,240,0,0], [192,168,0,0,255,255,0,0],
      [127,0,0,0,255,0,0,0]].map((range) => subtree(0x87, Buffer.from(range)))];
  // Exclude all IPv6 names: this gateway only listens on private IPv4.
  const excluded = tlv(0xa1, subtree(0x87, Buffer.alloc(32)));
  return new x509.Extension("2.5.29.30", true, tlv(0x30, Buffer.concat([tlv(0xa0, Buffer.concat(entries)), excluded])));
}

function createCertificateManager(userDataDir, logger, options = {}) {
  const safeStorage = options.safeStorage || (process.platform === "win32" ? require("electron").safeStorage : null);
  function writeCaKey(pem) {
    if (process.platform === "win32" || safeStorage) {
      if (!safeStorage?.isEncryptionAvailable()) throw new Error("OS encryption is required to protect the local CA key");
      writePrivate(caKeyPath + ".encrypted", safeStorage.encryptString(pem));
      if (fs.existsSync(caKeyPath)) fs.unlinkSync(caKeyPath);
    } else writePrivate(caKeyPath, pem);
  }
  function readCaKey() {
    if (fs.existsSync(caKeyPath + ".encrypted")) {
      if (!safeStorage?.isEncryptionAvailable()) throw new Error("Local CA key cannot be decrypted by this OS account");
      return safeStorage.decryptString(fs.readFileSync(caKeyPath + ".encrypted"));
    }
    const pem = fs.readFileSync(caKeyPath, "utf8");
    writeCaKey(pem);
    return pem;
  }
  // Section 8 folder split: gateway certificates live under
  // Data/gateway-certificates/, not directly in userData. `main.js` runs
  // `migrateLegacyLayout()` before this is ever called, so an existing
  // install's certificates have already moved here.
  const directory = computePaths(userDataDir).certificatesDir;
  const caKeyPath = path.join(directory, "local-ca-key.pem");
  const caCertPath = path.join(directory, "business-suite-local-ca.crt");
  const leafKeyPath = path.join(directory, "gateway-key.pem");
  const leafCertPath = path.join(directory, "gateway-cert.pem");
  const metadataPath = path.join(directory, "gateway-certificate.json");

  async function ensureCa() {
    fs.mkdirSync(directory, { recursive: true });
    if ((fs.existsSync(caKeyPath) || fs.existsSync(caKeyPath + ".encrypted")) && fs.existsSync(caCertPath)) {
      const cert = new x509.X509Certificate(fs.readFileSync(caCertPath, "utf8"));
      if (cert.notAfter.getTime() <= Date.now()) throw new Error("Local CA has expired; replace the CA and re-onboard paired devices.");
      if (!cert.getExtension("2.5.29.30")) {
        logger.warn("Legacy local CA is unconstrained; replace it and re-onboard devices to apply CA hardening");
      }
      return { key: await importPrivateKey(readCaKey()), cert };
    }
    logger.info("Generating local mobile-access certificate authority");
    const keys = await generateKeys();
    const name = "CN=Business Suite Local CA, O=Business Suite Local Installation";
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: name,
      issuer: name,
      notBefore: new Date(Date.now() - 5 * 60_000),
      notAfter: new Date(Date.now() + 2 * 365 * 24 * 60 * 60_000),
      signingAlgorithm: RSA,
      publicKey: keys.publicKey,
      signingKey: keys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        nameConstraints(),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign | x509.KeyUsageFlags.digitalSignature,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    writeCaKey(await privateKeyPem(keys.privateKey));
    fs.writeFileSync(caCertPath, cert.toString("pem"), { encoding: "utf8", mode: 0o644 });
    return { key: keys.privateKey, cert };
  }

  async function ensureLeaf(addresses, force = false) {
    const normalized = [...new Set(addresses)].sort();
    const ca = await ensureCa();
    if (!force && fs.existsSync(metadataPath) && fs.existsSync(leafKeyPath) && fs.existsSync(leafCertPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        if (JSON.stringify(meta.addresses) === JSON.stringify(normalized) && new Date(meta.expiresAt).getTime() > Date.now() + 30 * 24 * 60 * 60_000) {
          return describe(meta);
        }
      } catch {}
    }
    logger.info("Generating HTTPS gateway certificate", { addresses: normalized.join(",") });
    const keys = await generateKeys();
    // Apple and Chromium enforce the modern 398-day maximum for publicly
    // trusted-style TLS server leaves even when onboarding a private local CA.
    const notAfter = new Date(Math.min(Date.now() + 397 * 24 * 60 * 60_000, ca.cert.notAfter.getTime()));
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: new x509.Name([
        { CN: [normalized[0] || "business-suite.local"] },
        { O: ["Business Suite Local Installation"] },
      ]),
      // The CA's subject as it is encoded, byte for byte, so the chain also
      // builds from a CA an older (forge) build wrote.
      issuer: ca.cert.subjectName,
      notBefore: new Date(Date.now() - 5 * 60_000),
      notAfter,
      signingAlgorithm: RSA,
      publicKey: keys.publicKey,
      signingKey: ca.key,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([
          { type: "dns", value: "business-suite.local" },
          ...normalized.map((ip) => ({ type: "ip", value: ip })),
        ]),
      ],
    });
    const certPem = cert.toString("pem");
    writePrivate(leafKeyPath, await privateKeyPem(keys.privateKey));
    fs.writeFileSync(leafCertPath, certPem, { encoding: "utf8", mode: 0o644 });
    const meta = {
      addresses: normalized,
      generatedAt: new Date().toISOString(),
      expiresAt: notAfter.toISOString(),
      fingerprint: pemFingerprint(certPem),
      caFingerprint: pemFingerprint(fs.readFileSync(caCertPath, "utf8")),
    };
    fs.writeFileSync(metadataPath, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
    return describe(meta);
  }

  function describe(meta = null) {
    if (!meta) {
      if (!fs.existsSync(metadataPath)) return { exists: false, caCertPath };
      meta = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    }
    return { exists: true, ...meta, caCertPath, leafCertPath, leafKeyPath };
  }

  return {
    ensureLeaf,
    regenerate: (addresses) => ensureLeaf(addresses, true),
    describe,
    tlsOptions: () => ({ key: fs.readFileSync(leafKeyPath), cert: fs.readFileSync(leafCertPath) }),
    caCertPath,
  };
}

module.exports = { createCertificateManager, pemFingerprint };
