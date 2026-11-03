#!/usr/bin/env node
/**
 * Stage the PostgreSQL client installed by the production Alpine image into
 * the manifest-backed directory required by src/lib/pg-tools.ts.
 *
 * apk verifies repository signatures during installation. This records the
 * installed package identity and hashes the exact two executables copied into
 * the runtime payload. The Dockerfile then asks the application's production
 * resolver to validate this manifest and execute both tools before the image
 * can be built.
 */
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const toolsDir = path.resolve(process.env.PG_TOOLS_DIR || "/opt/postgresql-tools");
const expectedToolsDir = path.resolve("/opt/postgresql-tools");
const REQUIRED_PACKAGE_PREFIX = "postgresql16-client-";
const POSTGRES_VERSION_RE = /^16(?:\.\d+){1,2}$/;

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function findExecutable(name) {
  const located = commandOutput("sh", ["-c", `command -v ${name}`]);
  if (!located.startsWith("/")) throw new Error(`Could not resolve absolute path for ${name}: ${located}`);
  return located;
}

function postgresVersion(executable) {
  const output = commandOutput(executable, ["--version"]);
  const match = output.match(/PostgreSQL\)?\s+(\d+(?:\.\d+){1,2})/i);
  if (!match || !POSTGRES_VERSION_RE.test(match[1])) {
    throw new Error(`Unsupported or unrecognized PostgreSQL client version from ${executable}: ${output}`);
  }
  return match[1];
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function main() {
  if (process.platform !== "linux") throw new Error("Container PostgreSQL tool staging is supported only on Linux");
  if (toolsDir !== expectedToolsDir) {
    throw new Error(`PG_TOOLS_DIR must be ${expectedToolsDir}, received ${toolsDir}`);
  }

  const installedPackages = commandOutput("apk", ["info", "-v"]).split(/\r?\n/);
  const packageInfo = installedPackages.find((line) => line.startsWith(REQUIRED_PACKAGE_PREFIX));
  if (!packageInfo) {
    throw new Error("The signed Alpine postgresql16-client package is not installed");
  }

  const stagedFiles = [];
  const versions = [];
  await fs.rm(toolsDir, { recursive: true, force: true });
  await fs.mkdir(path.join(toolsDir, "bin"), { recursive: true });

  for (const name of ["pg_dump", "pg_restore"]) {
    const source = await fs.realpath(findExecutable(name));
    const sourceInfo = await fs.stat(source);
    if (!sourceInfo.isFile()) throw new Error(`${name} source is not a regular file: ${source}`);

    const version = postgresVersion(source);
    versions.push(version);
    const relativePath = `bin/${name}`;
    const destination = path.join(toolsDir, relativePath);
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o755);

    const destinationInfo = await fs.lstat(destination);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || destinationInfo.size < 1) {
      throw new Error(`Staged ${name} is missing, empty, or not a regular file`);
    }
    const stagedVersion = postgresVersion(destination);
    if (stagedVersion !== version) {
      throw new Error(`${name} changed version while staging: ${version} -> ${stagedVersion}`);
    }

    stagedFiles.push({
      path: relativePath,
      sha256: await sha256File(destination),
      bytes: destinationInfo.size,
    });
  }

  if (versions[0] !== versions[1]) {
    throw new Error(`PostgreSQL client tools do not match: pg_dump=${versions[0]}, pg_restore=${versions[1]}`);
  }

  const postgresVersionValue = versions[0];
  const artifactSha256 = createHash("sha256")
    .update(JSON.stringify({ packageInfo, postgresVersion: postgresVersionValue, files: stagedFiles }))
    .digest("hex");

  const manifest = {
    schemaVersion: 1,
    status: "verified",
    postgresVersion: postgresVersionValue,
    postgresMajor: 16,
    artifact: {
      organization: "alpinelinux",
      name: packageInfo,
      sha256: artifactSha256,
      sourceBuild: "Alpine signed APK repository package; installed by apk",
    },
    files: stagedFiles,
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(
    path.join(toolsDir, "provenance.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644 },
  );

  console.log(
    `Staged verified PostgreSQL ${postgresVersionValue} tools from ${packageInfo} at ${toolsDir}`,
  );
}

main().catch((error) => {
  console.error(`PostgreSQL container tool staging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
