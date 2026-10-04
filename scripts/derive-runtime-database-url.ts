/**
 * Resolves the connection string the SERVER PROCESS should run with, as
 * distinct from `DATABASE_URL`, which the Docker entrypoint uses to run
 * migrations and must therefore stay a privileged (table-owning) connection.
 *
 * This exists because every shipped compose file (`docker-compose.local.yml`,
 * plus the retired `archive/deploy/docker-compose.komodo.yml` and
 * `archive/deploy/docker-compose.srv1.yml`) hands the app
 * container exactly one `DATABASE_URL`: the Postgres superuser also used for
 * migrations. `assertRlsEffective()` (src/lib/db.ts) correctly refuses to
 * start with that connection in production — a superuser ignores every RLS
 * policy from migration 0021 outright — which is why those deployments now
 * crash-loop until this is fixed. Rather than ask every operator to hand-edit
 * their stack's environment, the entrypoint self-heals: it runs this script
 * after migrating, and launches the server with whatever this prints instead
 * of the original `DATABASE_URL`.
 *
 * Behaviour, in order:
 *
 *   1. `RUNTIME_DATABASE_URL` set → printed verbatim. An operator who already
 *      followed the manual `npm run db:app-role` instructions and wants full
 *      control keeps it; nothing here overrides an explicit choice.
 *   2. `DATABASE_URL`'s role is already unprivileged (not superuser, not
 *      BYPASSRLS) → `DATABASE_URL` is printed unchanged. Provisioning a
 *      second role would be pointless, and attempting one would fail anyway
 *      (creating a role needs privileges this connection doesn't have).
 *   3. Otherwise → provisions (or updates) `pos_app` — reusing `DATABASE_URL`'s
 *      own password under a different username unless `APP_DB_PASSWORD` is
 *      set, since anyone who can read `DATABASE_URL` already holds the
 *      superuser secret and a distinct one would add nothing — and prints the
 *      resulting connection string.
 *
 * Only the final URL goes to stdout, so a shell can capture it directly with
 * `$(...)`; every diagnostic goes to stderr.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createAppRole, decodeUrlCredential, DEFAULT_APP_ROLE } from "../src/lib/create-app-role";

async function isPrivileged(databaseUrl: string): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
    );
    return rows[0]?.privileged ?? false;
  } finally {
    await client.end();
  }
}

export async function deriveRuntimeDatabaseUrl(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): Promise<string> {
  const explicit = env.RUNTIME_DATABASE_URL;
  if (explicit) return explicit;

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set.");

  if (!(await isPrivileged(databaseUrl))) {
    // Already an unprivileged role — nothing to provision, nothing to switch.
    return databaseUrl;
  }

  const roleName = env.APP_DB_USER || DEFAULT_APP_ROLE;
  const source = new URL(databaseUrl);
  // Plaintext, not the URL's percent-encoded spelling: this value becomes the
  // role's password (and is re-encoded below when it goes back into the URL).
  const password = env.APP_DB_PASSWORD || decodeUrlCredential(source.password);

  await createAppRole({ databaseUrl, roleName, password, quiet: true });

  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = roleName;
  runtimeUrl.password = password;
  return runtimeUrl.toString();
}

export async function main() {
  try {
    process.stdout.write(await deriveRuntimeDatabaseUrl());
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main();
}
