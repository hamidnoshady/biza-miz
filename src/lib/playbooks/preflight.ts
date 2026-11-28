/**
 * Safety + cost preflight (issue #1590 §Wave 3 / inherited #1012 §3 step 4).
 *
 * Produces truthful `unknown` (نامشخص), never zero, for anything it cannot
 * compute. Consent-qualified reachable audience is separate from total matched.
 * Blocked templates are never offered a fake Run. This module is pure; the DB
 * half (`preflight-service.ts`) supplies audience/cost numbers.
 */
import type { AdaptiveContext } from "../adaptive-context";
import type { PlaybookTemplate, Preflight, PreflightCheck, AudiencePreflight, CostPreflight } from "./types";
import { evaluateEligibility } from "./eligibility";
import { validateQuickInputs } from "./quick-input";

export interface PreflightFacts {
  audience?: Partial<AudiencePreflight>;
  cost?: Partial<CostPreflight>;
  sourceFreshness?: { key: string; lastUpdatedAt: string | null }[];
  overlappingWorkflows?: number | null;
  messagingConfigured?: boolean;
  hasOnline?: boolean;
}

export function buildPreflight(
  template: PlaybookTemplate,
  ctx: AdaptiveContext,
  rawInputs: unknown,
  facts: PreflightFacts = {},
): Preflight {
  const eligibility = evaluateEligibility(template, ctx);
  const inputs = validateQuickInputs(template, rawInputs);
  const checks: PreflightCheck[] = [];
  const blockedReasonsFa: string[] = [];

  // Permissions/capabilities (already server-resolved; re-checked again at launch).
  if (!ctx.authorization.permissions.has(template.launchPermission)) {
    blockedReasonsFa.push("شما اجازه اجرای این قالب را ندارید.");
    checks.push({ key: "permission", labelFa: "مجوز اجرا", state: "blocked", detailFa: template.launchPermission });
  } else {
    checks.push({ key: "permission", labelFa: "مجوز اجرا", state: "ok" });
  }

  if (!eligibility.launchable) {
    for (const r of eligibility.reasons) blockedReasonsFa.push(reasonFa(r.code, r));
  }

  // Typed inputs.
  if (!inputs.ok) {
    for (const p of inputs.problems) blockedReasonsFa.push(`ورودی «${p.field}»: ${p.message}`);
    checks.push({ key: "inputs", labelFa: "ورودی‌های لازم", state: "blocked" });
  } else {
    checks.push({ key: "inputs", labelFa: "ورودی‌های لازم", state: "ok" });
  }

  // Consent / reachable audience (Growth outbound only).
  const isOutbound = template.executionBinding.executor === "growth" && template.channels.length > 0;
  const audience: AudiencePreflight = {
    totalMatched: facts.audience?.totalMatched ?? null,
    reachable: facts.audience?.reachable ?? null,
    excluded: facts.audience?.excluded ?? null,
    exclusionReasonsFa: facts.audience?.exclusionReasonsFa ?? [],
  };
  if (isOutbound) {
    const messagingConfigured = facts.messagingConfigured ?? ctx.profile.readiness.messagingConfigured;
    if (!messagingConfigured) {
      blockedReasonsFa.push("کانال ارسال پیام پیکربندی نشده است.");
      checks.push({ key: "channel", labelFa: "کانال ارسال", state: "blocked" });
    }
    if (audience.reachable === null) {
      checks.push({ key: "audience", labelFa: "مخاطب واجد شرایط", state: "unknown", detailFa: "نامشخص" });
    } else if (audience.reachable === 0) {
      blockedReasonsFa.push("هیچ مخاطب واجد شرایط (با رضایت) برای این کانال یافت نشد.");
      checks.push({ key: "audience", labelFa: "مخاطب واجد شرایط", state: "blocked", detailFa: "۰" });
    } else {
      checks.push({ key: "audience", labelFa: "مخاطب واجد شرایط", state: "ok", detailFa: String(audience.reachable) });
    }
    if (template.executionBinding.requiresOnline && facts.hasOnline === false) {
      blockedReasonsFa.push("این کار نیاز به اتصال آنلاین دارد؛ آفلاین اجرا نمی‌شود.");
      checks.push({ key: "online", labelFa: "اتصال آنلاین", state: "blocked" });
    }
  }

  // Cost (integer Rial; unknown ≠ zero; nothing is committed in preflight).
  const cost: CostPreflight = {
    estimatedRial: facts.cost?.estimatedRial ?? null,
    actualRial: facts.cost?.actualRial ?? null,
    liabilityRial: facts.cost?.liabilityRial ?? null,
    currencyDisplay: facts.cost?.currencyDisplay ?? "rial",
    noteFa: facts.cost?.noteFa,
  };
  checks.push({
    key: "cost",
    labelFa: "هزینه تخمینی",
    state: cost.estimatedRial === null ? "unknown" : "ok",
    detailFa: cost.estimatedRial === null ? "نامشخص" : `${cost.estimatedRial} ریال`,
  });

  // Approval requirement.
  const requiresApproval = template.executionBinding.requiresApproval;

  // Scheduling / quiet windows / frequency — surfaced, not faked.
  const kpiSummaryFa = template.measurement.map((m) => `${m.labelFa}`);

  return {
    checks,
    audience,
    cost,
    sourceFreshness: facts.sourceFreshness ?? [],
    overlappingWorkflows: facts.overlappingWorkflows ?? null,
    sendFrequencyLimitFa: isOutbound ? "طبق محدودیت‌های ارسال کانال و سقف کمپین" : undefined,
    quietWindowFa: isOutbound ? "ساعات سکوت (quiet hours) در صورت پیکربندی اعمال می‌شود" : undefined,
    requiresApproval,
    canPause: true,
    canCancel: true,
    rollbackFa: template.executionBinding.executor === "crm"
      ? "وظایف ایجادشده قابل لغو/بازتخصیص هستند؛ هیچ تغییر مالی انجام نمی‌شود."
      : "کمپین قابل توقف (pause) و لغو است؛ ارسال‌های انجام‌شده قابل پس‌گرفتن نیستند.",
    kpiSummaryFa,
    blocked: blockedReasonsFa.length > 0,
    blockedReasonsFa: dedupe(blockedReasonsFa),
  };
}

function reasonFa(code: string, r: { code: string } & Record<string, unknown>): string {
  switch (code) {
    case "app_disabled": return "این اپ برای کسب‌وکار غیرفعال است.";
    case "module_disabled": return "ماژول لازم غیرفعال است.";
    case "missing_permission": return `مجوز لازم را ندارید (${String(r.permission ?? "")}).`;
    case "missing_launch_permission": return "مجوز اجرای این قالب را ندارید.";
    case "capability_missing": return `قابلیت لازم در دسترس نیست (${String(r.capability ?? "")}).`;
    case "industry_unsupported": return "این قالب برای صنف شما در دسترس نیست.";
    case "data_missing": return `داده لازم موجود نیست: ${String(r.labelFa ?? r.key ?? "")}.`;
    case "not_published": return "این قالب هنوز منتشر نشده است.";
    case "archived": return "این قالب بایگانی شده است.";
    case "messaging_not_configured": return "کانال ارسال پیام پیکربندی نشده است.";
    case "no_consented_audience": return "مخاطب واجد شرایط (با رضایت) موجود نیست.";
    case "campaign_executor_unavailable": return "موتور اجرای کمپین (#901) در دسترس نیست.";
    case "offline_unsupported": return "این کار آفلاین پشتیبانی نمی‌شود.";
    default: return code;
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
