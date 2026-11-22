import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability } from "@/lib/platform-auth";
import { getResearchPlatformSettings } from "@/lib/ai-control-plane";
import {
  researchRetiredBody,
  RESEARCH_RETIRED_STATUS,
} from "@/lib/ai-research-retirement";

/**
 * Issue #812 §6 — the Deep Research platform switches.
 * Issue #1367 — read-only; writes are retired.
 *
 * `GET` stays so an operator or an audit can still read the historical caps a
 * run was created under (enabled flag, alias, max rounds, TTL, spend cap). It
 * never exposes a secret and never changes anything.
 *
 * `PUT` is gone: there is no new run for a cap to apply to, and letting the
 * console keep editing a retired workflow's budget would be a control that
 * promises something it cannot do. The refusal is `410 research_retired` with
 * the same body every retired endpoint returns.
 */
export const GET = async () => {
  const guard = await requirePlatformCapability("ai.read");
  if (guard.error) return guard.error;
  return NextResponse.json({
    settings: await getResearchPlatformSettings(),
    // Additive: marks the payload as historical so a client does not render a
    // live editor for a retired workflow.
    retired: true,
  });
};

export const PUT = async (_request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.config.manage");
  if (guard.error) return guard.error;
  return NextResponse.json(researchRetiredBody(), { status: RESEARCH_RETIRED_STATUS });
};
