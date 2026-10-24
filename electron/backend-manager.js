"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { computePaths } = require("./app-paths");
const { installPostmasterExitGuard, releaseEmbeddedPostgresExitHook } = require("./embedded-postgres-exit");
const desktopPackage = require("./package.json");

class StartupError extends Error {
  constructor(stage, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "StartupError";
    this.stage = stage;
  }
}

/**
 * `start()` was cancelled because the app is quitting (issue #985). Not a
 * startup failure: `main.js` exits 0 instead of showing the recovery dialog,
 * and `start()` stops anything it had already brought up before throwing this.
 */
class BackendStoppedError extends Error {
  constructor() {
    super("Desktop backend start was cancelled because the application is quitting.");
    this.name = "BackendStoppedError";
    this.stage = "stopped";
  }
}

function isInitialised(dataDir) {
  return fs.existsSync(path.join(dataDir, "PG_VERSION"));
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * A restore swaps databases by name and keeps the original under this prefix
 * until the replacement validates. If Windows/process interruption lands in
 * the tiny interval where `pos` has no name, recover the preserved original
 * instead of creating an empty database.
 */
async function recoverInterruptedRestore(client, target, logger) {
  const prefix = `${target}_restore_original_`;
  const state = await client.query(
    "SELECT datname FROM pg_database WHERE datname = $1 OR datname LIKE $2 ORDER BY datname DESC",
    [target, `${prefix}%`],
  );
  const targetExists = state.rows.some((row) => row.datname === target);
  const recoveries = state.rows.filter((row) => row.datname.startsWith(prefix));
  if (targetExists) {
    if (recoveries.length) logger.warn("A preserved pre-restore database remains available for recovery", { databases: recoveries.map((row) => row.datname) });
    return false;
  }
  const recovery = recoveries[0]?.datname;
  if (!recovery) return false;
  await client.query(`ALTER DATABASE ${quoteIdentifier(recovery)} RENAME TO ${quoteIdentifier(target)}`);
  await client.query(`ALTER DATABASE ${quoteIdentifier(target)} WITH ALLOW_CONNECTIONS true`);
  logger.warn("Recovered the original database after an interrupted restore", { recovery, target });
  return true;
}

function answers(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

// Windows lets 127.0.0.1:N bind while another process holds the dual-stack
// wildcard [::]:N, and loopback connects then reach that other process (e.g. a
// dev server on 3000). A successful bind alone is not proof the port is ours.
async function canListen(host, port) {
  const bound = await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
  return bound && !(await answers(host, port));
}

function findFreePort(host, from, to) {
  return (async () => {
    for (let port = from; port <= to; port += 1) {
      if (await canListen(host, port)) return port;
    }
    throw new Error(`No free loopback port is available in ${from}-${to}.`);
  })();
}

async function loadOrCreateConfig(userDataDir) {
  // Section 8 folder split: config.json lives under Configuration/, not
  // directly in userData. `main.js` runs `migrateLegacyLayout()` before
  // this is ever called, so an existing install's config.json has already
  // moved here by the time this reads/creates it.
  const configPath = computePaths(userDataDir).configPath;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  let changed = false;
  if (!config.pgPassword) { config.pgPassword = crypto.randomBytes(32).toString("hex"); changed = true; }
  if (!config.jwtSecret) { config.jwtSecret = crypto.randomBytes(32).toString("hex"); changed = true; }
  if (!config.masterKey) { config.masterKey = crypto.randomBytes(32).toString("base64"); changed = true; }
  if (!config.instanceId) { config.instanceId = crypto.randomUUID(); changed = true; }
  if (!config.pgPort) { config.pgPort = await findFreePort("127.0.0.1", 5544, 5599); changed = true; }
  if (!config.appPort) { config.appPort = await findFreePort("127.0.0.1", 3000, 3099); changed = true; }
  if (!config.gatewayPort) { config.gatewayPort = 8443; changed = true; }
  if (!config.gateway) { config.gateway = { enabled: false, selectedAddress: null }; changed = true; }
  if (changed) {
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  }
  return { config, configPath };
}

function saveConfig(configPath, config) {
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, configPath);
}

function childEnvironment(extra) {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extra };
}

function postgresStartStrategy(platform = process.platform) {
  return platform === "win32" ? "pg_ctl" : "embedded";
}

function pgCtlStartArguments(dataDir, logPath, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid PostgreSQL port: ${port}`);
  return [
    "start", "-D", dataDir, "-l", logPath, "-w", "-t", "90",
    // pg_ctl's -p means postgres executable; server options belong in -o.
    "-o", `-p ${port} -c listen_addresses=127.0.0.1`,
  ];
}

function runLoggedCommand(executable, args, logger, name) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    child.stdout?.on("data", (chunk) => logger.childOutput(name, chunk));
    child.stderr?.on("data", (chunk) => logger.childOutput(name, chunk, "warn"));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish(resolve);
      else finish(reject, new Error(`${name} exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`));
    });
  });
}

function desktopServerEnvironment(config, runtimeUrl, superuserUrl, appVersion = "unknown", options = {}) {
  const { pgToolsDir, emergencyBackupDir, updateStatePath, updateTargetPath, updatePolicyPath, updateCommandPath } = options;
  return {
    DATABASE_URL: runtimeUrl,
    BACKUP_DATABASE_URL: superuserUrl,
    JWT_SECRET: config.jwtSecret,
    POS_MASTER_KEY: config.masterKey,
    PORT: String(config.appPort),
    // This is the architectural boundary: Electron never opts out of secure
    // posture and never listens on a LAN interface. Phones use the HTTPS
    // gateway, which is enabled separately by the owner.
    BIND_ADDR: "127.0.0.1",
    NODE_ENV: "production",
    DEPLOYMENT_ROLE: "site",
    DESKTOP_INSTANCE_ID: config.instanceId,
    DESKTOP_PARENT_PID: String(process.pid),
    DESKTOP_DEVICE_NAME: require("node:os").hostname(),
    APP_RELEASE_VERSION: appVersion,
    // SemVer is the update identity. Commit/build remain separate provenance;
    // never put appVersion into APP_IMAGE_SHA or Central will compare unlike
    // identifiers again.
    APP_BUILD_COMMIT: typeof desktopPackage.buildCommit === "string" ? desktopPackage.buildCommit : "unknown",
    APP_BUILD_ID: typeof desktopPackage.buildId === "string" ? desktopPackage.buildId : "unknown",
    DESKTOP_RELEASE_CHANNEL: typeof desktopPackage.releaseChannel === "string" ? desktopPackage.releaseChannel : "stable",
    ELECTRON_VERSION: process.versions.electron || "unknown",
    APP_IMAGE_SHA: typeof desktopPackage.buildCommit === "string" ? desktopPackage.buildCommit : "unknown",
    // Bug fix (this cycle): `start()` below has always passed a 5th
    // options argument here (`{ pgToolsDir, emergencyBackupDir }`), but
    // this function's signature silently dropped it — neither value ever
    // reached the spawned server process's environment. Since NODE_ENV is
    // forced to "production" a few lines up, pg-tools.ts's pgToolBin()
    // *requires* PG_TOOLS_DIR in production and throws
    // "{pg_dump,pg_restore}_packaged_tools_not_configured" without it — so
    // every packaged desktop install's backup/restore was broken (the
    // *object* it dumps into, e.g. `BACKUP_DIR`, is separately configurable
    // in-app via the Owner's backup-directory setting and was unaffected;
    // this is specifically the *tool binary* the app shells out to).
    // RESTORE_EMERGENCY_DIR is a lower-severity companion fix: without it,
    // an emergency pre-restore dump falls back to the OS temp directory
    // instead of living beside the rest of this install's data under
    // `userData`.
    ...(pgToolsDir ? { PG_TOOLS_DIR: pgToolsDir } : {}),
    ...(emergencyBackupDir ? { RESTORE_EMERGENCY_DIR: emergencyBackupDir } : {}),
    ...(updateStatePath ? { DESKTOP_UPDATE_STATE_PATH: updateStatePath } : {}),
    ...(updateTargetPath ? { DESKTOP_UPDATE_TARGET_PATH: updateTargetPath } : {}),
    ...(updatePolicyPath ? { DESKTOP_UPDATE_POLICY_PATH: updatePolicyPath } : {}),
    ...(updateCommandPath ? { DESKTOP_UPDATE_COMMAND_PATH: updateCommandPath } : {}),
    ...(process.env.DESKTOP_SMOKE_MARKER
      ? {
          DESKTOP_SMOKE_MARKER: process.env.DESKTOP_SMOKE_MARKER,
          LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK: "1",
        }
      : {}),
  };
}

function runNodeScript(executable, appDir, relativePath, env, logger, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [path.join(appDir, relativePath)], {
      cwd: appDir,
      env: childEnvironment(env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (capture) stdout += chunk;
      else logger.childOutput(relativePath, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
      logger.childOutput(relativePath, chunk, "warn");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(capture ? stdout.trim() : undefined);
      else reject(new Error(`${relativePath} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

function waitForServerReady(url, instanceId, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    const exited = (code) => fail(new Error(`Application server exited before readiness (code ${code}).`));
    child.once("exit", exited);
    const attempt = () => {
      if (settled) return;
      const req = http.get(`${url}/api/health`, { timeout: 3000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { if (body.length < 4096) body += chunk; });
        res.on("end", () => {
          let response;
          try { response = JSON.parse(body); } catch { response = null; }
          if (res.statusCode === 200 && response?.ok === true && response?.instanceId === instanceId) {
            settled = true;
            child.off("exit", exited);
            resolve();
          } else if (Date.now() > deadline) {
            fail(new Error("The loopback port answered, but it was not this Business Suite instance."));
          } else setTimeout(attempt, 400);
        });
      });
      req.once("timeout", () => req.destroy());
      req.once("error", () => {
        if (Date.now() > deadline) fail(new Error("Application server did not become ready in time."));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

function answersAsInstance(port, instanceId) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { if (body.length < 4096) body += chunk; });
      res.on("end", () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body)?.instanceId === instanceId); } catch { resolve(false); }
      });
    });
    req.once("timeout", () => req.destroy());
    req.once("error", () => resolve(false));
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
}

function stopProcessTree(child, logger) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  } else child.kill("SIGKILL");
  logger.warn("Forced application server process-tree termination after graceful timeout.");
}

class BackendManager {
  constructor({ app, logger }) {
    this.app = app;
    this.logger = logger;
    this.pg = null;
    this.server = null;
    this.config = null;
    this.configPath = null;
    this.stopping = null;
    // Set by stop(); every await point in start() checks it so a quit that
    // lands mid-boot cannot start PostgreSQL or the server afterwards.
    this.stopRequested = false;
    this.pgCtlPath = null;
    this.exitGuard = null;
  }

  resolveRuntimeDir() {
    return this.app.isPackaged
      ? path.join(process.resourcesPath, "desktop-runtime")
      : path.join(__dirname, "..", ".desktop-runtime");
  }

  async loadEmbeddedPostgres() {
    if (this.EmbeddedPostgres) return this.EmbeddedPostgres;
    const modulePath = this.app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "embedded-postgres", "dist", "index.js")
      : path.join(__dirname, "node_modules", "embedded-postgres", "dist", "index.js");
    const embedded = await import(pathToFileURL(modulePath).href);
    // Loading the module registers a process `exit` hook that cannot stop
    // PostgreSQL cleanly (issue #869/#985); this backend stops it explicitly.
    // The packaged dependency is additionally patched at install/packaging time
    // (scripts/patch-embedded-postgres-exit-hook.js), so a hook that survives
    // this release call — a second module copy, an unexpected resolution — can
    // no longer reject with "done is not a function".
    try {
      if (!releaseEmbeddedPostgresExitHook(modulePath)) {
        this.logger.warn(
          "embedded-postgres registered no removable exit hook; relying on the packaged patch and the backend's own shutdown",
        );
      }
    } catch (error) {
      this.logger.warn("Could not release the embedded-postgres exit hook; relying on the packaged patch and the backend's own shutdown", error);
    }
    this.EmbeddedPostgres = embedded.default;
    return this.EmbeddedPostgres;
  }

  async pgControlPath() {
    // Cached: the postmaster exit guard needs the same path synchronously from
    // an `exit` listener, where a dynamic import is impossible.
    if (this.pgCtlPath) return this.pgCtlPath;
    const platformPackage = process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`;
    const modulePath = this.app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@embedded-postgres", platformPackage, "dist", "index.js")
      : path.join(__dirname, "node_modules", "@embedded-postgres", platformPackage, "dist", "index.js");
    this.pgCtlPath = (await import(pathToFileURL(modulePath).href)).pg_ctl;
    return this.pgCtlPath;
  }

  throwIfStopping() {
    if (this.stopRequested) throw new BackendStoppedError();
  }

  // Last-resort, synchronous `pg_ctl stop` at process exit. Installed before
  // PostgreSQL can start, so it also covers a quit during first-run initdb,
  // migrations, or a start that is cancelled halfway: the postmaster cannot
  // outlive the app even though no promise can run at exit time.
  async installExitGuard(dataDir) {
    if (this.exitGuard) return;
    try {
      this.exitGuard = installPostmasterExitGuard({ dataDir, pgCtl: await this.pgControlPath(), logger: this.logger });
    } catch (error) {
      this.logger.warn("Could not prepare the PostgreSQL postmaster exit guard", error);
    }
  }

  serverPidPath() {
    return path.join(computePaths(this.app.getPath("userData")).configDir, "server.pid");
  }

  // A crashed or force-killed shell leaves pg_ctl's detached PostgreSQL and
  // possibly the server child running hidden. Stop what is provably ours
  // before probing ports, so we reuse our own ports instead of fleeing them.
  async stopLeftoversFromUncleanExit(dataDir) {
    const pidPath = this.serverPidPath();
    try {
      const pid = Number(fs.readFileSync(pidPath, "utf8"));
      // Kill only if our own instance still answers — never a reused PID.
      if (pid > 0 && (await answersAsInstance(this.config.appPort, this.config.instanceId))) {
        this.logger.warn("Stopping application server left over from a previous run", { pid });
        await new Promise((resolve) => {
          spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true }).once("exit", resolve).once("error", resolve);
        });
      }
    } catch {}
    fs.rmSync(pidPath, { force: true });

    if (process.platform === "win32" && fs.existsSync(path.join(dataDir, "postmaster.pid"))) {
      // pg_ctl stop acts only on the postmaster owning this data directory.
      const pgCtl = await this.pgControlPath();
      await runLoggedCommand(pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "30"], this.logger, "pg_ctl stop (leftover)")
        .catch(() => {}); // not running: pg_ctl exits non-zero, nothing to do
    }
  }

  // Ports are sticky (the window's origin, and so its local storage, includes
  // the app port) but never a reason to fail: another program on the saved
  // port moves us to the next free one, persisted for later runs.
  async ensureFreePorts() {
    const { config } = this;
    let changed = false;
    if (!(await canListen("127.0.0.1", config.pgPort))) {
      const port = await findFreePort("127.0.0.1", 5544, 5599);
      this.logger.warn("PostgreSQL port is used by another program; moving", { from: config.pgPort, to: port });
      config.pgPort = port;
      changed = true;
    }
    if (!(await canListen("127.0.0.1", config.appPort))) {
      const port = await findFreePort("127.0.0.1", 3000, 3099);
      this.logger.warn("Application port is used by another program; moving", { from: config.appPort, to: port });
      config.appPort = port;
      changed = true;
    }
    if (changed) saveConfig(this.configPath, config);
  }

  async startPostgresWithPgCtl(dataDir, port) {
    const pgCtl = await this.pgControlPath();
    const logDir = this.logger.dir || computePaths(this.app.getPath("userData")).logsDir;
    const logPath = path.join(logDir, "postgres.log");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logPath, "", { encoding: "utf8", mode: 0o600 });
    try {
      await runLoggedCommand(pgCtl, pgCtlStartArguments(dataDir, logPath, port), this.logger, "pg_ctl start");
    } catch (error) {
      let postgresOutput = "";
      try {
        postgresOutput = fs.readFileSync(logPath, "utf8").slice(-16_384).trim();
      } catch {}
      if (postgresOutput) this.logger.childOutput("postgres", postgresOutput, "warn");
      throw new Error(`PostgreSQL pg_ctl startup failed${postgresOutput ? `: ${postgresOutput}` : "."}`, { cause: error });
    }
  }

  async start() {
    const userDataDir = this.app.getPath("userData");
    const runtimeDir = this.resolveRuntimeDir();
    if (!fs.existsSync(path.join(runtimeDir, "bin", "server.cjs"))) {
      throw new StartupError("runtime", `Desktop runtime is missing at ${runtimeDir}.`);
    }
    ({ config: this.config, configPath: this.configPath } = await loadOrCreateConfig(userDataDir));
    const { config } = this;
    const dataDir = computePaths(userDataDir).pgDataDir;
    // Before PostgreSQL can start: no exit path may leave its postmaster behind.
    await this.installExitGuard(dataDir);
    this.throwIfStopping();
    await this.stopLeftoversFromUncleanExit(dataDir);
    this.throwIfStopping();
    await this.ensureFreePorts();
    this.throwIfStopping();

    const firstRun = !isInitialised(dataDir);
    let postgresStage = firstRun ? "initdb" : "postgres-start";
    // Held locally: stop() may clear this.pg while this start is still awaiting,
    // and every use here must act on the instance this start created.
    let pg = null;
    try {
      this.logger.info("Starting embedded PostgreSQL", { port: config.pgPort, firstRun });
      const EmbeddedPostgres = await this.loadEmbeddedPostgres();
      this.throwIfStopping();
      pg = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "postgres",
        password: config.pgPassword,
        port: config.pgPort,
        persistent: true,
        initdbFlags: ["--encoding=UTF8"],
        postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
        onLog: (message) => this.logger.childOutput("postgres", message),
        onError: (error) => this.logger.error("postgres", error),
      });
      this.pg = pg;
      if (firstRun) await pg.initialise();
      this.throwIfStopping();
      postgresStage = "postgres-start";
      if (postgresStartStrategy() === "pg_ctl") {
        // pg_ctl uses PostgreSQL's restricted-process path for Windows tokens
        // carrying the local Administrators group, while remaining non-elevated.
        await this.startPostgresWithPgCtl(dataDir, config.pgPort);
      } else {
        await pg.start();
      }
      // A quit that landed while the postmaster was coming up must not leave it
      // running: PostgreSQL is up now, so stop it before aborting the start.
      if (this.stopRequested) {
        await this.stopPostgresGracefully(pg);
        throw new BackendStoppedError();
      }
    } catch (error) {
      if (error instanceof BackendStoppedError) throw error;
      throw new StartupError(postgresStage, "Local PostgreSQL could not be started.", error);
    }

    this.throwIfStopping();
    const superuserUrl = `postgres://postgres:${config.pgPassword}@127.0.0.1:${config.pgPort}/pos`;
    try {
      const client = pg.getPgClient("postgres", "127.0.0.1");
      await client.connect();
      await recoverInterruptedRestore(client, "pos", this.logger);
      const found = await client.query("SELECT 1 FROM pg_database WHERE datname = 'pos'");
      if (found.rows.length === 0) await client.query("CREATE DATABASE pos ENCODING 'UTF8'");
      await client.end();
    } catch (error) {
      if (this.stopRequested) throw new BackendStoppedError();
      throw new StartupError("database-create", "The local pos database could not be created.", error);
    }

    this.throwIfStopping();
    try {
      await runNodeScript(process.execPath, runtimeDir, "bin/migrate.cjs", { DATABASE_URL: superuserUrl }, this.logger);
    } catch (error) {
      // Quitting mid-migration is an expected cancellation, not a broken
      // upgrade: report it as a stop so no recovery dialog appears.
      if (this.stopRequested) throw new BackendStoppedError();
      throw new StartupError("migrations", "Database migrations failed. Existing data was not deleted.", error);
    }
    this.throwIfStopping();

    let runtimeUrl;
    try {
      runtimeUrl = await runNodeScript(
        process.execPath,
        runtimeDir,
        "bin/derive-runtime-database-url.cjs",
        { DATABASE_URL: superuserUrl },
        this.logger,
        true,
      );
      if (!runtimeUrl?.startsWith("postgres")) throw new Error("Restricted role helper returned no database URL.");
    } catch (error) {
      if (this.stopRequested) throw new BackendStoppedError();
      throw new StartupError("runtime-role", "The restricted PostgreSQL application role could not be prepared.", error);
    }

    this.throwIfStopping();
    const appUrl = `http://127.0.0.1:${config.appPort}`;
    const pgToolsDir = this.app.isPackaged
      ? path.join(process.resourcesPath, "postgresql-tools")
      : path.join(__dirname, "..", ".desktop-assets", "postgresql-tools");
    const desktopPaths = computePaths(userDataDir);
    const emergencyBackupDir = desktopPaths.emergencyBackupDir;
    const serverEnv = desktopServerEnvironment(config, runtimeUrl, superuserUrl, this.app.getVersion(), {
      pgToolsDir,
      emergencyBackupDir,
      updateStatePath: path.join(desktopPaths.configDir, "update-state.json"),
      updateTargetPath: path.join(desktopPaths.configDir, "update-target.json"),
      updatePolicyPath: path.join(desktopPaths.configDir, "update-policy.json"),
      updateCommandPath: path.join(desktopPaths.configDir, "update-command.json"),
    });
    // Last cancellation point, in the same tick as the spawn: a stop() that has
    // already run must not leave an unsupervised application server behind,
    // and a stop() that runs later sees this.server and kills it.
    this.throwIfStopping();
    this.server = spawn(process.execPath, [path.join(runtimeDir, "bin", "server.cjs")], {
      cwd: runtimeDir,
      env: childEnvironment(serverEnv),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    fs.writeFileSync(this.serverPidPath(), String(this.server.pid ?? ""), { mode: 0o600 });
    let serverStderr = "";
    this.server.stdout.on("data", (chunk) => this.logger.childOutput("server", chunk));
    this.server.stderr.on("data", (chunk) => {
      serverStderr = `${serverStderr}${chunk}`.slice(-8_000);
      this.logger.childOutput("server", chunk, "warn");
    });
    this.server.once("error", (error) => this.logger.error("Application server process error", error));
    try {
      // ponytail: a first start after install/update (fresh files, antivirus
      // scan) took >90 s here and was killed while still booting. A crash
      // still fails at once through the child's exit.
      await waitForServerReady(appUrl, config.instanceId, 300_000, this.server);
      this.throwIfStopping();
    } catch (error) {
      if (error instanceof BackendStoppedError) throw error;
      // stop() kills the server child, which fails readiness by design.
      if (this.stopRequested) throw new BackendStoppedError();
      const detail = serverStderr.trim();
      const cause = detail
        ? new Error(`${error instanceof Error ? error.message : String(error)}\n${detail}`)
        : error;
      throw new StartupError("server-readiness", "The application server did not pass its identity-aware health check.", cause);
    }
    this.logger.info("Desktop backend is ready", { appUrl, instanceId: config.instanceId });
    return { appUrl, config, configPath: this.configPath, userDataDir };
  }

  updateConfig(mutator) {
    mutator(this.config);
    saveConfig(this.configPath, this.config);
  }

  /**
   * Facts the update engine gates an install on. Every count comes from the
   * local database; a query that cannot run throws, which the caller treats as
   * "unsafe" (never as "nothing is open").
   */
  async preUpdateSafety() {
    if (!this.pg) throw new Error("PostgreSQL is not running.");
    const client = this.pg.getPgClient("pos", "127.0.0.1");
    await client.connect();
    try {
      const { rows } = await client.query(
        `SELECT
           (SELECT count(*)::int FROM employee_shifts WHERE ended_at IS NULL) AS open_shifts,
           (SELECT count(*)::int FROM orders WHERE status IN ('open','held')) AS open_orders,
           (SELECT count(*)::int FROM print_jobs WHERE status IN ('created','preparing','routing','sending') AND created_at > now() - interval '10 minutes') AS pending_print_jobs`,
      );
      return {
        openShifts: Number(rows[0]?.open_shifts ?? 0),
        openOrders: Number(rows[0]?.open_orders ?? 0),
        pendingPrintJobs: Number(rows[0]?.pending_print_jobs ?? 0),
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  async stopPostgresGracefully(instance = this.pg) {
    if (!instance) return;
    const dataDir = computePaths(this.app.getPath("userData")).pgDataDir;
    try {
      const pgCtl = await this.pgControlPath();
      await new Promise((resolve, reject) => {
        const child = spawn(pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "30"], { windowsHide: true });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`pg_ctl exited ${code}`)));
      });
    } catch (error) {
      this.logger.warn("Graceful pg_ctl shutdown failed; using embedded fallback", error);
      await instance.stop().catch((stopError) => this.logger.error("PostgreSQL fallback stop failed", stopError));
    }
    if (instance === this.pg) this.pg = null;
  }

  async stop() {
    // Set before the first await: a start() that is still running must see the
    // quit at its next checkpoint and must not start PostgreSQL or the server.
    this.stopRequested = true;
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.logger.info("Stopping desktop backend");
      if (this.server && this.server.exitCode === null) {
        this.server.kill("SIGTERM");
        if (!(await waitForExit(this.server, 30_000))) stopProcessTree(this.server, this.logger);
      }
      this.server = null;
      fs.rmSync(this.serverPidPath(), { force: true });
      await this.stopPostgresGracefully();
      this.logger.info("Desktop backend stopped");
    })();
    await this.stopping;
    this.stopping = null;
  }
}

module.exports = {
  BackendManager,
  BackendStoppedError,
  StartupError,
  loadOrCreateConfig,
  findFreePort,
  desktopServerEnvironment,
  postgresStartStrategy,
  pgCtlStartArguments,
  recoverInterruptedRestore,
};
