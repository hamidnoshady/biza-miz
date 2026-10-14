import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  AccountingDimensionError,
  saveDimensionSettings,
  type DimensionSettingChange,
} from "@/lib/accounting-dimensions-service";

/**
 * Switches kinds on or off and names the detail dimension. Switching a kind off
 * never deletes or re-classifies anything: it only refuses new postings to it.
 */
export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  let body: { changes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!Array.isArray(body?.changes) || body.changes.length === 0 || body.changes.length > 4) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const changes: DimensionSettingChange[] = [];
  for (const raw of body.changes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const item = raw as Record<string, unknown>;
    changes.push({
      kind: String(item.kind ?? ""),
      isEnabled: "isEnabled" in item ? (item.isEnabled as boolean) : undefined,
      label: "label" in item ? (item.label as string | null) : undefined,
    });
  }

  try {
    const settings = await saveDimensionSettings(session.businessId, session.sub, changes);
    return NextResponse.json({ settings });
  } catch (err) {
    if (err instanceof AccountingDimensionError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    throw err;
  }
});
