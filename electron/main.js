// Business Suite Windows desktop shell.
// The application server remains loopback-only; explicitly enabled phones and
// tablets use the separate HTTPS gateway in gateway-manager.js.
"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const { BackendManager } = require("./backend-manager");
const { createCertificateManager } = require("./certificate-manager");
const { FirewallManager } = require("./firewall-manager");
const { GatewayManager } = require("./gateway-manager");
const { createLogger } = require("./logger");
const nativePrinting = require("./native-printing");
const localStorageChecks = require("./local-storage");
const { computePaths, migrateLegacyLayout } = require("./app-paths");
const { DesktopUpdateEngine } = require("./update-engine");

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow = null;
  let backend = null;
  let gateway = null;
  let firewall = null;
  let logger = null;
  let updater = null;
  let quitting = false;
  let cleanupStarted = null;
  let ipcRegistered = false;

  function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  app.on("second-instance", focusMainWindow);

  async function createWindow(appUrl) {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 620,
      title: "Business Suite",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith(`${appUrl}/`) || url === appUrl) return;
      event.preventDefault();
      // A plain link off the app (e.g. «بازکردن نسخهٔ ابری») would otherwise do nothing.
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    });
    mainWindow.on("closed", () => { mainWindow = null; });
    await mainWindow.loadURL(appUrl);
  }

  async function gatewayStatus() {
    return { ...gateway.status(), firewall: await firewall.status(), logPath: logger.path };
  }

  function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.handle("pick-folder", async (_event, payload) => {
      const title = typeof payload?.title === "string" && payload.title ? payload.title : "پوشهٔ پشتیبان‌گیری";
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title,
      });
      return canceled ? null : filePaths[0];
    });

    // Local storage configuration (Section 3 of the desktop audit): let the
    // first-run wizard check a candidate folder's free space and actually
    // prove it is writable, BEFORE Postgres/attachments/backups are pointed
    // at it — see local-storage.js's header for the full rationale.
    ipcMain.handle("desktop:storage-suggest-root", async () => localStorageChecks.suggestedDefaultRoot());
    ipcMain.handle("desktop:storage-default-layout", async (_event, payload) => {
      const root = typeof payload?.root === "string" ? payload.root : "";
      if (!root.trim()) return null;
      return localStorageChecks.defaultLayout(root);
    });
    ipcMain.handle("desktop:storage-check-folder", async (_event, payload) => {
      const target = typeof payload?.path === "string" ? payload.path : "";
      const result = await localStorageChecks.evaluateFolder(target);
      if (!result.ok) logger.warn("Local storage folder check failed", { path: target, result });
      return result;
    });
    ipcMain.handle("desktop:gateway-status", gatewayStatus);
    ipcMain.handle("desktop:gateway-enable", async (_event, payload) => {
      const address = typeof payload?.address === "string" ? payload.address : "";
      const available = gateway.availableInterfaces();
      if (!available.some((item) => item.address === address)) throw new Error("invalid_lan_address");
      const port = backend.config.gatewayPort;
      const started = await gateway.start(address, port);
      backend.updateConfig((config) => {
        config.gateway = { enabled: true, selectedAddress: address };
      });
      return { ...(await gatewayStatus()), started };
    });
    ipcMain.handle("desktop:gateway-disable", async () => {
      await gateway.stop();
      backend.updateConfig((config) => {
        config.gateway = { enabled: false, selectedAddress: config.gateway?.selectedAddress || null };
      });
      return gatewayStatus();
    });
    ipcMain.handle("desktop:firewall-install", async () => {
      const result = await firewall.install(backend.config.gatewayPort);
      return { ...(await gatewayStatus()), firewall: result };
    });
    ipcMain.handle("desktop:firewall-remove", async () => {
      const result = await firewall.remove();
      return { ...(await gatewayStatus()), firewall: result };
    });
    ipcMain.handle("desktop:gateway-regenerate-certificate", async () => {
      const address = backend.config.gateway?.selectedAddress;
      if (!address) throw new Error("no_lan_address");
      await gateway.start(address, backend.config.gatewayPort, true);
      return gatewayStatus();
    });
    ipcMain.handle("desktop:show-ca-certificate", async () => {
      const certPath = gateway.certificates.caCertPath;
      if (!require("node:fs").existsSync(certPath)) gateway.certificates.ensureLeaf(gateway.availableInterfaces().map((item) => item.address));
      shell.showItemInFolder(certPath);
      return certPath;
    });
    ipcMain.handle("desktop:open-logs", async () => {
      shell.showItemInFolder(logger.path);
      return logger.path;
    });

    // Desktop updates: manual and background downloads share this one engine.
    // Renderer input is still treated as hostile: the engine validates SemVer,
    // HTTPS origin, exact size/hash, Authenticode publisher and backup evidence.
    ipcMain.handle("desktop:update-status", async () => updater.publicState());
    ipcMain.handle("desktop:update-policy", async (_event, payload) => updater.setPolicy(payload));
    ipcMain.handle("desktop:update-check", async (_event, payload) => updater.check(payload?.manifest ?? null));
    ipcMain.handle("desktop:update-download", async () => {
      try { return await updater.download(); } catch (error) { return updater.fail(error); }
    });
    ipcMain.handle("desktop:update-pause", async () => updater.pause());
    ipcMain.handle("desktop:update-cancel", async () => updater.cancel());
    ipcMain.handle("desktop:update-offline", async () => {
      const manifestChoice = await dialog.showOpenDialog({
        title: "فایل release-manifest.json را انتخاب کنید",
        properties: ["openFile"],
        filters: [{ name: "Release manifest", extensions: ["json"] }],
      });
      if (manifestChoice.canceled || !manifestChoice.filePaths[0]) return updater.publicState();
      const installerChoice = await dialog.showOpenDialog({
        title: "نصب‌کنندهٔ امضاشده را انتخاب کنید",
        properties: ["openFile"],
        defaultPath: path.dirname(manifestChoice.filePaths[0]),
        filters: [{ name: "Windows installer", extensions: ["exe"] }],
      });
      if (installerChoice.canceled || !installerChoice.filePaths[0]) return updater.publicState();
      return updater.prepareOffline(manifestChoice.filePaths[0], installerChoice.filePaths[0]);
    });
    ipcMain.handle("desktop:update-install-next-restart", async () => updater.scheduleNextRestart());
    ipcMain.handle("desktop:update-install-now", async () => performUpdateInstall());
    ipcMain.handle("desktop:update-show-backup", async () => {
      if (updater.state.backupPath) shell.showItemInFolder(updater.state.backupPath);
      return updater.state.backupPath ?? null;
    });

    // Native printing (Section 7 of the desktop audit): the desktop app talks
    // to Windows queues and network ESC/POS printers directly from this main
    // process — see native-printing.js's header for why the browser/cloud
    // product's separate loopback "print connector" is not needed here.
    ipcMain.handle("desktop:print-list-windows-printers", async () => {
      const result = await nativePrinting.listWindowsPrinters();
      if (!result.ok) logger.warn("Windows printer enumeration failed", result.detail);
      return result;
    });
    ipcMain.handle("desktop:print-discover-network", async () => {
      try {
        const printers = await nativePrinting.discoverNetworkPrinters();
        return { ok: true, printers };
      } catch (error) {
        logger.warn("Network printer discovery failed", error);
        return { ok: false, error: "print_failed", detail: error?.message };
      }
    });
    ipcMain.handle("desktop:print-probe", async (_event, payload) => {
      const target = payload?.target;
      const result = await nativePrinting.probeTarget(target);
      if (result.ok && result.reachable === false) logger.info("Printer probe unreachable", { target, detail: result.detail });
      return result;
    });
    ipcMain.handle("desktop:print-send-page", async (_event, payload) => {
      const printerName = typeof payload?.printerName === "string" ? payload.printerName : "";
      const dataBase64 = typeof payload?.dataBase64 === "string" ? payload.dataBase64 : "";
      let bytes;
      try {
        bytes = Buffer.from(dataBase64, "base64");
      } catch {
        return { ok: false, error: "invalid_printer", detail: "Print data is invalid." };
      }
      const result = await nativePrinting.sendPageToWindowsPrinter(printerName, bytes);
      if (result.ok) logger.info("Native page print handed off", { printerName, bytes: bytes.length });
      else logger.warn("Native page print failed", { printerName, error: result.error, detail: result.detail });
      return result;
    });
    ipcMain.handle("desktop:print-send-raw", async (_event, payload) => {
      const target = payload?.target;
      const dataBase64 = typeof payload?.dataBase64 === "string" ? payload.dataBase64 : "";
      let bytes;
      try {
        bytes = Buffer.from(dataBase64, "base64");
      } catch {
        return { ok: false, error: "invalid_printer", detail: "Print data is invalid." };
      }
      const result = await nativePrinting.sendRawToTarget(target, bytes);
      if (result.ok) logger.info("Native print delivered", { target, bytes: bytes.length });
      else logger.warn("Native print failed", { target, error: result.error, detail: result.detail });
      return result;
    });
  }

  async function runSmokeProbe(appUrl) {
    const firstStateResponse = await fetch(`${appUrl}/api/setup/state`, { cache: "no-store" });
    if (!firstStateResponse.ok) throw new Error(`setup state returned HTTP ${firstStateResponse.status}`);
    let state = await firstStateResponse.json();
    let authenticated = false;
    if (process.env.DESKTOP_SMOKE_BOOTSTRAP === "1" && state.needsBootstrap) {
      const bootstrap = await fetch(`${appUrl}/api/setup/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: "Packaged Runtime Test",
          locationName: "Windows Test Site",
          ownerName: "Test Owner",
          email: "packaged-runtime@example.invalid",
          password: "Packaged-Test-Password-2026",
          industry: "food_service",
          deploymentMode: "local",
        }),
      });
      if (!bootstrap.ok) throw new Error(`bootstrap returned HTTP ${bootstrap.status}: ${await bootstrap.text()}`);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] || "";
      const me = await fetch(`${appUrl}/api/auth/me`, { headers: { cookie } });
      authenticated = me.ok;
      state = await (await fetch(`${appUrl}/api/setup/state`, { headers: { cookie }, cache: "no-store" })).json();
    }
    const marker = process.env.DESKTOP_SMOKE_MARKER;
    if (!marker) throw new Error("DESKTOP_SMOKE_MARKER is required in smoke mode");
    require("node:fs").writeFileSync(marker, JSON.stringify({
      ok: true,
      needsBootstrap: Boolean(state.needsBootstrap),
      authenticated,
      instanceId: backend.config.instanceId,
      pgdata: require("node:fs").existsSync(path.join(computePaths(app.getPath("userData")).pgDataDir, "PG_VERSION")),
    }, null, 2));
  }

  /**
   * First-run local storage location (Section 3 of the desktop audit): ask
   * ONCE, before Postgres/config/logs land anywhere, whether this install's
   * data should live at the OS default `userData` path or on a drive/folder
   * the owner picks (a bigger disk, an external drive). Every later launch
   * reuses the answer via the marker file — see local-storage.js's header.
   *
   * Deliberately native dialogs rather than a second renderer window: this
   * runs before the application server (and therefore the whole Next.js UI)
   * exists, so there is nothing to load a web page against yet, and the
   * three questions here (default vs. custom, browse, confirm with the
   * space/access check result) map cleanly onto `dialog`'s built-in flows
   * without needing an HTML asset pipeline of its own.
   *
   * Never runs in packaged/CI smoke mode (`DESKTOP_SMOKE_MARKER`): an
   * unattended run must never block on a dialog nobody can answer, so it
   * always takes the default path there, exactly like every automated boot
   * before this feature existed.
   */
  async function runStorageBootstrap() {
    if (process.env.DESKTOP_SMOKE_MARKER) return;
    const fs = require("node:fs");
    try {
      const defaultUserDataDir = app.getPath("userData");
      // Checks BOTH the pre-Section-8 flat path and the post-migration
      // Configuration/ path: `migrateLegacyLayout()` (below, after this
      // function returns) moves config.json out of the flat location on
      // its first run, so an existing default-path install's SECOND launch
      // must still be recognised as "already has data here" — otherwise it
      // would incorrectly look like a fresh install and re-prompt for a
      // storage location every launch after the very first migration.
      const hasExistingConfigAtDefault =
        fs.existsSync(path.join(defaultUserDataDir, "config.json")) ||
        fs.existsSync(computePaths(defaultUserDataDir).configPath);
      const { root: markerRoot } = await localStorageChecks.readStorageRootMarker(defaultUserDataDir);
      const decision = localStorageChecks.decideStorageBootstrap({ hasExistingConfigAtDefault, markerRoot });
      if (decision.action === "use_marker_root") {
        app.setPath("userData", decision.root);
        return;
      }
      if (decision.action === "use_default") return;
      await promptForStorageLocation(defaultUserDataDir);
    } catch (error) {
      // A failure here must never prevent the app from starting: fall back
      // silently to whatever Electron's own default already is. `logger` is
      // not created yet at this point in boot, so this is a plain console
      // write rather than the structured logger the rest of main.js uses.
      console.error("Local storage bootstrap failed; using the default location.", error);
    }
  }

  async function promptForStorageLocation(defaultUserDataDir) {
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "محل ذخیرهٔ اطلاعات",
      message: "اطلاعات این نصب — پایگاه‌داده، تنظیمات، گزارش‌ها و نسخه‌های پشتیبان — کجا ذخیره شود؟",
      detail: `مسیر پیش‌فرض ویندوز:\n${defaultUserDataDir}\n\nبرای استفاده از درایو یا پوشهٔ دیگری (مثلاً دیسکی بزرگ‌تر یا یک هارد خارجی)، «انتخاب پوشهٔ دیگر» را بزنید. این انتخاب فقط یک بار پرسیده می‌شود.`,
      buttons: ["استفاده از مسیر پیش‌فرض", "انتخاب پوشهٔ دیگر"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response !== 1) return;

    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "پوشهٔ ذخیرهٔ اطلاعات را انتخاب کنید",
    });
    if (canceled || !filePaths[0]) return;
    const chosenRoot = filePaths[0];

    const evaluation = await localStorageChecks.evaluateFolder(chosenRoot);
    if (!evaluation.ok) {
      const detailLines = [];
      if (evaluation.access && !evaluation.access.ok) {
        detailLines.push(`دسترسی نوشتن: ناموفق (${evaluation.access.error || "unknown"})`);
      }
      if (evaluation.space && !evaluation.space.ok) {
        detailLines.push(`بررسی فضای دیسک: ناموفق (${evaluation.space.error || "unknown"})`);
      }
      await dialog.showMessageBox({
        type: "warning",
        title: "این پوشه قابل استفاده نیست",
        message: "بررسی پوشهٔ انتخابی موفق نبود؛ مسیر پیش‌فرض استفاده می‌شود.",
        detail: detailLines.join("\n") || "خطای نامشخص.",
        buttons: ["باشه"],
        noLink: true,
      });
      return;
    }

    const spaceNote = evaluation.space?.ok
      ? `فضای آزاد: ${evaluation.space.freeLabel}${
          evaluation.space.recommended ? "" : " — کمتر از مقدار پیشنهادشدهٔ ۱ گیگابایت است"
        }`
      : "بررسی فضای دیسک ممکن نشد؛ ادامه دادن به مسئولیت شما است.";
    const confirm = await dialog.showMessageBox({
      type: "info",
      title: "تأیید پوشهٔ ذخیره‌سازی",
      message: `اطلاعات این نصب در پوشهٔ زیر ذخیره خواهد شد:\n${chosenRoot}`,
      detail: `دسترسی نوشتن: موفق\n${spaceNote}\n\nپس از تأیید، این مسیر همیشه استفاده می‌شود.`,
      buttons: ["تأیید و ادامه", "انصراف (استفاده از مسیر پیش‌فرض)"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (confirm.response !== 0) return;

    app.setPath("userData", chosenRoot);
    await localStorageChecks.writeStorageRootMarker(defaultUserDataDir, chosenRoot);
  }

  async function initialiseBackend() {
    backend = new BackendManager({ app, logger });
    const state = await backend.start();
    const certificates = createCertificateManager(state.userDataDir, logger);
    firewall = new FirewallManager(logger);
    gateway = new GatewayManager({ backend, certificateManager: certificates, logger });
    if (state.config.gateway?.enabled && state.config.gateway.selectedAddress) {
      try {
        await gateway.start(state.config.gateway.selectedAddress, state.config.gatewayPort);
      } catch (error) {
        // A changed Wi-Fi address must never prevent the desktop itself from
        // opening. The Local devices panel reports addressActive=false.
        logger.warn("Saved local HTTPS gateway could not be restarted", error);
      }
    }
    return state;
  }

  async function cleanup() {
    if (cleanupStarted) return cleanupStarted;
    cleanupStarted = (async () => {
      if (gateway) await gateway.stop().catch((error) => logger?.error("Gateway shutdown failed", error));
      if (backend) await backend.stop().catch((error) => logger?.error("Backend shutdown failed", error));
    })();
    return cleanupStarted;
  }

  async function performUpdateInstall() {
    try {
      // Backup while PostgreSQL is healthy, then shut every local writer down
      // before NSIS replaces binaries. A backup verification failure throws
      // before cleanup and leaves the running application untouched.
      await updater.createVerifiedBackup(backend);
      await cleanup();
      updater.launchInstaller();
      quitting = true;
      app.exit(0);
      return updater.publicState();
    } catch (error) {
      const state = updater.fail(error);
      // If shutdown had already started, restart this same binary so the user
      // is not stranded with a closed local service after a UAC/launch error.
      if (cleanupStarted) {
        app.relaunch();
        quitting = true;
        app.exit(1);
      }
      return state;
    }
  }

  function writeSmokeFailure(error) {
    const marker = process.env.DESKTOP_SMOKE_MARKER;
    if (!marker) return;
    const stage = error?.stage || "startup";
    let logTail = "";
    try {
      const text = require("node:fs").readFileSync(logger.path, "utf8");
      logTail = text.slice(-6_000);
    } catch {}
    require("node:fs").writeFileSync(marker, JSON.stringify({
      ok: false,
      stage,
      error: error?.message || String(error),
      cause: error?.cause?.message || null,
      stack: error?.stack || null,
      logPath: logger.path,
      logTail,
    }, null, 2));
  }

  async function showStartupFailure(error) {
    const stage = error?.stage || "startup";
    logger.error(`Fatal desktop startup failure at ${stage}`, error);
    const result = await dialog.showMessageBox({
      type: "error",
      title: "Business Suite could not start",
      message: `Startup failed at: ${stage}`,
      detail: `${error?.message || "Unknown startup error"}\n\nYour business data was not deleted. Diagnostic log:\n${logger.path}`,
      buttons: ["Retry", "Open logs", "Exit"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (result.response === 1) {
      shell.showItemInFolder(logger.path);
      return "logs";
    }
    return result.response === 0 ? "retry" : "exit";
  }

  async function bootWithRecovery() {
    for (;;) {
      try {
        cleanupStarted = null;
        const state = await initialiseBackend();
        // Reaching here proves both PostgreSQL and the packaged web backend
        // passed their health checks. Only now may a pending update be marked
        // successful (and only when app.getVersion() is the expected target).
        updater?.completeStartupHealth();
        if (process.env.DESKTOP_SMOKE_MARKER) {
          await runSmokeProbe(state.appUrl);
          await cleanup();
          quitting = true;
          app.exit(0);
          return;
        }
        registerIpc();
        await createWindow(state.appUrl);
        return;
      } catch (error) {
        await cleanup();
        if (process.env.DESKTOP_SMOKE_MARKER) {
          logger.error(`Packaged smoke failed at ${error?.stage || "startup"}`, error);
          writeSmokeFailure(error);
          quitting = true;
          app.exit(1);
          return;
        }
        const choice = await showStartupFailure(error);
        if (choice === "exit") {
          quitting = true;
          app.exit(1);
          return;
        }
        if (choice === "logs") continue;
      }
    }
  }

  app.whenReady().then(async () => {
    // Runs before the logger/backend so a first-run choice of storage
    // location also decides where logs and Postgres data end up — not just
    // where the config marker recording the choice lives.
    await runStorageBootstrap();
    // Section 8 folder split: one-time, idempotent move of an existing
    // install's flat config.json/pgdata/logs/gateway-certificates/
    // emergency-backups into Configuration/Data/Backup/Logs. Must run
    // AFTER the storage-location choice above (so it operates on the final
    // `userData` root) and BEFORE the logger/backend/certificate manager
    // below compute any path from that root, so nothing ever reads from
    // the pre-split flat locations. A failure here must never block
    // startup — the app keeps working from whatever layout already exists
    // (see app-paths.js's `migrateLegacyLayout` for why a failed move
    // leaves the source untouched rather than losing data).
    try {
      const migration = migrateLegacyLayout(app.getPath("userData"));
      if (migration.migrated && migration.results?.some((entry) => entry.action === "moved")) {
        console.log("Migrated existing install to the Configuration/Data/Backup/Logs folder layout.", migration.results);
      }
    } catch (error) {
      console.error("Folder-layout migration failed; continuing with the existing layout.", error);
    }
    logger = createLogger(app.getPath("userData"));
    updater = new DesktopUpdateEngine({ app, logger });
    updater.on("state", (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:update-state", state);
    });
    // The packaged backend refreshes the credential-bound Central target during
    // its normal sync tick. Electron consumes that narrow local handoff even
    // when no renderer or settings page is open.
    updater.checkPersistedTarget();
    const updateCheckTimer = setInterval(() => updater.checkPersistedTarget(), 15 * 60 * 1000);
    updateCheckTimer.unref();
    logger.info("Desktop process starting", { version: app.getVersion(), packaged: app.isPackaged });
    process.on("uncaughtException", (error) => logger.error("Uncaught desktop exception", error));
    process.on("unhandledRejection", (error) => logger.error("Unhandled desktop rejection", error));
    await bootWithRecovery();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && backend?.config) void createWindow(`http://127.0.0.1:${backend.config.appPort}`);
      else focusMainWindow();
    });
  }).catch(async (error) => {
    logger?.error("Desktop ready handler failed", error);
    await cleanup();
    app.exit(1);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (updater?.state.installOnNextRestart && updater.state.state === "ready_to_install") {
      void performUpdateInstall();
      return;
    }
    quitting = true;
    void cleanup().finally(() => app.exit(0));
  });
}
