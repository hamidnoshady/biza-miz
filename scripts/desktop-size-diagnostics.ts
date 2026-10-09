#!/usr/bin/env tsx
/**
 * Records the exact byte accounting of a desktop payload before a size budget
 * can throw, so the numbers survive a failed run.
 *
 * Run from the root of the checkout being measured. The tooling itself can
 * come from another checkout, which is how a base commit is measured with the
 * same workflow as a pull request:
 *
 *   npx tsx <tooling>/scripts/desktop-size-diagnostics.ts \
 *     --root=.desktop-runtime --label=staged-runtime --out=desktop-size-diagnostics
 *
 * Options:
 *   --root=<dir>           tree to measure (required)
 *   --label=<name>         names the outputs and notices (default: basename of root)
 *   --out=<dir>            where the .md, .json and -manifest.tsv files go
 *   --strip-prefix=<path>  remove this prefix before classifying, e.g. the
 *                          packaged app's resources/desktop-runtime/
 *   --sha=<commit>         commit to print with the numbers (default: git HEAD here)
 *
 * Outputs a `::notice` annotation per section, readable through the Checks API
 * after the run, and appends the full report to $GITHUB_STEP_SUMMARY when set.
 * A missing root is reported and exits 0, because the budget step that follows
 * is the one that decides pass or fail.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  manifestTsv,
  noticesFor,
  summarize,
  summaryMarkdown,
  workflowNotice,
  type SizedFile,
} from "../src/lib/desktop-size-diagnostics";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit?.slice(prefix.length);
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Every regular file below `root`, with POSIX relative paths. Symlinked directories are not followed. */
async function listFiles(root: string): Promise<SizedFile[]> {
  const files: SizedFile[] = [];
  async function walk(directory: string, relative: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absolute, rel);
      } else if (entry.isFile()) {
        files.push({ path: rel, bytes: (await stat(absolute)).size });
      } else if (entry.isSymbolicLink()) {
        const target = await stat(absolute).catch(() => null);
        if (target?.isFile()) files.push({ path: rel, bytes: target.size });
      }
    }
  }
  await walk(root, "");
  return files;
}

async function main(): Promise<number> {
  const rootArg = argValue("root");
  if (!rootArg) {
    console.error(
      "usage: desktop-size-diagnostics.ts --root=<dir> [--label=<name>] [--out=<dir>] [--strip-prefix=<path>] [--sha=<commit>]",
    );
    return 2;
  }
  const root = path.resolve(rootArg);
  const label = argValue("label") ?? path.basename(root);
  const outDir = path.resolve(argValue("out") ?? "desktop-size-diagnostics");
  const stripPrefix = argValue("strip-prefix") ?? "";
  const sha = argValue("sha") ?? gitHead();
  const generatedAt = new Date().toISOString();
  const present = existsSync(root);

  const files = present ? await listFiles(root) : [];
  const summary = summarize(files, { stripPrefix, largestCount: 60 });
  const meta = { label, root: rootArg, sha, generatedAt };
  const markdown = present
    ? summaryMarkdown(meta, summary)
    : `# ${label} size\n\nRoot \`${rootArg}\` was not produced by this run (commit \`${sha}\`).\n`;

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${label}.md`), markdown);
  await writeFile(path.join(outDir, `${label}-manifest.tsv`), manifestTsv(files));
  await writeFile(
    path.join(outDir, `${label}.json`),
    `${JSON.stringify(
      {
        ...meta,
        totalBytes: summary.totalBytes,
        fileCount: summary.fileCount,
        topLevel: summary.topLevel,
        categories: summary.categories,
        packages: summary.packages,
        largestFiles: summary.largestFiles,
      },
      null,
      2,
    )}\n`,
  );

  console.log(workflowNotice(`${label} source`, `commit ${sha}; root ${rootArg}; generated ${generatedAt}`));
  if (present) {
    for (const line of noticesFor(label, summary)) console.log(line);
  } else {
    console.log(workflowNotice(`${label} total`, `${label}: root ${rootArg} was not produced`));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`desktop size diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
