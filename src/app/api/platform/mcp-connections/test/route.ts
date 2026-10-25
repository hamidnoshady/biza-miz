import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope, platformAudit } from "@/lib/platform-auth";
import { platformCan } from "@/lib/platform-admin";
import {
  diagnosePlatformMcpToken,
  platformMcpToolCatalogue,
} from "@/lib/mcp/platform-mcp";

/**
 * Issue #1126 §A — session-authenticated "test connection" diagnosis.
 *
 * The public `/api/platform/mcp` endpoint must answer every auth failure
 * identically, because an unauthenticated caller must not compare outcomes.
 * This route is the other side of that bargain: the caller already holds a
 * platform-admin session, so it may learn the precise reason a token fails
 * (wrong realm, malformed, unknown, revoked, expired, minter deactivated)
 * plus the minted-vs-effective capability split and the tool count an
 * external client would actually see.
 *
 * Secrecy rules, all deliberate:
 *
 *   * The token arrives in the POST body only — never a query string, never
 *     a URL — and is never logged, echoed, persisted, or returned. Only its
 *     SHA-256 hash is looked up.
 *   * Responses are `no-store`: a diagnosis names a live credential's grants.
 *   * The audit row keys on the identified connection id with the outcome —
 *     never the token — and only identified connections are audited, so
 *     probing random strings leaves no spam.
 *   * A diagnosis is not usage: `last_used_at` is untouched (see
 *     `diagnosePlatformMcpToken`).
 */
const MAX_TOKEN_LENGTH = 1024;

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { error, session } = await requirePlatformAdmin();
  if (error) return error;

  let body: { token?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return NextResponse.json({ error: "invalid_token" }, { status: 400 });
  }

  const diagnosis = await diagnosePlatformMcpToken(token);
  const noStore = { "Cache-Control": "no-store" } as const;
  if (!diagnosis.connection) {
    return NextResponse.json({ ok: false, status: diagnosis.status }, { headers: noStore });
  }

  const connection = diagnosis.connection;
  const minted = connection.capabilities;
  // Effective = minted ∩ minter's CURRENT role — the same intersection the
  // route applies live on every call, so the test can never promise a tool
  // the credential cannot actually run.
  const effective = minted.filter((capability) => platformCan(connection.adminRole, capability));
  const tools =
    diagnosis.status === "valid"
      ? platformMcpToolCatalogue(connection).map((tool) => ({
          name: tool.name,
          description: tool.description,
        }))
      : [];

  try {
    await platformAudit({
      adminId: session.padmin,
      action: "platform_mcp.test",
      entity: "platform_mcp_connection",
      entityId: connection.id,
      payload: { outcome: diagnosis.status, toolCount: tools.length },
    });
  } catch {
    // A diagnostic must never fail because its own audit write did — the
    // mint/revoke paths are loud, this one is best-effort by design.
  }

  return NextResponse.json(
    {
      ok: diagnosis.status === "valid",
      status: diagnosis.status,
      connection: {
        id: connection.id,
        name: connection.name,
        adminName: connection.adminName,
        adminRole: connection.adminRole,
        capabilities: minted,
        effectiveCapabilities: effective,
        capabilitiesReduced: effective.length < minted.length,
        expiresAt: connection.expiresAt,
        businessScope:
          connection.businessIds === null
            ? { mode: "all" as const }
            : { mode: "list" as const, count: connection.businessIds.length },
      },
      tools,
      toolCount: tools.length,
    },
    { headers: noStore },
  );
});
