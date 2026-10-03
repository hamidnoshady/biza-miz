/**
 * Budget evaluation. Critical capabilities stay available when the action
 * is to block or throttle non-critical spend.
 */

export type SpendLimitAction = "continue" | "warn_only" | "block_noncritical" | "throttle_noncritical";

export interface SpendEvaluation {
  /** Null when the business has no budget. */
  percent: number | null;
  crossedThresholds: number[];
  warned: boolean;
  atLimit: boolean;
  blocked: boolean;
  throttled: boolean;
}

export function evaluateSpend(input: {
  spentRial: number;
  budgetRial: number | null;
  thresholds: readonly number[];
  action: SpendLimitAction;
  critical: boolean;
}): SpendEvaluation {
  if (input.budgetRial == null || input.budgetRial <= 0) {
    return {
      percent: null,
      crossedThresholds: [],
      warned: false,
      atLimit: false,
      blocked: false,
      throttled: false,
    };
  }
  const spent = Math.max(0, Math.floor(input.spentRial));
  const percent = Math.floor((spent * 100) / input.budgetRial);
  const crossedThresholds = [...input.thresholds]
    .filter((threshold) => percent >= threshold)
    .sort((a, b) => a - b);
  const warned = crossedThresholds.length > 0 && input.action !== "continue";
  const atLimit = spent >= input.budgetRial;
  if (!atLimit || input.action === "continue" || input.action === "warn_only" || input.critical) {
    return { percent, crossedThresholds, warned, atLimit, blocked: false, throttled: false };
  }
  if (input.action === "block_noncritical") {
    return { percent, crossedThresholds, warned, atLimit, blocked: true, throttled: false };
  }
  return { percent, crossedThresholds, warned, atLimit, blocked: false, throttled: true };
}
