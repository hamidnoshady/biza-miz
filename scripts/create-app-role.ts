/** CLI wrapper for the runtime-role service in src/lib/create-app-role.ts. */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppRole, DEFAULT_APP_ROLE } from "../src/lib/create-app-role";

export { createAppRole, DEFAULT_APP_ROLE };
export type { AppRoleOptions, AppRoleResult } from "../src/lib/create-app-role";

export async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exitCode = 1;
    return;
  }
  const password = process.env.APP_DB_PASSWORD;
  if (!password) {
    console.error("APP_DB_PASSWORD is not set. Generate one with: openssl rand -hex 32");
    process.exitCode = 1;
    return;
  }
  await createAppRole({ databaseUrl, roleName: process.env.APP_DB_USER || DEFAULT_APP_ROLE, password });
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
