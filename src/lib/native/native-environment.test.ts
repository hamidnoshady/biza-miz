import { describe, expect, it } from "vitest";
import {
  ANDROID_PACKAGE_ENVIRONMENTS,
  androidPackageFromReferrer,
  detectNativeRuntime,
} from "./native-environment";

describe("androidPackageFromReferrer", () => {
  it.each([
    ["android-app://com.bizamiz.app", "com.bizamiz.app"],
    ["android-app://com.bizamiz.app/", "com.bizamiz.app"],
    ["android-app://com.bizamiz.app/some/path?x=1", "com.bizamiz.app"],
    ["android-app://com.bizamiz.app.staging", "com.bizamiz.app.staging"],
    ["android-app://com.bizamiz.app.dev", "com.bizamiz.app.dev"],
  ])("reads the allowlisted package from %s", (referrer, expected) => {
    expect(androidPackageFromReferrer(referrer)).toBe(expected);
  });

  it.each([
    "android-app://com.bizamiz.application",
    "android-app://com.bizamiz.app.evil",
    "android-app://com.bizamiz.app:443",
    "android-app://com.bizamiz.app@evil.example",
    "android-app://com.example.other",
    "https://com.bizamiz.app/",
    "https://evil.example/android-app://com.bizamiz.app",
    "",
  ])("rejects %s", (referrer) => {
    expect(androidPackageFromReferrer(referrer)).toBeNull();
  });

  it("maps each allowlisted package to its environment", () => {
    expect(ANDROID_PACKAGE_ENVIRONMENTS).toEqual({
      "com.bizamiz.app": "production",
      "com.bizamiz.app.staging": "staging",
      "com.bizamiz.app.dev": "development",
    });
  });
});

describe("detectNativeRuntime", () => {
  it("detects a TWA from a live allowlisted referrer and says it came from the referrer", () => {
    expect(detectNativeRuntime({ referrer: "android-app://com.bizamiz.app", remembered: null })).toEqual({
      kind: "android-twa",
      androidPackage: "com.bizamiz.app",
      environment: "production",
      fromReferrer: true,
    });
  });

  it("keeps detecting the TWA after a reload strips the referrer, using the remembered package", () => {
    expect(detectNativeRuntime({ referrer: "", remembered: "com.bizamiz.app.staging" })).toEqual({
      kind: "android-twa",
      androidPackage: "com.bizamiz.app.staging",
      environment: "staging",
      fromReferrer: false,
    });
  });

  it("ignores a remembered value that is not on the allowlist", () => {
    expect(detectNativeRuntime({ referrer: "", remembered: "com.attacker.app" })).toEqual({
      kind: "web",
      androidPackage: null,
      environment: null,
      fromReferrer: false,
    });
  });

  it("prefers the live referrer over a remembered package", () => {
    const result = detectNativeRuntime({
      referrer: "android-app://com.bizamiz.app.dev",
      remembered: "com.bizamiz.app",
    });
    expect(result.androidPackage).toBe("com.bizamiz.app.dev");
    expect(result.fromReferrer).toBe(true);
  });

  it("treats an ordinary browser visit as web", () => {
    expect(detectNativeRuntime({ referrer: "https://www.google.com/", remembered: null }).kind).toBe("web");
  });
});
