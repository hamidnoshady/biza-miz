/**
 * Issue #1001 — the Electron shell's hardening is wired, not just documented.
 *
 * Each case asserts one edge that used to be missing and that no unit test on a
 * single module can see on its own: the renderer-facing shell has no
 * owner-creating smoke code, every IPC handler is registered through the sender
 * check, the single-instance lock is taken *after* the storage location is
 * final, and the installer carries the fuses/appId/uninstall-cleanup the issue
 * asked for.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { RULE_NAME } = require("../../electron/firewall-manager.js") as { RULE_NAME: string };

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");
const mainJs = read("electron", "main.js");
const backendManager = read("electron", "backend-manager.js");
const preloadJs = read("electron", "preload.js");
const desktopManifest = JSON.parse(read("electron", "package.json")) as {
  build: {
    appId: string;
    files: string[];
    nsis: { guid?: string; include?: string; deleteAppDataOnUninstall?: boolean };
    electronFuses?: Record<string, boolean>;
  };
};

/** electron-builder's default NSIS GUID: uuidv5(appId, its fixed namespace). */
function nsisGuidFor(appId: string): string {
  const namespace = Buffer.from("50e065bc-3134-11e6-9bab-38c9862bdaf3".replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(Buffer.concat([namespace, Buffer.from(appId, "utf8")])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

describe("the shipped main process has no smoke backdoor", () => {
  it("neither defines the probe nor carries its hardcoded password", () => {
    expect(mainJs).not.toMatch(/function\s+runSmokeProbe/);
    expect(mainJs).not.toContain("Packaged-Test-Password");
    expect(mainJs).toContain('require("./smoke-probe")');
    // The probe is reached only in smoke mode.
    expect(mainJs).toMatch(/if \(process\.env\.DESKTOP_SMOKE_MARKER\) \{\s*\n\s*\/\//);
  });
});

describe("IPC authority", () => {
  it("registers every handler through the trusted-sender wrapper", () => {
    expect(mainJs).not.toMatch(/ipcMain\.handle\(/);
    expect(mainJs).toContain("registerTrustedHandler(ipcMain, channel");
    // The bridge's channels are the ones the wrapper serves.
    const channels = [...preloadJs.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1]);
    expect(channels.length).toBeGreaterThan(20);
    for (const channel of channels) expect(mainJs, channel).toContain(`handleIpc("${channel}"`);
  });

  it("keeps the gateway's own distinct refusal on top of the shared check", () => {
    expect(read("electron", "gateway-ipc-authorization.js")).toContain('"gateway_sender_forbidden"');
  });
});

describe("navigation and permissions are wired into the window", () => {
  it("uses the guard for navigations instead of the old single will-navigate listener", () => {
    expect(mainJs).toContain("installNavigationGuard(mainWindow.webContents, appUrl, shell)");
    expect(mainJs).not.toMatch(/webContents\.on\("will-navigate"/);
    const guard = read("electron", "navigation-guard.js");
    for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      expect(guard, event).toContain(`"${event}"`);
    }
  });

  it("installs deny-by-default permissions for the window session and the cloud partition", () => {
    expect(mainJs).toContain("installPermissionHandlers(session.defaultSession");
    expect(mainJs).toContain("installPermissionHandlers(session.fromPartition(CLOUD_PARTITION), { appOrigin: null })");
  });
});

describe("server supervision", () => {
  it("arms the restart listener only once the server has passed readiness", () => {
    expect(backendManager).toContain("onUnexpectedExit(listener)");
    expect(backendManager).toMatch(/this\.ready = true;\s*\n\s*this\.watchServer\(\);/);
    expect(backendManager).toContain("async restartServer()");
    expect(mainJs).toContain("startServerSupervision()");
    expect(mainJs).toContain("backend.restartServer()");
  });

  it("asks the owner only after the supervisor's attempts are spent", () => {
    expect(mainJs).toContain("onExhausted:");
    expect(mainJs).toContain("showServerCrashRecovery");
  });
});

describe("startup ordering", () => {
  it("takes the single-instance lock after the storage location is final", () => {
    const bootstrapCall = mainJs.indexOf("await runStorageBootstrap();");
    const lockCall = mainJs.indexOf("app.requestSingleInstanceLock()", bootstrapCall);
    const secondInstance = mainJs.indexOf("registerSecondInstanceHandler();", bootstrapCall);
    expect(bootstrapCall).toBeGreaterThan(-1);
    expect(lockCall).toBeGreaterThan(bootstrapCall);
    expect(secondInstance).toBeGreaterThan(lockCall);
    // It is taken exactly once, in that window-ready handler.
    expect(mainJs.match(/app\.requestSingleInstanceLock\(\)/g)).toHaveLength(1);
  });

  it("does not fall straight back into boot after 'Open logs'", () => {
    expect(mainJs).toMatch(/shell\.showItemInFolder\(logger\.path\);\s*\n\s*return showStartupFailure\(error, \{ logged: true \}\);/);
    expect(mainJs).not.toMatch(/choice === "logs"/);
  });
});

describe("installer configuration", () => {
  it("declares the new appId but keeps the existing install's NSIS identity", () => {
    expect(desktopManifest.build.appId).toBe("com.businesssuite.desktop");
    // An upgrade must install over the existing app rather than beside it.
    expect(desktopManifest.build.nsis.guid).toBe(nsisGuidFor("com.cafepos.desktop"));
  });

  it("flips the fuses the design allows, and keeps RunAsNode for the server child", () => {
    expect(desktopManifest.build.electronFuses).toEqual({
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
    // The server child is spawned as process.execPath with ELECTRON_RUN_AS_NODE.
    expect(backendManager).toContain('ELECTRON_RUN_AS_NODE: "1"');
  });

  it("ships an uninstaller cleanup for the firewall rule and the protocol handler", () => {
    const include = desktopManifest.build.nsis.include;
    expect(include).toBe("scripts/installer-cleanup.nsh");
    const nsh = read("electron", "scripts", "installer-cleanup.nsh");
    // The rule name must be the one the app creates, not a copy that can drift.
    expect(nsh).toContain(RULE_NAME);
    expect(nsh).toContain("netsh advfirewall firewall delete rule");
    expect(nsh).toContain('DeleteRegKey HKCU "Software\\Classes\\businesssuite"');
    expect(nsh).toContain("customUnInstall");
    expect(existsSync(path.join(root, "electron", include!))).toBe(true);
    // Application data is still the owner's after an uninstall.
    expect(desktopManifest.build.nsis.deleteAppDataOnUninstall).toBe(false);
  });

  it("packages every module the new hardening needs", () => {
    for (const file of [
      "ipc-sender.js",
      "navigation-guard.js",
      "permissions.js",
      "print-target-guard.js",
      "server-supervisor.js",
      "smoke-probe.js",
    ]) {
      expect(desktopManifest.build.files, file).toContain(file);
    }
  });
});
