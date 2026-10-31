/**
 * Issue #902 §9 item 5 — every managed service's readiness, in one tenant payload.
 *
 * Before this file, readiness existed in one place for one integration: the
 * messaging route computed SMS readiness from the business's child account, and
 * the other four services had no readiness at all — a Growth screen, a billing
 * screen and a media screen each decided their own copy from whatever internal
 * state they happened to hold. That is how a supplier name reaches a tenant: not
 * by decision, but by a screen reaching for the nearest field.
 *
 * The payload is a list of `TenantManagedServiceView` — the contract's shape,
 * which cannot carry a provider, an account id or a wholesale price. The route
 * passes the result through `assertTenantSafePayload` on the way out, so a future
 * adapter that adds a field is caught by a test rather than by a customer.
 *
 * Two things are deliberate:
 *
 *   - **Every registered service appears**, including the ones the business is not
 *     entitled to. `suspended_by_plan` is a sentence with a first-party link, and
 *     hiding the row is how a tenant never learns the capability exists.
 *   - **SMS keeps the view it already had.** `getTenantSmsReadiness` derives it
 *     from the child account's provision state, which is strictly richer than the
 *     plan layer this file reads for the others; re-deriving it here would give
 *     the same business two answers on two screens.
 */
import { getAiRuntimeReadiness, getPlatformAiConfig, type AiRuntimeUnavailableReason } from "../ai-config";
import { resolveBusinessCapability } from "../entitlement-service";
import { MANAGED_SERVICES, toTenantManagedServiceView, type TenantManagedServiceView } from "./contract";
import { getMediaConfig } from "../media-service";
import { resolveMessageConfig } from "../messaging-billing";
import { getPaymentConfig, getWalletBalanceRial } from "../wallet-service";
import { getTenantSmsReadiness } from "../kavenegar/credentials";
import {
  aiDetailKey,
  emailDetailKey,
  mediaDetailKey,
  paymentDetailKey,
  type EntitlementFacts,
} from "./readiness";

/** The entitlement resolver's answer, reduced to the contract's inputs. */
async function entitlement(businessId: string, capability: string): Promise<EntitlementFacts> {
  const resolution = await resolveBusinessCapability(businessId, capability);
  return { allowed: resolution.allowed, reason: resolution.reason };
}

/** True when the platform's own storage account is usable, not just switched on. */
function storageConfigured(config: Awaited<ReturnType<typeof getMediaConfig>>): boolean {
  return Boolean(
    config.endpoint.trim() &&
      config.bucket.trim() &&
      config.accessKeyId.trim() &&
      config.secretAccessKey.trim(),
  );
}

/**
 * One view per managed service, for one business.
 *
 * The platform's own configuration is read once per service rather than cached
 * across them: they are separate singletons, and a media misconfiguration must
 * not make the AI card say the same thing.
 */
export async function getTenantManagedServices(
  businessId: string,
): Promise<TenantManagedServiceView[]> {
  const [sms, messaging, aiConfig, payment, media, ai, topUp, mediaAccess] = await Promise.all([
    getTenantSmsReadiness(businessId),
    resolveMessageConfig(),
    getPlatformAiConfig(),
    getPaymentConfig(),
    getMediaConfig(),
    entitlement(businessId, "ai.use"),
    entitlement(businessId, "billing.top_up"),
    entitlement(businessId, "media.manage"),
  ]);
  const checkedAt = new Date().toISOString();
  const aiReadiness = getAiRuntimeReadiness(aiConfig);

  return [
    sms,
    toTenantManagedServiceView({
      definition: MANAGED_SERVICES.messagingEmail,
      detailKey: emailDetailKey({
        relayConfigured: messaging.emailProvider === "noop" || messaging.smtpConfigured,
      }),
      checkedAt,
    }),
    toTenantManagedServiceView({
      definition: MANAGED_SERVICES.aiAssistant,
      detailKey: aiDetailKey({
        entitlement: ai,
        platform: {
          ready: aiReadiness.ready,
          reason: (aiReadiness.reason as AiRuntimeUnavailableReason | null) ?? null,
        },
      }),
      checkedAt,
    }),
    toTenantManagedServiceView({
      definition: MANAGED_SERVICES.paymentsGateway,
      detailKey: paymentDetailKey({
        entitlement: topUp,
        gateway: payment.gateway,
        merchantConfigured: Boolean(payment.merchantId.trim()),
      }),
      checkedAt,
    }),
    toTenantManagedServiceView({
      definition: MANAGED_SERVICES.mediaStorage,
      detailKey: mediaDetailKey({
        entitlement: mediaAccess,
        enabled: media.enabled,
        storageConfigured: storageConfigured(media),
      }),
      checkedAt,
    }),
  ];
}

/**
 * Whether the business's wallet can pay for one more use of a metered service.
 *
 * Not used by the list above — readiness there is about whether the *service*
 * works, and every service has a `wallet_empty` state the send path decides with
 * the amount it needs. It is exported because a screen that wants to warn about
 * credit before a send should ask the billing domain, not re-read a ledger field.
 */
export async function hasCreditFor(businessId: string, amountRial: number): Promise<boolean> {
  if (!Number.isFinite(amountRial) || amountRial <= 0) return true;
  return (await getWalletBalanceRial(businessId)) >= amountRial;
}
