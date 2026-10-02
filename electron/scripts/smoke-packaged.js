"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dist = path.resolve(__dirname, "..", "dist", "win-unpacked");
const executable = process.env.DESKTOP_EXECUTABLE || path.join(dist, "Business Suite.exe");
if (!fs.existsSync(executable)) throw new Error(`packaged executable is missing: ${executable}`);
const userData = process.env.DESKTOP_SMOKE_USER_DATA
  ? path.resolve(process.env.DESKTOP_SMOKE_USER_DATA)
  : fs.mkdtempSync(path.join(os.tmpdir(), "business-suite-packaged-smoke-"));
fs.mkdirSync(userData, { recursive: true });

function launch(name, bootstrap) {
  const marker = path.join(userData, `${name}.json`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      let diagnostic = "";
      if (fs.existsSync(marker)) diagnostic = `\n${fs.readFileSync(marker, "utf8")}`;
      else {
        const log = path.join(userData, "logs", "desktop.log");
        if (fs.existsSync(log)) diagnostic = `\nDesktop log tail:\n${fs.readFileSync(log, "utf8").slice(-16_384)}`;
      }
      reject(new Error(`${message}${diagnostic}`));
    };
    const child = spawn(executable, [`--user-data-dir=${userData}`], {
      env: {
        ...process.env,
        DESKTOP_SMOKE_MARKER: marker,
        DESKTOP_SMOKE_BOOTSTRAP: bootstrap ? "1" : "0",
      },
      windowsHide: true,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      fail(`${name} packaged launch timed out after 10 minutes`);
    }, 600_000); // above the 5-minute server-readiness wait in backend-manager.js plus the rest of startup
    child.once("error", (error) => fail(`${name} could not start: ${error.message}`));
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return fail(`${name} packaged launch exited ${code}`);
      if (!fs.existsSync(marker)) return fail(`${name} did not write its smoke marker`);
      const result = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (!result.ok) return fail(`${name} reported a failed smoke marker`);
      if (settled) return;
      settled = true;
      resolve(result);
    });
  });
}

(async () => {
  const first = await launch("first-launch", true);
  if (!first.ok || first.needsBootstrap || !first.authenticated || !first.pgdata) {
    throw new Error(`first launch failed acceptance: ${JSON.stringify(first)}`);
  }
  const second = await launch("restart", false);
  if (!second.ok || second.needsBootstrap || !second.pgdata) {
    throw new Error(`restart failed persistence acceptance: ${JSON.stringify(second)}`);
  }
  if (first.instanceId !== second.instanceId) throw new Error("desktop instance identity did not persist across restart");
  if (fs.existsSync(path.join(userData, "pgdata", "postmaster.pid"))) {
    throw new Error("PostgreSQL postmaster.pid remained after clean desktop exit");
  }
  console.log(`Packaged desktop smoke passed. Persistent test data: ${userData}`);
})().catch((error) => {
  console.error(error);
  // GitHub's public job page exposes annotations even when raw Actions logs
  // require authentication. Keep the root cause visible to package reviewers.
  if (process.env.GITHUB_ACTIONS === "true") {
    const annotation = String(error?.stack || error)
      .slice(0, 8_000)
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.error(`::error title=Packaged desktop smoke failed::${annotation}`);
  }
  process.exit(1);
});
