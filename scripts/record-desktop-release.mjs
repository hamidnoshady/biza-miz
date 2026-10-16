#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Record only the source that actually passed packaged acceptance. Never rebase
 * the version commit onto untested code, retry a push, or move an existing tag.
 * Atomic push makes a rejection of EITHER ref reject BOTH refs.
 */
export function recordDesktopRelease({ cwd = process.cwd(), source, version, runUrl }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!/^[a-f0-9]{40}$/.test(source ?? "")) throw new Error("A full tested source SHA is required");
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!semver.test(version ?? "")) throw new Error("Version must be canonical X.Y.Z");
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl ?? "")) throw new Error("A GitHub Actions run URL is required");
  if (git("rev-parse", "HEAD") !== source) throw new Error("Checkout differs from the tested source");
  if (git("status", "--porcelain")) throw new Error("Release checkout must be clean");
  const tag = `desktop-v${version}`;
  const remoteTag = git("ls-remote", "origin", `refs/tags/${tag}`);
  if (remoteTag) throw new Error(`${tag} already exists; never overwrite a shipped tag`);
  const remoteMain = git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(remoteMain)) throw new Error("Cannot resolve remote main");
  if (remoteMain !== source) return { status: "superseded", source, main: remoteMain, version, runUrl };

  const packagePath = resolve(cwd, "electron/package.json");
  const lockPath = resolve(cwd, "electron/package-lock.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!semver.test(pkg.version) || lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("Desktop package/lock versions must agree before recording a release");
  }
  const before = pkg.version.split(".").map(BigInt);
  const after = version.split(".").map(BigInt);
  const difference = after.findIndex((value, index) => value !== before[index]);
  if (difference < 0 || after[difference] < before[difference]) throw new Error("Release version must advance");
  pkg.version = lock.version = lock.packages[""].version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  git("add", "--", "electron/package.json", "electron/package-lock.json");
  git("commit", "-m", `Desktop v${version}`, "-m", `Packaged-source: ${source}\nAcceptance-run: ${runUrl}\nInstaller-artifact: business-suite-desktop-installer-${version}`);
  const commit = git("rev-parse", "HEAD");
  if (git("rev-parse", "HEAD^") !== source) throw new Error("Version commit must directly follow the tested source");
  git("tag", tag, commit);
  // No --force, --force-with-lease, pull/rebase or fallback to a non-atomic push.
  // A main update/tag collision between ls-remote and push fails closed.
  git("push", "--atomic", "origin", `${commit}:refs/heads/main`, `refs/tags/${tag}:refs/tags/${tag}`);
  return { status: "recorded", source, commit, tag, version, runUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Release recording is restricted to main");
    const result = recordDesktopRelease({
      source: process.env.TESTED_SOURCE_SHA,
      version: process.env.VERSION,
      runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    });
    const message = result.status === "recorded"
      ? `Recorded ${result.tag} at ${result.commit}; packaged source ${result.source}.`
      : `SUPERSEDED: packaged source ${result.source}, current main ${result.main}. No version commit or tag pushed; artifact is not a new release.`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Desktop version recording\n\n${message}\n\nAcceptance: ${result.runUrl}\n`);
  } catch (error) {
    console.error(error.message);
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  }
}
