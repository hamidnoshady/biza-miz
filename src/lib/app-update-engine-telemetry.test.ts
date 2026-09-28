import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistDesktopUpdateTarget, readDesktopEngineTelemetry } from "./app-update";
import type { DesktopReleaseManifest } from "./desktop-release";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function stateFile(value: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-engine-telemetry-"));
  roots.push(root);
  const file = path.join(root, "update-state.json");
  await writeFile(file, JSON.stringify(value));
  return file;
}

describe("Desktop engine telemetry state file", () => {
  it("reports bounded validated engine state rather than renderer page state", async () => {
    const file = await stateFile({
      state: "failed",
      target: { version: "2.1.0" },
      errorCode: "authenticode_invalid",
      errorDetail: "signature check failed",
    });
    await expect(readDesktopEngineTelemetry(file)).resolves.toEqual({
      updateState: "failed",
      updateTargetVersion: "2.1.0",
      lastErrorCode: "authenticode_invalid",
      lastErrorMessage: "signature check failed",
    });
  });

  it("atomically hands an authenticated Central target to Electron without a renderer page", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desktop-target-handoff-")); roots.push(root);
    const targetPath = path.join(root, "update-target.json");
    const target: DesktopReleaseManifest = {
      manifestSignature: "A".repeat(96),
      version: "2.1.0", buildCommit: "a".repeat(40), buildId: "candidate-1", channel: "stable",
      releasedAt: "2026-09-28T08:00:00.000Z", minimumSupportedVersion: "1.0.0", mandatory: false,
      installer: { url: "https://github.com/example/product/update.exe", sha256: "b".repeat(64), size: 12, signatureRequired: true, expectedPublisher: "Business Suite" },
      database: { migrationVersion: 187, minimumSchemaVersion: 1, maximumSchemaVersion: 187, backupRequired: true },
      releaseNotes: ["Verified"], recovery: { knownGoodVersion: null, notes: null },
    };
    await expect(persistDesktopUpdateTarget(target, targetPath)).resolves.toBe(true);
    await expect(readFile(targetPath, "utf8").then(JSON.parse)).resolves.toMatchObject({ version: "2.1.0", manifestSignature: target.manifestSignature });
    await expect(persistDesktopUpdateTarget(target, path.join(root, "wrong-name.json"))).resolves.toBe(false);
  });

  it("fails closed for invalid paths, states, versions and oversized files", async () => {
    const invalid = await stateFile({ state: "invented", target: { version: "git-sha" } });
    await expect(readDesktopEngineTelemetry(invalid)).resolves.toMatchObject({ updateState: null, updateTargetVersion: null });
    await expect(readDesktopEngineTelemetry(path.join(path.dirname(invalid), "other.json"))).resolves.toMatchObject({ updateState: null });
    await writeFile(invalid, "x".repeat(64 * 1024 + 1));
    await expect(readDesktopEngineTelemetry(invalid)).resolves.toMatchObject({ updateState: null });
  });
});
