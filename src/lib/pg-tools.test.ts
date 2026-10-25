import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pgToolBin, postgresToolConnection, resolvePgTool, runPgRestore } from "./pg-tools";

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.PG_TOOLS_TEST_ARGS;
  delete process.env.PG_TOOLS_TEST_PASSWORD;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function packagedTools(version = "16.14") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pg-tools-test-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "bin"));
  const names = process.platform === "win32" ? ["pg_dump.exe", "pg_restore.exe"] : ["pg_dump", "pg_restore"];
  const files = [];
  for (const name of names) {
    const label = name.startsWith("pg_dump") ? "pg_dump" : "pg_restore";
    const body = process.platform === "win32"
      ? `@echo off\r\necho ${label} (PostgreSQL) ${version}\r\n`
      : `#!/bin/sh\necho '${label} (PostgreSQL) ${version}'\n`;
    const absolute = path.join(dir, "bin", name);
    await fs.writeFile(absolute, body, { mode: 0o755 });
    files.push({ path: `bin/${name}`, sha256: sha(body), bytes: Buffer.byteLength(body) });
  }
  await fs.writeFile(path.join(dir, "provenance.json"), JSON.stringify({
    schemaVersion: 1,
    status: "verified",
    postgresVersion: version,
    postgresMajor: 16,
    artifact: {
      organization: "Business Suite test fixture",
      name: "postgresql-tools-test.zip",
      sha256: "a".repeat(64),
    },
    files,
    generatedAt: new Date(0).toISOString(),
  }));
  return { dir, files };
}

describe("PostgreSQL tool credentials", () => {
  it("removes the password from argv and passes it only through the child environment", () => {
    const connection = postgresToolConnection("postgres://postgres:p%40ss%3Aword@127.0.0.1:5544/pos?sslmode=disable");
    expect(connection.dbname).not.toContain("p%40ss");
    expect(connection.dbname).not.toContain("p@ss");
    expect(connection.dbname).toContain("postgres@127.0.0.1:5544");
    expect(connection.env).toEqual({ PGPASSWORD: "p@ss:word" });
  });

  it("sanitizes the actual pg_restore child argv and preserves its credential in PGPASSWORD", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pg-restore-argv-test-"));
    dirs.push(dir);
    const argsPath = path.join(dir, "args.txt");
    const passwordPath = path.join(dir, "password.txt");
    process.env.PG_TOOLS_TEST_ARGS = argsPath;
    process.env.PG_TOOLS_TEST_PASSWORD = passwordPath;
    const executable = path.join(dir, process.platform === "win32" ? "fake-pg-restore.cmd" : "fake-pg-restore");
    const script = process.platform === "win32"
      ? "@echo off\r\n> \"%PG_TOOLS_TEST_ARGS%\" echo %*\r\n> \"%PG_TOOLS_TEST_PASSWORD%\" echo %PGPASSWORD%\r\n"
      : "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$PG_TOOLS_TEST_ARGS\"\nprintf '%s' \"$PGPASSWORD\" > \"$PG_TOOLS_TEST_PASSWORD\"\n";
    await fs.writeFile(executable, script, { mode: 0o755 });

    await runPgRestore(executable, [
      "--exit-on-error",
      "--dbname=postgres://postgres:p%40ss%3Aword@127.0.0.1:5544/scratch",
      "backup.dump",
    ]);
    const args = await fs.readFile(argsPath, "utf8");
    expect(args).toContain("--no-password");
    expect(args).not.toContain("p%40ss");
    expect(args).not.toContain("p@ss");
    expect((await fs.readFile(passwordPath, "utf8")).trim()).toBe("p@ss:word");
  });
});

describe("production PostgreSQL tool resolution", () => {
  it("never falls back to PATH or accepts an arbitrary executable override", () => {
    expect(() => pgToolBin("pg_dump", { NODE_ENV: "production" })).toThrow("packaged_tools_not_configured");
    expect(() => pgToolBin("pg_dump", { NODE_ENV: "production", PG_DUMP_PATH: "/tmp/pg_dump" })).toThrow(
      "external_override_forbidden",
    );
  });

  it.skipIf(process.platform === "win32")("verifies packaged provenance, every file hash, and the exact executable version", async () => {
    const fixture = await packagedTools();
    const resolved = await resolvePgTool("pg_dump", { NODE_ENV: "production", PG_TOOLS_DIR: fixture.dir });
    expect(resolved.source).toBe("packaged");
    expect(resolved.postgresVersion).toBe("16.14");
    expect(resolved.provenance?.artifact.sha256).toBe("a".repeat(64));
  });

  it("rejects a packaged payload changed after provenance was generated", async () => {
    const fixture = await packagedTools();
    const dump = process.platform === "win32" ? "pg_dump.exe" : "pg_dump";
    await fs.appendFile(path.join(fixture.dir, "bin", dump), "tamper");
    await expect(resolvePgTool("pg_dump", { NODE_ENV: "production", PG_TOOLS_DIR: fixture.dir })).rejects.toThrow(
      "file_missing_or_changed",
    );
  });

  it.skipIf(process.platform === "win32")("rejects a non-16 or provenance-mismatched executable version", async () => {
    const fixture = await packagedTools("15.9");
    const manifestPath = path.join(fixture.dir, "provenance.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.postgresVersion = "16.14";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expect(resolvePgTool("pg_restore", { NODE_ENV: "production", PG_TOOLS_DIR: fixture.dir })).rejects.toThrow(
      "version_mismatch",
    );
  });
});
