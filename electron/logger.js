"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { computePaths } = require("./app-paths");

const SECRET_PATTERNS = [
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+/gi,
  /(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi,
  /((?:jwt|sync|pairing|api)[_-]?(?:secret|token|code)\s*[:=]\s*)[^\s,;]+/gi,
  /((?:password|passphrase)\s*[:=]\s*)[^\s,;]+/gi,
];

const SECRET_KEY = /^(?:authorization|(?:set-)?cookie|masterKey|pgPassword|password|passphrase|x-eshobe-billing-signature|(?:jwt|sync|pairing|api)[_-]?(?:secret|token|code))$/i;

function redactText(value) {
  let text = String(value).replace(/((?:masterKey|pgPassword|cookie|set-cookie|x-eshobe-billing-signature)\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "$1[REDACTED]");
  return text;
}

function redact(value) {
  const seen = new WeakSet();
  let text;
  if (value && typeof value === "object") {
    try {
      text = JSON.stringify(value, (key, item) => {
        if (SECRET_KEY.test(key)) return "[REDACTED]";
        if (item instanceof Error) item = { name: item.name, message: item.message, stack: item.stack };
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        return typeof item === "string" || typeof item === "bigint" ? redactText(item) : item;
      });
    } catch { text = "[Unserializable details]"; }
  } else text = String(value);
  return value && typeof value === "object" ? text : redactText(text);
}

function rotate(logPath, maxBytes, retained) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size < maxBytes) return;
    for (let index = retained - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`;
      const target = `${logPath}.${index + 1}`;
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // Logging must never prevent the application from booting.
  }
}

function createLogger(userDataDir, options = {}) {
  // Section 8 folder split: logs live under Logs/, not directly in
  // userData. `main.js` runs `migrateLegacyLayout()` before this is ever
  // called, so an existing install's log files have already moved here.
  const logDir = computePaths(userDataDir).logsDir;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "desktop.log");
  const maxBytes = options.maxBytes || 5 * 1024 * 1024;
  const retained = options.retained || 5;

  function write(level, message, details) {
    rotate(logPath, maxBytes, retained);
    const suffix = details === undefined ? "" : ` ${redact(details)}`;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}${suffix}\n`;
    try {
      fs.appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // There is no safe fallback that should make startup fatal.
    }
    const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[consoleMethod](line.trimEnd());
  }

  return {
    path: logPath,
    dir: logDir,
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
    childOutput: (name, chunk, level = "info") => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) write(level, `${name}: ${line}`);
    },
  };
}

module.exports = { createLogger, redact };
