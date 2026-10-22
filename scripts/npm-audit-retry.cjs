#!/usr/bin/env node
/*
 * Run the production dependency audit without turning a transient npm registry
 * outage into a false CI failure. Vulnerability findings and all other npm
 * errors still fail immediately; only known network/5xx failures are retried.
 */
const { spawnSync } = require("node:child_process");

const maxAttempts = 5;
const transientFailure = /(?:\b50[0-4]\b|service unavailable|bad gateway|gateway timeout|internal server error|eai_again|econnreset|etimedout|econnrefused|enotfound|socket hang up|fetch failed|audit endpoint returned an error)/i;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["audit", "--omit=dev", "--audit-level=high"],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
  if (result.status === 0 && !result.error) process.exit(0);

  const exitCode = result.status ?? 1;
  if (!transientFailure.test(output) || attempt === maxAttempts) {
    if (attempt === maxAttempts && transientFailure.test(output)) {
      console.error(`npm audit registry request remained unavailable after ${maxAttempts} attempts.`);
    }
    process.exit(exitCode);
  }

  const delayMs = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
  console.warn(`npm audit hit a transient registry/network error; retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxAttempts}).`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}
