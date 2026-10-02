import { describe, expect, it } from "vitest";
import {
  AEC_CAPABILITIES,
  AEC_OPERATING_PROFILES,
  AEC_OPERATING_PROFILE_LABELS,
  AEC_PROFILE_CAPABILITIES,
  AEC_SPECIALTIES,
  aecCapabilitiesForProfile,
  hasAecCapability,
  isAecOperatingProfile,
  isAecSpecialty,
} from "./aec";

describe("aec", () => {
  it("lists capabilities for every operating profile", () => {
    for (const profile of AEC_OPERATING_PROFILES) {
      expect(AEC_PROFILE_CAPABILITIES[profile]).toBeDefined();
      expect(AEC_PROFILE_CAPABILITIES[profile].length).toBeGreaterThan(0);
    }
  });
  it("has labels for every profile and specialty", () => {
    for (const p of AEC_OPERATING_PROFILES) expect(AEC_OPERATING_PROFILE_LABELS[p]).toBeTruthy();
    for (const s of AEC_SPECIALTIES) expect(s.length).toBeGreaterThan(0);
  });
  it("recognises operating profiles and specialties", () => {
    expect(isAecOperatingProfile("contractor")).toBe(true);
    expect(isAecOperatingProfile("nope")).toBe(false);
    expect(isAecSpecialty("architecture")).toBe(true);
    expect(isAecSpecialty("nope")).toBe(false);
  });
  it("capability helpers are consistent", () => {
    expect(aecCapabilitiesForProfile("contractor")).toContain("aec_procurement");
    expect(hasAecCapability("individual", "aec_procurement")).toBe(false);
    expect(AEC_CAPABILITIES.length).toBeGreaterThan(5);
  });
});
