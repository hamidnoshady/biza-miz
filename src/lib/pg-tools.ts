/**
 * PostgreSQL client-tool resolution and execution.
 *
 * Desktop production builds never search PATH and never trust a per-process
 * executable override. They resolve the two packaged clients from
 * PG_TOOLS_DIR, verify every staged file against the packaged provenance
 * manifest, verify the executable's exact PostgreSQL version, and compare its
 * major version with the server before a dump or restore is attempted.
 *
 * Explicit PG_DUMP_PATH/PG_RESTORE_PATH values remain available to development,
 * operator CLI and integration tests. They are intentionally refused when
 * NODE_ENV=production; a controlled non-desktop production deployment can stage
 * the same manifest directory and set PG_TOOLS_DIR.
 */
import { createHash } from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "pg";

export type PgToolKind = "pg_dump" | "pg_restore";

export interface PgToolsProvenance {
  schemaVersion: 1;
  status: "verified";
  postgresVersion: string;
  postgresMajor: number;
  artifact: {
    organization: string;
    name: string;
    sha256: string;
    sourceBuild?: string;
  };
  files: Array<{ path: string; sha256: string; bytes: number }>;
  generatedAt: string;
}

export interface PgToolResolution {
  kind: PgToolKind;
  executable: string;
  source: "packaged" | "development-override" | "development-path";
  postgresVersion: string;
  postgresMajor: number;
  provenance: PgToolsProvenance | null;
}

function isProduction(env: Partial<NodeJS.ProcessEnv>): boolean {
  return env.NODE_ENV === "production";
}

function executableName(kind: PgToolKind): string {
  return process.platform === "win32" ? `${kind}.exe` : kind;
}

function explicitPath(kind: PgToolKind, env: Partial<NodeJS.ProcessEnv>): string | undefined {
  return (kind === "pg_dump" ? env.PG_DUMP_PATH : env.PG_RESTORE_PATH)?.trim() || undefined;
}

/** Synchronous path selection retained for callers that expose the chosen path. */
export function pgToolBin(kind: PgToolKind, env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const override = explicitPath(kind, env);
  if (isProduction(env) && override) {
    throw new Error(`${kind}_external_override_forbidden_in_production`);
  }
  const toolsDir = env.PG_TOOLS_DIR?.trim();
  if (toolsDir) return path.join(toolsDir, "bin", executableName(kind));
  if (isProduction(env)) throw new Error(`${kind}_packaged_tools_not_configured`);
  return override ?? executableName(kind);
}

export function pgDumpBin(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return pgToolBin("pg_dump", env);
}

export function pgRestoreBin(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return pgToolBin("pg_restore", env);
}

function spawnOptionsFor(bin: string, stdio: SpawnOptions["stdio"] = ["ignore", "ignore", "pipe"]): SpawnOptions {
  const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin.trim());
  return { stdio, shell: isBatch, windowsHide: true };
}

export const PG_DUMP_TIMEOUT_MS = 15 * 60 * 1000;
export const PG_RESTORE_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_TIMEOUT_MS = 15_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const validatedDirectories = new Map<string, Promise<PgToolsProvenance>>();
const resolvedTools = new Map<string, Promise<PgToolResolution>>();

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

function safeManifestPath(relative: string): boolean {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\")) return false;
  const normalized = path.posix.normalize(relative);
  return normalized === relative && !normalized.startsWith("../") && normalized !== "..";
}

async function validatePackagedDirectory(toolsDir: string): Promise<PgToolsProvenance> {
  const root = path.resolve(toolsDir);
  const cached = validatedDirectories.get(root);
  if (cached) return cached;
  const validation = (async () => {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(path.join(root, "provenance.json"), "utf8"));
    } catch (error) {
      throw new Error(`postgresql_tools_provenance_unreadable:${error instanceof Error ? error.message : String(error)}`);
    }
    const manifest = value as Partial<PgToolsProvenance>;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.status !== "verified" ||
      typeof manifest.postgresVersion !== "string" ||
      !/^16(?:\.\d+){1,2}$/.test(manifest.postgresVersion) ||
      manifest.postgresMajor !== 16 ||
      !manifest.artifact ||
      typeof manifest.artifact.organization !== "string" ||
      !manifest.artifact.organization.trim() ||
      !SHA256_RE.test(manifest.artifact.sha256 ?? "") ||
      !Array.isArray(manifest.files)
    ) {
      throw new Error("postgresql_tools_provenance_invalid");
    }
    const required = new Set([`bin/${executableName("pg_dump")}`, `bin/${executableName("pg_restore")}`]);
    const seen = new Set<string>();
    for (const entry of manifest.files) {
      if (!entry || !safeManifestPath(entry.path) || !SHA256_RE.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
        throw new Error("postgresql_tools_provenance_file_invalid");
      }
      if (seen.has(entry.path)) throw new Error(`postgresql_tools_provenance_duplicate:${entry.path}`);
      seen.add(entry.path);
      required.delete(entry.path);
      const absolute = path.resolve(root, ...entry.path.split("/"));
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("postgresql_tools_path_escape");
      const info = await fs.lstat(absolute).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) {
        throw new Error(`postgresql_tools_file_missing_or_changed:${entry.path}`);
      }
      const digest = await sha256File(absolute);
      if (digest !== entry.sha256) throw new Error(`postgresql_tools_checksum_mismatch:${entry.path}`);
    }
    if (required.size) throw new Error(`postgresql_tools_required_files_missing:${[...required].join(",")}`);
    return manifest as PgToolsProvenance;
  })();
  validatedDirectories.set(root, validation);
  try {
    return await validation;
  } catch (error) {
    validatedDirectories.delete(root);
    throw error;
  }
}

function captureVersion(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--version"], {
      ...spawnOptionsFor(bin, ["ignore", "pipe", "pipe"]),
      timeout: VERSION_TIMEOUT_MS,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { if (output.length < 1000) output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { if (output.length < 1000) output += chunk.toString(); });
    child.once("error", (error) => reject(new Error(`postgresql_tool_version_start_failed:${error.message}`)));
    child.once("close", (code, signal) => {
      if (code !== 0) return reject(new Error(`postgresql_tool_version_failed:${signal ?? code}`));
      const match = output.match(/PostgreSQL\)?\s+(\d+(?:\.\d+){1,2})/i);
      if (!match) return reject(new Error("postgresql_tool_version_unrecognized"));
      resolve(match[1]);
    });
  });
}

export async function resolvePgTool(
  kind: PgToolKind,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): Promise<PgToolResolution> {
  const executable = pgToolBin(kind, env);
  const toolsDir = env.PG_TOOLS_DIR?.trim();
  const cacheKey = `${kind}\0${executable}\0${toolsDir ?? ""}\0${env.NODE_ENV ?? ""}`;
  const cached = resolvedTools.get(cacheKey);
  if (cached) return cached;
  const resolving = (async () => {
    const provenance = toolsDir ? await validatePackagedDirectory(toolsDir) : null;
    const postgresVersion = await captureVersion(executable);
    const postgresMajor = Number(postgresVersion.split(".")[0]);
    if (provenance && postgresVersion !== provenance.postgresVersion) {
      throw new Error(`postgresql_tool_version_mismatch:${kind}:${postgresVersion}:${provenance.postgresVersion}`);
    }
    if (postgresMajor !== 16) throw new Error(`postgresql_tool_major_unsupported:${postgresMajor}`);
    return {
      kind,
      executable,
      source: provenance ? "packaged" as const : explicitPath(kind, env) ? "development-override" as const : "development-path" as const,
      postgresVersion,
      postgresMajor,
      provenance,
    };
  })();
  resolvedTools.set(cacheKey, resolving);
  try {
    return await resolving;
  } catch (error) {
    resolvedTools.delete(cacheKey);
    throw error;
  }
}

export async function assertPgToolServerCompatibility(
  resolution: PgToolResolution,
  databaseUrl: string,
  expectedServerMajor = Number(process.env.PG_SERVER_MAJOR || "0"),
): Promise<number> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query<{ version_num: string }>("SELECT current_setting('server_version_num') AS version_num");
    const serverMajor = Math.floor(Number(rows[0]?.version_num ?? 0) / 10_000);
    if (!serverMajor) throw new Error("postgresql_server_version_unrecognized");
    if (expectedServerMajor && serverMajor !== expectedServerMajor) {
      throw new Error(`postgresql_server_major_unexpected:${serverMajor}:${expectedServerMajor}`);
    }
    // pg_dump refuses a newer server. Keeping the packaged client on the same
    // major as the embedded server also guarantees pg_restore archive support.
    if (resolution.postgresMajor < serverMajor || (resolution.provenance && resolution.postgresMajor !== serverMajor)) {
      throw new Error(`postgresql_tool_server_incompatible:${resolution.postgresMajor}:${serverMajor}`);
    }
    return serverMajor;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Verify both packaged clients and server compatibility for diagnostics/startup acceptance. */
export async function inspectPgTools(databaseUrl: string): Promise<{ dump: PgToolResolution; restore: PgToolResolution; serverMajor: number }> {
  const [dump, restore] = await Promise.all([resolvePgTool("pg_dump"), resolvePgTool("pg_restore")]);
  if (dump.postgresVersion !== restore.postgresVersion) throw new Error("postgresql_tools_version_pair_mismatch");
  const serverMajor = await assertPgToolServerCompatibility(dump, databaseUrl);
  await assertPgToolServerCompatibility(restore, databaseUrl);
  return { dump, restore, serverMajor };
}

export function postgresToolConnection(databaseUrl: string): {
  dbname: string;
  env: Partial<NodeJS.ProcessEnv>;
} {
  const parsed = new URL(databaseUrl);
  let password = parsed.password;
  try { password = decodeURIComponent(password); } catch { /* retain the literal credential */ }
  parsed.password = "";
  return {
    dbname: parsed.toString(),
    env: password ? { PGPASSWORD: password } : {},
  };
}

function executeTool(
  bin: string,
  args: string[],
  timeout: number,
  label: PgToolKind,
  credentialEnv: Partial<NodeJS.ProcessEnv> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      ...spawnOptionsFor(bin),
      timeout,
      env: { ...process.env, ...credentialEnv },
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString(); });
    child.once("error", (error) => reject(new Error(`could not start ${label}: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      const hint = label === "pg_dump" && /row-level security/.test(stderr)
        ? " — pg_dump must connect as the privileged (migration/owner) role; point BACKUP_DATABASE_URL at it"
        : "";
      reject(new Error(`${label} exited with ${signal ?? code}: ${stderr.trim().slice(0, 1000)}${hint}`));
    });
  });
}

export async function runPgDump(outFile: string, databaseUrl: string, bin?: string): Promise<void> {
  const resolution = bin
    ? { kind: "pg_dump" as const, executable: bin, source: "development-override" as const, postgresVersion: "16.0", postgresMajor: 16, provenance: null }
    : await resolvePgTool("pg_dump");
  if (!bin) await assertPgToolServerCompatibility(resolution, databaseUrl);
  const connection = postgresToolConnection(databaseUrl);
  await executeTool(
    resolution.executable,
    ["--format=custom", "--compress=gzip:6", "--no-password", `--file=${outFile}`, connection.dbname],
    PG_DUMP_TIMEOUT_MS,
    "pg_dump",
    connection.env,
  );
}

export async function runPgRestore(bin: string | undefined, args: string[], databaseUrl?: string): Promise<void> {
  let resolution: PgToolResolution;
  if (bin && process.env.NODE_ENV !== "production") {
    resolution = { kind: "pg_restore", executable: bin, source: "development-override", postgresVersion: "16.0", postgresMajor: 16, provenance: null };
  } else {
    resolution = await resolvePgTool("pg_restore");
    if (bin && path.resolve(bin) !== path.resolve(resolution.executable)) {
      throw new Error("pg_restore_external_override_forbidden_in_production");
    }
  }
  if (databaseUrl && (resolution.provenance || process.env.NODE_ENV === "production")) {
    await assertPgToolServerCompatibility(resolution, databaseUrl);
  }
  const connection = databaseUrl ? postgresToolConnection(databaseUrl) : null;
  let credentialEnv = connection?.env ?? {};
  const safeArgs = args.map((argument) => {
    if (!argument.startsWith("--dbname=")) return argument;
    const target = argument.slice("--dbname=".length);
    // Non-URL dbnames do not carry credentials and remain untouched.
    if (!/^postgres(?:ql)?:\/\//i.test(target)) return argument;
    const targetConnection = postgresToolConnection(target);
    if (!connection) credentialEnv = { ...credentialEnv, ...targetConnection.env };
    return `--dbname=${targetConnection.dbname}`;
  });
  if (!safeArgs.includes("--no-password") && !safeArgs.includes("-w")) safeArgs.unshift("--no-password");
  await executeTool(resolution.executable, safeArgs, PG_RESTORE_TIMEOUT_MS, "pg_restore", credentialEnv);
}
