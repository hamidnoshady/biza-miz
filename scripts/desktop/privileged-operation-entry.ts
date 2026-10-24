import { dumpDatabaseUrl } from "../../src/lib/backup";
import { restoreDumpFile } from "../../src/lib/restore-engine";
import { runPgDump } from "../../src/lib/pg-tools";

async function readRequest(): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (raw.length > 2 * 1024 * 1024) throw new Error("privileged_operation_too_large");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("privileged_operation_invalid");
  return parsed as Record<string, unknown>;
}

async function main(): Promise<unknown> {
  const request = await readRequest();
  const databaseUrl = dumpDatabaseUrl();
  if (request.operation === "dump") {
    if (typeof request.outFile !== "string") throw new Error("privileged_dump_path_missing");
    await runPgDump(request.outFile, databaseUrl);
    return null;
  }
  if (request.operation === "restore") {
    if (typeof request.dumpPath !== "string" || typeof request.source !== "string" || typeof request.apply !== "boolean") {
      throw new Error("privileged_restore_request_invalid");
    }
    return restoreDumpFile({
      databaseUrl,
      dumpPath: request.dumpPath,
      source: request.source,
      apply: request.apply,
      scratchDb: typeof request.scratchDb === "string" ? request.scratchDb : undefined,
      emergencyDir: typeof request.emergencyDir === "string" ? request.emergencyDir : undefined,
      journal: request.journal as never,
      runtimeEnv: process.env,
    });
  }
  throw new Error("privileged_operation_unknown");
}

void main().then(
  (result) => process.stdout.write(JSON.stringify({ ok: true, result })),
  (error) => {
    // Keep stdout machine-readable. Electron redacts connection strings before
    // returning any failure to the unprivileged web process or writing a log.
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  },
);
