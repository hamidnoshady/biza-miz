// src/lib/desktop-cloud-window.test.ts
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { cloudTarget, createCloudWindowController, offlinePageUrl } = require("../../electron/cloud-window.js");

type Handler = (...args: unknown[]) => void;

class FakeContents {
  handlers = new Map<string, Handler>();
  openHandler: ((details: { url: string }) => { action: string }) | null = null;
  setWindowOpenHandler(fn: (details: { url: string }) => { action: string }) {
    this.openHandler = fn;
  }
  on(event: string, fn: Handler) {
    this.handlers.set(event, fn);
  }
}

function fakeElectron() {
  const created: FakeWindow[] = [];
  class FakeWindow {
    webContents = new FakeContents();
    loaded: string[] = [];
    focused = 0;
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      created.push(this);
    }
    loadURL(url: string) {
      this.loaded.push(url);
      return Promise.resolve();
    }
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {
      this.focused += 1;
    }
    on() {}
  }
  const shell = { openExternal: vi.fn(async () => {}) };
  return { created, shell, BrowserWindow: FakeWindow };
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

describe("createCloudWindowController", () => {
  it("opens one sandboxed window with no preload and its own remembered login, and reuses it", () => {
    const electron = fakeElectron();
    const controller = createCloudWindowController(electron);
    expect(controller.open("https://cafe.example.com/accounting/reports")).toBe(true);
    expect(controller.open("https://cafe.example.com/crm/overview")).toBe(true);
    expect(electron.created).toHaveLength(1);
    const prefs = electron.created[0].options.webPreferences;
    expect(prefs.preload).toBeUndefined();
    expect(prefs).toMatchObject({ partition: "persist:cloud", sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(electron.created[0].loaded).toEqual([
      "https://cafe.example.com/accounting/reports",
      "https://cafe.example.com/crm/overview",
    ]);
  });

  it("refuses a non-https address without creating a window", () => {
    const electron = fakeElectron();
    expect(createCloudWindowController(electron).open("http://cafe.example.com/")).toBe(false);
    expect(electron.created).toHaveLength(0);
  });

  it("keeps navigation on the cloud's origin and sends anything else to the browser", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.example.com/accounting/reports");
    const navigate = electron.created[0].webContents.handlers.get("will-navigate")!;
    const inside = { preventDefault: vi.fn() };
    navigate(inside, "https://cafe.example.com/crm/overview");
    expect(inside.preventDefault).not.toHaveBeenCalled();
    const outside = { preventDefault: vi.fn() };
    navigate(outside, "https://elsewhere.example.org/");
    expect(outside.preventDefault).toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledWith("https://elsewhere.example.org/");
  });

  it("shows the offline page when the cloud cannot be reached", () => {
    const electron = fakeElectron();
    createCloudWindowController(electron).open("https://cafe.example.com/accounting/reports");
    const failed = electron.created[0].webContents.handlers.get("did-fail-load")!;
    failed({}, -106, "ERR_INTERNET_DISCONNECTED", "https://cafe.example.com/accounting/reports", true);
    expect(electron.created[0].loaded.at(-1)).toMatch(/^data:text\/html/);
  });
});

describe("offlinePageUrl", () => {
  it("escapes the retry address", () => {
    const html = decodeURIComponent(offlinePageUrl('https://a.example.com/"><script>x</script>').split(",")[1]);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
