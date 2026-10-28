/**
 * Issue #902 §5 — the product half: a business event becomes one approved
 * message on the business's own child account.
 *
 * `sendManagedLookup` (§5d) sends a message when a caller names a template and
 * supplies the token values. This module is the caller: it decides *whether*
 * the business asked for this message at all, resolves the facts the event
 * really has, and makes sure one fact is one message even when the event is
 * replayed.
 *
 * ## The three refusals that come before money
 *
 *   * **The business's own decision.** A trigger with no row in
 *     `kavenegar_lookup_triggers` sends nothing. Enabling one is a deliberate
 *     act on the tenant screen — the migration seeds no rows, so no business
 *     starts texting its customers because a release said so.
 *   * **The customer's own consent.** A transactional message is not an
 *     unconsented message: the recipient must exist, have a reachable mobile
 *     and still hold `parties.sms_consent`. A "no" is recorded as `skipped` so
 *     support can answer «چرا پیامک نیامد؟» with a fact rather than a shrug.
 *   * **The template's own mapping.** A template that declares a variable the
 *     event cannot fill is refused at configuration time *and* again at send
 *     time (the draft could have changed in between), because positional
 *     mapping is what makes the message truthful.
 *
 * ## One fact, one attempt
 *
 * The send log's UNIQUE `(business_id, trigger_key, event_key)` is the claim:
 * the row is written *before* the provider is called, so a replayed sync event,
 * a second terminal bumping another line of the same ticket, or an operator
 * refreshing the kitchen screen cannot send twice. Which also means a refusal
 * consumes the fact — there is no retry queue here, on purpose: telling a
 * customer their order is ready twenty minutes later is worse than not telling
 * them, and a retried send is a second charge for one event.
 *
 * ## Never on the critical path
 *
 * Every entry point is safe to call from the middle of a kitchen bump or a till
 * close: nothing here throws, and a failed SMS is logged and swallowed. Taking
 * money has already committed by the time this runs.
 *
 * ## And never for authentication
 *
 * There is no login trigger, and `lookup-trigger-facts.ts` says why in full: an
 * OTP runs on the platform-auth transport and must survive an empty tenant
 * wallet, a suspended child or a switched-off Growth. `lookup-trigger-boundaries.test.ts`
 * pins that separation by reading the imports of the auth path.
 */
import { query } from "../db";
import { normalizeReceptor } from "./client";
import {
  MANAGED_LOOKUP_TRIGGERS,
  TRIGGER_DESCRIPTIONS,
  TRIGGER_LABELS,
  checkTriggerTemplate,
  isManagedLookupTrigger,
  triggerEventKey,
  triggerValues,
  type ManagedLookupTrigger,
  type OrderReadyFacts,
  type PaymentReceivedFacts,
  type TriggerFactsByKind,
  type TriggerTemplateProblem,
} from "./lookup-trigger-facts";
import { sendManagedLookup, type LookupSendOutcome } from "./lookup-send-service";
import { readTemplateForBusiness, type LookupTemplateRow, type LookupTemplateState } from "./template-service";
import { isTemplateVariable, type TemplateVariable } from "./template-variables";
import type { LookupSendExecutor } from "./rest";

/**
 * The row's `variables` is a text[] whose contents the database constrains
 * (migration 0264's CHECK) but TypeScript does not. Narrowing here means the
 * rest of the module reasons in the closed `TemplateVariable` vocabulary, and a
 * value that somehow escaped the CHECK is treated as "not declared" rather than
 * filled.
 */
function declaredVariables(values: readonly string[]): TemplateVariable[] {
  return values.filter(isTemplateVariable);
}

/** Why nothing was sent to anyone: an address problem, not a provider problem. */
export type TriggerSkipCode = "no_customer" | "missing_phone" | "no_consent";

export type TriggerDispatchResult =
  | { status: "sent"; templateId: string; messageId: string | null; chargedRial: number }
  /** This fact was already handled (sent, refused — either way, settled). */
  | { status: "duplicate" }
  | { status: "skipped"; code: TriggerSkipCode }
  /** The business's choice, the template's state or the wallet refused it. */
  | { status: "blocked"; code: string }
  /** The provider refused definitively; nothing was charged (refunded in full). */
  | { status: "failed"; code: string }
  /** The provider may or may not have sent it; the reservation is kept. */
  | { status: "unknown"; templateId: string; reservedRial: number }
  /** Something in this module's own machinery broke. Logged; never thrown. */
  | { status: "error" };

export interface TriggerSetting {
  trigger: ManagedLookupTrigger;
  label: string;
  description: string;
  enabled: boolean;
  templateId: string | null;
  templateTitle: string | null;
  templateState: LookupTemplateState | null;
  /** Why the attached template cannot be used, or null when it can. */
  problem: TriggerTemplateProblem | "template_not_approved" | null;
  updatedAt: string | null;
}

export class LookupTriggerError extends Error {
  constructor(public readonly code: "invalid_trigger" | "template_not_found" | "template_not_approved" | TriggerTemplateProblem) {
    super(code);
    this.name = "LookupTriggerError";
  }
}

/**
 * The tenant's automation screen: every trigger the vocabulary has, whatever
 * this business decided about it. Reading the join rather than the config table
 * means a template withdrawn from the catalog shows up as "cannot send" instead
 * of vanishing from the screen while the automation is still on.
 */
export async function listTriggerSettings(businessId: string): Promise<TriggerSetting[]> {
  const { rows } = await query<{
    trigger_key: string;
    enabled: boolean;
    template_id: string;
    title: string | null;
    state: LookupTemplateState | null;
    variables: string[] | null;
    updated_at: Date;
  }>(
    `SELECT t.trigger_key, t.enabled, t.template_id, t.updated_at,
            lt.title, lt.state, lt.variables
       FROM kavenegar_lookup_triggers t
       LEFT JOIN kavenegar_lookup_templates lt
              ON lt.id = t.template_id AND lt.business_id = t.business_id
      WHERE t.business_id = $1`,
    [businessId],
  );
  const byTrigger = new Map(rows.map((row) => [row.trigger_key, row]));

  return MANAGED_LOOKUP_TRIGGERS.map((trigger) => {
    const row = byTrigger.get(trigger);
    const declared = row?.variables ? declaredVariables(row.variables) : null;
    let problem: TriggerSetting["problem"] = null;
    if (row && declared) {
      problem =
        row.state === "approved"
          ? checkTriggerTemplate(trigger, declared)
          : "template_not_approved";
    }
    return {
      trigger,
      label: TRIGGER_LABELS[trigger],
      description: TRIGGER_DESCRIPTIONS[trigger],
      enabled: Boolean(row?.enabled),
      templateId: row?.template_id ?? null,
      templateTitle: row?.title ?? null,
      templateState: row?.state ?? null,
      problem,
      updatedAt: row?.updated_at?.toISOString() ?? null,
    };
  });
}

/**
 * Turn one trigger on (or off), attached to one of this business's approved
 * messages.
 *
 * The checks are the same ones the dispatcher makes, deliberately repeated here:
 * an operator should learn that a template cannot fill this event's variables
 * while they are still looking at the form, not from a send log three days
 * later.
 */
export async function saveTriggerSetting(input: {
  businessId: string;
  trigger: string;
  templateId: string;
  enabled?: boolean;
}): Promise<TriggerSetting> {
  if (!isManagedLookupTrigger(input.trigger)) throw new LookupTriggerError("invalid_trigger");

  const template = await readTemplateForBusiness(input.businessId, input.templateId);
  if (!template) throw new LookupTriggerError("template_not_found");
  if (template.state !== "approved") throw new LookupTriggerError("template_not_approved");
  const problem = checkTriggerTemplate(input.trigger, declaredVariables(template.variables));
  if (problem) throw new LookupTriggerError(problem);

  await query(
    `INSERT INTO kavenegar_lookup_triggers (business_id, trigger_key, template_id, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, trigger_key) DO UPDATE
       SET template_id = EXCLUDED.template_id,
           enabled = EXCLUDED.enabled,
           updated_at = now()`,
    [input.businessId, input.trigger, input.templateId, input.enabled ?? true],
  );

  const settings = await listTriggerSettings(input.businessId);
  return settings.find((setting) => setting.trigger === input.trigger)!;
}

/** The business's live choice for one trigger, or null when it never made one / turned it off. */
async function readEnabledTrigger(
  businessId: string,
  trigger: ManagedLookupTrigger,
): Promise<{ templateId: string } | null> {
  const { rows } = await query<{ template_id: string }>(
    `SELECT template_id FROM kavenegar_lookup_triggers
      WHERE business_id = $1 AND trigger_key = $2 AND enabled
      LIMIT 1`,
    [businessId, trigger],
  );
  return rows[0] ? { templateId: rows[0].template_id } : null;
}

/**
 * Claim one fact. `null` means somebody already has it — the caller reports
 * `duplicate` and touches nothing, which is what makes a replay free.
 */
async function claimSend(input: {
  businessId: string;
  trigger: ManagedLookupTrigger;
  eventKey: string;
}): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO kavenegar_lookup_trigger_sends (business_id, trigger_key, event_key, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (business_id, trigger_key, event_key) DO NOTHING
     RETURNING id`,
    [input.businessId, input.trigger, input.eventKey],
  );
  return rows[0]?.id ?? null;
}

async function finishSend(
  id: string,
  patch: {
    status: "sent" | "blocked" | "failed" | "unknown" | "skipped";
    code?: string | null;
    templateId?: string | null;
    providerMessageId?: string | null;
    segments?: number | null;
    chargedRial?: number;
  },
): Promise<void> {
  await query(
    `UPDATE kavenegar_lookup_trigger_sends
        SET status = $2, code = $3, template_id = $4, provider_message_id = $5,
            segments = $6, charged_rial = $7, updated_at = now()
      WHERE id = $1`,
    [
      id,
      patch.status,
      patch.code ?? null,
      patch.templateId ?? null,
      patch.providerMessageId ?? null,
      patch.segments ?? null,
      Math.max(0, Math.trunc(patch.chargedRial ?? 0)),
    ],
  );
}

/** Provider-neutral code for a blocked send, with the variable named when there is one. */
function blockedCode(outcome: Extract<LookupSendOutcome, { status: "blocked" }>): string {
  return outcome.variable ? `${outcome.code}:${outcome.variable}` : outcome.code;
}

function mapOutcome(outcome: LookupSendOutcome): {
  result: TriggerDispatchResult;
  patch: Parameters<typeof finishSend>[1];
} {
  if (outcome.status === "sent") {
    return {
      result: {
        status: "sent",
        templateId: outcome.templateId,
        messageId: outcome.messageId,
        chargedRial: outcome.chargedRial,
      },
      patch: {
        status: "sent",
        templateId: outcome.templateId,
        providerMessageId: outcome.messageId,
        segments: outcome.segments,
        chargedRial: outcome.chargedRial,
      },
    };
  }
  if (outcome.status === "unknown") {
    // The reservation is kept (§5d), so the amount held is the amount this fact
    // has cost so far. It is not a settled charge and the log says "unknown".
    return {
      result: { status: "unknown", templateId: outcome.templateId, reservedRial: outcome.reservedRial },
      patch: { status: "unknown", code: "unknown_outcome", templateId: outcome.templateId, chargedRial: outcome.reservedRial },
    };
  }
  if (outcome.status === "failed") {
    return {
      result: { status: "failed", code: outcome.code },
      patch: { status: "failed", code: outcome.code, templateId: outcome.templateId },
    };
  }
  return {
    result: { status: "blocked", code: blockedCode(outcome) },
    patch: { status: "blocked", code: blockedCode(outcome) },
  };
}

/**
 * Run one trigger for one fact.
 *
 * `execute` is the §5d test seam; production passes nothing and the child's key
 * is used for real. `declared` is re-read from the row in the database rather
 * than trusted from the caller — a template edited between configuration and
 * send must not be filled with a mapping that no longer matches.
 */
export async function dispatchLookupTrigger<T extends ManagedLookupTrigger>(input: {
  businessId: string;
  trigger: T;
  /** The identity of the fact (`order:<uuid>`), never of the attempt. */
  eventKey: string;
  receptor: string;
  facts: TriggerFactsByKind[T];
  execute?: LookupSendExecutor;
}): Promise<TriggerDispatchResult> {
  let claimId: string;
  try {
    const claimed = await claimSend({
      businessId: input.businessId,
      trigger: input.trigger,
      eventKey: input.eventKey,
    });
    if (!claimed) return { status: "duplicate" };
    claimId = claimed;
  } catch (error) {
    console.error("lookup trigger claim failed:", input.trigger, error instanceof Error ? error.message : error);
    return { status: "error" };
  }

  try {
    const setting = await readEnabledTrigger(input.businessId, input.trigger);
    if (!setting) {
      await finishSend(claimId, { status: "blocked", code: "trigger_disabled" });
      return { status: "blocked", code: "trigger_disabled" };
    }

    const template: LookupTemplateRow | null = await readTemplateForBusiness(
      input.businessId,
      setting.templateId,
    );
    if (!template) {
      await finishSend(claimId, { status: "blocked", code: "template_not_found" });
      return { status: "blocked", code: "template_not_found" };
    }
    const declared = declaredVariables(template.variables);
    const problem = checkTriggerTemplate(input.trigger, declared);
    if (problem) {
      await finishSend(claimId, { status: "blocked", code: problem, templateId: template.id });
      return { status: "blocked", code: problem };
    }

    const outcome = await sendManagedLookup({
      businessId: input.businessId,
      templateId: template.id,
      variables: triggerValues(input.trigger, input.facts, declared),
      receptor: input.receptor,
      execute: input.execute,
    });
    const { result, patch } = mapOutcome(outcome);
    await finishSend(claimId, patch);
    return result;
  } catch (error) {
    console.error("lookup trigger dispatch failed:", input.trigger, error instanceof Error ? error.message : error);
    // The claim stays `pending`: something broke between the claim and a known
    // answer, and a row that says so is honest. It also means the fact cannot be
    // re-claimed into a duplicate message by a replay.
    return { status: "error" };
  }
}

/**
 * The order (and who placed it) behind a trigger.
 *
 * One read for the whole picture: the order's number, the customer who placed
 * it, their reachable mobile and their standing consent, and the store's own
 * name. Nothing here is provider-specific; a null customer is normal (walk-in
 * tickets) and is what `recipientSkip` reports as `no_customer`.
 */
async function readOrderContext(input: {
  locationId: string;
  orderId: string;
}): Promise<{
  orderNumber: string;
  storeName: string;
  customerName: string | null;
  customerId: string | null;
  phone: string | null;
  phoneE164: string | null;
  smsConsent: boolean | null;
} | null> {
  const { rows } = await query<{
    order_number: string;
    store_name: string;
    customer_id: string | null;
    customer_name: string | null;
    phone: string | null;
    phone_e164: string | null;
    sms_consent: boolean | null;
  }>(
    `SELECT o.order_number::text AS order_number,
            b.name AS store_name,
            o.customer_id,
            p.name AS customer_name,
            p.phone,
            p.phone_e164,
            p.sms_consent
       FROM orders o
       JOIN locations l ON l.id = o.location_id
       JOIN businesses b ON b.id = l.business_id
       LEFT JOIN parties p ON p.id = o.customer_id AND p.business_id = l.business_id
      WHERE o.id = $1 AND o.location_id = $2`,
    [input.orderId, input.locationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    orderNumber: row.order_number,
    storeName: row.store_name,
    customerName: row.customer_name,
    customerId: row.customer_id,
    phone: row.phone,
    phoneE164: row.phone_e164,
    smsConsent: row.sms_consent,
  };
}

/**
 * The shared body of both notifiers: read the order, refuse an unaddressable
 * recipient (recording why), then dispatch the trigger.
 *
 * The facts are built from the context by the caller, because only the caller
 * knows what its event adds to the order — an amount, for a receipt.
 */
async function notifyOrderEvent<T extends ManagedLookupTrigger>(input: {
  businessId: string;
  locationId: string;
  orderId: string;
  trigger: T;
  facts: (context: { storeName: string; customerName: string | null; orderNumber: string }) => TriggerFactsByKind[T];
  execute?: LookupSendExecutor;
}): Promise<TriggerDispatchResult> {
  try {
    const context = await readOrderContext(input);
    if (!context) return { status: "error" };

    const eventKey = triggerEventKey(input.trigger, input.orderId);
    // An address problem is recorded as `skipped` and never reaches the
    // provider: a refusal that says "no consent" is what support needs to read.
    const skip = recipientSkip(context);
    if (skip) {
      const claimed = await claimSend({
        businessId: input.businessId,
        trigger: input.trigger,
        eventKey,
      }).catch(() => null);
      if (!claimed) return { status: "duplicate" };
      await finishSend(claimed, { status: "skipped", code: skip });
      return { status: "skipped", code: skip };
    }

    return await dispatchLookupTrigger({
      businessId: input.businessId,
      trigger: input.trigger,
      eventKey,
      receptor: (context.phoneE164 ?? context.phone)!,
      facts: input.facts({
        storeName: context.storeName,
        customerName: context.customerName,
        orderNumber: context.orderNumber,
      }),
      execute: input.execute,
    });
  } catch (error) {
    console.error(
      `${input.trigger} notice failed:`,
      input.orderId,
      error instanceof Error ? error.message : error,
    );
    return { status: "error" };
  }
}

/**
 * The order is ready. Called *after* the kitchen transition committed, from
 * both the online bump and the offline replay, so the same ticket reached from
 * two terminals still produces one message.
 */
export async function notifyOrderReady(input: {
  businessId: string;
  locationId: string;
  orderId: string;
  execute?: LookupSendExecutor;
}): Promise<TriggerDispatchResult> {
  return notifyOrderEvent({
    ...input,
    trigger: "order_ready",
    facts: ({ storeName, customerName, orderNumber }) => ({
      customerName,
      storeName,
      orderNumber,
    }),
  });
}

/**
 * The bill was paid. Called *after* the settlement committed, from the counter's
 * checkout route and from the offline replay — the same fact key, so a payment
 * recorded locally and replayed on reconnection is one receipt.
 *
 * `amountRial` is what was actually taken in this settlement, passed by the
 * caller rather than re-read: the order's `total` is a different number once a
 * later amendment or a second tender touches it, and a receipt has to say what
 * the customer paid.
 */
export async function notifyPaymentReceived(input: {
  businessId: string;
  locationId: string;
  orderId: string;
  amountRial: number;
  receivedAt?: Date;
  execute?: LookupSendExecutor;
}): Promise<TriggerDispatchResult> {
  const receivedAt = input.receivedAt ?? new Date();
  return notifyOrderEvent({
    ...input,
    trigger: "payment_received",
    facts: ({ storeName }) => ({ amountRial: input.amountRial, storeName, receivedAt }),
  });
}

/** Why this recipient cannot be messaged, or null when they can. */
function recipientSkip(row: {
  customerId: string | null;
  phone: string | null;
  phoneE164: string | null;
  smsConsent: boolean | null;
}): TriggerSkipCode | null {
  if (!row.customerId) return "no_customer";
  if (!normalizeReceptor(row.phoneE164 ?? row.phone ?? "")) return "missing_phone";
  // A customer who said "no SMS" is not sent one, transactional or not.
  if (row.smsConsent !== true) return "no_consent";
  return null;
}
