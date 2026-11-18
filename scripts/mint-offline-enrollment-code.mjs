#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Mint a fresh Full Offline enrollment code for the desktop acceptance phase.
 *
 * Issue #1194. The acceptance harness hands `DESKTOP_ACCEPTANCE_OFFLINE_TOKEN`
 * to the installed app, which redeems it against Cloud during Full Offline
 * bootstrap. Redemption is one-way (`local_enrollment_codes.redeemed_at`) and
 * a code expires 24 hours after issue (`LOCAL_ENROLLMENT_CODE_TTL_HOURS` in
 * `src/lib/local-activation-crypto.ts`), so a code kept in repository secrets
 * passes exactly one acceptance run and then fails every later run with
 * `code_already_redeemed`. This script mints one code per run through the same
 * owner endpoint the connections screen uses (`POST /api/connections/desktop`
 * with `profile: "local"`), which also writes the ordinary
 * `local_activation.code_issued` audit row on Cloud.
 *
 * It exports the code as `DESKTOP_ACCEPTANCE_OFFLINE_TOKEN` through
 * `$GITHUB_ENV` (masked first), or prints it for a local run.
 *
 * Required environment:
 *   DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL       public HTTPS origin of the Cloud
 *   DESKTOP_ACCEPTANCE_OFFLINE_OWNER_EMAIL     owner of the staging business
 *   DESKTOP_ACCEPTANCE_OFFLINE_OWNER_PASSWORD  that owner's password
 *   DESKTOP_ACCEPTANCE_OFFLINE_LOCATION_ID     branch the code is issued for
 * Optional:
 *   DESKTOP_ACCEPTANCE_OFFLINE_OWNER_TOTP_SECRET  base32 TOTP secret, needed only
 *                                                 when that owner has a confirmed
 *                                                 second factor
 *   GITHUB_ENV                                    appended to when present
 *
 * Nothing here prints a password, a session cookie or the code unmasked in CI.
 */

const CODE_SHAPE = /^OFL1-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optional(name) {
  return process.env[name]?.trim() || "";
}

/** The 6-digit RFC 6238 code for a secret at a moment (30-second steps). */
function totpCode(secret, at = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secret).toUpperCase().replace(/[\s=]+/g, "");
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("the TOTP secret is not base32");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(at / 30000);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = crypto.createHmac("sha1", Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

/** The first cookie pair from a Set-Cookie header list. */
function sessionCookie(response) {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /(?:^|,\s*)(pos_session=[^;]+)/.exec(header);
  return match ? match[1] : "";
}

/** A JSON body, plus the server's error code when it refused. */
async function call(base, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    // A redirect here is a refusal in disguise (the middleware sends an
    // unauthenticated call to the login page), so never follow one.
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      // The middleware's CSRF guard expects a same-origin Origin on writes.
      Origin: base,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  const code = typeof json?.error === "string" ? ` (${json.error})` : "";
  return { status: response.status, headers: response.headers, json, code };
}

async function main() {
  const origin = required("DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL").replace(/\/+$/, "");
  const email = required("DESKTOP_ACCEPTANCE_OFFLINE_OWNER_EMAIL");
  const password = required("DESKTOP_ACCEPTANCE_OFFLINE_OWNER_PASSWORD");
  const locationId = required("DESKTOP_ACCEPTANCE_OFFLINE_LOCATION_ID");
  const totpSecret = optional("DESKTOP_ACCEPTANCE_OFFLINE_OWNER_TOTP_SECRET");

  let base;
  try {
    base = new URL(origin);
  } catch {
    throw new Error("DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL is not a URL");
  }
  // The packaged runtime only accepts an HTTPS Cloud (`https_required`), so a
  // code minted against anything else could never be redeemed.
  if (base.protocol !== "https:") {
    throw new Error("DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL must be https");
  }

  const login = await call(base.origin, "/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
  let cookie = login.status === 200 ? sessionCookie(login) : "";

  if (login.status === 200 && !cookie && login.json?.mfaRequired === true) {
    const mfaToken = login.json?.mfaToken;
    if (!mfaToken) throw new Error("the second-factor challenge carried no pending token");
    if (!totpSecret) {
      const offered = Array.isArray(login.json?.availableMethods)
        ? login.json.availableMethods.join(",")
        : "unknown";
      throw new Error(
        `owner login requires a second factor (${offered}); set DESKTOP_ACCEPTANCE_OFFLINE_OWNER_TOTP_SECRET or use an owner without a confirmed factor`,
      );
    }
    const verified = await call(base.origin, "/api/auth/mfa/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${mfaToken}` },
      body: { code: totpCode(totpSecret), method: "totp" },
    });
    if (verified.status !== 200) {
      throw new Error(`second-factor verification answered ${verified.status}${verified.code}`);
    }
    cookie = sessionCookie(verified);
  }

  if (!cookie) {
    throw new Error(`owner login answered ${login.status}${login.code} with no session cookie`);
  }

  const issued = await call(base.origin, "/api/connections/desktop", {
    method: "POST",
    headers: { Cookie: cookie },
    body: { profile: "local", locationId },
  });
  if (issued.status !== 201) {
    throw new Error(`issuing an enrollment code answered ${issued.status}${issued.code}`);
  }
  const code = typeof issued.json?.code === "string" ? issued.json.code : "";
  if (!CODE_SHAPE.test(code)) {
    throw new Error("the issue endpoint returned something that is not a Full Offline enrollment code");
  }

  const summary = issued.json?.summary ?? {};
  const expiresAt = typeof summary.expiresAt === "string" ? summary.expiresAt : "in 24 hours";
  const where = typeof summary.locationName === "string" ? ` for ${summary.locationName}` : "";

  if (process.env.GITHUB_ENV) {
    console.log(`::add-mask::${code}`);
    fs.appendFileSync(process.env.GITHUB_ENV, `DESKTOP_ACCEPTANCE_OFFLINE_TOKEN=${code}\n`);
    console.log(`minted a single-use Full Offline enrollment code${where}; expires ${expiresAt}`);
  } else {
    console.log("minted a single-use Full Offline enrollment code" + where + `; expires ${expiresAt}`);
    console.log(`DESKTOP_ACCEPTANCE_OFFLINE_TOKEN=${code}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
