"use strict";

/**
 * Loopback broker for the two operations that need PostgreSQL's owner role.
 * Electron retains the credential; Next receives only this server's URL and a
 * per-boot token. Each request runs the reviewed runtime worker in a short-lived
 * child whose environment alone contains BACKUP_DATABASE_URL.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function authorized(header, token) {
  const presented = Buffer.from(String(header || ""));
  const expected = Buffer.from(`Bearer ${token}`);
  if (presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(presented, expected);
}

function credentialSecrets(...urls) {
  const values = new Set();
  for (const raw of urls) {
    if (!raw) continue;
    values.add(raw);
    try {
      const password = new URL(raw).password;
      if (password) {
        values.add(password);
        values.add(decodeURIComponent(password));
      }
    } catch { /* the full value is still redacted */ }
  }
  // Replace longer values first so a full URL cannot leave its password tail.
  return [...values].sort((a, b) => b.length - a.length);
}

function redact(value, secrets) {
  let text = String(value || "");
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  return text.slice(0, 2000);
}

function validRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.operation === "dump") {
    return typeof body.outFile === "string" && path.isAbsolute(body.outFile) && body.bin === undefined;
  }
  if (body.operation !== "restore") return false;
  return (
    typeof body.dumpPath === "string" && path.isAbsolute(body.dumpPath) &&
    typeof body.source === "string" && body.source.length > 0 && body.source.length <= 1024 &&
    typeof body.apply === "boolean"
  );
}

async function startPrivilegedOperationServer(options) {
  const {
    runtimeDir,
    runtimeDatabaseUrl,
    superuserDatabaseUrl,
    pgToolsDir,
    emergencyBackupDir,
    logger,
  } = options;
  const workerPath = path.join(runtimeDir, "bin", "privileged-operation.cjs");
  if (!fs.existsSync(workerPath)) throw new Error(`Privileged Desktop worker is missing at ${workerPath}.`);
  const token = crypto.randomBytes(32).toString("base64url");
  const children = new Set();
  const secrets = credentialSecrets(superuserDatabaseUrl, runtimeDatabaseUrl);

  function runWorker(request) {
    if (!validRequest(request)) return Promise.reject(new Error("privileged_operation_invalid_request"));
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        DEPLOYMENT_ROLE: "site",
        DATABASE_URL: runtimeDatabaseUrl,
        BACKUP_DATABASE_URL: superuserDatabaseUrl,
        PG_TOOLS_DIR: pgToolsDir,
        RESTORE_EMERGENCY_DIR: emergencyBackupDir,
      };
      delete env.DESKTOP_PRIVILEGED_URL;
      delete env.DESKTOP_PRIVILEGED_TOKEN;
      const child = spawn(process.execPath, [workerPath], {
        cwd: runtimeDir,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_BODY_BYTES); });
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8000);
        logger.childOutput("privileged-operation", redact(chunk.toString(), secrets), "warn");
      });
      child.once("error", (error) => {
        children.delete(child);
        reject(error);
      });
      child.once("exit", (code) => {
        children.delete(child);
        let response = null;
        try { response = JSON.parse(stdout); } catch { /* handled below */ }
        if (code === 0 && response?.ok === true) return resolve(response.result ?? null);
        const detail = response?.ok === false ? response.error : stderr || `worker exited ${code}`;
        reject(new Error(redact(detail, secrets)));
      });
      child.stdin.on("error", () => { /* exit/error reports the operation failure */ });
      child.stdin.end(JSON.stringify(request));
    });
  }

  const server = http.createServer((req, res) => {
    const respond = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST" || req.url !== "/operations" || !authorized(req.headers.authorization, token) || req.headers.origin) {
      respond(403, { ok: false, error: "privileged_operation_forbidden" });
      return;
    }
    let raw = "";
    let rejected = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES && !rejected) {
        rejected = true;
        respond(413, { ok: false, error: "privileged_operation_too_large" });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (rejected) return;
      void (async () => {
        let body;
        try { body = JSON.parse(raw); } catch {
          respond(400, { ok: false, error: "privileged_operation_invalid_json" });
          return;
        }
        if (!validRequest(body)) {
          respond(400, { ok: false, error: "privileged_operation_invalid_request" });
          return;
        }
        try {
          const result = await runWorker(body);
          respond(200, { ok: true, result });
        } catch (error) {
          respond(500, { ok: false, error: redact(error?.message || error, secrets) });
        }
      })();
    });
    req.on("error", () => { /* disconnected local client; worker still cleans its own scratch DB */ });
  });
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Privileged operation server has no loopback port.");

  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    run: runWorker,
    async close() {
      for (const child of children) {
        if (child.exitCode !== null || !child.pid) continue;
        if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        else child.kill("SIGTERM");
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startPrivilegedOperationServer, validRequest };
