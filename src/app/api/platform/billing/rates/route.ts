import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { getMediaConfig, saveMediaTariff } from "@/lib/media-service";
import { maskMediaConfig, validateMediaTariffInput } from "@/lib/media";
import { getPublicMessageConfig, saveMessageRates, MessageConfigError } from "@/lib/messaging-billing";
import { getAiCostingConfig, saveAiCostingConfig } from "@/lib/ai-gateway-service";
import { parseSafeIntInput } from "@/lib/platform-money";

/**
 * The ONE commercial rates catalogue (migration 0176): everything a business
 * is charged per unit of use, managed from `/platform/billing?tab=usage` —
 *
 *   messaging — Rial per SMS segment / per email (platform_message_config)
 *   media     — the daily storage tariff + AI image-enhance price
 *               (platform_media_config)
 *   ai        — the per-turn ceiling and LiteLLM-based costing rates
 *               (platform_ai_gateway — the one canonical internal-cost source;
 *               /platform/ai keeps the technical connection only)
 *
 * Every group is readable by any admin, writable only with `billing.manage`
 * (the sensitive financial-configuration capability — support never holds it).
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const [message, media, ai] = await Promise.all([
    getPublicMessageConfig(),
    getMediaConfig(),
    getAiCostingConfig(),
  ]);
  const maskedMedia = maskMediaConfig(media);
  return NextResponse.json({
    messaging: { rate: message.rate },
    media: {
      billingEnabled: maskedMedia.billingEnabled,
      dailyFlatRial: maskedMedia.dailyFlatRial,
      dailyPerGbRial: maskedMedia.dailyPerGbRial,
      freeQuotaMb: maskedMedia.freeQuotaMb,
      enhancePriceRial: maskedMedia.enhancePriceRial,
    },
    ai,
  });
});

function parseNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = parseSafeIntInput(value, { min: 0 });
  return parsed !== null ? parsed : NaN;
}

export const PUT = withPlatformScope(async (req: Request) => {
  const guard = await requirePlatformCapability("billing.manage");
  if (guard.error) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // --- Messaging rates -----------------------------------------------------
  if (body.messaging && typeof body.messaging === "object") {
    const messaging = body.messaging as { smsRialPerSegment?: unknown; emailRialPerSend?: unknown };
    const sms = parseNonNegativeInt(messaging.smsRialPerSegment);
    const email = parseNonNegativeInt(messaging.emailRialPerSend);
    if (Number.isNaN(sms) || Number.isNaN(email)) {
      return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
    }
    const before = (await getPublicMessageConfig()).rate;
    try {
      const rate = await saveMessageRates({
        smsRialPerSegment: sms,
        emailRialPerSend: email,
      });
      await platformAudit({
        adminId: guard.session.padmin,
        action: "messaging_rate.changed",
        entity: "platform_message_config",
        entityId: "true",
        payload: { before, after: rate },
      });
    } catch (err) {
      if (err instanceof MessageConfigError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  // --- Media / storage tariff ----------------------------------------------
  if (body.media && typeof body.media === "object") {
    const before = await getMediaConfig();
    const result = validateMediaTariffInput(body.media, {
      billingEnabled: before.billingEnabled,
      dailyFlatRial: before.dailyFlatRial,
      dailyPerGbRial: before.dailyPerGbRial,
      freeQuotaMb: before.freeQuotaMb,
      enhancePriceRial: before.enhancePriceRial,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    await saveMediaTariff(result.tariff, guard.session.padmin);
    await platformAudit({
      adminId: guard.session.padmin,
      action: "storage_rate.changed",
      entity: "platform_media_config",
      entityId: "true",
      payload: {
        before: {
          billingEnabled: before.billingEnabled,
          dailyFlatRial: before.dailyFlatRial,
          dailyPerGbRial: before.dailyPerGbRial,
          freeQuotaMb: before.freeQuotaMb,
          enhancePriceRial: before.enhancePriceRial,
        },
        after: result.tariff,
      },
    });
  }

  // --- AI commercial costing -----------------------------------------------
  if (body.ai && typeof body.ai === "object") {
    const ai = body.ai as Record<string, unknown>;
    const numbers = {
      usdRialRate:
        ai.usdRialRate === undefined
          ? undefined
          : ai.usdRialRate == null || ai.usdRialRate === ""
            ? null
            : parseNonNegativeInt(ai.usdRialRate),
      inputCostRialPerMillion: parseNonNegativeInt(ai.inputCostRialPerMillion),
      outputCostRialPerMillion: parseNonNegativeInt(ai.outputCostRialPerMillion),
      revenueMarginPercent: parseNonNegativeInt(ai.revenueMarginPercent),
      maxTurnRial: parseNonNegativeInt(ai.maxTurnRial),
    };
    if (Object.values(numbers).some((v) => Number.isNaN(v))) {
      return NextResponse.json({ error: "INVALID_AMOUNT" }, { status: 400 });
    }
    const before = await getAiCostingConfig();
    const after = await saveAiCostingConfig({
      ...numbers,
      gatewayCostingEnabled:
        typeof ai.gatewayCostingEnabled === "boolean" ? ai.gatewayCostingEnabled : undefined,
    });
    await platformAudit({
      adminId: guard.session.padmin,
      action: "usage_rate.changed",
      entity: "platform_ai_gateway",
      entityId: "true",
      payload: { group: "ai", before, after },
    });
  }

  // Recompute the whole catalogue so the caller sees the merged result.
  const [message, media, aiCosting] = await Promise.all([
    getPublicMessageConfig(),
    getMediaConfig(),
    getAiCostingConfig(),
  ]);
  const maskedMedia = maskMediaConfig(media);
  return NextResponse.json({
    messaging: { rate: message.rate },
    media: {
      billingEnabled: maskedMedia.billingEnabled,
      dailyFlatRial: maskedMedia.dailyFlatRial,
      dailyPerGbRial: maskedMedia.dailyPerGbRial,
      freeQuotaMb: maskedMedia.freeQuotaMb,
      enhancePriceRial: maskedMedia.enhancePriceRial,
    },
    ai: aiCosting,
  });
});
