"use strict";

/**
 * Issue #1194 — the one RFC 6238 implementation shared by the two places that
 * answer a second factor for the acceptance run:
 *
 *   - `electron/scripts/smoke-packaged.js`, logging into an installed app whose
 *     first-run Owner was enrolled with TOTP;
 *   - `scripts/mint-offline-enrollment-code.mjs`, logging into the staging
 *     Cloud owner that issues a Full Offline enrollment code.
 *
 * Both used to carry their own copy of this arithmetic. A drift between them
 * would fail as "second factor refused" at run time rather than as a type or
 * test error, so the code exists once and both callers require it.
 *
 * Six digits, SHA-1, 30-second steps — what the product's own enrolment
 * (`src/lib/` MFA implementation) expects.
 */

const crypto = require("node:crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an unpadded base32 secret into bytes; refuse anything else. */
function base32Decode(secret) {
  const clean = String(secret).toUpperCase().replace(/[\s=]+/g, "");
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("the TOTP secret is not base32");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The 6-digit RFC 6238 code for a secret at a moment (30-second steps). */
function totpCode(secret, at = Date.now()) {
  const counter = Math.floor(at / 30000);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

module.exports = { base32Decode, totpCode };
