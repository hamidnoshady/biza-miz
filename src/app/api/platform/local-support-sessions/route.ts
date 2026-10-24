import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { listLocalInstallations } from "@/lib/local-activation-cloud-service";
import {
  endOrRevokeLocalSupportSessionOnCloud,
  listLocalSupportSessionsForBusiness,
  queueLocalSupportCommandOnCloud,
  requestLocalSupportSessionOnCloud,
} from "@/lib/local-remote-support-service";
import type { LocalSupportSessionMode } from "@/lib/local-activation-contract";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0",
};

export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("impersonate.readOnly");
  if (error) return error;

  const businessId = (request.nextUrl.searchParams.get("businessId") ?? "").trim();
  if (!businessId) {
    return NextResponse.json({ error: "missing_business_id" }, { status: 400 });
  }
  const business = await getBusiness(businessId);
  if (!business) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const [installations, supportData] = await Promise.all([
    listLocalInstallations(businessId),
    listLocalSupportSessionsForBusiness(businessId, session.padmin),
  ]);

  return NextResponse.json(
    {
      businessId,
      installations,
      sessions: supportData.sessions,
      commands: supportData.commands,
    },
    { headers: NO_STORE_HEADERS },
  );
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  const businessId = typeof body.businessId === "string" ? body.businessId.trim() : "";
  if (!businessId) {
    return NextResponse.json({ error: "missing_business_id" }, { status: 400 });
  }

  const business = await getBusiness(businessId);
  if (!business) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (action === "request") {
    const mode: LocalSupportSessionMode =
      body.mode === "controlled"
        ? "controlled"
        : body.mode === "recovery_only"
          ? "recovery_only"
          : "read_only";
    const capability =
      mode === "read_only" ? "impersonate.readOnly" : "impersonate.controlled";
    const { session, error } = await requirePlatformCapability(capability);
    if (error) return error;

    const res = await requestLocalSupportSessionOnCloud({
      businessId,
      localInstallationId: String(body.localInstallationId ?? ""),
      adminId: session.padmin,
      operatorName: session.fullName || session.email,
      mode,
      reason: String(body.reason ?? ""),
      ticketId: typeof body.ticketId === "string" ? body.ticketId.trim() || null : null,
      minutes: Number(body.minutes ?? 30),
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: res.error },
        { status: res.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { ok: true, sessionId: res.sessionId },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  }

  if (action === "command") {
    const { session, error } = await requirePlatformCapability("impersonate.readOnly");
    if (error) return error;

    const res = await queueLocalSupportCommandOnCloud({
      businessId,
      sessionId: String(body.sessionId ?? ""),
      adminId: session.padmin,
      commandType: String(body.commandType ?? ""),
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: res.error },
        { status: res.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { ok: true, commandId: res.commandId },
      { status: 201, headers: NO_STORE_HEADERS },
    );
  }

  if (action === "end" || action === "revoke") {
    const capability =
      action === "revoke" ? "impersonate.controlled" : "impersonate.readOnly";
    const { session, error } = await requirePlatformCapability(capability);
    if (error) return error;

    const res = await endOrRevokeLocalSupportSessionOnCloud({
      businessId,
      sessionId: String(body.sessionId ?? ""),
      adminId: session.padmin,
      revoke: action === "revoke",
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: res.error },
        { status: res.httpStatus, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
