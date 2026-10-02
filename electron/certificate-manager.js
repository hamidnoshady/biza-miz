"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { computePaths } = require("./app-paths");

// ---------------------------------------------------------------------------
// A minimal X.509 v3 writer on Node's own crypto.
//
// This file used to depend on node-forge. The whole package is flagged
// (GHSA-86w9-cpqp-85rv, no fixed release), and all this file ever does is
// *build* two certificates: the local CA and the gateway's TLS leaf. Key
// generation and the RSA-SHA256 signature are Node's `crypto`; the only piece
// Node lacks is an X.509 *builder*, which is the DER encoding below. It writes
// the same fields and extensions the forge version wrote, and it reads a CA an
// older release left on disk (PKCS#1 key, forge-encoded certificate), so
// existing installs keep their trusted CA and phones need no re-onboarding.
// ---------------------------------------------------------------------------

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const octetString = (buffer) => der(0x04, buffer);
const boolean = (value) => der(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8String = (text) => der(0x0c, Buffer.from(text, "utf8"));
const explicit = (n, inner) => der(0xa0 | n, inner);
const bitString = (bytes, unusedBits = 0) => der(0x03, Buffer.from([unusedBits]), bytes);

function objectId(dotted) {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let n = value >> 7; n > 0; n >>= 7) chunk.unshift((n & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

/** A positive INTEGER from big-endian bytes; a leading 0x00 keeps the sign bit clear. */
function positiveInteger(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  let body = bytes.subarray(start);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return der(0x02, body);
}

/** UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function x509Time(date) {
  const stamp = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${stamp.slice(2)}Z`, "ascii"))
    : der(0x18, Buffer.from(`${stamp}Z`, "ascii"));
}

const OIDS = {
  commonName: "2.5.4.3",
  organizationName: "2.5.4.10",
  sha256WithRSAEncryption: "1.2.840.113549.1.1.11",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  subjectKeyIdentifier: "2.5.29.14",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

function distinguishedName(attributes) {
  return sequence(...attributes.map(({ name, value }) => set(sequence(objectId(OIDS[name]), utf8String(value)))));
}

function extension(name, critical, value) {
  return sequence(objectId(OIDS[name]), ...(critical ? [boolean(true)] : []), octetString(value));
}

/** keyUsage as a BIT STRING, bits in RFC 5280 order: digitalSignature(0) … cRLSign(6). */
function keyUsage(flags) {
  const order = ["digitalSignature", "nonRepudiation", "keyEncipherment", "dataEncipherment", "keyAgreement", "keyCertSign", "cRLSign"];
  let byte = 0;
  let highest = -1;
  order.forEach((flag, index) => {
    if (flags[flag]) {
      byte |= 0x80 >> index;
      highest = index;
    }
  });
  return bitString(Buffer.from([byte]), highest < 0 ? 0 : 7 - highest);
}

function ipAddressBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split(".").map(Number));
  if (!net.isIPv6(ip)) throw new Error(`not an IP address: ${ip}`);
  const [head, tail = ""] = ip.split("::");
  const groups = (part) => (part ? part.split(":") : []);
  const missing = ip.includes("::") ? 8 - groups(head).length - groups(tail).length : 0;
  const all = [...groups(head), ...Array(missing).fill("0"), ...groups(tail)];
  return Buffer.concat(all.map((group) => {
    const out = Buffer.alloc(2);
    out.writeUInt16BE(parseInt(group, 16), 0);
    return out;
  }));
}

/** Header of the DER element at `offset`: its tag and where its content starts and ends. */
function readElement(buffer, offset) {
  let length = buffer[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + buffer[offset + 2 + i];
    header += count;
  }
  return { tag: buffer[offset], offset, start: offset + header, end: offset + header + length };
}

function pemToDer(pem) {
  return Buffer.from(pem.replace(/-----(?:BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
}

function derToPem(certificate) {
  const lines = certificate.toString("base64").match(/.{1,64}/g).join("\r\n");
  return `-----BEGIN CERTIFICATE-----\r\n${lines}\r\n-----END CERTIFICATE-----\r\n`;
}

/**
 * The certificate's subject Name, as the exact DER bytes it was signed over.
 * A leaf's issuer is copied from here byte for byte, so it always chains to the
 * CA that signs it, including a CA an older release wrote.
 */
function subjectNameDer(certPem) {
  const certificate = pemToDer(certPem);
  const tbs = readElement(certificate, readElement(certificate, 0).start);
  const fields = [];
  for (let cursor = tbs.start; cursor < tbs.end && fields.length < 6; ) {
    const element = readElement(certificate, cursor);
    fields.push(element);
    cursor = element.end;
  }
  // [0] version (optional), serialNumber, signature, issuer, validity, subject.
  const subject = fields[fields[0].tag === 0xa0 ? 5 : 4];
  return certificate.subarray(subject.offset, subject.end);
}

/** RFC 5280 §4.2.1.2 method (1): SHA-1 of the subjectPublicKey bits — what forge computed. */
function subjectKeyIdentifier(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const algorithm = readElement(spki, readElement(spki, 0).start);
  const key = readElement(spki, algorithm.end);
  return crypto.createHash("sha1").update(spki.subarray(key.start + 1, key.end)).digest();
}

function serial() {
  return crypto.randomBytes(16).toString("hex").replace(/^0+/, "1");
}

/** Builds a v3 certificate and signs it with sha256WithRSAEncryption. */
function signCertificate({ subject, issuerDer, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const algorithm = sequence(objectId(OIDS.sha256WithRSAEncryption), der(0x05));
  const tbs = sequence(
    explicit(0, der(0x02, Buffer.from([2]))),
    positiveInteger(Buffer.from(serial(), "hex")),
    algorithm,
    issuerDer,
    sequence(x509Time(notBefore), x509Time(notAfter)),
    distinguishedName(subject),
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(...extensions)),
  );
  const signature = crypto.sign("sha256", tbs, signingKey);
  return derToPem(sequence(tbs, algorithm, bitString(signature)));
}

function generateRsaKeyPair() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
}

/** PKCS#1 «RSA PRIVATE KEY» PEM — the format earlier releases wrote, so old and new keys look alike. */
function privateKeyPem(privateKey) {
  return privateKey.export({ type: "pkcs1", format: "pem" });
}

function pemFingerprint(pem) {
  const der = pemToDer(pem);
  return crypto.createHash("sha256").update(der).digest("hex").match(/.{2}/g).join(":").toUpperCase();
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function createCertificateManager(userDataDir, logger) {
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

  function ensureCa() {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath)) {
      return {
        key: crypto.createPrivateKey(fs.readFileSync(caKeyPath, "utf8")),
        subjectDer: subjectNameDer(fs.readFileSync(caCertPath, "utf8")),
      };
    }
    logger.info("Generating local mobile-access certificate authority");
    const keys = generateRsaKeyPair();
    const name = [
      { name: "commonName", value: "Business Suite Local CA" },
      { name: "organizationName", value: "Business Suite Local Installation" },
    ];
    const certPem = signCertificate({
      subject: name,
      issuerDer: distinguishedName(name),
      publicKey: keys.publicKey,
      signingKey: keys.privateKey,
      notBefore: new Date(Date.now() - 5 * 60_000),
      notAfter: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000),
      extensions: [
        extension("basicConstraints", true, sequence(boolean(true))),
        extension("keyUsage", true, keyUsage({ keyCertSign: true, cRLSign: true, digitalSignature: true })),
        extension("subjectKeyIdentifier", false, octetString(subjectKeyIdentifier(keys.publicKey))),
      ],
    });
    writePrivate(caKeyPath, privateKeyPem(keys.privateKey));
    fs.writeFileSync(caCertPath, certPem, { encoding: "utf8", mode: 0o644 });
    return { key: keys.privateKey, subjectDer: subjectNameDer(certPem) };
  }

  function ensureLeaf(addresses, force = false) {
    const normalized = [...new Set(addresses)].sort();
    if (!force && fs.existsSync(metadataPath) && fs.existsSync(leafKeyPath) && fs.existsSync(leafCertPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        if (JSON.stringify(meta.addresses) === JSON.stringify(normalized) && new Date(meta.expiresAt).getTime() > Date.now() + 30 * 24 * 60 * 60_000) {
          return describe(meta);
        }
      } catch {}
    }
    const ca = ensureCa();
    logger.info("Generating HTTPS gateway certificate", { addresses: normalized.join(",") });
    const keys = generateRsaKeyPair();
    // Apple and Chromium enforce the modern 398-day maximum for publicly
    // trusted-style TLS server leaves even when onboarding a private local CA.
    const notAfter = new Date(Date.now() + 397 * 24 * 60 * 60_000);
    const certPem = signCertificate({
      subject: [
        { name: "commonName", value: normalized[0] || "business-suite.local" },
        { name: "organizationName", value: "Business Suite Local Installation" },
      ],
      issuerDer: ca.subjectDer,
      publicKey: keys.publicKey,
      signingKey: ca.key,
      notBefore: new Date(Date.now() - 5 * 60_000),
      notAfter,
      extensions: [
        extension("basicConstraints", true, sequence()),
        extension("keyUsage", true, keyUsage({ digitalSignature: true, keyEncipherment: true })),
        extension("extKeyUsage", false, sequence(objectId(OIDS.serverAuth))),
        extension("subjectAltName", false, sequence(
          der(0x82, Buffer.from("business-suite.local", "ascii")),
          ...normalized.map((ip) => der(0x87, ipAddressBytes(ip))),
        )),
      ],
    });
    writePrivate(leafKeyPath, privateKeyPem(keys.privateKey));
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
