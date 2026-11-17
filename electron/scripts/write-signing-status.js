"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = async function writeSigningStatus(result) {
  // electron-builder's afterAllArtifactBuild hook receives BuildResult, not an
  // individual ArtifactCreated object. Keep one package-level status beside
  // the artifacts and record every path the completed build returned.
  if (!result || typeof result.outDir !== "string" || !Array.isArray(result.artifactPaths)) {
    throw new Error("electron-builder returned an invalid afterAllArtifactBuild result");
  }
  const provider = (process.env.WINDOWS_SIGNING_PROVIDER || "unsigned").trim().toLowerCase();
  const output = {
    schemaVersion: 1,
    status: provider === "unsigned" ? "UNSIGNED DEVELOPMENT" : "SIGNED - VERIFICATION REQUIRED",
    provider,
    expectedSigner: process.env.WINDOWS_EXPECTED_SIGNER?.trim() || null,
    expectedThumbprint: process.env.WINDOWS_EXPECTED_SIGNER_THUMBPRINT?.replace(/[\s:]/g, "").toUpperCase() || null,
    rfc3161TimestampRequired: provider !== "unsigned",
    artifacts: result.artifactPaths.map((artifactPath) => path.basename(artifactPath)).sort(),
    commit: process.env.CANDIDATE_COMMIT || process.env.GITHUB_SHA || null,
    generatedAt: new Date().toISOString(),
  };
  const destination = path.join(result.outDir, "windows-signing-status.json");
  fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
};
