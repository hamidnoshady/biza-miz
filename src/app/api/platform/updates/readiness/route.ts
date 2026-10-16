import { NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { currentCentralRuntime } from "@/lib/app-update";
import { evaluateReleaseReadiness } from "@/lib/desktop-release-readiness";

/**
 * Redacted infrastructure readiness for the release pipeline. Reports presence
 * and a public-key fingerprint, never a value. A Coolify redeploy
 * acknowledgement is not release verification: `centralRuntime` is what the
 * running container says it is, to be compared with the expected image SHA.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const facts = await withoutTenantScope("platform", async () => {
    const tables = await query<{ ready: boolean }>(
      `SELECT to_regclass('public.platform_desktop_update_policy') IS NOT NULL
          AND to_regclass('public.business_desktop_update_policies') IS NOT NULL AS ready`,
    );
    const releases = await query<{ count: string }>(`SELECT count(*)::text AS count FROM platform_releases WHERE status='published'`);
    const last = await query<{ created_at: Date | string; payload: { version?: string } | null }>(
      `SELECT created_at,payload FROM platform_audit_log
        WHERE action='desktop_release.pipeline_promote' ORDER BY created_at DESC LIMIT 1`,
    );
    const row = last.rows[0];
    return {
      policyTablesReady: tables.rows[0]?.ready === true,
      publishedReleaseCount: Number(releases.rows[0]?.count ?? 0),
      lastRegistration: row?.payload?.version
        ? { at: new Date(row.created_at).toISOString(), version: row.payload.version }
        : null,
    };
  });
  const readiness = evaluateReleaseReadiness(process.env, facts);
  return NextResponse.json({ ...readiness, centralRuntime: currentCentralRuntime() });
});
