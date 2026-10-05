/**
 * Issue #812 §4 — the scheduled-job definitions behind the proactive tick.
 *
 * This module used to be `ai-agents.ts`, and it is the *reason* the word "Agent"
 * had to be reclaimed. It defined five tenant-scheduled background jobs, each
 * with a Persian title and description, a per-job enable switch and a schedule
 * hour — the same vocabulary the Superadmin's system agents now own. Two things
 * called "Agent", one of which a business could switch on and off, is exactly
 * how a control-plane boundary gets argued away.
 *
 * So the concept is migrated, not renamed in place:
 *
 *  - These are SCHEDULED JOBS (کارهای زمان‌بندی‌شده). They run on a clock,
 *    produce drafts, and nobody talks to them.
 *  - The per-job opt-in switches survive, because they are what stops a tenant
 *    paying for a digest with no sections in it, and because turning a category
 *    off is a product setting, not an AI permission. They live in the existing
 *    `ai_agent_settings` table, whose name is a fact about the past and not
 *    worth a data migration.
 *  - What is GONE: the job definitions with their Persian titles (the hub
 *    column that displayed them was deleted with the tenant agent builder), the
 *    status pill derivation, the "today's tasks" list, and the three service
 *    functions that fed them. All three had no caller outside this module.
 *
 * The one thing left that a reader needs to know: which scheduled job
 * contributes which digest section, so an empty digest is never claimed or
 * paid for.
 */
import type { AiProactiveRunKind } from "./ai-proactive";

/** The scheduled jobs that contribute a section to the daily/weekly digest. */
export const DIGEST_JOB_KEYS = ["financial_report_builder", "sales_analyzer", "reconciliation_assistant"] as const;
export type DigestJobKey = (typeof DIGEST_JOB_KEYS)[number];

/** The scheduled jobs that produce their own draft stream rather than a digest section. */
export const DRAFT_JOB_KEYS = ["receivables_follow_up", "service_reminders"] as const;
export type DraftJobKey = (typeof DRAFT_JOB_KEYS)[number];

/** Every scheduled job key — the set `ai_agent_settings.agent_key` accepts. */
export const SCHEDULED_JOB_KEYS = [...DIGEST_JOB_KEYS, ...DRAFT_JOB_KEYS] as const;
export type ScheduledJobKey = (typeof SCHEDULED_JOB_KEYS)[number];

export interface ScheduledJobSwitch {
  enabled: boolean;
  scheduleHour: number;
}

export type ScheduledJobSwitches = Record<ScheduledJobKey, ScheduledJobSwitch>;

export function isScheduledJobKey(value: unknown): value is ScheduledJobKey {
  return typeof value === "string" && (SCHEDULED_JOB_KEYS as readonly string[]).includes(value);
}

/** The `ai_proactive_runs.kind` each job's work is recorded under. */
export const JOB_RUN_KIND: Record<ScheduledJobKey, AiProactiveRunKind> = {
  financial_report_builder: "daily_digest",
  reconciliation_assistant: "daily_digest",
  sales_analyzer: "weekly_digest",
  receivables_follow_up: "customer_debt_drafts",
  service_reminders: "service_reminder_drafts",
};

export interface DigestSectionInclusion {
  financial: boolean;
  sales: boolean;
  reconciliation: boolean;
}

/**
 * True once at least one job would contribute a section to the digest — the run
 * is then worth claiming and paying for. An all-off configuration must not
 * spend a tenant's credit on an empty digest, which is a billing correctness
 * property and not a nicety.
 */
export function hasAnyDigestContent(inclusion: DigestSectionInclusion): boolean {
  return inclusion.financial || inclusion.sales || inclusion.reconciliation;
}

export function digestSectionInclusion(switches: ScheduledJobSwitches): DigestSectionInclusion {
  return {
    financial: switches.financial_report_builder.enabled,
    sales: switches.sales_analyzer.enabled,
    reconciliation: switches.reconciliation_assistant.enabled,
  };
}
