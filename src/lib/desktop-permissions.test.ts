/**
 * Issue #1001 — permissions are deny-by-default.
 *
 * Electron's defaults were in force for both the till window and the remote
 * `persist:cloud` webview. The product needs the camera (barcode scanner,
 * inventory vision count) and clipboard write (the settings screens copy tokens
 * and links); everything else must be refused.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { permissionDecision, installPermissionHandlers } = require("../../electron/permissions.js") as {
  permissionDecision: (
    permission: string,
    requestingOrigin: string | null,
    options?: { appOrigin?: string | null; details?: { mediaTypes?: string[] } },
  ) => boolean;
  installPermissionHandlers: (
    session: unknown,
    options: { appOrigin?: string | null },
  ) => { permissionDecision: typeof permissionDecision };
};

const APP = "http://127.0.0.1:3000";
const app = { appOrigin: APP };

describe("permissionDecision", () => {
  it("grants the camera to the app origin only", () => {
    expect(permissionDecision("media", APP, { ...app, details: { mediaTypes: ["video"] } })).toBe(true);
    // Audio (microphone) is not part of the product and stays refused.
    expect(permissionDecision("media", APP, { ...app, details: { mediaTypes: ["audio"] } })).toBe(false);
    expect(permissionDecision("media", APP, { ...app, details: { mediaTypes: ["audio", "video"] } })).toBe(true);
    // A remote document in the cloud partition (appOrigin null) gets nothing.
    expect(permissionDecision("media", "https://cafe.example.com", { appOrigin: null, details: { mediaTypes: ["video"] } })).toBe(false);
  });

  it("refuses a request from another origin even in the app session", () => {
    expect(permissionDecision("media", "https://evil.example", { ...app, details: { mediaTypes: ["video"] } })).toBe(false);
    expect(permissionDecision("notifications", "https://evil.example", app)).toBe(false);
  });

  it("keeps clipboard write for the copy buttons and refuses everything else", () => {
    expect(permissionDecision("clipboard-sanitized-write", APP, app)).toBe(true);
    for (const permission of [
      "notifications",
      "geolocation",
      "midi",
      "midiSysex",
      "pointerLock",
      "fullscreen",
      "openExternal",
      "hid",
      "serial",
      "usb",
      "display-capture",
      "clipboard-read",
      "speaker-selection",
      "unknown-permission",
      "",
    ]) {
      expect(permissionDecision(permission, APP, app), permission).toBe(false);
    }
  });
});

describe("installPermissionHandlers", () => {
  it("installs both the request and the check handler on the session", () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const session = {
      setPermissionRequestHandler: (fn: (...args: unknown[]) => unknown) => {
        handlers.request = fn;
      },
      setPermissionCheckHandler: (fn: (...args: unknown[]) => unknown) => {
        handlers.check = fn;
      },
    };
    installPermissionHandlers(session, { appOrigin: APP });
    expect(handlers.request).toBeTypeOf("function");
    expect(handlers.check).toBeTypeOf("function");

    const callback = vi.fn();
    handlers.request({}, "media", callback, { requestingUrl: `${APP}/dashboard/inventory`, mediaTypes: ["video"] });
    expect(callback).toHaveBeenCalledWith(true);

    callback.mockClear();
    handlers.request({}, "media", callback, { requestingUrl: "https://evil.example/", mediaTypes: ["video"] });
    expect(callback).toHaveBeenCalledWith(false);

    expect(handlers.check({}, "media", APP, { mediaTypes: ["video"] })).toBe(true);
    expect(handlers.check({}, "geolocation", APP, {})).toBe(false);
  });

  it("denies every device permission to the cloud partition", () => {
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    installPermissionHandlers(
      {
        setPermissionRequestHandler: (fn: (...args: unknown[]) => unknown) => {
          handlers.request = fn;
        },
        setPermissionCheckHandler: (fn: (...args: unknown[]) => unknown) => {
          handlers.check = fn;
        },
      },
      { appOrigin: null },
    );
    const callback = vi.fn();
    handlers.request({}, "media", callback, { requestingUrl: "https://cafe.example.com/", mediaTypes: ["video"] });
    expect(callback).toHaveBeenCalledWith(false);
    expect(handlers.check({}, "media", "https://cafe.example.com", { mediaTypes: ["video"] })).toBe(false);
  });
});
