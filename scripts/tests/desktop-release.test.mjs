import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordDesktopRelease } from "../record-desktop-release.mjs";

const runUrl = "https://github.com/owner/repo/actions/runs/123";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "desktop-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git"), repo = join(root, "repo"), other = join(root, "other");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "main", repo);
  for (const [key, value] of [["user.email", "test@example.com"], ["user.name", "Release test"], ["core.autocrlf", "false"]]) git(repo, "config", key, value);
  mkdirSync(join(repo, "electron"));
  writeFileSync(join(repo, "electron/package.json"), JSON.stringify({ name: "desktop", version: "1.0.59", buildCommit: "unknown" }, null, 2) + "\n");
  writeFileSync(join(repo, "electron/package-lock.json"), JSON.stringify({ version: "1.0.59", lockfileVersion: 3, packages: { "": { version: "1.0.59" } } }, null, 2) + "\n");
  writeFileSync(join(repo, "app.txt"), "tested app\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "tested source");
  git(repo, "remote", "add", "origin", remote); git(repo, "push", "origin", "main");
  git(root, "clone", "--branch", "main", remote, other);
  git(other, "config", "user.email", "other@example.com"); git(other, "config", "user.name", "Other update");
  const source = git(repo, "rev-parse", "HEAD");
  const record = (overrides = {}) => recordDesktopRelease({ cwd: repo, source, version: "1.0.60", runUrl, ...overrides });
  const ref = (name) => git(root, "--git-dir", remote, "show-ref", "--verify", "--hash", name);
  const noTag = () => assert.equal(git(root, "--git-dir", remote, "tag", "--list", "desktop-v1.0.60"), "");
  const race = (code) => {
    // Git for Windows executes hooks with its bundled sh; Node does the actual work.
    const hooks = join(root, "hooks"); mkdirSync(hooks);
    const runner = join(root, "race.cjs");
    writeFileSync(runner, `const {execFileSync}=require('node:child_process');const {writeFileSync}=require('node:fs');const git=(...a)=>execFileSync('git',a,{cwd:${JSON.stringify(other)},stdio:'pipe'});${code}`);
    writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\n"${process.execPath.replaceAll("\\", "/")}" "${runner.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
    git(repo, "config", "core.hooksPath", hooks);
  };
  return { root, remote, repo, other, git, source, record, ref, noTag, race };
}

test("atomic release tag follows only the tested source and records provenance", (t) => {
  const f = fixture(t), result = f.record();
  assert.equal(result.status, "recorded");
  assert.equal(f.ref("refs/heads/main"), result.commit);
  assert.equal(f.ref("refs/tags/desktop-v1.0.60"), result.commit);
  assert.equal(f.git(f.repo, "rev-parse", `${result.commit}^`), f.source);
  assert.match(f.git(f.repo, "show", "-s", "--format=%B", result.commit), new RegExp(`Packaged-source: ${f.source}`));
  assert.equal(f.git(f.repo, "diff", "--name-only", f.source, result.commit), "electron/package-lock.json\nelectron/package.json");
  assert.equal(JSON.parse(readFileSync(join(f.repo, "electron/package.json"))).buildCommit, "unknown");
});

test("stale build is superseded without a commit, tag, or rebase", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.other, "app.txt"), "new source\n");
  f.git(f.other, "commit", "-am", "main advanced"); f.git(f.other, "push", "origin", "main");
  const main = f.ref("refs/heads/main");
  assert.equal(f.record().status, "superseded");
  assert.equal(f.git(f.repo, "rev-parse", "HEAD"), f.source);
  assert.equal(f.ref("refs/heads/main"), main); f.noTag();
});

test("main update between inspection and push cannot leave a tag or replay the bump", (t) => {
  const f = fixture(t);
  f.race(`writeFileSync(${JSON.stringify(join(f.other, "app.txt"))},'racing update');git('commit','-am','racing main');git('push','origin','main');`);
  assert.throws(() => f.record());
  assert.notEqual(f.ref("refs/heads/main"), f.source); f.noTag();
  assert.equal(f.git(f.repo, "rev-parse", "HEAD^"), f.source);
});

test("tag collision during push cannot partially update main or overwrite tag", (t) => {
  const f = fixture(t);
  f.race(`git('tag','desktop-v1.0.60');git('push','origin','refs/tags/desktop-v1.0.60');`);
  assert.throws(() => f.record());
  assert.equal(f.ref("refs/heads/main"), f.source);
  assert.equal(f.ref("refs/tags/desktop-v1.0.60"), f.source);
});

test("branch protection rejection cannot partially publish a tag", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.remote, "hooks/update"), '#!/bin/sh\nif [ "$1" = "refs/heads/main" ]; then exit 1; fi\n', { mode: 0o755 });
  assert.throws(() => f.record());
  assert.equal(f.ref("refs/heads/main"), f.source); f.noTag();
});

test("existing tags are immutable, even when a run is repeated", (t) => {
  const f = fixture(t), result = f.record();
  assert.throws(() => f.record({ source: result.commit }), /already exists/);
  assert.equal(f.ref("refs/tags/desktop-v1.0.60"), result.commit);
});

test("dirty checkout, wrong SHA, downgrade, invalid version and lock mismatch fail closed", (t) => {
  const f = fixture(t);
  assert.throws(() => f.record({ source: "0".repeat(40) }), /Checkout differs/);
  for (const version of ["1.0.59", "1.0.58", "01.0.60", "2.0.0;bad"]) assert.throws(() => f.record({ version }));
  writeFileSync(join(f.repo, "app.txt"), "dirty");
  assert.throws(() => f.record(), /clean/);
  f.git(f.repo, "restore", "app.txt");
  const lock = join(f.repo, "electron/package-lock.json");
  writeFileSync(lock, JSON.stringify({ version: "1.0.58" }));
  f.git(f.repo, "commit", "-am", "inconsistent lock"); f.git(f.repo, "push", "origin", "main");
  assert.throws(() => f.record({ source: f.ref("refs/heads/main") }), /versions must agree/);
  f.noTag();
});


test("a server without atomic push support never falls back to separate updates", (t) => {
  const f = fixture(t);
  f.git(f.root, "--git-dir", f.remote, "config", "receive.advertiseAtomic", "false");
  assert.throws(() => f.record());
  assert.equal(f.ref("refs/heads/main"), f.source); f.noTag();
});

test("CLI refuses a non-main release without changing remote refs", (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL("../record-desktop-release.mjs", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [script], {
    cwd: f.repo, env: { ...process.env, GITHUB_REF: "refs/heads/arena/test" }, stdio: "pipe",
  }), (error) => String(error.stderr).includes("restricted to main"));
  assert.equal(f.ref("refs/heads/main"), f.source); f.noTag();
});
