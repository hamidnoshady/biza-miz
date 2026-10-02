import { describe, expect, it } from "vitest";
import { CLOUD_EMBED_UA_TOKEN, cloudPageUrl, isCloudEmbedUserAgent, mirroredPath } from "./cloud-embed";

describe("isCloudEmbedUserAgent", () => {
  it("recognises only the pane's token", () => {
    expect(isCloudEmbedUserAgent(`Mozilla/5.0 Electron/33 ${CLOUD_EMBED_UA_TOKEN}`)).toBe(true);
    expect(isCloudEmbedUserAgent("Mozilla/5.0 Chrome/130")).toBe(false);
    expect(isCloudEmbedUserAgent(null)).toBe(false);
  });
});

describe("cloudPageUrl", () => {
  it("builds the same screen on the cloud, https only", () => {
    expect(cloudPageUrl("https://cafe.example.com", "/accounting/reports?tab=sales")).toBe(
      "https://cafe.example.com/accounting/reports?tab=sales",
    );
    expect(cloudPageUrl("http://cafe.example.com", "/crm/overview")).toBeNull();
    expect(cloudPageUrl(null, "/crm/overview")).toBeNull();
  });

  it("never leaves the configured cloud's origin", () => {
    expect(cloudPageUrl("https://cafe.example.com", "//evil.example.org/x")).toBeNull();
    expect(cloudPageUrl("https://cafe.example.com", "https://evil.example.org/x")).toBeNull();
    expect(cloudPageUrl("https://cafe.example.com/", "/")).toBe("https://cafe.example.com/");
  });
});

describe("mirroredPath", () => {
  const cloud = "https://cafe.example.com";
  it("copies a cloud screen's path and query", () => {
    expect(mirroredPath("https://cafe.example.com/crm/deals?tab=open", cloud)).toBe("/crm/deals?tab=open");
  });

  it("leaves the desktop's address alone for sign-in pages, APIs and other hosts", () => {
    expect(mirroredPath("https://cafe.example.com/login?next=%2Fcrm", cloud)).toBeNull();
    expect(mirroredPath("https://cafe.example.com/desktop-login", cloud)).toBeNull();
    expect(mirroredPath("https://cafe.example.com/api/auth/desktop-session?code=x", cloud)).toBeNull();
    expect(mirroredPath("https://evil.example.org/crm", cloud)).toBeNull();
    expect(mirroredPath("not a url", cloud)).toBeNull();
    expect(mirroredPath("https://cafe.example.com/crm", null)).toBeNull();
  });

  it("does not mistake a path that merely starts with a sign-in word", () => {
    expect(mirroredPath("https://cafe.example.com/loginsights", cloud)).toBe("/loginsights");
  });
});
