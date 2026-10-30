/**
 * Issue #902 §5 — which business event may become which message, expressed as
 * data rather than as `if` statements scattered through the order and payment
 * code.
 *
 * The point of this module is the closed vocabulary. A trigger is one of two
 * known events, each with a fixed set of facts it can supply, and a template is
 * only usable for a trigger when every variable it declares is one of those
 * facts. That check happens at *configuration* time (a business turning the
 * automation on) and again at send time (the draft could have been edited in
 * between) — a mapping that cannot be filled never reaches the provider.
 *
 * ## What is not here, and why that is the interesting part
 *
 * `login_code` is not a trigger. A login OTP is sent from the platform-auth
 * transport and paid for by the platform, which is what keeps a member able to
 * log in when Growth is off, the business's child account is suspended, or the
 * marketing wallet is empty (issue #902 DoD #9). Every trigger in this module
 * is, by definition, a send on the *business's* child account charged to the
 * *business's* wallet. Adding the login code to this list would therefore be
 * the outage the issue spends a paragraph forbidding — so the vocabulary here
 * is two entries long, and `lookup-triggers.ts` cannot be reached from the auth
 * path at all (a guard test reads the imports).
 *
 * ## Facts, not strings
 *
 * The dispatcher is handed typed facts (a customer's name, an amount in rial),
 * never a `Record<string, string>` from an event payload. Formatting — Persian
 * digits, grouping, a Jalali date — belongs to the token renderers in
 * `template-variables.ts`, and letting a caller pre-format would put a second,
 * unaudited formatter in front of the one that already refuses bad input.
 */
import {
  renderTemplateTokens,
  type TemplateVariable,
  type TemplateValues,
} from "./template-variables";

/** The events a business may turn into a message. Deliberately closed. */
export const MANAGED_LOOKUP_TRIGGERS = ["order_ready", "payment_received"] as const;

export type ManagedLookupTrigger = (typeof MANAGED_LOOKUP_TRIGGERS)[number];

/** Persian labels — first-party words, safe to show a tenant. */
export const TRIGGER_LABELS: Record<ManagedLookupTrigger, string> = {
  order_ready: "آمادهٔ تحویل شدن سفارش",
  payment_received: "ثبت پرداخت",
};

/** One sentence saying what turning this on does, for the tenant screen. */
export const TRIGGER_DESCRIPTIONS: Record<ManagedLookupTrigger, string> = {
  order_ready: "وقتی همهٔ اقلام یک سفارش آماده شد، برای مشتری همان سفارش یک پیامک می‌رود.",
  payment_received: "وقتی پرداخت سفارش ثبت شد، برای مشتری همان سفارش یک رسید پیامکی می‌رود.",
};

/**
 * The variables each event can honestly fill. Anything a template declares
 * outside its trigger's row cannot be supplied from that event, so the template
 * is refused for the trigger rather than sent with a blank.
 */
export const TRIGGER_VARIABLES: Record<ManagedLookupTrigger, readonly TemplateVariable[]> = {
  order_ready: ["customer_name", "store_name", "order_number"],
  payment_received: ["amount", "store_name", "date"],
};

/** What an order-ready event knows. Nulls are normal: not every order has a customer. */
export interface OrderReadyFacts {
  customerName: string | null;
  storeName: string | null;
  /** `orders.order_number` is a bigint; the renderer turns it into digits. */
  orderNumber: string | number | null;
}

/** What a recorded payment knows. */
export interface PaymentReceivedFacts {
  /** Integer rial, the platform's storage unit. */
  amountRial: number;
  storeName: string | null;
  /** When the payment was received. Defaults to "now" at the call site, never here. */
  receivedAt: Date | null;
}

export interface TriggerFactsByKind {
  order_ready: OrderReadyFacts;
  payment_received: PaymentReceivedFacts;
}

export function isManagedLookupTrigger(value: unknown): value is ManagedLookupTrigger {
  return typeof value === "string" && (MANAGED_LOOKUP_TRIGGERS as readonly string[]).includes(value);
}

/**
 * The values one event supplies for one template, restricted to the variables
 * the template actually declares.
 *
 * Nulls are omitted rather than sent as empty strings: `renderTemplateTokens`
 * answers `variable_missing` for an absent value and refuses to send, which is
 * the behaviour we want when an order has no customer name to greet.
 */
export function triggerValues<T extends ManagedLookupTrigger>(
  trigger: T,
  facts: TriggerFactsByKind[T],
  declared: readonly TemplateVariable[],
): TemplateValues {
  const available: TemplateValues =
    trigger === "order_ready"
      ? {
          customer_name: (facts as OrderReadyFacts).customerName,
          store_name: (facts as OrderReadyFacts).storeName,
          order_number: (facts as OrderReadyFacts).orderNumber,
        }
      : {
          amount: (facts as PaymentReceivedFacts).amountRial,
          store_name: (facts as PaymentReceivedFacts).storeName,
          date: (facts as PaymentReceivedFacts).receivedAt,
        };

  const values: TemplateValues = {};
  for (const variable of declared) {
    const value = available[variable];
    if (value !== null && value !== undefined && value !== "") values[variable] = value;
  }
  return values;
}

/** Declared variables this trigger cannot fill. Empty means the template fits. */
export function unsupportedTriggerVariables(
  trigger: ManagedLookupTrigger,
  declared: readonly TemplateVariable[],
): TemplateVariable[] {
  const supported = TRIGGER_VARIABLES[trigger];
  return declared.filter((variable) => !supported.includes(variable));
}

/** Why a template cannot be attached to a trigger, or null when it can. */
export type TriggerTemplateProblem = "template_variables_undeclared" | "trigger_variable_unsupported";

export function checkTriggerTemplate(
  trigger: ManagedLookupTrigger,
  declared: readonly TemplateVariable[],
): TriggerTemplateProblem | null {
  // A template with no declared variables cannot be filled positionally, which
  // is the same refusal `sendManagedLookup` makes (`template_variables_undeclared`).
  if (declared.length === 0) return "template_variables_undeclared";
  if (unsupportedTriggerVariables(trigger, declared).length > 0) return "trigger_variable_unsupported";
  return null;
}

/**
 * The identity of the *fact*, not of the attempt.
 *
 * `order:<uuid>` is stable across a replayed sync event, two terminals bumping
 * different lines of one ticket, and an operator retrying. That stability is
 * what the send log's UNIQUE constraint turns into "one message, once".
 */
export function triggerEventKey(trigger: ManagedLookupTrigger, subjectId: string): string {
  const prefix = trigger === "order_ready" ? "order" : "payment";
  return `${prefix}:${subjectId}`;
}

/**
 * The facts a *sample* event would carry, for the tenant's preview only.
 *
 * Issue #902 §9 item 0 asks for "a tenant preview of a trigger's exact text
 * before enabling it". The point of the word *exact* is that the preview must
 * come from the same renderer the send uses: a hand-written example on the
 * screen can disagree with the message that actually goes out, and the tenant
 * would only find out from a customer. So the preview runs
 * `triggerValues` → `renderTemplateTokens`, the two functions the dispatcher
 * runs, over obviously-fake values.
 *
 * The values are fake on purpose — «سارا محمدی», a 250,000 Rial payment — so the
 * preview is never mistaken for a real customer's message, and they are the same
 * samples the message library already renders on the console.
 */
export const TRIGGER_SAMPLE_FACTS: TriggerFactsByKind = {
  order_ready: {
    customerName: "سارا محمدی",
    storeName: "فروشگاه نمونه",
    orderNumber: 1042,
  },
  payment_received: {
    amountRial: 250_000,
    storeName: "فروشگاه نمونه",
    receivedAt: new Date("2026-10-28T09:30:00.000Z"),
  },
};

/**
 * The message this template would produce for this trigger, with sample facts.
 *
 * `null` when the template cannot be rendered for the event — a declared
 * variable the event cannot fill, or a body that fails validation. A caller
 * must render nothing rather than an empty string: an empty preview reads as
 * "the message is blank", which is a different and much more alarming claim
 * than "this pair does not fit".
 */
export function previewTriggerMessage(input: {
  trigger: ManagedLookupTrigger;
  body: string;
  declared: readonly TemplateVariable[];
}): string | null {
  const values = triggerValues(input.trigger, TRIGGER_SAMPLE_FACTS[input.trigger], input.declared);
  const rendered = renderTemplateTokens({
    body: input.body,
    variables: input.declared,
    values,
  });
  return rendered.ok ? rendered.preview : null;
}

/**
 * The refusal codes a tenant may read, in first-party words.
 *
 * A send log is only useful if the tenant can act on what it says. These codes
 * are the platform's own (`kavenegar_lookup_trigger_sends.code`), never provider
 * text — the supplier's vocabulary stays on the console — and a code this map
 * does not know is shown as a generic sentence rather than as the raw string,
 * because a future code is not an excuse to leak internals into a tenant screen.
 */
export const TRIGGER_CODE_LABELS: Record<string, string> = {
  no_consent: "مشتری اجازهٔ دریافت پیامک نداده است",
  no_customer: "این سفارش مشتری ثبت‌شده ندارد",
  missing_phone: "شمارهٔ موبایل مشتری ثبت نشده است",
  trigger_disabled: "این اطلاع‌رسانی خاموش بود",
  template_not_approved: "پیام انتخاب‌شده تأیید نشده است",
  insufficient_credit: "اعتبار کیف پول کافی نبود",
  wallet_empty: "اعتبار کیف پول کافی نبود",
  delivery_failed: "ارسال ناموفق بود",
  unknown_outcome: "نتیجهٔ ارسال نامشخص است",
};

/** A first-party sentence for a stored code; never the raw code. */
export function triggerCodeLabel(code: string | null): string | null {
  if (!code) return null;
  return TRIGGER_CODE_LABELS[code] ?? "پیام ارسال نشد";
}
