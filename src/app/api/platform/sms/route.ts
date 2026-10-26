import { NextRequest, NextResponse } from "next/server";
import {
  getPublicSmsConfig,
  savePlatformSmsConfig,
} from "@/lib/sms-config";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";

/**
 * Phase 24 Wave 2 — the Kavenegar connection, in the console.
 *
 * Per CLAUDE.md, anything that administers clients across businesses belongs
 * here rather than in a tenant dashboard: one SMS account sends every
 * business's login OTPs, and every send costs the *platform* money. Same shape
 * and same guards as `platform_ai_config` for the credential itself.
 *
 * Issue #902 corrected the capability: this route used `ai.config.manage`,
 * which is owner-only and belongs to a different domain, so the SMS desk could
 * not administer its own provider. It now asks for `messaging.manage` — the
 * capability migration 0176 created for SMS/email technical configuration and
 * granted to the same operators who run the rest of the messaging console. The
 * change is a fix, not a widening: `messaging.manage` already gated the
 * marketing provider key, rates and packages.
 *
 * The key is never returned, on any path. `keyHint` is the last four
 * characters, which is enough to answer "is this the account I think it is"
 * and not enough to send anything.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("messaging.manage");
  if (error) return error;

  return NextResponse.json({ config: await getPublicSmsConfig() });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("messaging.manage");
  if (error) return error;

  let body: { apiKey?: unknown; otpTemplate?: unknown; clearApiKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;
  const otpTemplate = typeof body.otpTemplate === "string" ? body.otpTemplate : undefined;
  const clearApiKey = body.clearApiKey === true;

  // Kavenegar template names are carrier-approved identifiers, not free text.
  if (otpTemplate !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(otpTemplate.trim())) {
    return NextResponse.json({ error: "invalid_template" }, { status: 400 });
  }

  const config = await savePlatformSmsConfig({ apiKey, otpTemplate, clearApiKey });

  // Audited like every other console write — and, obviously, without the key.
  // An audit log holding the credential it audits is worse than none.
  await platformAudit({
    adminId: session.padmin,
    action: "sms.config.update",
    entity: "platform_sms_config",
    entityId: "1",
    payload: {
      keyChanged: clearApiKey ? "cleared" : apiKey && apiKey.trim().length > 0 ? "replaced" : "unchanged",
      otpTemplate: config.otpTemplate,
    },
  });

  return NextResponse.json({ config });
});
