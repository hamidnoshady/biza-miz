import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const temporaryDirectories: string[] = [];

function runNode(script: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "release-evidence-binding-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("candidate-bound external release evidence", () => {
  it("requires candidate commit binding throughout the external evidence workflows", async () => {
    const mobile = await fs.readFile(path.join(root, ".github/workflows/mobile-real-device-acceptance.yml"), "utf8");
    const printer = await fs.readFile(path.join(root, ".github/workflows/physical-printer-acceptance.yml"), "utf8");
    const printerHarness = await fs.readFile(path.join(root, "scripts/accept-physical-printer.ps1"), "utf8");
    const aggregate = await fs.readFile(path.join(root, ".github/workflows/release-acceptance-aggregate.yml"), "utf8");
    const readiness = await fs.readFile(path.join(root, ".github/workflows/release-readiness.yml"), "utf8");
    const production = await fs.readFile(path.join(root, ".github/workflows/windows-production-release.yml"), "utf8");
    const signedCandidate = await fs.readFile(path.join(root, ".github/workflows/windows-signed-candidate.yml"), "utf8");
    const windows11 = await fs.readFile(path.join(root, ".github/workflows/windows-11-release.yml"), "utf8");
    const signatureVerifier = await fs.readFile(path.join(root, "scripts/verify-windows-signatures.ps1"), "utf8");
    const installerManifest = JSON.parse(await fs.readFile(path.join(root, "config/windows-installer-signing-manifest.json"), "utf8"));

    expect(mobile).toContain("candidate_commit:");
    expect(mobile).toContain("ref: ${{ inputs.candidate_commit }}");
    expect(mobile).toContain("WORKFLOW_COMMIT: ${{ github.sha }}");
    expect(mobile).toContain("commit = $env:CANDIDATE_COMMIT");
    expect(printer).toContain("candidate_commit:");
    expect(printer).toContain("ref: ${{ inputs.candidate_commit }}");
    expect(printer).toContain("WORKFLOW_COMMIT: ${{ github.sha }}");
    expect(printer).toContain("$harnessRun.head_sha -cne $env:CANDIDATE_COMMIT");
    expect(printer).toContain("$delivery.gateway.connectorSourceGitBlob -cne $candidateConnectorGitBlob");
    expect(printer).toContain("commit = $env:CANDIDATE_COMMIT");
    expect(printerHarness).toContain("$checkedOutCommit -cne $CandidateCommit");
    expect(printerHarness).toContain("Candidate connector working tree file was modified after checkout");
    expect(printerHarness).toContain("Port 9123 already has a listener");
    expect(printerHarness).toContain("$_.OwningProcess -ne $process.Id");
    expect(printerHarness).toContain("connectorSourceSha256 = $connectorSha256");
    expect(printerHarness).toContain("connectorSourceGitBlob = $connectorSourceGitBlob");
    expect(aggregate).toContain("ref: ${{ inputs.candidate_commit }}");
    expect(aggregate).toContain("WORKFLOW_COMMIT: ${{ github.sha }}");
    expect(aggregate).toContain("$run.head_sha -cne $env:CANDIDATE_COMMIT");
    expect(aggregate).toContain("Require successful authoritative evidence workflows");
    expect(aggregate).toContain("if ($value.commit -ne $env:COMMIT)");
    expect(readiness).toContain("ref: ${{ inputs.candidate_commit }}");
    expect(readiness).toContain("CANDIDATE_COMMIT: ${{ inputs.candidate_commit }}");
    expect(readiness).toContain("WORKFLOW_COMMIT: ${{ github.sha }}");
    expect(readiness).toContain("--commit=$env:CANDIDATE_COMMIT");
    expect(readiness).toContain("candidate_installer_sha256 is required for the production gate");
    expect(production).toContain("candidate_commit:");
    expect(production).toContain("ref: ${{ inputs.candidate_commit }}");
    expect(production).toContain("WORKFLOW_COMMIT: ${{ github.sha }}");
    expect(production).toContain("$candidateRun.head_sha -cne $env:CANDIDATE_COMMIT");
    expect(production).toContain("$acceptanceRun.head_sha -cne $env:CANDIDATE_COMMIT");
    expect(production).toContain("-CandidateCommit $env:CANDIDATE_COMMIT");
    expect(production).toContain("commit=$env:CANDIDATE_COMMIT");
    expect(production).toContain("signatureVerificationSha256");
    expect(production).toContain("without rebuilding");
    expect(production).toContain("$candidateReadiness.installerSha256 -cne $installerHash");
    expect(production).toContain("installerSha256 -cne $env:PROMOTION_INSTALLER_SHA256");
    expect(production).not.toContain("npm run dist --prefix electron");
    expect(signedCandidate).toContain("npm run dist --prefix electron");
    expect(signedCandidate).toContain("signed-candidate");
    expect(signedCandidate).toContain("WORKFLOW_COMMIT: ${{ github.sha }}");
    expect(signedCandidate).toContain("$readiness.productionEligible -or $readiness.status -cne 'FAIL'");
    expect(windows11).toContain("candidate_commit:");
    expect(windows11).toContain("previous_version:");
    expect(windows11).toContain("Assert-ProvenanceArtifact");
    expect(windows11).toContain("$candidateRun.head_sha -cne $env:CANDIDATE_COMMIT");
    expect(windows11).toContain("$previousProvenance.commit -cne $env:PREVIOUS_WORKFLOW_COMMIT");
    expect(windows11).toContain("signing reports do not match release provenance");
    expect(windows11).toContain("windows-installer-signing-manifest.json");
    expect(windows11).toContain("-CandidateCommit $env:CANDIDATE_COMMIT");
    expect(signatureVerifier).toContain("commit = $CandidateCommit");
    expect(signatureVerifier).toContain("[string]::Equals($signer, $ExpectedSigner");
    expect(signatureVerifier).not.toContain("$signer.IndexOf($ExpectedSigner");
    expect(installerManifest.required).toEqual([
      { id: "nsis-installer", pattern: "Bizamiz Setup *.exe", exactly: 1 },
    ]);
  });

  it("limits protected signing credentials to validation and packaging steps", async () => {
    const workflow = await fs.readFile(path.join(root, ".github/workflows/windows-signed-candidate.yml"), "utf8");
    const workflowEnv = workflow.slice(0, workflow.indexOf("\njobs:"));
    for (const secret of [
      "WINDOWS_CSC_LINK",
      "WINDOWS_CSC_KEY_PASSWORD",
      "AZURE_SUBSCRIPTION_ID",
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
    ]) {
      expect(workflowEnv).not.toContain(`secrets.${secret}`);
    }

    const dependencyInstall = workflow.indexOf("Install and audit Electron dependencies");
    const azureLogin = workflow.indexOf("Authenticate to Azure with protected OIDC federation");
    const signingBuild = workflow.indexOf("Set release version and build through configured signing provider");
    expect(dependencyInstall).toBeGreaterThan(-1);
    expect(azureLogin).toBeGreaterThan(dependencyInstall);
    expect(signingBuild).toBeGreaterThan(azureLogin);
    const signingStep = workflow.slice(signingBuild, workflow.indexOf("Clear transient Azure CLI signing session"));
    expect(signingStep).toContain("CSC_LINK: ${{ vars.WINDOWS_SIGNING_PROVIDER == 'pfx'");
    expect(signingStep).toContain("AZURE_CLIENT_SECRET: ${{ vars.WINDOWS_SIGNING_PROVIDER == 'azure-trusted-signing'");
    expect(workflow).toContain("fromJSON(vars.WINDOWS_SIGNING_RUNNER_JSON");
    expect(workflow).toContain("certificate-store signing requires WINDOWS_SIGNING_RUNNER_JSON");
  });

  it("preserves the candidate commit in validated real-device evidence", async () => {
    const directory = await temporaryDirectory();
    const config = JSON.parse(await fs.readFile(path.join(root, "config/mobile-device-acceptance.json"), "utf8"));
    const requiredChecks = config.platforms["android-real-device"].requiredChecks as string[];
    const commit = "a".repeat(40);
    const input = path.join(directory, "input.json");
    const output = path.join(directory, "output.json");
    await fs.writeFile(input, JSON.stringify({
      checkId: "android-real-device",
      version: "1.2.3",
      commit,
      deviceModel: "Acceptance device",
      osVersion: "Android 16",
      browser: "Chrome",
      tester: "Release operator",
      caSha256Fingerprint: Array.from({ length: 32 }, () => "AB").join(":"),
      evidenceUrl: "https://evidence.invalid/android-session",
      checks: Object.fromEntries(requiredChecks.map((check) => [check, true])),
    }));

    const result = await runNode("scripts/validate-mobile-acceptance.mjs", [`--input=${input}`, `--output=${output}`]);
    expect(result.code).toBe(0);
    expect(JSON.parse(await fs.readFile(output, "utf8")).commit).toBe(commit);
  });

  it("rejects real-device evidence that is not bound to a candidate commit", async () => {
    const directory = await temporaryDirectory();
    const input = path.join(directory, "input.json");
    const output = path.join(directory, "output.json");
    await fs.writeFile(input, JSON.stringify({
      checkId: "android-real-device",
      version: "1.2.3",
      evidenceUrl: "https://evidence.invalid/android-session",
    }));

    const result = await runNode("scripts/validate-mobile-acceptance.mjs", [`--input=${input}`, `--output=${output}`]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("release-candidate Git commit SHA");
  });

  it("permits production only when every evidence item matches one commit and version", async () => {
    const directory = await temporaryDirectory();
    const config = JSON.parse(await fs.readFile(path.join(root, "config/release-readiness.json"), "utf8"));
    const commit = "b".repeat(40);
    const version = "1.2.3";
    const evidencePath = path.join(directory, "evidence.json");
    const outputPath = path.join(directory, "readiness.json");
    const markdownPath = path.join(directory, "readiness.md");
    const checks = Object.fromEntries(config.checks.map((check: { id: string; artifactBound?: boolean }) => [check.id, {
      configured: true,
      status: "PASS",
      commit,
      version,
      executedAt: new Date().toISOString(),
      evidenceUrl: `https://evidence.invalid/${check.id}`,
      platform: "acceptance fixture",
      ...(check.artifactBound === true ? { installerSha256: "f".repeat(64) } : {}),
    }]));
    await fs.writeFile(evidencePath, JSON.stringify({ schemaVersion: 1, installerSha256: "f".repeat(64), checks }));

    const result = await runNode("scripts/generate-release-readiness.mjs", [
      `--evidence=${evidencePath}`,
      `--output=${outputPath}`,
      `--markdown=${markdownPath}`,
      `--commit=${commit}`,
      `--version=${version}`,
      `--installer-sha256=${"f".repeat(64)}`,
      "--production",
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(report.status).toBe("PASS");
    expect(report.productionEligible).toBe(true);
    expect(report.installerSha256).toBe("f".repeat(64));
  });

  it("blocks stale external evidence from another candidate commit", async () => {
    const directory = await temporaryDirectory();
    const config = JSON.parse(await fs.readFile(path.join(root, "config/release-readiness.json"), "utf8"));
    const commit = "c".repeat(40);
    const version = "1.2.3";
    const evidencePath = path.join(directory, "evidence.json");
    const outputPath = path.join(directory, "readiness.json");
    const markdownPath = path.join(directory, "readiness.md");
    const checks = Object.fromEntries(config.checks.map((check: { id: string; artifactBound?: boolean }) => [check.id, {
      configured: true,
      status: "PASS",
      commit: check.id === "android-real-device" ? "d".repeat(40) : commit,
      version,
      executedAt: new Date().toISOString(),
      evidenceUrl: `https://evidence.invalid/${check.id}`,
      platform: "acceptance fixture",
      ...(check.artifactBound === true ? { installerSha256: "f".repeat(64) } : {}),
    }]));
    await fs.writeFile(evidencePath, JSON.stringify({ schemaVersion: 1, installerSha256: "f".repeat(64), checks }));

    const result = await runNode("scripts/generate-release-readiness.mjs", [
      `--evidence=${evidencePath}`,
      `--output=${outputPath}`,
      `--markdown=${markdownPath}`,
      `--commit=${commit}`,
      `--version=${version}`,
      `--installer-sha256=${"f".repeat(64)}`,
      "--production",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(report.productionEligible).toBe(false);
    expect(report.checks.find((check: { id: string }) => check.id === "android-real-device").state)
      .toBe("MANUAL ACCEPTANCE REQUIRED");
  });

  it("blocks retail Windows evidence that is not bound to an installer hash", async () => {
    const directory = await temporaryDirectory();
    const config = JSON.parse(await fs.readFile(path.join(root, "config/release-readiness.json"), "utf8"));
    const commit = "e".repeat(40);
    const version = "2.0.0";
    const evidencePath = path.join(directory, "evidence.json");
    const outputPath = path.join(directory, "readiness.json");
    const markdownPath = path.join(directory, "readiness.md");
    const checks = Object.fromEntries(config.checks.map((check: { id: string; artifactBound?: boolean }) => [check.id, {
      configured: true,
      status: "PASS",
      commit,
      version,
      executedAt: new Date().toISOString(),
      evidenceUrl: `https://evidence.invalid/${check.id}`,
      platform: "acceptance fixture",
    }]));
    await fs.writeFile(evidencePath, JSON.stringify({ schemaVersion: 1, installerSha256: "f".repeat(64), checks }));

    const result = await runNode("scripts/generate-release-readiness.mjs", [
      `--evidence=${evidencePath}`,
      `--output=${outputPath}`,
      `--markdown=${markdownPath}`,
      `--commit=${commit}`,
      `--version=${version}`,
      `--installer-sha256=${"f".repeat(64)}`,
      "--production",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(report.checks.find((check: { id: string }) => check.id === "windows-11-retail").state)
      .toBe("MANUAL ACCEPTANCE REQUIRED");
  });

  it("blocks acceptance evidence for a different signed installer", async () => {
    const directory = await temporaryDirectory();
    const config = JSON.parse(await fs.readFile(path.join(root, "config/release-readiness.json"), "utf8"));
    const commit = "e".repeat(40);
    const version = "2.0.0";
    const installerSha256 = "f".repeat(64);
    const evidencePath = path.join(directory, "evidence.json");
    const outputPath = path.join(directory, "readiness.json");
    const markdownPath = path.join(directory, "readiness.md");
    const checks = Object.fromEntries(config.checks.map((check: { id: string; artifactBound?: boolean }) => [check.id, {
      configured: true,
      status: "PASS",
      commit,
      version,
      executedAt: new Date().toISOString(),
      evidenceUrl: `https://evidence.invalid/${check.id}`,
      platform: "acceptance fixture",
      ...(check.artifactBound === true ? {
        installerSha256: check.id === "windows-11-retail" ? "0".repeat(64) : installerSha256,
      } : {}),
    }]));
    await fs.writeFile(evidencePath, JSON.stringify({ schemaVersion: 1, installerSha256, checks }));

    const result = await runNode("scripts/generate-release-readiness.mjs", [
      `--evidence=${evidencePath}`,
      `--output=${outputPath}`,
      `--markdown=${markdownPath}`,
      `--commit=${commit}`,
      `--version=${version}`,
      `--installer-sha256=${installerSha256}`,
      "--production",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(report.productionEligible).toBe(false);
    expect(report.checks.find((check: { id: string }) => check.id === "windows-11-retail").state)
      .toBe("MANUAL ACCEPTANCE REQUIRED");
  });

  it("requires an explicit installer identity for production mode", async () => {
    const directory = await temporaryDirectory();
    const evidencePath = path.join(directory, "evidence.json");
    await fs.writeFile(evidencePath, JSON.stringify({
      schemaVersion: 1,
      installerSha256: "f".repeat(64),
      checks: {},
    }));

    const result = await runNode("scripts/generate-release-readiness.mjs", [
      `--evidence=${evidencePath}`,
      `--output=${path.join(directory, "readiness.json")}`,
      `--markdown=${path.join(directory, "readiness.md")}`,
      `--commit=${"e".repeat(40)}`,
      "--version=2.0.0",
      "--production",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("requires explicit commit, version and installer SHA-256");
  });

  it("does not treat truthy configured values as configured evidence", async () => {
    const directory = await temporaryDirectory();
    const evidencePath = path.join(directory, "evidence.json");
    const outputPath = path.join(directory, "readiness.json");
    await fs.writeFile(evidencePath, JSON.stringify({
      schemaVersion: 1,
      checks: {
        "automated-core": {
          configured: "true",
          status: "PASS",
          commit: "e".repeat(40),
          executedAt: new Date().toISOString(),
          evidenceUrl: "https://evidence.invalid/automated-core",
        },
      },
    }));

    const result = await runNode("scripts/generate-release-readiness.mjs", [
      `--evidence=${evidencePath}`,
      `--output=${outputPath}`,
      `--markdown=${path.join(directory, "readiness.md")}`,
      `--commit=${"e".repeat(40)}`,
      "--version=2.0.0",
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(report.checks.find((check: { id: string }) => check.id === "automated-core").state)
      .toBe("NOT CONFIGURED");
  });

  it("blocks Authenticode evidence signed for another release version", async () => {
    const directory = await temporaryDirectory();
    const config = JSON.parse(await fs.readFile(path.join(root, "config/release-readiness.json"), "utf8"));
    const commit = "e".repeat(40);
    const version = "2.0.0";
    const evidencePath = path.join(directory, "evidence.json");
    const outputPath = path.join(directory, "readiness.json");
    const markdownPath = path.join(directory, "readiness.md");
    const checks = Object.fromEntries(config.checks.map((check: { id: string; artifactBound?: boolean }) => [check.id, {
      configured: true,
      status: "PASS",
      commit,
      version: check.id === "authenticode" ? "1.9.0" : version,
      executedAt: new Date().toISOString(),
      evidenceUrl: `https://evidence.invalid/${check.id}`,
      platform: "acceptance fixture",
      ...(check.artifactBound === true ? { installerSha256: "f".repeat(64) } : {}),
    }]));
    await fs.writeFile(evidencePath, JSON.stringify({ schemaVersion: 1, installerSha256: "f".repeat(64), checks }));

    const result = await runNode("scripts/generate-release-readiness.mjs", [
      `--evidence=${evidencePath}`,
      `--output=${outputPath}`,
      `--markdown=${markdownPath}`,
      `--commit=${commit}`,
      `--version=${version}`,
      `--installer-sha256=${"f".repeat(64)}`,
      "--production",
    ]);
    expect(result.code).toBe(1);
    const report = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(report.productionEligible).toBe(false);
    expect(report.checks.find((check: { id: string }) => check.id === "authenticode").state)
      .toBe("FAIL");
  });
});
