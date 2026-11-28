/**
 * DB half of preflight (issue #1590). Computes truthful audience facts from
 * canonical sources, then calls pure `buildPreflight`. Never fabricates;
 * `null` = unknown (نامشخص). Nothing is written; nothing is sent.
 */
import type { AdaptiveContext } from "../adaptive-context";
import type { PlaybookTemplate, Preflight } from "./types";
import { buildPreflight } from "./preflight";
import { validateQuickInputs } from "./quick-input";
import { segmentDefinitionForTemplate } from "./executor";

export async function buildPreflightForTemplate(
  template: PlaybookTemplate,
  ctx: AdaptiveContext,
  rawInputs: unknown,
  opts: { hasOnline?: boolean; businessId: string },
): Promise<Preflight> {
  const inputs = validateQuickInputs(template, rawInputs).values;
  const facts: Parameters<typeof buildPreflight>[3] = { hasOnline: opts.hasOnline ?? true };

  if (template.executionBinding.executor === "growth" && template.channels.length > 0 && ctx.profile.readiness.messagingConfigured) {
    try {
      const { countDefinition } = await import("../crm-segments-service");
      const { businessToday } = await import("../business-day-service");
      const { CHANNEL_PURPOSE } = await import("../campaign-channels");
      const today = await businessToday(opts.businessId);
      const definition = segmentDefinitionForTemplate(template, inputs, today) as never;
      const channel = inputs.channel === "email" ? "email" : "sms";
      const purpose = CHANNEL_PURPOSE[channel];
      const [totalMatched, reachable] = await Promise.all([
        countDefinition(opts.businessId, definition, "view"),
        countDefinition(opts.businessId, definition, purpose),
      ]);
      facts.audience = {
        totalMatched,
        reachable,
        excluded: Math.max(0, totalMatched - reachable),
        exclusionReasonsFa: totalMatched > reachable ? ["بدون رضایت بازاریابی برای این کانال", "بدون شماره/ایمیل معتبر", "مستثنا/لغو اشتراک"] : [],
      };
    } catch {
      // leave audience unknown (نامشخص); never report zero on a failed read
    }
    facts.messagingConfigured = ctx.profile.readiness.messagingConfigured;
  }

  return buildPreflight(template, ctx, rawInputs, facts);
}
