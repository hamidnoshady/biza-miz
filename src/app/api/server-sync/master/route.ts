import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { recordSyncRun } from "@/lib/server-sync";
import { requireSiteCredential } from "@/lib/server-sync-auth";
import {
  applyMasterChanges,
  decodeMasterCursor,
  encodeMasterCursor,
  readMasterFeed,
  resolveAppliedMasterConflicts,
  type MasterFeedChange,
} from "@/lib/master-sync-service";

/**
 * Master-data sync between a paired desktop and this central server
 * (migration 0190): customers, the branch's menu, tables and payment ways.
 *
 *   GET  — the next page of this server's changes for the caller's branch
 *   POST — merge the desktop's changes into this server
 *
 * Bearer-authenticated with the site device credential, like push/pull; the
 * credential — never the request — names the business and branch.
 */

export async function GET(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;
  const params = new URL(request.url).searchParams;
  const rawCursor = params.get("cursor");
  const cursor = rawCursor ? decodeMasterCursor(rawCursor) : null;
  if (rawCursor && !cursor) return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
  const node = params.get("node");
  const limit = Number(params.get("limit") ?? "200");
  if (!Number.isSafeInteger(limit) || limit < 1) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const page = await withTenant(
    identity.businessId,
    () =>
      readMasterFeed(identity.businessId, {
        cursor,
        limit,
        locationId: identity.locationId,
        excludeNode: node && /^[0-9a-z]{1,32}$/.test(node) ? node : null,
      }),
    { locationId: identity.locationId },
  );
  return NextResponse.json({
    changes: page.changes,
    cursor: encodeMasterCursor(page.cursor),
    hasMore: page.hasMore,
    node: page.node,
  });
}

function validChange(value: unknown): value is MasterFeedChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  return (
    typeof change.table === "string" &&
    typeof change.rowId === "string" &&
    typeof change.deleted === "boolean" &&
    typeof change.rowHlc === "string" &&
    typeof change.txid === "string" &&
    !!change.clocks &&
    typeof change.clocks === "object" &&
    !Array.isArray(change.clocks) &&
    (change.row === null || (typeof change.row === "object" && !Array.isArray(change.row)))
  );
}

export async function POST(request: NextRequest) {
  const auth = await requireSiteCredential(request);
  if ("response" in auth) return auth.response;
  const { identity } = auth;
  let body: { changes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const changes = body.changes;
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 500 || !changes.every(validChange)) {
    return NextResponse.json({ error: "invalid_changes" }, { status: 400 });
  }

  const result = await withTenant(
    identity.businessId,
    async () => {
      const applied = await applyMasterChanges(identity.businessId, changes, {
        receiverLocationId: identity.locationId,
      });
      await resolveAppliedMasterConflicts(identity.businessId, changes, applied.outcomes);
      await recordSyncRun({
        businessId: identity.businessId,
        siteDeviceId: identity.siteDeviceId,
        locationId: identity.locationId,
        direction: "push",
        status: applied.outcomes.includes("conflict") ? "error" : "ok",
        eventsAttempted: changes.length,
        eventsApplied: applied.outcomes.filter((outcome) => outcome === "applied").length,
        eventsDeferred: applied.outcomes.filter((outcome) => outcome === "deferred").length,
        eventsDeadLettered: applied.outcomes.filter((outcome) => outcome === "conflict").length,
        errorCode: applied.outcomes.includes("conflict") ? "master_conflict" : null,
      });
      return applied;
    },
    { locationId: identity.locationId },
  );
  return NextResponse.json(result);
}
