import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { enqueueCloudException } from "@/lib/cloud-exception-relay";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";
import { callCloudOnlineSupportFromSite } from "@/lib/local-activation-site-service";

const MAX_DESCRIPTION = 5000;
const MAX_SCREENSHOT = 4 * 1024 * 1024; // 4 MiB, generous for a downscaled JPEG

interface BugReportBody {
  description?: unknown;
  screenshot?: unknown;
  pageUrl?: unknown;
  userAgent?: unknown;
  viewport?: unknown;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireMember();
  if (error) return error;

  let body: BugReportBody;
  try {
    body = (await request.json()) as BugReportBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description) {
    return NextResponse.json({ error: "description_required" }, { status: 400 });
  }
  if (description.length > MAX_DESCRIPTION) {
    return NextResponse.json({ error: "description_too_long" }, { status: 400 });
  }

  const screenshot = typeof body.screenshot === "string" ? body.screenshot : null;
  if (screenshot && screenshot.length > MAX_SCREENSHOT) {
    return NextResponse.json({ error: "screenshot_too_large" }, { status: 400 });
  }
  if (screenshot && !screenshot.startsWith("data:image/")) {
    return NextResponse.json({ error: "screenshot_invalid" }, { status: 400 });
  }

  const pageUrl = typeof body.pageUrl === "string" ? body.pageUrl.slice(0, 2000) : null;
  const userAgent = typeof body.userAgent === "string" ? body.userAgent.slice(0, 1000) : null;
  const viewport = typeof body.viewport === "string" ? body.viewport.slice(0, 200) : null;

  // Issue #974: on Full Offline (`local`) site installations, Bug Reports are
  // strictly online-only against the authenticated Cloud endpoint — never
  // queued locally while offline or claimed as sent before Cloud accepts.
  if (deploymentRole() === "site") {
    const deployment = await readDeploymentProfile(session.businessId);
    if (deployment.profile === "local" && deployment.source !== "inferred") {
      const cloudRes = await callCloudOnlineSupportFromSite<{
        id: string;
        createdAt: string;
      }>(session.businessId, {
        method: "POST",
        body: {
          action: "bug_report_create",
          description,
          screenshot,
          pageUrl,
          userAgent,
          viewport,
          reporterName: session.fullName,
        },
      });
      if (!cloudRes.ok) {
        return NextResponse.json(
          { error: cloudRes.error, onlineOnly: true },
          { status: cloudRes.httpStatus, headers: { "Cache-Control": "no-store" } },
        );
      }
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, $2, 'bug_report.online_submitted', 'bug_report', $3, '{}'::jsonb)`,
        [session.businessId, session.sub, cloudRes.data.id],
      );
      return NextResponse.json(
        { id: cloudRes.data.id, createdAt: cloudRes.data.createdAt, onlineOnly: true },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bug_reports (business_id, location_id, user_id, description, screenshot, page_url, user_agent, viewport)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        session.businessId,
        session.locationId ?? null,
        session.sub,
        description,
        screenshot,
        pageUrl,
        userAgent,
        viewport,
      ],
    );
    await enqueueCloudException(client, {
      businessId: session.businessId,
      kind: "bug_report.created",
      aggregateId: rows[0].id,
      payload: {
        reportId: rows[0].id,
        locationId: session.locationId ?? null,
        userId: session.sub,
        description,
        screenshot,
        pageUrl,
        userAgent,
        viewport,
      },
    });
    await client.query("COMMIT");
    return NextResponse.json({ id: rows[0].id }, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});
