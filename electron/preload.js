"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", Object.freeze({
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
}));

contextBridge.exposeInMainWorld("businessSuiteDesktop", Object.freeze({
  isDesktop: true,
  pickFolder: (title) => ipcRenderer.invoke("pick-folder", { title }),
  /** Phase 45: open a cloud screen in the «نسخهٔ ابری» window (https only). */
  openCloud: (url) => ipcRenderer.invoke("desktop:open-cloud", { url }),
  /**
   * Local storage configuration (Section 3 of the desktop audit): a
   * first-run/settings check of a candidate data folder — free space on its
   * volume, and a real write/read/delete round trip — before the app commits
   * Postgres/attachments/backups to it. See electron/local-storage.js.
   */
  storage: Object.freeze({
    suggestDefaultRoot: () => ipcRenderer.invoke("desktop:storage-suggest-root"),
    defaultLayout: (root) => ipcRenderer.invoke("desktop:storage-default-layout", { root }),
    checkFolder: (path) => ipcRenderer.invoke("desktop:storage-check-folder", { path }),
  }),
  localGateway: Object.freeze({
    status: () => ipcRenderer.invoke("desktop:gateway-status"),
    enable: (address) => ipcRenderer.invoke("desktop:gateway-enable", { address }),
    disable: () => ipcRenderer.invoke("desktop:gateway-disable"),
    installFirewallRule: () => ipcRenderer.invoke("desktop:firewall-install"),
    removeFirewallRule: () => ipcRenderer.invoke("desktop:firewall-remove"),
    regenerateCertificate: () => ipcRenderer.invoke("desktop:gateway-regenerate-certificate"),
    showCaCertificate: () => ipcRenderer.invoke("desktop:show-ca-certificate"),
    openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  }),
  update: Object.freeze({
    status: () => ipcRenderer.invoke("desktop:update-status"),
    configure: (policy) => ipcRenderer.invoke("desktop:update-policy", policy),
    check: (manifest) => ipcRenderer.invoke("desktop:update-check", { manifest }),
    download: () => ipcRenderer.invoke("desktop:update-download"),
    pause: () => ipcRenderer.invoke("desktop:update-pause"),
    cancel: () => ipcRenderer.invoke("desktop:update-cancel"),
    selectOfflinePackage: () => ipcRenderer.invoke("desktop:update-offline"),
    installNow: () => ipcRenderer.invoke("desktop:update-install-now"),
    installOnNextRestart: () => ipcRenderer.invoke("desktop:update-install-next-restart"),
    showBackup: () => ipcRenderer.invoke("desktop:update-show-backup"),
    onState: (callback) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("desktop:update-state", listener);
      return () => ipcRenderer.removeListener("desktop:update-state", listener);
    },
  }),
  /**
   * Native printing (Section 7 of the desktop audit): the same
   * `{type:"windows", systemName}` / `{type:"network", ip, port}` target
   * shape `src/lib/printing/types.ts` already models, delivered straight
   * from this desktop process — no separate "print connector" install. The
   * printing settings UI (`src/lib/printing/client.ts`) prefers this bridge
   * over the loopback connector whenever `window.businessSuiteDesktop` is
   * present; the connector remains the path for the browser/cloud product.
   */
  printing: Object.freeze({
    listWindowsPrinters: () => ipcRenderer.invoke("desktop:print-list-windows-printers"),
    discoverNetworkPrinters: () => ipcRenderer.invoke("desktop:print-discover-network"),
    probe: (target) => ipcRenderer.invoke("desktop:print-probe", { target }),
    sendRaw: (target, dataBase64) => ipcRenderer.invoke("desktop:print-send-raw", { target, dataBase64 }),
    sendPage: (printerName, dataBase64) => ipcRenderer.invoke("desktop:print-send-page", { printerName, dataBase64 }),
  }),
}));

