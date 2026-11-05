import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `required` gate in `.github/workflows/test.yml` is the single status check
 * branch protection points at, so its own definition of "passed" is the
 * repository's definition of "passed".
 *
 * It used to test only `failure` and `cancelled` while its comment promised it
 * also caught a job that "never ran". Those are not the same set: a job whose
 * `if` evaluated false, or one GitHub never started, reports `skipped` — so the
 * gate could print "all checks passed" for a run in which one of its required
 * jobs did not execute. Issue #755 §22 asks for the CI workflow(s) to actually
 * cover this work; a gate that can pass vacuously is the one bug that would make
 * every other green check meaningless.
 *
 * Read as source rather than YAML-parsed, then execute the actual Bash gate:
 * its behavior must survive shell translations, not depend on a literal list.
 */

const source = readFileSync(path.join(".github", "workflows", "test.yml"), "utf8");

/**
 * Only the `jobs:` half of the file. The `on:` block has two-space-indented keys
 * of its own (`push:`, `pull_request:`), so a file-wide scan for job keys picks
 * up the trigger table and reports `push` as an ungated job.
 */
const jobsIndex = source.indexOf("\njobs:");
if (jobsIndex === -1) throw new Error("test.yml has no jobs: block");
const workflow = source.slice(jobsIndex);

/**
 * The body of a top-level job, from its key to the next top-level job key.
 *
 * Matches a *job key* specifically (two spaces, a name, a colon, end of line),
 * not the next two-space indent of any kind — an ordinary `\n  ` search stops at
 * the first nested line and returns a one-line "job".
 */
function jobBlock(job: string): string {
  const start = workflow.indexOf(`\n  ${job}:`);
  expect(start, `job ${job} not found in test.yml`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const end = /\n {2}[a-z][a-z0-9-]*:\s*$/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

describe("the required CI gate", () => {
  it("needs every check the workflow runs", () => {
    const required = jobBlock("required");
    const needs = /needs:\s*\[([^\]]+)\]/.exec(required);
    expect(needs, "the required job must declare its needs").not.toBeNull();

    const declared = needs![1].split(",").map((s) => s.trim());

    // Every job defined at the top level of this workflow, minus `required`
    // itself, which fans them in and cannot need itself.
    const defined = [...workflow.matchAll(/\n {2}([a-z][a-z0-9-]*):\s*$/gm)]
      .map((m) => m[1])
      .filter((name) => name !== "required");

    expect(defined.length).toBeGreaterThan(5);
    // Every job that exists is gated. A job nobody needs is a job whose failure
    // does not stop a merge.
    for (const job of defined) {
      expect(declared, `${job} is not gated by the required check`).toContain(job);
    }
    for (const job of ["lint", "typecheck", "unit-tests", "build", "integration-tests", "design-checks"]) {
      expect(declared, `${job} must gate the run`).toContain(job);
    }
  });

  it.each([
    ["success success success", 0],
    ["failure success success", 1],
    ["success cancelled success", 1],
    ["success success skipped", 1],
    ["success unknown success", 1],
    ["", 1],
    ["   ", 1],
  ])("checks actual job results %j with exit status %i", (results, status) => {
    const required = jobBlock("required");
    expect(required).toMatch(/shell:\s*bash/);
    expect(required).toContain("RESULTS: ${{ join(needs.*.result, ' ') }}");
    const run = /        run: \|\r?\n((?: {10}[^\n]*\n?)+)/.exec(required);
    expect(run, "the required job must execute its gate script").not.toBeNull();
    const script = run![1].replace(/^ {10}/gm, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
      env: { ...process.env, RESULTS: results },
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    if (status !== 0) expect(result.stdout).toContain("::error::");
  });

  it("runs even when an upstream job fails, so it can report on it", () => {
    expect(jobBlock("required")).toMatch(/if:\s*always\(\)/);
  });

  it("treats a skipped job as a hard failure rather than a warning", () => {
    expect(jobBlock("required")).toMatch(/::error::/);
    expect(jobBlock("required")).toMatch(/exit 1/);
  });
});
