/**
 * Issue #902 §5 — sending one approved lookup message.
 *
 * The library produces an approved message; `template-variables.ts` produces its
 * token values. This module is what finally puts the two on the wire, and it
 * exists because that step is where money, credentials and the provider's own
 * rules meet:
 *
 *   * **The child's key, not the master's.** A lookup send is authenticated by
 *     the business's own account key, so the message leaves the business's
 *     account and is paid for out of its provider credit. A business whose
 *     account is missing, suspended or undecryptable is refused
 *     (`sms_not_ready`) — fail closed, never fall back to the platform key.
 *   * **Retail first, wholesale second.** The tenant is charged Bizamiz retail,
 *     priced by the central engine (§4). The provider's reported cost is recorded
 *     separately as a tenant-invisible vendor event. One message, one reserve,
 *     one settle, at most one refund.
 *   * **An unknown outcome is not a failure.** `verify/lookup` is a POST; a
 *     dropped connection may mean the message went out. The reservation is
 *     therefore *kept* on ambiguity and the caller is told `unknown` — refunding
 *     would let the same message be sent again for free, and retrying would bill
 *     the tenant twice.
 *   * **Approved only.** A draft, a submitted or a rejected template cannot send.
 *     That is the provider's rule (status 424) enforced before a request leaves
 *     the building, so the operator sees the refusal in the console instead of in
 *     a failed delivery report.
 *
 * The caller is the operator's "send a test" action — which is also the honest
 * way to verify a template end to end before a trigger is wired to it.
 */
import { recordVendorCost } from "../billing/runtime";
import {
  MessageInsufficientCreditError,
  reserveMessageSend,
  refundUnsentMessage,
  settleMessageSend,
  resolveMessageConfig,
  type MessageSendReservation,
} from "../messaging-billing";
import { smsSegmentCount } from "../messaging-billing-pure";
import { vendorCostMeter } from "../messaging-vendor-cost";
import { KavenegarManagementError, KavenegarTransportError, executeLookupSend, type LookupSendExecutor } from "./rest";
import { normalizeReceptor, type LookupSendResult } from "./client";
import { readTemplateForBusiness, LookupTemplateError, type LookupTemplateRow } from "./template-service";
import { renderTemplateTokens, type RenderErrorCode, type TemplateValues } from "./template-variables";
import { quoteBusinessSends } from "./retail-pricing-service";
import { DEFAULT_RETAIL_PRICE_VERSION, quoteRetailBatch } from "./retail-pricing";
import { resolveBusinessSmsSender } from "./credentials";

/** Why a lookup send did not happen. Every value is first-party-safe. */
export type LookupSendBlockedCode =
  | "template_not_found"
  | "template_not_approved"
  | "template_archived"
  | "template_variables_undeclared"
  | "invalid_receptor"
  | "sms_not_ready"
  | "insufficient_credit"
  | "pricing_unavailable"
  | RenderErrorCode;

export type LookupSendOutcome =
  | {
      status: "sent";
      templateId: string;
      /** The provider's message id, for support and delivery tracking. */
      messageId: string | null;
      segments: number;
      /** Retail charged to the business's wallet, in rial. */
      chargedRial: number;
      /** What the provider said it cost (tenant-invisible). Null if unreported. */
      providerCostRial: number | null;
    }
  | {
      /** The provider may or may not have sent it. The reservation is kept. */
      status: "unknown";
      templateId: string;
      reservedRial: number;
    }
  | {
      status: "failed";
      templateId: string;
      /** Provider-neutral code, safe to log and to show an operator. */
      code: string;
      refundedRial: number;
    }
  | { status: "blocked"; code: LookupSendBlockedCode; variable?: string };

const SMS_METER = vendorCostMeter("sms") ?? "messaging.sms_segment";

/**
 * Price one lookup message.
 *
 * The base unit price is central Billing's (`platform_message_config`), and the
 * retail engine applies the version, slabs, exceptions, markup, surcharge,
 * discount and tax on top. Without a base rate there is nothing honest to charge,
 * so the send is refused (`pricing_unavailable`) — a guessed price on a wallet
 * entry is worse than a refusal. If only the *version* tables are unreadable
 * (mid-migration, a failed query), the base rate is used: exactly what the
 * messaging drain does in the same situation, and what the tenant paid before §4.
 */
async function priceLookupMessage(
  businessId: string,
  segments: number,
): Promise<{ ok: true; totalRial: number; version: number } | { ok: false }> {
  let unitPriceRial: number;
  try {
    const config = await resolveMessageConfig();
    unitPriceRial = config.rate.smsRialPerSegment;
  } catch {
    return { ok: false };
  }
  const messages = [{ channel: "sms" as const, unitPriceRial, quantity: segments }];
  try {
    const priced = await quoteBusinessSends({ businessId, messages });
    return { ok: true, totalRial: priced.totalRial, version: priced.version.version };
  } catch {
    const fallback = quoteRetailBatch({
      businessId,
      monthlySegments: 0,
      version: DEFAULT_RETAIL_PRICE_VERSION,
      messages,
    });
    return { ok: true, totalRial: fallback.totalRial, version: DEFAULT_RETAIL_PRICE_VERSION.version };
  }
}

/**
 * Send one approved lookup message to one recipient.
 *
 * `execute` is the test seam: the default posts to the provider with the child's
 * key, and a test passes a recorded fixture. Everything else — approval, the
 * child's own credentials, the price, the reserve and the settle — is the real
 * code path.
 */
export async function sendManagedLookup(input: {
  businessId: string;
  templateId: string;
  variables: TemplateValues;
  receptor: string;
  execute?: LookupSendExecutor;
}): Promise<LookupSendOutcome> {
  const receptor = normalizeReceptor(input.receptor);
  if (!receptor) return { status: "blocked", code: "invalid_receptor" };

  let template: LookupTemplateRow | null;
  try {
    template = await readTemplateForBusiness(input.businessId, input.templateId);
  } catch (error) {
    if (error instanceof LookupTemplateError) return { status: "blocked", code: "template_not_found" };
    throw error;
  }
  if (!template) return { status: "blocked", code: "template_not_found" };
  if (template.archived_at !== null) return { status: "blocked", code: "template_archived" };
  if (template.state !== "approved") return { status: "blocked", code: "template_not_approved" };
  if (template.variables.length === 0) {
    // Positional mapping is the whole contract. Without it a caller would be
    // guessing which value belongs in which sentence.
    return { status: "blocked", code: "template_variables_undeclared" };
  }

  const rendered = renderTemplateTokens({
    body: template.body,
    variables: template.variables,
    values: input.variables,
  });
  if (!rendered.ok) return { status: "blocked", code: rendered.code, variable: rendered.variable };

  const sender = await resolveBusinessSmsSender(input.businessId);
  if (!sender.apiKey) return { status: "blocked", code: "sms_not_ready" };

  const segments = Math.max(1, smsSegmentCount(rendered.preview));
  const price = await priceLookupMessage(input.businessId, segments);
  if (!price.ok) return { status: "blocked", code: "pricing_unavailable" };

  let reservation: MessageSendReservation | null = null;
  if (price.totalRial > 0) {
    try {
      reservation = await reserveMessageSend({
        businessId: input.businessId,
        reservedRial: price.totalRial,
        // The wallet entry is tenant-readable: a version number, never a markup.
        metadata: { retailPriceVersion: price.version, source: "managed_lookup", lookupTemplateId: template.id },
      });
    } catch (error) {
      if (error instanceof MessageInsufficientCreditError) {
        return { status: "blocked", code: "insufficient_credit" };
      }
      throw error;
    }
  }

  let result: LookupSendResult;
  try {
    result = await (input.execute ?? executeLookupSend)({
      apiKey: sender.apiKey,
      template: template.name,
      receptor,
      tokens: rendered.tokens,
      sender: sender.sender || null,
    });
  } catch (error) {
    // A definitive provider answer (424 template not approved there, 411 bad
    // recipient, 418 no credit on the child) means nothing was sent: refund in
    // full and report the provider-neutral code.
    if (error instanceof KavenegarManagementError) {
      if (reservation) {
        await refundUnsentMessage({
          businessId: input.businessId,
          reservation,
          reason: "ارسال پیام تأییدشده انجام نشد",
        }).catch(() => {});
      }
      return {
        status: "failed",
        templateId: template.id,
        code: error.classification.code,
        refundedRial: reservation?.reservedRial ?? 0,
      };
    }
    // A dropped connection is NOT a failure. The reservation stands: the message
    // may well be on its way, and refunding would let it be sent again for free.
    if (error instanceof KavenegarTransportError && error.ambiguous) {
      return { status: "unknown", templateId: template.id, reservedRial: reservation?.reservedRial ?? 0 };
    }
    if (reservation) {
      await refundUnsentMessage({
        businessId: input.businessId,
        reservation,
        reason: "ارسال پیام تأییدشده انجام نشد",
      }).catch(() => {});
    }
    return {
      status: "failed",
      templateId: template.id,
      code: "send_failed",
      refundedRial: reservation?.reservedRial ?? 0,
    };
  }

  // Accepted. Settle what was priced: the tenant is charged retail, and the
  // provider's cost never touches their wallet.
  if (reservation) {
    await settleMessageSend({
      businessId: input.businessId,
      reservation,
      actualCostRial: price.totalRial,
      note: "ارسال پیام تأییدشده",
      metadata: { lookupTemplateId: template.id, segments },
    });
  }

  // Wholesale cost as a finance fact, tenant-invisible (§0/DoD #3). A billing
  // write must never fail a message that already went out.
  if (typeof result.costRial === "number" && result.costRial > 0) {
    const reference = result.messageId
      ? `kavenegar_lookup:${result.messageId}`
      : `kavenegar_lookup_request:${reservation?.requestId ?? template.id}`;
    try {
      await recordVendorCost({
        businessId: input.businessId,
        meterKey: SMS_METER,
        provider: "kavenegar",
        sourceReference: reference,
        amountRial: result.costRial,
        metadata: {
          channel: "sms",
          source: "managed_lookup",
          lookupTemplateId: template.id,
          retailRial: price.totalRial,
          priceVersion: price.version,
          segments,
        },
        tenantVisible: false,
      });
    } catch (error) {
      console.error(
        "managed lookup vendor cost failed:",
        template.id,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return {
    status: "sent",
    templateId: template.id,
    messageId: result.messageId,
    segments,
    chargedRial: price.totalRial,
    providerCostRial: result.costRial,
  };
}
