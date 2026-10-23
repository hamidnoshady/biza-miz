import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { platformAudit, requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { DESKTOP_UPDATE_COMMANDS } from "@/lib/desktop-update-command";
import { createDesktopUpdateCommand, listDeviceUpdateCommands } from "@/lib/desktop-update-command-service";
import { isUuid } from "@/lib/uuid";

export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const businessId = request.nextUrl.searchParams.get("businessId") ?? "";
  const siteDeviceId = request.nextUrl.searchParams.get("siteDeviceId") ?? "";
  if (!isUuid(businessId) || !isUuid(siteDeviceId)) return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  return NextResponse.json({ commands: await listDeviceUpdateCommands(businessId, siteDeviceId) });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("updates.manage");
  if (error) return error;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400 }); }
  if (!isUuid(body.businessId) || !isUuid(body.siteDeviceId) ||
      !(DESKTOP_UPDATE_COMMANDS as readonly unknown[]).includes(body.command)) {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) return NextResponse.json({ error: "reason_required" }, { status: 400 });
  const ttlMinutes = Number(body.ttlMinutes ?? 1440);
  if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 10080) {
    return NextResponse.json({ error: "invalid_expiry" }, { status: 400 });
  }
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 8
    ? body.idempotencyKey.slice(0, 200) : randomUUID();
  const command = await createDesktopUpdateCommand({
    businessId: body.businessId, siteDeviceId: body.siteDeviceId,
    command: body.command as (typeof DESKTOP_UPDATE_COMMANDS)[number], idempotencyKey, reason,
    adminId: session.padmin, expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  });
  if (!command) return NextResponse.json({ error: "active_device_not_found" }, { status: 404 });
  await platformAudit({
    adminId: session.padmin, businessId: body.businessId, action: "desktop_update_command.request",
    entity: "site_device", entityId: body.siteDeviceId,
    payload: { command: body.command, reason, idempotencyKey, expiresAt: command.expires_at },
  });
  return NextResponse.json({ command }, { status: 201 });
});
