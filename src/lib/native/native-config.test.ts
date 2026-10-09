/**
 * Drift guards for the Android TWA runtime (issue #884).
 *
 * The bridge contract, the environment table, and the Digital Asset Links file
 * are read by three consumers: this web code, the Gradle build, and the
 * instrumented Android tests. These checks make sure each consumer still agrees
 * with the shared JSON, so a change in one place cannot silently break another.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import assetLinks from "../../../public/.well-known/assetlinks.json";
import contract from "../../../config/native-bridge-contract.json";
import environments from "../../../config/android-environments.json";
import {
  NATIVE_CAPABILITIES,
  NATIVE_CAPABILITY_MIN_BRIDGE,
  NATIVE_COMMAND_MIN_BRIDGE,
  NATIVE_COMMANDS,
  NATIVE_ENVIRONMENTS,
  NATIVE_ERROR_CODES,
  NATIVE_EVENTS,
  NATIVE_PERMISSION_STATES,
  NATIVE_BRIDGE_VERSION,
} from "./bridge-contract";
import { ANDROID_PACKAGE_ENVIRONMENTS } from "./native-environment";

function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");
}

const sorted = (values: readonly string[]) => [...values].sort();

describe("bridge contract matches its TypeScript mirror", () => {
  it("uses the protocol version in the JSON", () => {
    expect(NATIVE_BRIDGE_VERSION).toBe(contract.bridgeVersion);
  });

  it("has the same commands", () => {
    expect(sorted(NATIVE_COMMANDS)).toEqual(sorted(Object.keys(contract.commands)));
  });

  it("has the same events", () => {
    expect(sorted(NATIVE_EVENTS)).toEqual(sorted(Object.keys(contract.events)));
  });

  it("has the same error codes", () => {
    expect(sorted(NATIVE_ERROR_CODES)).toEqual(sorted(contract.errorCodes));
  });

  it("has the same permission states", () => {
    expect(sorted(NATIVE_PERMISSION_STATES)).toEqual(sorted(contract.permissionStates));
  });

  it("has the same environments", () => {
    expect(sorted(NATIVE_ENVIRONMENTS)).toEqual(sorted(contract.environments));
  });

  it("has the same capabilities, each with the same minimum bridge version", () => {
    expect(sorted(NATIVE_CAPABILITIES)).toEqual(sorted(Object.keys(contract.capabilities)));
    for (const capability of NATIVE_CAPABILITIES) {
      expect(NATIVE_CAPABILITY_MIN_BRIDGE[capability]).toBe(contract.capabilities[capability].nativeMinBridgeVersion);
    }
  });

  it("has the same minimum bridge version for each command", () => {
    for (const command of NATIVE_COMMANDS) {
      expect(NATIVE_COMMAND_MIN_BRIDGE[command]).toBe(contract.commands[command].minBridgeVersion);
    }
  });

  it("never declares a command or event that needs a bridge newer than the current protocol", () => {
    for (const spec of [...Object.values(contract.commands), ...Object.values(contract.events)]) {
      expect(spec.minBridgeVersion).toBeLessThanOrEqual(contract.bridgeVersion);
    }
  });

  it("keeps the command set small: no generic executor, only named commands", () => {
    expect(NATIVE_COMMANDS).toEqual(["app.info", "notifications.status"]);
  });
});

describe("environment table", () => {
  it("has exactly the three environments the contract names", () => {
    expect(sorted(Object.keys(environments.environments))).toEqual(sorted(NATIVE_ENVIRONMENTS));
  });

  it("gives every environment a distinct applicationId", () => {
    const ids = Object.values(environments.environments).map((spec) => spec.applicationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives production the applicationId that Play already knows", () => {
    expect(environments.environments.production.applicationId).toBe("com.bizamiz.app");
  });

  it("keeps every webOrigin either empty (must be supplied at build time) or a bare https origin", () => {
    for (const spec of Object.values(environments.environments)) {
      if (spec.webOrigin === "") continue;
      expect(spec.webOrigin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    }
  });

  it("never ships a placeholder origin for staging or production", () => {
    expect(environments.environments.staging.webOrigin).toBe("");
    expect(environments.environments.production.webOrigin).toBe("");
  });

  it("maps every applicationId to its environment on the web side", () => {
    for (const [env, spec] of Object.entries(environments.environments)) {
      expect(ANDROID_PACKAGE_ENVIRONMENTS[spec.applicationId]).toBe(env);
    }
  });
});

describe("Digital Asset Links", () => {
  it("is an array with one statement per environment package", () => {
    const packages = assetLinks.map((statement) => statement.target.package_name);
    expect(sorted(packages)).toEqual(sorted(Object.values(environments.environments).map((spec) => spec.applicationId)));
  });

  it("grants the TWA the two relations it needs and nothing else", () => {
    for (const statement of assetLinks) {
      expect(sorted(statement.relation)).toEqual([
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.use_as_origin",
      ]);
      expect(statement.target.namespace).toBe("android_app");
    }
  });

  it("lists certificate fingerprints only in the form Digital Asset Links expects", () => {
    for (const statement of assetLinks) {
      expect(Array.isArray(statement.target.sha256_cert_fingerprints)).toBe(true);
      for (const fingerprint of statement.target.sha256_cert_fingerprints) {
        expect(fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      }
    }
  });
});

describe("Android build reads the shared contract", () => {
  it("loads both JSON files instead of copying their values", () => {
    const gradle = repoFile("android/app/build.gradle.kts");
    expect(gradle).toContain("config/native-bridge-contract.json");
    expect(gradle).toContain("config/android-environments.json");
  });

  it("pins the Gradle wrapper to a checksum-verified distribution", () => {
    const properties = repoFile("android/gradle/wrapper/gradle-wrapper.properties");
    expect(properties).toMatch(/^distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.14\.3-bin\.zip$/m);
    expect(properties).toMatch(/^distributionSha256Sum=[0-9a-f]{64}$/m);
    expect(properties).toMatch(/^validateDistributionUrl=true$/m);
  });
});
