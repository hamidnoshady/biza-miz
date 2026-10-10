/**
 * Byte accounting for the desktop payload: the staged runtime that
 * `npm run desktop:runtime` writes, and the unpacked Windows app that
 * electron-builder packages from it.
 *
 * The budgets in `verify-shippables.yml` and `build-desktop-installer.yml`
 * throw when a payload is too big, and a thrown step hides its numbers from
 * everything but the raw log, which is not retrievable after the fact. These
 * helpers turn a file listing into the numbers a reviewer needs (totals,
 * per-category and per-package rows, the largest files, and a manifest) so
 * the CLI in `scripts/desktop-size-diagnostics.ts` can record them before the
 * budget step runs and keep them when it fails.
 *
 * Everything here is pure: callers pass in `{ path, bytes }` pairs, so the
 * accounting can be tested without a build.
 */

export interface SizedFile {
  /** POSIX path relative to the measured root, e.g. `.next/server/chunks/1.js`. */
  readonly path: string;
  readonly bytes: number;
}

export interface SizeRow {
  readonly key: string;
  readonly bytes: number;
  readonly files: number;
}

export interface SizeSummary {
  readonly totalBytes: number;
  readonly fileCount: number;
  /** Every first path segment, largest first. */
  readonly topLevel: readonly SizeRow[];
  /** What the bytes are, grouped by `categoryOf` (after `stripPrefix`). */
  readonly categories: readonly SizeRow[];
  /** Traced `node_modules` packages, grouped by package name (after `stripPrefix`). */
  readonly packages: readonly SizeRow[];
  readonly largestFiles: readonly SizedFile[];
}

const CLIENT_REFERENCE_MANIFEST = "client-reference-manifest.js";
const BUILD_TRACE = ".nft.json";

/**
 * Classifies one file. Manifest and trace rules come first because they cut
 * across directories: a `route_client-reference-manifest.js` lives under
 * `.next/server/app/api/`, but its cost is the same wherever it sits, and the
 * question "how much do the per-route manifests cost" must not be hidden inside
 * "API routes".
 */
export function categoryOf(relativePath: string): string {
  const p = relativePath.replace(/\\/g, "/");
  if (p.endsWith(CLIENT_REFERENCE_MANIFEST)) return "Next client-reference manifests";
  if (p.endsWith(BUILD_TRACE)) return "Next build traces (*.nft.json)";
  if (p.startsWith(".next/server/app/api/")) {
    return p.endsWith("/route.js") ? "Next server app/api route bundles" : "Next server app/api (other)";
  }
  if (p.startsWith(".next/server/app/")) return "Next server app pages and layouts";
  if (p.startsWith(".next/server/chunks/")) return "Next server shared chunks";
  if (p.startsWith(".next/server/")) return "Next server (other)";
  if (p.startsWith(".next/static/chunks/app/")) return "Next client route chunks";
  if (p.startsWith(".next/static/chunks/")) return "Next client shared chunks";
  if (p.startsWith(".next/static/")) return "Next static (other)";
  if (p.startsWith(".next/")) return "Next (other)";
  if (p.startsWith("node_modules/")) return "node_modules (traced packages)";
  if (p.startsWith("bin/")) return "bin/ (custom server and migration bundles)";
  if (p.startsWith("migrations/")) return "migrations/";
  if (p.startsWith("public/")) return "public/";
  const parts = p.split("/");
  if (parts.length === 1) return "other: root files";
  if (parts[0] === "resources") return `other: ${parts[0]}/${parts[1]}`;
  return `other: ${parts[0]}`;
}

/** `node_modules/@scope/name/...` → `@scope/name`; `node_modules/name/...` → `name`. */
export function packageOf(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  if (parts[0] !== "node_modules" || parts.length < 2) return null;
  if (parts[1].startsWith("@")) return parts.length > 2 ? `${parts[1]}/${parts[2]}` : parts[1];
  return parts[1];
}

function groupRows(entries: Iterable<[string, { bytes: number; files: number }]>): SizeRow[] {
  return [...entries]
    .map(([key, value]) => ({ key, bytes: value.bytes, files: value.files }))
    .sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
}

function bump(map: Map<string, { bytes: number; files: number }>, key: string, bytes: number): void {
  const row = map.get(key) ?? { bytes: 0, files: 0 };
  row.bytes += bytes;
  row.files += 1;
  map.set(key, row);
}

/**
 * Totals and breakdowns for a listing. `stripPrefix` is removed before the
 * category and package rules run, so a packaged app can be read as its staged
 * runtime (`resources/desktop-runtime/` → the runtime's own layout). Top-level
 * rows always use the unstripped path, so the packaged view still shows
 * `resources` next to `locales`.
 */
export function summarize(
  files: readonly SizedFile[],
  options: { readonly stripPrefix?: string; readonly largestCount?: number } = {},
): SizeSummary {
  const stripPrefix = (options.stripPrefix ?? "").replace(/\\/g, "/");
  const largestCount = options.largestCount ?? 40;
  const topLevel = new Map<string, { bytes: number; files: number }>();
  const categories = new Map<string, { bytes: number; files: number }>();
  const packages = new Map<string, { bytes: number; files: number }>();
  let totalBytes = 0;

  for (const file of files) {
    totalBytes += file.bytes;
    const raw = file.path.replace(/\\/g, "/");
    bump(topLevel, raw.includes("/") ? raw.slice(0, raw.indexOf("/")) : raw, file.bytes);
    const scoped = stripPrefix && raw.startsWith(stripPrefix) ? raw.slice(stripPrefix.length) : raw;
    bump(categories, categoryOf(scoped), file.bytes);
    const pkg = packageOf(scoped);
    if (pkg) bump(packages, pkg, file.bytes);
  }

  const largestFiles = [...files]
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, largestCount);

  return {
    totalBytes,
    fileCount: files.length,
    topLevel: groupRows(topLevel),
    categories: groupRows(categories),
    packages: groupRows(packages),
    largestFiles,
  };
}

/** Binary megabytes, one decimal, as the budget scripts print them (1 MiB = 1,048,576 bytes). */
export function formatMiB(bytes: number, decimals = 1): string {
  return `${(bytes / 1048576).toFixed(decimals)} MiB`;
}

/** Exact bytes with thousands separators, so a figure can be compared digit for digit. */
export function formatExactBytes(bytes: number): string {
  return `${Math.trunc(bytes)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A tab-separated manifest, one line per file, sorted by path: `bytes<TAB>path`. */
export function manifestTsv(files: readonly SizedFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sorted.length === 0) return "";
  return sorted.map((file) => `${file.bytes}\t${file.path.replace(/\\/g, "/")}`).join("\n") + "\n";
}

function rowsTable(rows: readonly SizeRow[], limit: number): string {
  const lines = ["| Bytes | MiB | Files | Key |", "| ---: | ---: | ---: | --- |"];
  for (const row of rows.slice(0, limit)) {
    lines.push(
      `| ${formatExactBytes(row.bytes)} | ${formatMiB(row.bytes, 2)} | ${row.files} | ${row.key.replace(/\|/g, "\\|")} |`,
    );
  }
  return lines.join("\n");
}

/** The full human-readable report, written to the step summary and the artifact. */
export function summaryMarkdown(
  meta: { readonly label: string; readonly root: string; readonly sha: string; readonly generatedAt: string },
  summary: SizeSummary,
): string {
  return [
    `# ${meta.label} size`,
    "",
    `- Root: \`${meta.root}\``,
    `- Source commit: \`${meta.sha}\``,
    `- Generated: ${meta.generatedAt}`,
    `- Total: **${formatExactBytes(summary.totalBytes)} bytes** (${formatMiB(summary.totalBytes, 3)}), ${summary.fileCount} files`,
    "",
    "## Top-level",
    "",
    rowsTable(summary.topLevel, 50),
    "",
    "## Categories",
    "",
    rowsTable(summary.categories, 50),
    "",
    "## Traced packages",
    "",
    rowsTable(summary.packages, 60),
    "",
    "## Largest files",
    "",
    "| Bytes | MiB | Path |",
    "| ---: | ---: | --- |",
    ...summary.largestFiles.map((file) => `| ${formatExactBytes(file.bytes)} | ${formatMiB(file.bytes, 2)} | \`${file.path}\` |`),
    "",
  ].join("\n");
}

/** Escapes message data for a workflow command (`%`, CR and LF). */
export function escapeWorkflowData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escapes a workflow command property such as `title`, which also cannot hold `:` or `,`. */
export function escapeWorkflowProperty(value: string): string {
  return escapeWorkflowData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** One `::notice` line. Annotations are how these numbers stay readable through the API. */
export function workflowNotice(title: string, message: string): string {
  return `::notice title=${escapeWorkflowProperty(title)}::${escapeWorkflowData(message)}`;
}

/**
 * The notices for one payload: a headline with the exact total, then the top
 * categories, the top packages and the largest files. Each message stays well
 * under the workflow-command size limit, so nothing is silently truncated.
 */
export function noticesFor(label: string, summary: SizeSummary, rowLimit = 14): string[] {
  const headline = `${label}: ${formatExactBytes(summary.totalBytes)} bytes (${formatMiB(summary.totalBytes, 3)}) in ${summary.fileCount} files`;
  const top = summary.topLevel
    .slice(0, 8)
    .map((row) => `${row.key} ${formatMiB(row.bytes, 2)}`)
    .join("; ");
  const categoryLines = summary.categories
    .slice(0, rowLimit)
    .map((row) => `${formatMiB(row.bytes, 2).padStart(10)}  ${row.key} (${row.files})`);
  const packageLines = summary.packages
    .slice(0, rowLimit)
    .map((row) => `${formatMiB(row.bytes, 2).padStart(10)}  ${row.key}`);
  const fileLines = summary.largestFiles
    .slice(0, 12)
    .map((file) => `${formatMiB(file.bytes, 2).padStart(10)}  ${file.path}`);
  return [
    workflowNotice(`${label} total`, `${headline}. Top-level: ${top}`),
    workflowNotice(`${label} categories`, categoryLines.join("\n")),
    workflowNotice(`${label} packages`, packageLines.join("\n")),
    workflowNotice(`${label} largest files`, fileLines.join("\n")),
  ];
}
