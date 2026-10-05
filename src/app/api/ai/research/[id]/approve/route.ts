import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  approveResearchRun,
  getResearchRun,
  listResearchSources,
  runResearchRun,
} from "@/lib/ai-research";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { toolDefinitions } from "@/lib/ai";
import { filterAiToolsByPermissions } from "@/lib/ai-capabilities";
import { gateAiTurn, settleAiTurn } from "@/lib/ai-wallet-billing";

/**
 * Issue #812 §5 — approving a Deep Research run, and running it.
 *
 * This is the only path from `awaiting_approval` to `running`, and it is the
 * human approval §5 requires: the member sees the estimated maximum cost when
 * the run is created and this call is them saying yes.
 *
 * The run then executes to completion here rather than being handed to a
 * background worker, because §5 wants it isolated and bounded: it has a round
 * cap, a spend cap it checks after every round, and an environment TTL. When it
 * finishes — or stops at the cap — the cost is settled exactly once through the
 * same `settleAiTurn` every other turn uses, so research shows up in usage and
 * billing alongside chat instead of beside it.
 *
 * A second approval for an already-approved run is refused rather than
 * re-running it: re-approving is how a run spends twice.
 */
export const POST = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    // §12 — the caller's own authority is the boundary here too, and it is
    // checked BEFORE the run's business id is read. `getSession()` only proves
    // the caller belongs to this business; without this line every member —
    // including roles whose whole permission set is `ai.use` — could approve a
    // run that spends the business's AI budget and reads the tools below.
    const guard = await requirePermission(PERMISSIONS.aiUse);
    if (guard.error) return guard.error;
    const session = guard.session;
    const effectivePermissions = guard.membership?.permissions ?? new Set();
    const { id } = await params;

    const existing = await getResearchRun({ id, businessId: session.businessId });
    if (!existing) return NextResponse.json({ error: "research_not_found" }, { status: 404 });
    if (existing.status !== "awaiting_approval") {
      return NextResponse.json({ error: "research_not_awaiting_approval" }, { status: 409 });
    }

    const approved = await approveResearchRun({ id, businessId: session.businessId, userId: session.sub });
    if (!approved.ok) return NextResponse.json({ error: approved.error }, { status: 409 });

    const config = await resolveAiConfigFor(session.businessId, session.locationId ?? null);
    if (!config.enabled) {
      return NextResponse.json({ error: "ai_disabled" }, { status: 503 });
    }

    // §12's intersection is NOT re-opened for research, and this is where that
    // is enforced rather than merely claimed. The catalogue is filtered by the
    // caller's effective permissions through the same helper chat uses, so a
    // research run cannot read a surface its approver could not have read
    // themselves — Deep Research is a bigger budget, not a wider permission.
    const toolNames = filterAiToolsByPermissions(
      toolDefinitions("dashboard", { retrieval: config.knowledge?.enabled === true }),
      effectivePermissions,
    ).map((tool) => tool.function.name);

    // Pre-request wallet gate, the same one chat uses, so a research run cannot
    // be started by a business that is already in AI debt. The run's own spend
    // cap is what bounds the spend; the gate only refuses a business that
    // cannot pay at all.
    const requestId = `research:${id}`;
    try {
      await gateAiTurn(session.businessId, config);
    } catch {
      return NextResponse.json({ error: "insufficient_credit" }, { status: 402 });
    }

    const outcome = await runResearchRun({ id, businessId: session.businessId, config, toolNames });
    if (!outcome.ok) {
      // A run that could not execute still settles whatever it accrued, so a
      // failed environment is not a free one.
      await settleAiTurn({
        businessId: session.businessId,
        requestId,
        config,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        attribution: {
          requestType: "deep_research",
          userId: session.sub,
          locationId: session.locationId ?? null,
          projectId: existing.projectId,
          // §12 — the run's own identity, as a column, so the usage report can
          // total a run in one query instead of scanning metadata. A failed run
          // keeps it: §16 says a failed environment is not a free one, and the
          // same rule applies to its attribution.
          researchRunId: id,
          runtimeMode: "deep_research",
          systemAgentId: existing.systemAgentId,
          metadata: { researchRunId: id, researchStatus: outcome.error },
        },
      });
      return NextResponse.json({ error: outcome.error }, { status: 500 });
    }

    const settled = await settleAiTurn({
      businessId: session.businessId,
      requestId,
      config,
      usage: {
        inputTokens: outcome.outcome.usage.promptTokens,
        outputTokens: outcome.outcome.usage.completionTokens,
      },
      costUsd: outcome.outcome.costUsd,
      attribution: {
        requestType: "deep_research",
        model: outcome.outcome.run.modelAlias || config.model,
        userId: session.sub,
        locationId: session.locationId ?? null,
        projectId: outcome.outcome.run.projectId,
        // §12 — the dimensions the issue names, as columns. `runtimeMode` is
        // `deep_research` for the whole run regardless of which mode the chat
        // that spawned it was in, because that is the mode whose alias and
        // caps the money was actually spent under.
        runtimeMode: "deep_research",
        researchRunId: id,
        systemAgentId: outcome.outcome.run.systemAgentId,
        metadata: {
          researchRunId: id,
          researchStatus: outcome.outcome.run.status,
          roundsUsed: outcome.outcome.run.roundsUsed,
          spendCapUsd: outcome.outcome.run.spendCapUsd,
          environmentId: outcome.outcome.run.environmentId,
          promptVersion: outcome.outcome.run.promptVersion,
          systemAgentId: outcome.outcome.run.systemAgentId,
        },
      },
    });

    const sources = await listResearchSources(id, session.businessId);
    return NextResponse.json({
      run: outcome.outcome.run,
      sources,
      settlement: { chargedRial: settled.chargedRial, costUsd: outcome.outcome.costUsd },
    });
  },
);
