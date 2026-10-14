import { describe, expect, it } from "vitest";
import {
  CLOUD_EMBED_ATTRIBUTE,
  CLOUD_EMBED_MARKER_SCRIPT,
  CLOUD_EMBED_UA_TOKEN,
  cloudPageUrl,
  cloudThemeScript,
  isCloudEmbedUserAgent,
  mirroredPath,
} from "./cloud-embed";

describe("isCloudEmbedUserAgent", () => {
  it("recognises only the pane's token", () => {
    expect(isCloudEmbedUserAgent(`Mozilla/5.0 Electron/33 ${CLOUD_EMBED_UA_TOKEN}`)).toBe(true);
    expect(isCloudEmbedUserAgent("Mozilla/5.0 Chrome/130")).toBe(false);
    expect(isCloudEmbedUserAgent(null)).toBe(false);
  });
});

describe("CLOUD_EMBED_MARKER_SCRIPT", () => {
  function run(userAgent: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const documentElement = { setAttribute: (name: string, value: string) => (attributes[name] = value) };
    new Function("navigator", "document", CLOUD_EMBED_MARKER_SCRIPT)({ userAgent }, { documentElement });
    return attributes;
  }

  it("marks the page only inside the pane", () => {
    expect(run(`Mozilla/5.0 Electron/44 ${CLOUD_EMBED_UA_TOKEN}`)).toEqual({ [CLOUD_EMBED_ATTRIBUTE]: "" });
    expect(run("Mozilla/5.0 Electron/44 Safari/537.36")).toEqual({});
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

describe("cloudThemeScript", () => {
  function run(script: string, stored: string | null) {
    const store = new Map<string, string>(stored === null ? [] : [["theme", stored]]);
    const events: Array<{ type: string; init: Record<string, unknown> }> = [];
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    class StorageEvent {
      constructor(public type: string, public init: Record<string, unknown>) {}
    }
    const window = { dispatchEvent: (event: StorageEvent) => void events.push(event) };
    new Function("localStorage", "window", "StorageEvent", script)(localStorage, window, StorageEvent);
    return { stored: store.get("theme"), events };
  }

  it("stores the till's theme and tells the open page to switch", () => {
    const result = run(cloudThemeScript("dark")!, "light");
    expect(result.stored).toBe("dark");
    expect(result.events).toEqual([
      { type: "storage", init: { key: "theme", oldValue: "light", newValue: "dark" } },
    ]);
  });

  it("does nothing when the page already wears it", () => {
    expect(run(cloudThemeScript("light")!, "light").events).toEqual([]);
  });

  it("sends only light or dark", () => {
    expect(cloudThemeScript("system")).toBeNull();
    expect(cloudThemeScript(undefined)).toBeNull();
    expect(cloudThemeScript('dark");alert(1);("')).toBeNull();
  });
});
