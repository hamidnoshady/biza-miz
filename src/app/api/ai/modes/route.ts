import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { AI_CHAT_MODES } from "@/lib/ai-runtime-modes-shared";
import { listPlatformAiModes, modeAvailability } from "@/lib/ai-runtime-modes";

/**
 * Issue #1546 (Fast truthfulness) — which chat modes this tenant may actually
 * select, so the picker can disable an unusable mode instead of letting a member
 * choose it and meet a refusal at send time.
 *
 * The answer is the same decision the chat route refuses on (`modeAvailability`),
 * read from the same platform settings row, so the two cannot drift apart.
 * It deliberately carries no provider detail: no alias, deployment, temperature
 * or credential — only the mode, a boolean, and a machine reason the browser
 * turns into a sentence. A member needs no management capability to learn which
 * modes exist (`ai.use` is the assistant's own permission), and the response is
 * `no-store` because it is per-deployment configuration that changes without
 * the member's session changing.
 */
export const GET = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.aiUse);
  if (error) return error;

  const rows = await listPlatformAiModes();
  const byMode = new Map(rows.map((row) => [row.mode_key, row]));
  const modes = AI_CHAT_MODES.map((mode) => {
    const row = byMode.get(mode) ?? { is_active: undefined, model_alias: "" };
    return { mode, ...modeAvailability(row, mode) };
  });

  return NextResponse.json(
    { modes },
    { headers: { "Cache-Control": "no-store" } },
  );
});
