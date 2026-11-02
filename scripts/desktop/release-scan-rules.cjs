"use strict";

/**
 * Issue #1194 — the rules the signed-artifact gate applies to a Windows
 * desktop payload.
 *
 * The desktop review's acceptance criteria are about bytes a customer can
 * unpack from the *installed* application, not about whether the source tree
 * looks clean. These rules are therefore deliberately dumb and absolute: a
 * literal that must never appear inside anything the installer writes to
 * disk, and a path shape that must never survive into the packaged runtime.
 * `scripts/scan-desktop-release.mjs` walks a real `win-unpacked` tree (and,
 * when asked, a signed installer extracted with 7-Zip) and applies them;
 * `src/lib/desktop-release-hardening.test.ts` applies the same table to
 * `electron/package.json`'s `build.files` so a regression is caught before a
 * ten-minute Windows build.
 *
 * Kept in CommonJS on purpose: the gate is a plain `node` script in CI, the
 * vitest suite is TypeScript, and `require()` is the one loader both share
 * without a build step.
 */

/**
 * Literals that must not occur in any shipped text/binary payload.
 *
 * Each entry names the mechanism it removes, not just a string: a reader who
 * hits one needs to know what privilege the literal used to grant.
 */
const FORBIDDEN_TEXT_MARKERS = Object.freeze([
  {
    id: "desktop-smoke-environment",
    marker: "DESKTOP_SMOKE_",
    description:
      "Test-mode environment switches (marker/bootstrap/packaged-probe) that used to gate the throwaway owner and the mock cloud activation service. Issue #1194 removes them from the shipped shell entirely; no non-secret variable may switch the release into a test bootstrap.",
  },
  {
    id: "smoke-probe-module",
    marker: "smoke-probe",
    description:
      "The #1001 probe module that created a known-password local owner and served a mock cloud activation API.",
  },
  {
    id: "run-smoke-probe",
    marker: "runSmokeProbe",
    description: "The probe's entry point, reachable from the packaged main process before #1194.",
  },
  {
    id: "mock-cloud-activation",
    marker: "startMockCloudActivation",
    description:
      "The mock Cloud enrollment service that signed a synthetic offline lease. Release bytes must never be able to mint one.",
  },
  {
    id: "smoke-owner-password",
    marker: "Packaged-Test-Password",
    description: "The hardcoded smoke owner password. A shipped credential is an instant login on a fresh install.",
  },
  {
    id: "platform-seed-password",
    marker: "PLATFORM_ADMIN_PASSWORD",
    description:
      "The Central Superadmin seed tool's credential variable. Seeding a platform admin is a Cloud operation and must not travel in a site installer.",
  },
  {
    id: "platform-seed-script",
    marker: "seed-platform-admin",
    description: "The Central platform-admin bootstrap script. Site installs never need it and must not contain it.",
  },
  {
    id: "private-signing-material",
    // A complete PEM block, not the four words on their own: a bundled
    // dependency's documentation may legitimately *mention* a private key
    // header, while a real key always has the base64 body and END line.
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]{0,128}?[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    description:
      "A PEM private key (release signing, JWT signing, or TLS CA). Only the public release-verification key may ship; private material must never be in an installer.",
  },
]);

/** Normalise the rule table into literal and regex forms once. */
const TEXT_RULES = Object.freeze(
  FORBIDDEN_TEXT_MARKERS.map((rule) =>
    rule.pattern
      ? { ...rule, kind: "pattern", maxBytes: rule.maxBytes ?? 16 * 1024 * 1024 }
      : { ...rule, kind: "literal" },
  ),
);

/**
 * Path shapes that must not exist in the packaged web runtime. Matched
 * against POSIX-style paths relative to the runtime root (`app/...` from the
 * Next build, `resources/...` from win-unpacked), so both a staged runtime
 * and an extracted installer can be judged by the same table.
 */
const FORBIDDEN_PATH_RULES = Object.freeze([
  {
    id: "central-platform-pages",
    pattern: /(?:^|\/)app\/platform(?:\/|$)/,
    description:
      "Central-only Superadmin console pages. A site runtime 404s the realm in middleware; they are also removed from the packaged runtime so the privilege surface is not merely hidden.",
  },
  {
    id: "central-platform-api",
    pattern: /(?:^|\/)app\/api\/platform(?:\/|$)/,
    description:
      "Central-only Superadmin API routes (admin management, billing, backup control, platform MCP). Excluded from the desktop runtime by scripts/build-desktop-runtime.mjs.",
  },
  {
    id: "smoke-probe-file",
    pattern: /(?:^|\/)smoke-probe(?:\.js)?$/,
    description: "The removed test bootstrap module, by file name.",
  },
  {
    id: "platform-seed-file",
    pattern: /(?:^|\/)(?:seed|reset)-(?:platform-admin|platform-mfa)(?:\.ts|\.js)?$/,
    description: "Central credential-seeding and MFA-reset tooling.",
  },
  {
    id: "private-key-file",
    pattern: /\.(?:pfx|p12|p8)$|(?:^|\/)(?:id_rsa|id_ed25519|release-private-key)(?:\.|$)/,
    description: "Private key containers and conventional private key file names.",
  },
  {
    id: "source-or-test-file",
    pattern: /(?:\.test\.(?:ts|tsx|js|mjs)$|(?:^|\/)__tests__\/|(?:^|\/)coverage\/|(?:^|\/)\.git\/)/,
    description: "Test suites, coverage output and repository metadata are not part of a production payload.",
    // Third-party packages legitimately ship their own test fixtures through
    // Next's trace; our own payload is what this rule protects.
    scope: "outside-node-modules",
  },
  {
    id: "environment-file",
    pattern: /(?:^|\/)\.env(?:\.(?!example$)[\w.-]+)?$/,
    description:
      "An environment file inside the payload. Per-install secrets are generated at first run and kept in Configuration/config.json; a shipped .env is either a leaked credential or a source-tree artefact.",
    scope: "outside-node-modules",
  },
]);

/** The one PEM that is allowed to ship: the public key the updater verifies releases with. */
const ALLOWED_KEY_FILES = Object.freeze(["desktop-release-public-key.pem"]);

/** Case-sensitive buffer search for one literal marker. */
function bufferContains(buffer, marker) {
  return typeof buffer?.includes === "function" && buffer.includes(Buffer.from(marker, "utf8"));
}

/**
 * Apply the text rules to one payload.
 *
 * `buffer` is the raw bytes (never a decoded string) so a marker cannot hide
 * behind a binary header, and so a UTF-8 BOM or a mixed-encoding file cannot
 * defeat the check. Returns `{ id, marker, path, description }` per hit — no
 * context is included on purpose: the gate runs in a public CI log and must
 * not echo surrounding secret material.
 */
function scanTextBuffer(buffer, payloadPath) {
  const findings = [];
  for (const rule of TEXT_RULES) {
    if (rule.kind === "literal") {
      if (!bufferContains(buffer, rule.marker)) continue;
      findings.push({ id: rule.id, marker: rule.marker, path: payloadPath, description: rule.description });
      continue;
    }
    if (!buffer || buffer.length > rule.maxBytes) continue;
    // latin1 is a byte-for-byte view: it cannot throw on binary content and
    // the ASCII markers keep their offsets.
    if (!rule.pattern.test(buffer.toString("latin1"))) continue;
    findings.push({ id: rule.id, path: payloadPath, description: rule.description });
  }
  return findings;
}

/** Apply the path rules to one relative path. */
function scanPath(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, "/");
  const inNodeModules = /(?:^|\/)node_modules\//.test(normalized);
  const findings = [];
  for (const rule of FORBIDDEN_PATH_RULES) {
    if (rule.scope === "outside-node-modules" && inNodeModules) continue;
    if (rule.pattern.test(normalized)) {
      findings.push({ id: rule.id, path: normalized, description: rule.description });
    }
  }
  return findings;
}

/** Whether a `.pem`/key-shaped file is the deliberately public release key. */
function isAllowedKeyFile(relativePath) {
  const base = String(relativePath).replace(/\\/g, "/").split("/").pop() || "";
  return ALLOWED_KEY_FILES.includes(base);
}

module.exports = {
  FORBIDDEN_TEXT_MARKERS,
  FORBIDDEN_PATH_RULES,
  TEXT_RULES,
  ALLOWED_KEY_FILES,
  bufferContains,
  scanTextBuffer,
  scanPath,
  isAllowedKeyFile,
};
