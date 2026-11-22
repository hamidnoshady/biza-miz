import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  researchRetiredBody,
  RESEARCH_RETIRED_STATUS,
} from "@/lib/ai-research-retirement";

/**
 * Issue #812 §5 — the old Deep Research approval-and-execute endpoint.
 * Issue #1367 — retired.
 *
 * This was the only path from `awaiting_approval` to `running`, and the path
 * that spent the business's AI budget. It now refuses before it reads a run,
 * opens a wallet gate or calls a provider, so:
 *
 *  - a run created before the retirement cannot be started by a direct request;
 *  - a repeated approval can no longer re-run or double-settle anything;
 *  - the endpoint keeps a stable `410 research_retired` answer instead of
 *    disappearing, so an old client shows the message rather than retrying a 404.
 *
 * Historical runs and their settlements are untouched: nothing here reads,
 * rewrites or deletes `ai_research_runs`, `ai_research_sources` or
 * `ai_wallet_settlements`. The read-only history lives on `GET /api/ai/research`.
 */
export const POST = withTenantScope(
  async (_request: NextRequest, _context: { params: Promise<{ id: string }> }) => {
    // Authorization first, exactly as before: a caller without `ai.use` must not
    // learn the platform's product policy, and a revoked capability must stay
    // revoked regardless of the retirement.
    const guard = await requirePermission(PERMISSIONS.aiUse);
    if (guard.error) return guard.error;

    return NextResponse.json(researchRetiredBody(), { status: RESEARCH_RETIRED_STATUS });
  },
);
