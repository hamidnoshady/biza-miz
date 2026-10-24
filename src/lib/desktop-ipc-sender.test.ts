/**
 * Issue #1001 — every `desktop:*` IPC handler must re-check its caller.
 *
 * The preload bridge is exposed to whatever the window's main frame loads, so
 * "the window loaded our app once" is not proof about the current caller. These
 * cases pin the three properties that matter: same webContents, main frame, and
 * the application origin — plus the registration wrapper that makes the check
 * non-optional for every handler `main.js` adds.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { isTrustedAppFrame, assertTrustedSender, registerTrustedHandler } = require(
  "../../electron/ipc-sender.js",
) as {
  isTrustedAppFrame: (event: unknown, window: unknown, appUrl: string | null) => boolean;
  assertTrustedSender: (event: unknown, window: unknown, appUrl: string | null) => void;
  registerTrustedHandler: (
    ipcMain: { handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => void },
    channel: string,
    context: { window: () => unknown; appUrl: () => string | null },
    handler: (event: unknown, payload: unknown) => unknown,
  ) => void;
};

const APP_URL = "http://127.0.0.1:3000";

function fixture() {
  const mainFrame = { url: `${APP_URL}/settings/connections` };
  const webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  return { window, webContents, mainFrame, event };
}

describe("IPC sender trust", () => {
  it("accepts only this window's main frame on the app origin", () => {
    const f = fixture();
    expect(isTrustedAppFrame(f.event, f.window, APP_URL)).toBe(true);
    // Any path on the app origin is the app.
    f.mainFrame.url = `${APP_URL}/accounting/ledger`;
    expect(isTrustedAppFrame(f.event, f.window, APP_URL)).toBe(true);
  });

  it("refuses a webview guest, a subframe, a foreign origin and a dead window", () => {
    const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
      // A <webview> guest is a different webContents.
      (f) => {
        f.event.sender = { mainFrame: f.mainFrame };
      },
      // A subframe of the app page is not the main frame.
      (f) => {
        f.event.senderFrame = { url: `${APP_URL}/frame` };
      },
      // A redirect (or open redirect) that loaded another origin in the frame.
      (f) => {
        f.mainFrame.url = "https://evil.example/settings";
      },
      // A window that has been destroyed, or no app URL known yet.
      (f) => {
        f.window.isDestroyed = () => true;
      },
    ];
    for (const mutate of cases) {
      const f = fixture();
      mutate(f);
      expect(isTrustedAppFrame(f.event, f.window, APP_URL)).toBe(false);
      expect(() => assertTrustedSender(f.event, f.window, APP_URL)).toThrow("ipc_sender_forbidden");
    }
    const f = fixture();
    expect(isTrustedAppFrame(f.event, f.window, null)).toBe(false);
    expect(isTrustedAppFrame(f.event, null as never, APP_URL)).toBe(false);
  });

  it("registers handlers through the check, reading the window per call", async () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipcMain = {
      handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => {
        listeners.set(channel, listener);
      },
    };
    let current: ReturnType<typeof fixture> | null = null;
    const handler = vi.fn(async (_event: unknown, payload: unknown) => ({ payload }));
    registerTrustedHandler(ipcMain, "desktop:print-send-raw", { window: () => current?.window ?? null, appUrl: () => APP_URL }, handler);

    const listener = listeners.get("desktop:print-send-raw")!;
    // Before the window exists nothing can call it.
    await expect(listener(fixture().event, { a: 1 })).rejects.toThrow("ipc_sender_forbidden");

    current = fixture();
    await expect(listener(current.event, { a: 1 })).resolves.toEqual({ payload: { a: 1 } });
    expect(handler).toHaveBeenCalledTimes(1);

    // A navigated window stops being a valid caller without any re-registration.
    const hijacked = fixture();
    hijacked.mainFrame.url = "https://evil.example/";
    await expect(listener(hijacked.event, { a: 2 })).rejects.toThrow("ipc_sender_forbidden");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
