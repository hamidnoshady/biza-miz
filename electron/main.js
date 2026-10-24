// Business Suite Windows desktop shell.
// The application server remains loopback-only; explicitly enabled phones and
// tablets use the separate HTTPS gateway in gateway-manager.js.
"use strict";
const { authorizeGatewayInvocation } = require("./gateway-ipc-authorization");

const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const { BackendManager, BackendStoppedError } = require("./backend-manager");
const { createCertificateManager } = require("./certificate-manager");
const { FirewallManager } = require("./firewall-manager");
const { GatewayManager } = require("./gateway-manager");
const { createLogger } = require("./logger");
const nativePrinting = require("./native-printing");
const localStorageChecks = require("./local-storage");
const { computePaths, migrateLegacyLayout } = require("./app-paths");
const { DesktopUpdateEngine } = require("./update-engine");
const { companionStatus, launchCompanion } = require("./support-companion");
const maintenanceGate = require("./maintenance-gate");
const { CLOUD_PARTITION, guardCloudPane, hardenCloudPane, hideCloudSidebar, stampEmbedAgent } = require("./cloud-pane");
const { registerTrustedHandler } = require("./ipc-sender");
const { installNavigationGuard } = require("./navigation-guard");
const { installPermissionHandlers } = require("./permissions");
const {
  MAX_PAGE_PAYLOAD_BYTES,
  MAX_RAW_PAYLOAD_BYTES,
  readPrintPayload,
  validatePrintTarget,
} = require("./print-target-guard");
const { ServerSupervisor } = require("./server-supervisor");
const { runSmokeProbe } = require("./smoke-probe");

// Phase 46: «ورود با حساب ابری» — the cloud hands the browser back to the app
// with businesssuite://cloud-login?code=…&state=…
const LOGIN_PROTOCOL = "businesssuite";
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(LOGIN_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(LOGIN_PROTOCOL);
}

/** The one link shape the app accepts; everything else in argv is ignored. */
function cloudLoginLink(argv) {
  for (const raw of argv ?? []) {
    if (typeof raw !== "string" || !raw.startsWith(`${LOGIN_PROTOCOL}://`)) continue;
    try {
      const url = new URL(raw);
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const token = /^[A-Za-z0-9_-]{16,128}$/;
      if (url.hostname === "cloud-login" && token.test(code) && token.test(state)) return { code, state };
    } catch {}
  }
  return null;
}

// Issue #1001 — `requestSingleInstanceLock()` is scoped to the app's `userData`
// path, and `runStorageBootstrap()` may point that path at the owner's chosen
// drive/folder. Taking the lock here (before the choice) let two instances each
// hold their own lock and run against different data roots, so the lock is
// acquired inside `app.whenReady()` once the location is final — see the
// `requestSingleInstanceLock()` call there.
function runDesktopShell() {
  let mainWindow = null;
  let backend = null;
  let gateway = null;
  let firewall = null;
  let logger = null;
  let updater = null;
  let quitting = false;
  let cleanupStarted = null;
  let ipcRegistered = false;
  let mainAppUrl = null;
  // A login link that arrived before the till window existed (a cold start from the browser).
  let pendingLoginLink = cloudLoginLink(process.argv);

  function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  /**
   * The local server finishes the sign-in: it checks `state` against the
   * cookie it set when the button was pressed (so a link nobody here asked
   * for signs nobody in), then redeems `code` with the cloud.
   */
  function completeCloudLogin(link) {
    if (!link) return;
    if (!mainWindow || !mainAppUrl) {
      pendingLoginLink = link;
      return;
    }
    const target = new URL("/api/auth/cloud-login/callback", mainAppUrl);
    target.searchParams.set("code", link.code);
    target.searchParams.set("state", link.state);
    void mainWindow.loadURL(target.toString()).catch(() => {});
    focusMainWindow();
  }

  // Registered only by the instance that owns the lock (see `app.whenReady()`).
  function registerSecondInstanceHandler() {
    app.on("second-instance", (_event, argv) => {
      focusMainWindow();
      completeCloudLogin(cloudLoginLink(argv));
    });
  }

  async function createWindow(appUrl) {
    // Issue #1001 — Electron's default permission policy is permissive and
    // applied to both this window and the remote `persist:cloud` webview.
    // Deny by default; the till window may use the camera (barcode scanning,
    // inventory vision count) and clipboard write, nothing else. The cloud pane
    // is a remote document and gets no device access at all — see permissions.js.
    let appOrigin = null;
    try {
      appOrigin = new URL(appUrl).origin;
    } catch {
      appOrigin = null;
    }
    installPermissionHandlers(session.defaultSession, { appOrigin });
    installPermissionHandlers(session.fromPartition(CLOUD_PARTITION), { appOrigin: null });

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
        // Phase 46: cloud screens render in a <webview> (cloud-pane.js hardens every one).
        webviewTag: true,
      },
    });
    let paneOrigin = null;
    mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      paneOrigin = hardenCloudPane(webPreferences, params);
      if (!paneOrigin) return event.preventDefault();
      // Every request to the cloud carries the embed token — service-worker
      // navigations included — so the cloud never draws its own sidebar here.
      const cloudSession = session.fromPartition(CLOUD_PARTITION);
      stampEmbedAgent(cloudSession, paneOrigin, params.useragent || cloudSession.getUserAgent());
    });
    mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
      if (!paneOrigin) return;
      guardCloudPane(contents, paneOrigin, shell);
      hideCloudSidebar(contents);
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    // Issue #1001 — `will-navigate` alone missed redirects and frame
    // navigations; navigation-guard.js covers all three and keeps a foreign
    // document (which would inherit this window's preload bridge) out of it.
    installNavigationGuard(mainWindow.webContents, appUrl, shell);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    mainAppUrl = appUrl;
    await mainWindow.loadURL(appUrl);
    const link = pendingLoginLink;
    pendingLoginLink = null;
    completeCloudLogin(link);
  }

  async function gatewayStatus() {
    return { ...gateway.status(), firewall: await firewall.status(), logPath: logger.path };
  }

  function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;
    // Issue #1001 — every handler below can act with desktop authority
    // (firewall/UAC, update install, gateway, printing, folder picking), and the
    // preload bridge is reachable from anything the window's main frame loads.
    // Registering through this wrapper makes "is the caller this window's main
    // frame on the app origin?" a property of registration, not of each handler.
    const handleIpc = (channel, handler) =>
      registerTrustedHandler(ipcMain, channel, { window: () => mainWindow, appUrl: () => mainAppUrl }, handler);

    handleIpc("pick-folder", async (_event, payload) => {
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
    handleIpc("desktop:storage-suggest-root", async () => localStorageChecks.suggestedDefaultRoot());
    handleIpc("desktop:storage-default-layout", async (_event, payload) => {
      const root = typeof payload?.root === "string" ? payload.root : "";
      if (!root.trim()) return null;
      return localStorageChecks.defaultLayout(root);
    });
    handleIpc("desktop:storage-check-folder", async (_event, payload) => {
      const target = typeof payload?.path === "string" ? payload.path : "";
      const result = await localStorageChecks.evaluateFolder(target);
      if (!result.ok) logger.warn("Local storage folder check failed", { path: target, result });
      return result;
    });
    handleIpc("desktop:gateway-status", async (event) => {
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
      return gatewayStatus();
    });
    handleIpc("desktop:gateway-enable", async (event, payload) => {
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
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
    handleIpc("desktop:gateway-disable", async (event) => {
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
      await gateway.stop();
      backend.updateConfig((config) => {
        config.gateway = { enabled: false, selectedAddress: config.gateway?.selectedAddress || null };
      });
      return gatewayStatus();
    });
    handleIpc("desktop:firewall-install", async (event) => {
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: "warning", buttons: ["انصراف", "تأیید تغییر دیوار آتش"], defaultId: 0, cancelId: 0,
        title: "تغییر دسترسی شبکهٔ محلی",
        message: "این کار قوانین دیوار آتش سیستم را تغییر می‌دهد و دسترسی دستگاه‌های شبکه به این برنامه را تحت تأثیر قرار می‌دهد. ادامه می‌دهید؟",
      });
      if (confirmation.response !== 1) throw new Error("gateway_action_cancelled");
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
      const result = await firewall.install(backend.config.gatewayPort);
      return { ...(await gatewayStatus()), firewall: result };
    });
    handleIpc("desktop:firewall-remove", async (event) => {
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
      const confirmation = await dialog.showMessageBox(mainWindow, {
        type: "warning", buttons: ["انصراف", "تأیید تغییر دیوار آتش"], defaultId: 0, cancelId: 0,
        title: "تغییر دسترسی شبکهٔ محلی",
        message: "این کار قوانین دیوار آتش سیستم را تغییر می‌دهد و دسترسی دستگاه‌های شبکه به این برنامه را تحت تأثیر قرار می‌دهد. ادامه می‌دهید؟",
      });
      if (confirmation.response !== 1) throw new Error("gateway_action_cancelled");
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
      const result = await firewall.remove();
      return { ...(await gatewayStatus()), firewall: result };
    });
    handleIpc("desktop:gateway-regenerate-certificate", async (event) => {
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
      const address = backend.config.gateway?.selectedAddress;
      if (!address) throw new Error("no_lan_address");
      await gateway.start(address, backend.config.gatewayPort, true);
      return gatewayStatus();
    });
    handleIpc("desktop:show-ca-certificate", async (event) => {
      await authorizeGatewayInvocation(event, mainWindow, mainAppUrl);
      const certPath = gateway.certificates.caCertPath;
      if (!require("node:fs").existsSync(certPath)) await gateway.certificates.ensureLeaf(gateway.availableInterfaces().map((item) => item.address));
      shell.showItemInFolder(certPath);
      return certPath;
    });
    handleIpc("desktop:open-logs", async () => {
      shell.showItemInFolder(logger.path);
      return logger.path;
    });
    // Issue #984 — the ticket UI's "open companion" action. Renderer input is
    // a ticket id hint only: launching authorizes nothing, and absence is
    // reported truthfully instead of failing silently.
    handleIpc("desktop:support-companion", async (_event, payload) => {
      if (payload && payload.action === "launch") {
        const ticketId = typeof payload.ticketId === "string" ? payload.ticketId.slice(0, 64) : null;
        return launchCompanion({ ticketId });
      }
      return companionStatus();
    });

    // Desktop updates: manual and background downloads share this one engine.
    // Renderer input is still treated as hostile: the engine validates SemVer,
    // HTTPS origin, exact size/hash, Authenticode publisher and backup evidence.
    handleIpc("desktop:update-status", async () => updater.publicState());
    handleIpc("desktop:update-policy", async (_event, payload) => updater.setPolicy(payload));
    handleIpc("desktop:update-check", async (_event, payload) => updater.check(payload?.manifest ?? null));
    handleIpc("desktop:update-download", async () => {
      try { return await updater.download(); } catch (error) { return updater.fail(error); }
    });
    handleIpc("desktop:update-pause", async () => updater.pause());
    handleIpc("desktop:update-cancel", async () => updater.cancel());
    handleIpc("desktop:update-offline", async () => {
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
    handleIpc("desktop:update-install-next-restart", async () => updater.scheduleNextRestart());
    handleIpc("desktop:update-install-now", async () => performUpdateInstall());
    handleIpc("desktop:update-postpone", async (_event, payload) => {
      try { return updater.postponeAutoInstall(payload?.hours); } catch (error) { return updater.fail(error); }
    });
    handleIpc("desktop:update-show-backup", async () => {
      if (updater.state.backupPath) shell.showItemInFolder(updater.state.backupPath);
      return updater.state.backupPath ?? null;
    });

    // Native printing (Section 7 of the desktop audit): the desktop app talks
    // to Windows queues and network ESC/POS printers directly from this main
    // process — see native-printing.js's header for why the browser/cloud
    // product's separate loopback "print connector" is not needed here.
    handleIpc("desktop:print-list-windows-printers", async () => {
      const result = await nativePrinting.listWindowsPrinters();
      if (!result.ok) logger.warn("Windows printer enumeration failed", result.detail);
      return result;
    });
    handleIpc("desktop:print-discover-network", async () => {
      try {
        const printers = await nativePrinting.discoverNetworkPrinters();
        return { ok: true, printers };
      } catch (error) {
        logger.warn("Network printer discovery failed", error);
        return { ok: false, error: "print_failed", detail: error?.message };
      }
    });
    // Issue #1001 — these three handlers were a raw TCP primitive: the renderer
    // supplied `{ip, port}` and arbitrary bytes, and the main process dialled it
    // (loopback services such as PostgreSQL included). print-target-guard.js
    // narrows the target to an RFC1918 address on this machine's own subnets
    // with an allow-listed raw-print port, and bounds the payload before it is
    // decoded. A refused target answers `invalid_printer`, which the settings and
    // POS screens already render.
    handleIpc("desktop:print-probe", async (_event, payload) => {
      const checked = validatePrintTarget(payload?.target);
      if (!checked.ok) {
        logger.warn("Refused a print probe target", { detail: checked.detail });
        return checked;
      }
      const target = checked.target;
      const result = await nativePrinting.probeTarget(target);
      if (result.ok && result.reachable === false) logger.info("Printer probe unreachable", { target, detail: result.detail });
      return result;
    });
    handleIpc("desktop:print-send-page", async (_event, payload) => {
      const printerName = typeof payload?.printerName === "string" ? payload.printerName.trim() : "";
      if (!printerName) return { ok: false, error: "invalid_printer", detail: "The Windows printer queue name is missing." };
      const payloadCheck = readPrintPayload(payload?.dataBase64, { maxBytes: MAX_PAGE_PAYLOAD_BYTES });
      if (!payloadCheck.ok) {
        logger.warn("Refused a page print payload", { printerName, detail: payloadCheck.detail });
        return payloadCheck;
      }
      const bytes = payloadCheck.bytes;
      const result = await nativePrinting.sendPageToWindowsPrinter(printerName, bytes, { pageGeometry: payload?.pageGeometry });
      if (result.ok) logger.info("Native page print handed off", { printerName, bytes: bytes.length });
      else logger.warn("Native page print failed", { printerName, error: result.error, detail: result.detail });
      return result;
    });
    handleIpc("desktop:print-send-raw", async (_event, payload) => {
      const checked = validatePrintTarget(payload?.target);
      if (!checked.ok) {
        logger.warn("Refused a raw print target", { detail: checked.detail });
        return checked;
      }
      const payloadCheck = readPrintPayload(payload?.dataBase64, { maxBytes: MAX_RAW_PAYLOAD_BYTES });
      if (!payloadCheck.ok) {
        logger.warn("Refused a raw print payload", { detail: payloadCheck.detail });
        return payloadCheck;
      }
      const target = checked.target;
      const bytes = payloadCheck.bytes;
      const result = await nativePrinting.sendRawToTarget(target, bytes);
      if (result.ok) logger.info("Native print delivered", { target, bytes: bytes.length });
      else logger.warn("Native print failed", { target, error: result.error, detail: result.detail });
      return result;
    });
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

  // One install at a time: a manual click racing the scheduler (or itself) must
  // not start a second backup / shutdown / installer launch.
  let updateInstallRunning = false;

  async function performUpdateInstall() {
    if (updateInstallRunning) return updater.publicState();
    updateInstallRunning = true;
    // The shutdown below is intentional: the supervisor must not read it as a
    // crash and start restarting the server the installer is replacing.
    serverSupervisor?.cancel();
    // Issue #984 — claim the cross-runtime maintenance gate after the
    // backup (backups are long; the claim only needs to cover shutdown +
    // install). A refused claim fails the install honestly and leaves the
    // running application untouched, retryable from the update UI.
    let gate = null;
    try {
      // Backup while PostgreSQL is healthy, then shut every local writer down
      // before NSIS replaces binaries. A backup verification failure throws
      // before cleanup and leaves the running application untouched.
      await updater.createVerifiedBackup(backend);
      const claimed = maintenanceGate.acquireLock();
      if (!claimed.ok) {
        updateInstallRunning = false;
        return updater.fail({
          code: "maintenance_gate_busy",
          message:
            claimed.error === "companion_maintenance_running"
              ? "The support companion is running maintenance; retry the install after it finishes."
              : "The maintenance gate could not be claimed; retry the install.",
        });
      }
      gate = claimed.handle;
      await cleanup();
      const launched = updater.launchInstaller();
      // The installer outlives this process: re-stamp the claim to its PID
      // so the companion stays out until the install actually exits.
      gate.handoff(launched.installerPid);
      quitting = true;
      app.exit(0);
      return updater.publicState();
    } catch (error) {
      updateInstallRunning = false;
      if (gate) gate.release();
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

  /**
   * Ask the owner what to do about a failed start. Returns "retry" or "exit";
   * "Open logs" and "Open support companion" are *inspection* actions, not
   * decisions — issue #1001: answering "open logs" used to fall straight back
   * into a fresh boot attempt, so the app retried while the owner was still
   * reading the log. It now opens the folder and asks again.
   */
  async function showStartupFailure(error, { logged = false } = {}) {
    const stage = error?.stage || "startup";
    if (!logged) logger.error(`Fatal desktop startup failure at ${stage}`, error);
    // Issue #984 — the companion exists precisely for this moment: the main
    // app is down, but the standalone diagnostics companion can still run.
    const companion = companionStatus();
    const result = await dialog.showMessageBox({
      type: "error",
      title: "Business Suite could not start",
      message: `Startup failed at: ${stage}`,
      detail: `${error?.message || "Unknown startup error"}\n\nYour business data was not deleted. Diagnostic log:\n${logger.path}`,
      buttons: ["Retry", "Open logs", companion.installed ? "Open support companion" : "Support companion (not installed)", "Exit"],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });
    if (result.response === 1) {
      shell.showItemInFolder(logger.path);
      return showStartupFailure(error, { logged: true });
    }
    if (result.response === 2) {
      const launched = launchCompanion({});
      if (!launched.ok) {
        await dialog.showMessageBox({
          type: "info",
          title: "Support companion",
          message: "The support companion is not installed on this machine.",
          detail: "Ask your support operator for the companion installer — it runs independently of Business Suite and can diagnose this failure.",
          buttons: ["OK"],
          noLink: true,
        });
      }
      return showStartupFailure(error, { logged: true });
    }
    return result.response === 0 ? "retry" : "exit";
  }

  /**
   * Issue #1001 — supervise the application server after startup.
   *
   * `server.ts` exits on any non-network uncaught exception by design, and until
   * now nothing watched it after the readiness check: the window stayed open
   * against a dead port. `backend.onUnexpectedExit` fires for an exit that is
   * not the app quitting or an update install; ServerSupervisor restarts with
   * backoff and, after its last attempt, this dialog asks the owner.
   */
  let serverSupervisor = null;

  async function showServerCrashRecovery({ attempts }) {
    // A loop, not recursion: "open logs" inspects and asks again, and "restart"
    // gives the supervisor a clean attempt budget without nesting dialogs.
    for (;;) {
      const failures = serverSupervisor?.consecutiveFailures || attempts;
      const options = {
        type: "error",
        title: "Business Suite stopped unexpectedly",
        message: "The local application service stopped and could not be restarted automatically.",
        detail: `It failed ${failures} time(s) in a row. Your business data is not lost. Diagnostic log:\n${logger.path}`,
        buttons: ["Restart now", "Open logs", "Exit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      };
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (result.response === 1) {
        shell.showItemInFolder(logger.path);
        continue;
      }
      if (result.response !== 0) {
        quitting = true;
        app.exit(1);
        return;
      }
      serverSupervisor?.reset();
      if (await serverSupervisor?.attemptRestart({ reason: "owner_restart" })) return;
    }
  }

  function startServerSupervision() {
    if (serverSupervisor || !backend) return;
    serverSupervisor = new ServerSupervisor({
      logger,
      restart: () => backend.restartServer(),
      onRecovered: () => {
        // The restarted server is the same instance on the same port, so the
        // window only needs to load the app again (it was showing a dead page).
        if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadURL(mainAppUrl).catch(() => {});
      },
      onExhausted: (info) => showServerCrashRecovery(info),
    });
    backend.onUnexpectedExit((info) => {
      logger.warn("Application server exited unexpectedly", info);
      void serverSupervisor?.notifyExit(info);
    });
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
          // The probe itself lives in smoke-probe.js (issue #1001) and its
          // account-creating path additionally needs an unpackaged build or the
          // smoke harness's own opt-in.
          await runSmokeProbe({
            appUrl: state.appUrl,
            userDataDir: app.getPath("userData"),
            instanceId: backend.config.instanceId,
            env: process.env,
            isPackaged: app.isPackaged,
          });
          await cleanup();
          quitting = true;
          app.exit(0);
          return;
        }
        registerIpc();
        await createWindow(state.appUrl);
        startServerSupervision();
        return;
      } catch (error) {
        await cleanup();
        if (error instanceof BackendStoppedError) {
          // The owner quit while the backend was still starting (first-run
          // initdb, migrations). This is a normal shutdown, not a failure:
          // exit 0 quietly instead of showing the recovery dialog.
          logger?.info("Desktop startup cancelled because the application is quitting");
          quitting = true;
          app.exit(0);
          return;
        }
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
        // "retry" is the only other answer: inspection actions are handled
        // inside showStartupFailure, which asks again before returning.
      }
    }
  }

  app.whenReady().then(async () => {
    // Runs before the logger/backend so a first-run choice of storage
    // location also decides where logs and Postgres data end up — not just
    // where the config marker recording the choice lives.
    await runStorageBootstrap();
    // Issue #1001 — the single-instance lock is scoped to `userData`, and the
    // call above may have moved that directory to the owner's chosen root.
    // Taking the lock first (as this shell used to) let a second launch hold a
    // different lock and run against a different data root at the same time.
    // The losing instance quits before touching PostgreSQL or the window.
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    registerSecondInstanceHandler();
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
    void updater.applyPersistedCommand();
    const updateCheckTimer = setInterval(() => {
      updater.checkPersistedTarget();
      void updater.applyPersistedCommand();
    }, 15 * 60 * 1000);
    updateCheckTimer.unref();
    const updateCommandTimer = setInterval(() => {
      updater.applyPersistedPolicy();
      void updater.applyPersistedCommand();
    }, 30 * 1000);
    updateCommandTimer.unref();
    // Unattended install (central policy "safe_window"; off by default). The
    // engine decides policy + safety + announced grace period; this only asks it
    // once a minute and, on "install", runs the SAME path as the Install Now button.
    let autoInstallBusy = false;
    const autoInstallTimer = setInterval(async () => {
      if (autoInstallBusy || updateInstallRunning || !backend) return;
      autoInstallBusy = true;
      try {
        const outcome = await updater.autoInstallTick({
          readSafety: () => backend.preUpdateSafety(),
          readSystem: async () => {
            const stats = require("node:fs").statfsSync(app.getPath("userData"));
            return { freeDiskBytes: Number(stats.bavail) * Number(stats.bsize), onBatteryPower: require("electron").powerMonitor.isOnBatteryPower() };
          },
        });
        if (outcome.action === "install") {
          logger.info("Starting scheduled unattended update install");
          await performUpdateInstall();
        }
      } catch (error) {
        logger.warn("Unattended update tick failed", error);
      } finally {
        autoInstallBusy = false;
      }
    }, 60 * 1000);
    autoInstallTimer.unref();
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
    // A deliberate quit is not a crash: no restart attempts or dialogs.
    serverSupervisor?.cancel();
    quitting = true;
    void cleanup().finally(() => app.exit(0));
  });
}

runDesktopShell();
