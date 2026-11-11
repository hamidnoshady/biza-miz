import type { PoolClient } from "pg";
import type { DemoDeployment } from "./demo-session-credentials";

/** Verify the live store on the same connection that will do the work. */
export async function assertDemoDatabase(
  client: Pick<PoolClient, "query">,
  config: DemoDeployment,
  access: "runtime" | "migration" = "runtime",
): Promise<void> {
  const { rows } = await client.query<{ safe: boolean }>(
    `SELECT pg_catalog.shobj_description(d.oid, 'pg_database') = $1
            AND ($2::boolean OR (
              NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole)
              AND NOT pg_has_role(r.oid, d.datdba, 'MEMBER')
            )) AS safe
       FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_roles r
      WHERE d.datname = current_database() AND r.rolname = current_user`,
    [`bizamiz-demo:${config.databaseId}`, access === "migration"],
  );
  if (rows[0]?.safe !== true) throw new Error("demo_database_identity_mismatch");
}
