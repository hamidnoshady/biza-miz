import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability } from "@/lib/platform-auth";
import {
  getResearchPlatformSettings,
  updateResearchPlatformSettings,
} from "@/lib/ai-control-plane";

/**
 * Issue #812 §6 — the Deep Research platform switches.
 *
 * Every cap here is a hard ceiling the workflow enforces server-side, not a
 * default the UI suggests: enabled/disabled, the LiteLLM alias, max context,
 * max rounds, environment TTL, max spend per run, minimum data readiness and
 * the external-web policy. A tenant cannot change any of them, and the chat
 * route refuses a `deep_research` turn outright when `enabled` is false.
 */
export const GET = async () => {
  const guard = await requirePlatformCapability("ai.read");
  if (guard.error) return guard.error;
  return NextResponse.json({ settings: await getResearchPlatformSettings() });
};

export const PUT = async (request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.config.manage");
  if (guard.error) return guard.error;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const settings = await updateResearchPlatformSettings({
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      modelAlias: typeof body.modelAlias === "string" ? body.modelAlias : undefined,
      maxRounds: typeof body.maxRounds === "number" ? body.maxRounds : undefined,
      maxContextBytes: typeof body.maxContextBytes === "number" ? body.maxContextBytes : undefined,
      ttlHours: typeof body.ttlHours === "number" ? body.ttlHours : undefined,
      maxSpendRial: typeof body.maxSpendRial === "number" ? body.maxSpendRial : undefined,
      minDataReadiness: typeof body.minDataReadiness === "number" ? body.minDataReadiness : undefined,
      externalWeb: typeof body.externalWeb === "boolean" ? body.externalWeb : undefined,
    });
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "update_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
};
