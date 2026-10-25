"use strict";

const { spawn } = require("node:child_process");

const RULE_NAME = "Bizamiz Local Devices";
// The rule an install made before the rename. It is bound to the old executable name, so
// it no longer matches the program; install()/remove() delete it and status() ignores it.
const LEGACY_RULE_NAMES = ["Business Suite Local Devices"];

function removeRulesScript() {
  return [RULE_NAME, ...LEGACY_RULE_NAMES]
    .map((name) => `Get-NetFirewallRule -DisplayName ${psQuote(name)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`)
    .join("; ");
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(script, elevated = false) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const args = elevated
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `& { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'); exit $p.ExitCode }`,
        ]
      : ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `PowerShell exited ${code}`)));
  });
}

class FirewallManager {
  constructor(logger) {
    this.logger = logger;
  }

  async status() {
    if (process.platform !== "win32") return { supported: false, installed: false };
    try {
      const output = await runPowerShell(`$r = Get-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -ErrorAction SilentlyContinue; if ($r) { 'installed' } else { 'missing' }`);
      const profiles = await runPowerShell("Get-NetConnectionProfile | Select-Object -ExpandProperty NetworkCategory");
      return { supported: true, installed: output.includes("installed"), publicNetwork: profiles.split(/\r?\n/).includes("Public") };
    } catch (error) {
      this.logger.warn("Could not inspect Windows Firewall rule", error);
      return { supported: true, installed: false, error: "status_unavailable" };
    }
  }

  async install(port, executable = process.execPath) {
    if (process.platform !== "win32") return { supported: false, installed: false };
    const script = [
      `$ErrorActionPreference = 'Stop'`,
      removeRulesScript(),
      `New-NetFirewallRule -DisplayName ${psQuote(RULE_NAME)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${Number(port)},${Number(port) + 1} -Profile Private -RemoteAddress LocalSubnet -Program ${psQuote(executable)} | Out-Null`,
    ].join("; ");
    try {
      await runPowerShell(script, true);
      this.logger.info("Installed scoped Windows Firewall rule", { port });
      return { supported: true, installed: true };
    } catch (error) {
      this.logger.warn("Windows Firewall elevation was denied or failed", error);
      return { supported: true, installed: false, error: "elevation_denied" };
    }
  }

  async remove() {
    if (process.platform !== "win32") return { supported: false, installed: false };
    try {
      await runPowerShell(removeRulesScript(), true);
      this.logger.info("Removed Windows Firewall mobile gateway rule");
      return { supported: true, installed: false };
    } catch (error) {
      this.logger.warn("Could not remove Windows Firewall rule", error);
      return { supported: true, installed: true, error: "elevation_denied" };
    }
  }
}

module.exports = { FirewallManager, RULE_NAME, LEGACY_RULE_NAMES, psQuote };
