// src/lib/desktop-cloud-pane.test.ts
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { cloudTarget, guardCloudPane, hardenCloudPane } = require("../../electron/cloud-pane.js");

type Handler = (...args: unknown[]) => void;

class FakeContents {
  handlers = new Map<string, Handler>();
  loaded: string[] = [];
  openHandler: ((details: { url: string }) => { action: string }) | null = null;
  setWindowOpenHandler(fn: (details: { url: string }) => { action: string }) {
    this.openHandler = fn;
  }
  on(event: string, fn: Handler) {
    this.handlers.set(event, fn);
  }
  loadURL(url: string) {
    this.loaded.push(url);
    return Promise.resolve();
  }
}

function guarded(origin = "https://cafe.example.com") {
  const contents = new FakeContents();
  const shell = { openExternal: vi.fn(async () => {}) };
  guardCloudPane(contents, origin, shell);
  return { contents, shell };
}

describe("cloudTarget", () => {
  it("accepts only https addresses", () => {
    expect(cloudTarget("https://cafe.app.example.com/accounting/reports")?.toString()).toBe(
      "https://cafe.app.example.com/accounting/reports",
    );
    expect(cloudTarget("http://cafe.app.example.com/")).toBeNull();
    expect(cloudTarget("javascript:alert(1)")).toBeNull();
    expect(cloudTarget("not a url")).toBeNull();
  });
});

describe("hardenCloudPane", () => {
  it("strips the preload and Node, sandboxes, and pins the cloud partition whatever the page asked for", () => {
    const prefs: Record<string, unknown> = { preload: "file:///evil.js", nodeIntegration: true, sandbox: false, contextIsolation: false };
    const params: Record<string, unknown> = { src: "https://cafe.example.com/crm/overview", partition: "persist:other", allowpopups: "true" };
    expect(hardenCloudPane(prefs, params)).toBe("https://cafe.example.com");
    expect(prefs.preload).toBeUndefined();
    expect(prefs).toMatchObject({ nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true });
    expect(params.partition).toBe("persist:cloud");
    expect(params.allowpopups).toBeUndefined();
  });

  it("refuses anything but an https address", () => {
    for (const src of ["http://cafe.example.com/", "file:///C:/x.html", "data:text/html,x", undefined]) {
      expect(hardenCloudPane({}, { src })).toBeNull();
    }
  });
});

describe("guardCloudPane", () => {
  it("keeps navigation on the cloud's origin and sends anything else to the browser", () => {
    const { contents, shell } = guarded();
    const navigate = contents.handlers.get("will-navigate")!;
    const inside = { preventDefault: vi.fn() };
    navigate(inside, "https://cafe.example.com/crm/overview");
    expect(inside.preventDefault).not.toHaveBeenCalled();
    const outside = { preventDefault: vi.fn() };
    navigate(outside, "https://elsewhere.example.org/");
    expect(outside.preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledWith("https://elsewhere.example.org/");
  });

  it("opens popups in the system browser, never as a window", () => {
    const { contents, shell } = guarded();
    expect(contents.openHandler!({ url: "https://help.example.org/" })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledWith("https://help.example.org/");
  });

  it("follows a same-origin redirect and sends any other host to the browser", () => {
    const { contents, shell } = guarded("https://cafe.ac.example.com");
    const redirect = contents.handlers.get("will-redirect")!;
    const same = { preventDefault: vi.fn() };
    redirect(same, "https://cafe.ac.example.com/login?next=%2Fcrm");
    expect(same.preventDefault).not.toHaveBeenCalled();
    for (const url of ["https://bistro.ac.example.com/", "http://cafe.ac.example.com/", "https://cafe.ac.example.com.evil.org/"]) {
      const event = { preventDefault: vi.fn() };
      redirect(event, url);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(shell.openExternal).toHaveBeenCalledWith(url);
    }
  });

  it("lets a subframe follow a cross-origin redirect (a website preview, a video embed)", () => {
    const { contents, shell } = guarded();
    const redirect = contents.handlers.get("will-redirect")!;
    const sub = { preventDefault: vi.fn(), isMainFrame: false };
    redirect(sub, "https://preview.example.org/home", false, false);
    expect(sub.preventDefault).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("sends billing and subscription to the system browser, and a client-side move returns to the last page", () => {
    const { contents, shell } = guarded();
    const event = { preventDefault: vi.fn() };
    contents.handlers.get("will-navigate")!(event, "https://cafe.example.com/settings/billing");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledWith("https://cafe.example.com/settings/billing");
    contents.handlers.get("did-navigate")!({}, "https://cafe.example.com/crm/overview");
    contents.handlers.get("did-navigate-in-page")!({}, "https://cafe.example.com/crm/deals?tab=open", true);
    contents.handlers.get("did-navigate-in-page")!({}, "https://cafe.example.com/embed/x", false);
    contents.handlers.get("did-navigate-in-page")!({}, "https://cafe.example.com/settings/subscription", true);
    expect(shell.openExternal).toHaveBeenCalledWith("https://cafe.example.com/settings/subscription");
    expect(contents.loaded.at(-1)).toBe("https://cafe.example.com/crm/deals?tab=open");
  });
});
