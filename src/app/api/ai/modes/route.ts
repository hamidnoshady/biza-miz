import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { aiModeAvailability, listPlatformAiModes } from "@/lib/ai-runtime-modes";

/**
 * Issue #1546 (Fast truthfulness) — which chat modes this tenant may actually
 * select, so the picker can disable an unusable mode instead of letting a member
 * choose it and meet a refusal at send time.
 *
 * The answer is `modeAvailability`, the same decision the chat route refuses on,
 * so the two cannot drift apart. It deliberately carries no provider detail: no
 * alias, deployment, temperature or credential — only the mode, a boolean, and a
 * machine reason the browser turns into a sentence. A member needs no management
 * capability to learn which modes exist (`ai.use` is the assistant's own
 * permission), and the response is `no-store` because it is per-deployment
 * configuration that changes without the member's session changing.
 */
export const GET = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.aiUse);
  if (error) return error;

  return NextResponse.json(
    { modes: aiModeAvailability(await listPlatformAiModes()) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
