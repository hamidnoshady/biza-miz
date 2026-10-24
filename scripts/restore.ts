/**
 * Restore a database backup (Phase 10) — the tested half of the runbook in
 * docs/deployment/backup-restore.md.
 *
 * The default is a DRY RUN: the artifact is restored into a scratch database
 * (`<dbname>_restore_verify`) and validated, without touching the production
 * database at all. Only `--apply --yes` replaces the real database, and it
 * verifies into the scratch DB first even then.
 *
 * Usage:
 *   npx tsx scripts/restore.ts <artifact.dump | artifact.dump.enc>
 *   npx tsx scripts/restore.ts --from-cloud <object-key>
 *   npx tsx scripts/restore.ts <artifact> --apply --yes
 *
 * Options:
 *   --from-cloud <key>    download the artifact from S3-compatible storage
 *                         first (credentials via BACKUP_S3_* env vars below —
 *                         after a total machine loss there is no database to
 *                         read the dashboard's cloud settings from)
 *   --apply               after successful verification, replace the target
 *                         database with the backup (requires --yes)
 *   --yes                 confirm the destructive --apply step
 *   --keep-scratch        keep the scratch database after verification
 *   --database-url <url>  target (default: DATABASE_URL from .env)
 *
 * Environment:
 *   DATABASE_URL            target database (as in .env)
 *   BACKUP_PASSPHRASE       passphrase for .dump.enc artifacts
 *   BACKUP_S3_ENDPOINT      https://… (only for --from-cloud)
 *   BACKUP_S3_REGION        default us-east-1
 *   BACKUP_S3_BUCKET
 *   BACKUP_S3_ACCESS_KEY_ID
 *   BACKUP_S3_SECRET_ACCESS_KEY
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { decryptBackup, isEncryptedBackup } from "../src/lib/backup";
import { s3Get, type S3Config } from "../src/lib/s3-lite";

interface Args {
  artifact: string | null;
  fromCloud: string | null;
  apply: boolean;
  yes: boolean;
  keepScratch: boolean;
  databaseUrl: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    artifact: null,
    fromCloud: null,
    apply: false,
    yes: false,
    keepScratch: false,
    databaseUrl: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-cloud") args.fromCloud = argv[++i] ?? null;
    else if (a === "--apply") args.apply = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--keep-scratch") args.keepScratch = true;
    else if (a === "--database-url") args.databaseUrl = argv[++i] ?? null;
    else if (a.startsWith("--")) fail(`unknown option: ${a}`);
    else if (args.artifact) fail("only one artifact argument is allowed");
    else args.artifact = a;
  }
  return args;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function run(bin: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (err) => reject(new Error(`could not start ${bin}: ${err.message}`)));
    child.on("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited with ${signal ?? code}`)),
    );
  });
}

/** Same server, different database — for admin commands and scratch restores. */
function withDatabase(databaseUrl: string, dbName: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function adminClient(databaseUrl: string): Promise<Client> {
  const client = new Client({ connectionString: withDatabase(databaseUrl, "postgres") });
  await client.connect();
  return client;
}

async function fetchFromCloud(key: string): Promise<Buffer> {
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const bucket = process.env.BACKUP_S3_BUCKET;
  const accessKeyId = process.env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BACKUP_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    fail("--from-cloud needs BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY");
  }
  const config: S3Config = {
    endpoint: endpoint.replace(/\/+$/, ""),
    region: process.env.BACKUP_S3_REGION || "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
  };
  console.log(`Downloading ${key} from ${config.endpoint}/${bucket} …`);
  return s3Get(config, key);
}

interface CountRow extends Record<string, unknown> {
  n: string;
}

async function validateScratch(scratchUrl: string): Promise<boolean> {
  const client = new Client({ connectionString: scratchUrl });
  await client.connect();
  try {
    const migrations = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    if (migrations.rows.length === 0) {
      console.error("VALIDATION FAILED: schema_migrations is empty — not a POS backup?");
      return false;
    }
    console.log(
      `  migrations in backup: ${migrations.rows.length} (latest ${migrations.rows.at(-1)!.filename})`,
    );

    let ok = true;
    for (const table of ["businesses", "locations", "users", "orders", "journal_entries"]) {
      try {
        const { rows } = await client.query<CountRow>(`SELECT count(*) AS n FROM ${table}`);
        console.log(`  ${table}: ${rows[0].n} rows`);
      } catch (err) {
        console.error(`VALIDATION FAILED: table ${table} missing (${(err as Error).message})`);
        ok = false;
      }
    }
    return ok;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL is not set (or pass --database-url)");
  if (!args.artifact && !args.fromCloud) fail("pass an artifact path, or --from-cloud <key>");
  if (args.apply && !args.yes) {
    fail("--apply REPLACES the production database; add --yes to confirm (verify-only needs no flags)");
  }

  // 1. Obtain the artifact bytes (local file or cloud download).
  let data: Buffer;
  let sourceName: string;
  if (args.fromCloud) {
    data = await fetchFromCloud(args.fromCloud);
    sourceName = args.fromCloud.split("/").at(-1)!;
  } else {
    data = readFileSync(args.artifact!);
    sourceName = args.artifact!.split("/").at(-1)!;
  }
  console.log(`Artifact: ${sourceName} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);

  // 2. Decrypt if needed.
  if (isEncryptedBackup(data)) {
    const passphrase = process.env.BACKUP_PASSPHRASE;
    if (!passphrase) fail("artifact is encrypted — set BACKUP_PASSPHRASE");
    console.log("Decrypting …");
    data = decryptBackup(data, passphrase);
  }

  const workDir = join(tmpdir(), `pos-restore-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  const dumpPath = join(workDir, "restore.dump");
  writeFileSync(dumpPath, data);

  const targetDb = new URL(databaseUrl).pathname.replace(/^\//, "") || "pos";
  const scratchDb = `${targetDb}_restore_verify`;
  const pgRestore = process.env.PG_RESTORE_PATH || "pg_restore";

  try {
    // 3. Restore into the scratch database and validate — never production.
    const admin = await adminClient(databaseUrl);
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${scratchDb}"`);
      await admin.query(`CREATE DATABASE "${scratchDb}"`);
    } finally {
      await admin.end();
    }
    console.log(`Restoring into scratch database "${scratchDb}" …`);
    await run(pgRestore, [
      "--no-owner",
      "--no-privileges",
      `--dbname=${withDatabase(databaseUrl, scratchDb)}`,
      dumpPath,
    ]);
    console.log("Validating scratch restore:");
    const valid = await validateScratch(withDatabase(databaseUrl, scratchDb));
    if (!valid) process.exit(1);
    console.log(`Verification OK.${args.keepScratch ? ` Scratch database "${scratchDb}" kept.` : ""}`);

    if (!args.apply) {
      console.log(`Dry run complete — production database "${targetDb}" was NOT touched.`);
      console.log("Re-run with --apply --yes to restore for real.");
      return;
    }

    // 4. --apply: replace the production database (stop the app first!).
    console.log(`Replacing database "${targetDb}" with the backup …`);
    const admin2 = await adminClient(databaseUrl);
    try {
      await admin2.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [targetDb],
      );
      await admin2.query(`DROP DATABASE IF EXISTS "${targetDb}"`);
      await admin2.query(`CREATE DATABASE "${targetDb}"`);
    } finally {
      await admin2.end();
    }
    await run(pgRestore, ["--no-owner", "--no-privileges", `--dbname=${databaseUrl}`, dumpPath]);
    console.log(`Restore complete — "${targetDb}" now matches ${sourceName}.`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    if (!args.keepScratch) {
      try {
        const admin = await adminClient(databaseUrl);
        await admin.query(`DROP DATABASE IF EXISTS "${scratchDb}"`);
        await admin.end();
      } catch {
        // best effort — the scratch DB is harmless if left behind
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
