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
import type { TemplateVariable, TemplateValues } from "./template-variables";

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
