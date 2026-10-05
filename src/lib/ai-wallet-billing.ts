/**
 * AI Operating Layer — Phase B billing orchestration.
 *
 * The one place that turns a finished AI turn into a charge against the ONE
 * platform wallet. It replaces the old reserve→settle→cancel flow
 * (`ai-billing-service.ts`) that debited a separate `ai_business_billing`
 * balance up front at the maximum turn amount and refunded the remainder.
 *
 * The new flow (rebuild Parts 2 & 3):
 *
 *   gateAiTurn()      before the request — refuse when the wallet cannot
 *                     afford AI (blocks the next request when in debt or when
 *                     available credit + allowance is below `maxTurnRial`, the
 *                     pre-request minimum required credit threshold).
 *   settleAiTurn()    after the request  — compute the REAL cost from the
 *                     gateway's reported USD (LiteLLM), or the token-rate
 *                     fallback when the gateway did not price the turn, then
 *                     debit the wallet through wallet-service. Never discards
 *                     already-incurred provider costs: any shortfall beyond
 *                     allowance + wallet balance is booked as AI debt.
 *
 * Cost policy:
 *   - LiteLLM is the source of truth for provider/model cost. When the gateway
 *     reports a valid non-negative USD figure (including `0` for free/cached
 *     turns) and gateway costing is on, that figure is authoritative.
 *   - When the gateway did not report a cost (`null`/`undefined`/malformed, or
 *     gateway costing off), the platform's per-token Rial rate is the fallback.
 */

import { randomUUID } from "node:crypto";
import { calculateAiUsageCostRial, type AiTokenUsage } from "./ai-billing";
import { resolveGatewayTurnPricing } from "./ai-gateway-service";
import {
  checkAiAffordability,
  settleAiWalletCharge,
  type AiSettlementResult,
} from "./wallet-service";

/** Raised by `gateAiTurn` when the wallet cannot afford another AI turn. */
export class AiWalletInsufficientError extends Error {
  constructor(
    public balanceRial: number,
    public debtRial: number,
    public requiredRial: number,
  ) {
    super("ai_wallet_insufficient");
  }
}

/** The pricing inputs a turn carries from its resolved AiConfig. */
export interface AiTurnPricingConfig {
  /**
   * Pre-request minimum required credit threshold (Rial). A turn is only
   * admitted when `debtRial === 0` and `walletBalanceRial + allowanceRemainingRial >= maxTurnRial`.
   * Post-turn settlement always records the full actual cost (never discarding
   * incurred provider cost) and flags `ceilingExceeded` if actual cost exceeded
   * this pre-request threshold.
   */
  maxTurnRial: number;
  inputTokenRialPerMillion: number;
  outputTokenRialPerMillion: number;
  revenueMarginPercent: number;
}

export interface AiTurnAttribution {
  requestType?: string;
  model?: string | null;
  conversationId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  automationId?: string | null;
  coworkerId?: string | null;
  locationId?: string | null;
  userId?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
  // Issue #812 §12 — per-turn attribution, carried as columns on the
  // settlement row so usage can be sliced by them. See `AiSettlementInput`.
  /** The runtime mode in force: `auto`, `instant` or `deep_research`. */
  runtimeMode?: string | null;
  /** The Superadmin system agent invoked, if the turn ran as one. */
  systemAgentId?: string | null;
  /** The assignment (suggestion card) that surfaced the agent. */
  suggestionId?: string | null;
  /** The Deep Research run this settlement belongs to. */
  researchRunId?: string | null;
  /** The prompt layers the resolver composed, in composition order. */
  promptLayers?: readonly string[] | null;
}

export interface SettledAiTurnResult extends AiSettlementResult {
  configuredMaxTurnRial: number;
  ceilingExceeded: boolean;
}

/**
 * Pre-request gate. Throws `AiWalletInsufficientError` when the business is in
 * AI debt or its usable credit (wallet + remaining monthly plan allowance) is
 * below the configured pre-request threshold (`maxTurnRial`). A zero threshold
 * means only outstanding debt blocks.
 */
export async function gateAiTurn(
  businessId: string,
  config: AiTurnPricingConfig,
): Promise<void> {
  const required = Math.max(0, Math.floor(config.maxTurnRial));
  const check = await checkAiAffordability(businessId, required);
  if (!check.affordable) {
    throw new AiWalletInsufficientError(check.balanceRial, check.debtRial, check.requiredRial);
  }
}

/** Allocate a per-turn request id before the request begins. */
export function newAiRequestId(): string {
  return randomUUID();
}

/**
 * Settle a finished turn against the wallet. `costUsd` is the gateway's
 * reported figure (or null); `usage` is the token count used for the fallback.
 * Returns the wallet settlement result (what was charged, any new debt, and
 * whether the actual cost exceeded the pre-request `maxTurnRial` threshold).
 */
export async function settleAiTurn(input: {
  businessId: string;
  requestId: string;
  config: AiTurnPricingConfig;
  usage: AiTokenUsage;
  costUsd?: number | null;
  litellmCallId?: string | null;
  cacheHit?: boolean;
  attribution?: AiTurnAttribution;
}): Promise<SettledAiTurnResult> {
  const attribution = input.attribution ?? {};

  // Prefer the gateway's real cost (including valid 0 for cached/free responses);
  // fall back to platform token rates only when costUsd is missing/malformed or
  // gateway costing is off.
  const gatewayPricing = await resolveGatewayTurnPricing(
    input.costUsd,
    input.config.revenueMarginPercent,
  );

  let chargedRial: number;
  let providerCostRial = 0;
  let pricedBy: "gateway" | "token_rate" | "free";
  if (gatewayPricing) {
    chargedRial = Math.max(0, Math.ceil(gatewayPricing.chargedRial));
    providerCostRial = Math.max(0, Math.ceil(gatewayPricing.costRial));
    pricedBy = chargedRial === 0 ? "free" : "gateway";
  } else {
    chargedRial = calculateAiUsageCostRial(input.usage, {
      inputTokenRialPerMillion: input.config.inputTokenRialPerMillion,
      outputTokenRialPerMillion: input.config.outputTokenRialPerMillion,
    });
    providerCostRial = chargedRial;
    pricedBy = chargedRial > 0 ? "token_rate" : "free";
  }

  const configuredMaxTurnRial = Math.max(0, Math.floor(input.config.maxTurnRial));
  const ceilingExceeded = configuredMaxTurnRial > 0 && chargedRial > configuredMaxTurnRial;

  const settlement = await settleAiWalletCharge({
    businessId: input.businessId,
    requestId: input.requestId,
    chargedRial,
    providerCostRial,
    costUsd: gatewayPricing ? gatewayPricing.costUsd : null,
    pricedBy,
    litellmCallId: input.litellmCallId ?? null,
    cacheHit: input.cacheHit ?? false,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    requestType: attribution.requestType,
    model: attribution.model,
    conversationId: attribution.conversationId,
    projectId: attribution.projectId,
    agentId: attribution.agentId,
    automationId: attribution.automationId,
    coworkerId: attribution.coworkerId,
    locationId: attribution.locationId,
    userId: attribution.userId,
    note: attribution.note,
    metadata: {
      ...attribution.metadata,
      ...(configuredMaxTurnRial > 0 ? { configuredMaxTurnRial, ceilingExceeded } : {}),
    },
    // §12 — the issue's named dimensions, as first-class columns. They also
    // stay in `metadata` so the JSON is self-describing when a row is read on
    // its own, but the columns are what the report groups on. `runtimeMode`
    // stays NULL when the surface has no mode, so the report never claims an
    // OCR turn ran on the `auto` alias.
    runtimeMode: attribution.runtimeMode ?? null,
    systemAgentId: attribution.systemAgentId ?? null,
    suggestionId: attribution.suggestionId ?? null,
    researchRunId: attribution.researchRunId ?? null,
    promptLayers: attribution.promptLayers ?? [],
  });
  if (!settlement.duplicate) {
    try {
      const { appendUsageEvent, recordVendorCost } = await import("./billing/runtime");
      if (providerCostRial > 0) {
        await recordVendorCost({
          businessId: input.businessId,
          meterKey: "ai.credit",
          provider: "litellm",
          sourceReference: input.requestId,
          amountRial: providerCostRial,
          metadata: { model: attribution.model ?? null, pricedBy },
        });
      }
      if (input.usage.inputTokens > 0) {
        await appendUsageEvent({
          eventId: `${input.requestId}:input`,
          businessId: input.businessId,
          meterKey: "ai.input_tokens",
          source: "ai",
          quantity: input.usage.inputTokens,
          unit: "token",
          resource: "ai_turn",
          resourceId: input.requestId,
          dimensions: { walletBacked: true, pricedBy },
          ratedAmountRial:
            pricedBy === "token_rate"
              ? Math.ceil(
                  (input.usage.inputTokens * Math.max(0, input.config.inputTokenRialPerMillion)) /
                    1_000_000,
                )
              : 0,
        });
      }
      if (input.usage.outputTokens > 0) {
        await appendUsageEvent({
          eventId: `${input.requestId}:output`,
          businessId: input.businessId,
          meterKey: "ai.output_tokens",
          source: "ai",
          quantity: input.usage.outputTokens,
          unit: "token",
          resource: "ai_turn",
          resourceId: input.requestId,
          dimensions: { walletBacked: true, pricedBy },
          ratedAmountRial:
            pricedBy === "token_rate"
              ? Math.ceil(
                  (input.usage.outputTokens * Math.max(0, input.config.outputTokenRialPerMillion)) /
                    1_000_000,
                )
              : 0,
        });
      }
    } catch (error) {
      console.error("ai usage ledger failed:", input.requestId, error);
    }
  }
  return {
    ...settlement,
    configuredMaxTurnRial,
    ceilingExceeded,
  };
}
