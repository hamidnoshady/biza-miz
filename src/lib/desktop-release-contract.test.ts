/**
 * The release pipeline ↔ Central contract, pinned from the source (issue #981 §7).
 * A workflow edit that renames a payload field, leaks a Cloud credential into the
 * Desktop pipeline, or lets Cloud publishing touch a Desktop release fails here
 * rather than at the next production release.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDesktopReleaseInput } from "./desktop-release-service";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const productionRelease = read(".github", "workflows", "windows-production-release.yml");
const cloudPublish = read(".github", "workflows", "publish.yml");
const promoteRoute = read("src", "app", "api", "desktop-releases", "promote", "route.ts");

function payloadKeys(workflow: string): string[] {
  const block = workflow.match(/\$payload = \[ordered\]@\{([\s\S]*?)\n\s*\} \| ConvertTo-Json/);
  if (!block) throw new Error("registry payload block not found in windows-production-release.yml");
  return [...block[1].matchAll(/^\s*([A-Za-z0-9]+)\s*=/gm)].map((match) => match[1]);
}

describe("windows-production-release.yml → /api/desktop-releases/promote", () => {
  const keys = payloadKeys(productionRelease);

  it("posts exactly the fields Central's validator reads", () => {
    expect(keys.sort()).toEqual([
      "buildCommit", "buildId", "channel", "expectedPublisher", "installerSha256", "installerSize", "installerUrl",
      "knownGoodReleaseId", "mandatory", "manifestSignature", "maximumSchemaVersion", "migrationVersion",
      "minimumSchemaVersion", "minimumSupportedVersion", "recoveryNotes", "releaseNotes", "rolloutPercentage",
      "rolloutState", "status", "version",
    ]);
  });

  it("builds a payload Central accepts (signature checked only when a public key is configured)", () => {
    const previous = process.env.DESKTOP_RELEASE_PUBLIC_KEY_PEM;
    delete process.env.DESKTOP_RELEASE_PUBLIC_KEY_PEM;
    try {
      const payload = {
        version: "1.2.3", buildCommit: "abcdef0123456789", buildId: "run-1", channel: "stable", status: "published",
        rolloutState: "internal", rolloutPercentage: 0, minimumSupportedVersion: null, mandatory: false,
        installerUrl: "https://github.com/example/product/releases/download/v1.2.3/Setup.exe",
        installerSha256: "a".repeat(64), installerSize: 1234, manifestSignature: "A".repeat(100),
        expectedPublisher: "Example Publisher", migrationVersion: 226, minimumSchemaVersion: 1,
        maximumSchemaVersion: 226, releaseNotes: ["note"], recoveryNotes: null, knownGoodReleaseId: null,
      };
      expect(Object.keys(payload).sort()).toEqual(keys.sort());
      expect(validateDesktopReleaseInput(payload)).toMatchObject({ ok: true });
    } finally {
      if (previous !== undefined) process.env.DESKTOP_RELEASE_PUBLIC_KEY_PEM = previous;
    }
  });

  it("registers as published/internal/0% and Central ignores any other rollout the caller asks for", () => {
    expect(productionRelease).toMatch(/rolloutState = 'internal'/);
    expect(productionRelease).toMatch(/rolloutPercentage = 0/);
    expect(promoteRoute).toContain('validated.input.rolloutState = "internal"');
    expect(promoteRoute).toContain("validated.input.rolloutPercentage = 0");
  });

  it("authenticates with the release publish token, from a secret, sent as a Bearer header", () => {
    expect(productionRelease).toContain("secrets.DESKTOP_RELEASE_PUBLISH_TOKEN");
    expect(productionRelease).toContain("vars.DESKTOP_RELEASE_REGISTRY_URL");
    expect(productionRelease).toMatch(/Authorization = "Bearer \$env:REGISTRY_TOKEN"/);
    expect(promoteRoute).toContain("DESKTOP_RELEASE_PUBLISH_TOKEN");
    expect(promoteRoute).toContain("timingSafeEqual");
  });

  it("an already-registered release is a 409 the pipeline can retry against, never a duplicate", () => {
    expect(promoteRoute).toContain("release_exists");
    expect(promoteRoute).toContain("status: 409");
  });
});

describe("the Cloud and Desktop pipelines stay isolated", () => {
  it("publish.yml (Cloud → Coolify) never touches Desktop release credentials", () => {
    for (const name of ["DESKTOP_RELEASE_PUBLISH_TOKEN", "DESKTOP_RELEASE_PRIVATE_KEY_PEM", "DESKTOP_RELEASE_REGISTRY_URL", "WINDOWS_EXPECTED_SIGNER"]) {
      expect(cloudPublish, name).not.toContain(name);
    }
  });

  it("the Desktop release workflows never use the Coolify deploy token or the Cloud health URL", () => {
    for (const file of ["windows-production-release.yml", "windows-signed-candidate.yml", "windows-11-release.yml"]) {
      const workflow = read(".github", "workflows", file);
      expect(workflow, file).not.toContain("COOLIFY_API_TOKEN");
      expect(workflow, file).not.toContain("PRODUCTION_HEALTH_URL");
    }
  });

  it("promoting a Desktop release does not redeploy Cloud, and the Desktop private key never reaches Central", () => {
    expect(productionRelease).not.toMatch(/coolify/i);
    expect(promoteRoute).not.toContain("DESKTOP_RELEASE_PRIVATE_KEY_PEM");
  });
});
