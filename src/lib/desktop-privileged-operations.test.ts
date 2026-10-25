import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { startPrivilegedOperationServer, validRequest } = require("../../electron/privileged-operations.js") as {
  startPrivilegedOperationServer(options: Record<string, unknown>): Promise<{
    url: string;
    token: string;
    run(request: unknown): Promise<unknown>;
    close(): Promise<void>;
  }>;
  validRequest(value: unknown): boolean;
};

const RUNTIME_URL = "postgres://runtime:runtime-secret@127.0.0.1:5544/app";
const SUPERUSER_URL = "postgres://postgres:s3cr%40t@127.0.0.1:5544/postgres";

describe("privileged operation request validation", () => {
  it("accepts only fixed operations with absolute paths and typed restore controls", () => {
    const output = path.resolve("backup.dump");
    expect(validRequest({ operation: "dump", outFile: output })).toBe(true);
    expect(validRequest({ operation: "dump", outFile: "relative.dump" })).toBe(false);
    expect(validRequest({ operation: "dump", outFile: output, bin: "/other/pg_dump" })).toBe(false);
    expect(validRequest({ operation: "restore", dumpPath: output, source: "cloud/key", apply: false })).toBe(true);
    expect(validRequest({ operation: "restore", dumpPath: output, source: "cloud/key", apply: "false" })).toBe(false);
    expect(validRequest({ operation: "shell", outFile: output })).toBe(false);
  });
});

describe("loopback privileged operation broker", () => {
  let root = "";
  let capture = "";
  let broker: Awaited<ReturnType<typeof startPrivilegedOperationServer>> | null = null;
  const childOutput = vi.fn();

  beforeEach(async () => {
    childOutput.mockReset();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-privileged-test-"));
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    capture = path.join(root, "capture.json");
    process.env.TEST_CAPTURE = capture;
    fs.writeFileSync(path.join(bin, "privileged-operation.cjs"), `
      const fs = require("node:fs");
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        const request = JSON.parse(raw);
        fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({
          runtime: process.env.DATABASE_URL,
          backup: process.env.BACKUP_DATABASE_URL,
          bridgeUrl: process.env.DESKTOP_PRIVILEGED_URL,
          bridgeToken: process.env.DESKTOP_PRIVILEGED_TOKEN,
          tools: process.env.PG_TOOLS_DIR,
        }));
        if (request.operation === "restore") {
          const password = new URL(process.env.BACKUP_DATABASE_URL).password;
          process.stderr.write("worker failed " + process.env.BACKUP_DATABASE_URL + " " + decodeURIComponent(password));
          process.stdout.write(JSON.stringify({ ok: false, error: "failed " + process.env.BACKUP_DATABASE_URL + " " + decodeURIComponent(password) }));
          process.exitCode = 1;
        } else {
          process.stdout.write(JSON.stringify({ ok: true, result: { operation: request.operation } }));
        }
      });
    `);
    broker = await startPrivilegedOperationServer({
      runtimeDir: root,
      runtimeDatabaseUrl: RUNTIME_URL,
      superuserDatabaseUrl: SUPERUSER_URL,
      pgToolsDir: path.join(root, "tools"),
      emergencyBackupDir: path.join(root, "emergency"),
      logger: { childOutput },
    });
  });

  afterEach(async () => {
    await broker?.close();
    broker = null;
    delete process.env.TEST_CAPTURE;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("requires the per-boot bearer token, rejects browser origins, and confines credentials to the child", async () => {
    const output = path.join(root, "backup.dump");
    const call = (authorization?: string, origin?: string) => fetch(`${broker!.url}/operations`, {
      method: "POST",
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(origin ? { Origin: origin } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation: "dump", outFile: output }),
    });
    expect((await call()).status).toBe(403);
    expect((await call(`Bearer ${broker!.token}`, "https://evil.invalid")).status).toBe(403);
    // Same JavaScript character count, different UTF-8 byte length: must be a
    // normal 403, never a timingSafeEqual exception that kills the handler.
    expect((await call(`Bearer ${"é".repeat(broker!.token.length)}`)).status).toBe(403);
    expect(fs.existsSync(capture)).toBe(false);

    const response = await call(`Bearer ${broker!.token}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { operation: "dump" } });
    const child = JSON.parse(fs.readFileSync(capture, "utf8"));
    expect(child.runtime).toBe(RUNTIME_URL);
    expect(child.backup).toBe(SUPERUSER_URL);
    expect(child.bridgeUrl).toBeUndefined();
    expect(child.bridgeToken).toBeUndefined();
  });

  it("redacts full URLs and standalone passwords from worker responses and logs", async () => {
    const response = await fetch(`${broker!.url}/operations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${broker!.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "restore", dumpPath: path.join(root, "backup.dump"), source: "local/key", apply: false }),
    });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("[redacted]");
    expect(body.error).not.toContain(SUPERUSER_URL);
    expect(body.error).not.toContain("s3cr@t");
    const logs = childOutput.mock.calls.map((call) => String(call[1])).join("\n");
    expect(logs).toContain("[redacted]");
    expect(logs).not.toContain(SUPERUSER_URL);
    expect(logs).not.toContain("s3cr@t");
  });
});
