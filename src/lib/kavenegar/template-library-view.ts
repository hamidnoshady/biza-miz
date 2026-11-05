/**
 * Issue #902 §5 — the platform's message library, as a tenant is allowed to
 * read it.
 *
 * `tenantTemplateLibrary` (`master-template-service.ts`) answers the database
 * question: which entries are offered to this business's trade and plan, and
 * which of them it already copied. This module answers the *screen's* question,
 * and it is separate for one reason: everything here is copy a tenant reads, so
 * it is the place where "no supplier vocabulary" is decided once instead of in
 * a component.
 *
 * Three things a person needs in order to choose a message honestly:
 *
 *   1. **What it will say.** The sample is rendered by the same renderer that
 *      fills a real send (`renderTemplateSample`), so a preview cannot promise
 *      formatting the send does not produce.
 *   2. **What it needs.** Each declared variable with its Persian name, because
 *      «%token2» is a template's notation, not a person's.
 *   3. **What it can be used for.** Which of the business's automations this
 *      message can serve, computed by the same check that refuses a bad pairing
 *      at send time (`checkTriggerTemplate`) — so the screen never offers a
 *      pairing the server would reject.
 *
 * Nothing here names the provider, its template ids or its approval states: an
 * entry is «آمادهٔ افزودن» or it is not offered at all.
 */
import {
  MANAGED_LOOKUP_TRIGGERS,
  TRIGGER_LABELS,
  checkTriggerTemplate,
  type ManagedLookupTrigger,
} from "./lookup-trigger-facts";
import { isTemplateVariable, type TemplateVariable } from "./template-variables";

/** First-party names for the domain variables a template may declare. */
export const VARIABLE_LABELS: Record<TemplateVariable, string> = {
  code: "کد تأیید",
  customer_name: "نام مشتری",
  store_name: "نام کسب‌وکار",
  order_number: "شمارهٔ سفارش",
  amount: "مبلغ (ریال)",
  date: "تاریخ",
};

/** One declared variable, in the words a business owner would use. */
export interface LibraryVariableView {
  name: TemplateVariable;
  label: string;
}

/** What the tenant screen renders for one library entry. */
export interface LibraryEntryView {
  id: string;
  title: string;
  /** Persian name of the message's purpose. */
  purposeLabel: string;
  /** The body with sample values in it — what the customer will actually read. */
  sample: string;
  variables: LibraryVariableView[];
  /** The business automations this message can serve. Empty means none yet. */
  triggers: { key: ManagedLookupTrigger; label: string }[];
  /** True when this business already has a copy in its own catalog. */
  alreadyAdded: boolean;
}

const PURPOSE_LABELS: Record<"verification" | "transactional", string> = {
  verification: "کد ورود یا تأیید",
  transactional: "اطلاع‌رسانی تراکنشی",
};

/**
 * Turn one database row into what the screen shows.
 *
 * A variable the closed vocabulary does not know is dropped rather than
 * rendered as its raw key: it cannot be filled by any event, and showing a
 * tenant `%token4` would be showing them our notation.
 */
export function libraryEntryView(entry: {
  id: string;
  title: string;
  purpose: "verification" | "transactional";
  sample: string;
  variables?: readonly string[];
  alreadyAdded: boolean;
}): LibraryEntryView {
  const declared = (entry.variables ?? []).filter(isTemplateVariable);
  return {
    id: entry.id,
    title: entry.title,
    purposeLabel: PURPOSE_LABELS[entry.purpose] ?? PURPOSE_LABELS.transactional,
    sample: entry.sample,
    variables: declared.map((name) => ({ name, label: VARIABLE_LABELS[name] })),
    triggers: declared.length
      ? MANAGED_LOOKUP_TRIGGERS.filter((trigger) => checkTriggerTemplate(trigger, declared) === null).map(
          (trigger) => ({ key: trigger, label: TRIGGER_LABELS[trigger] }),
        )
      : [],
    alreadyAdded: entry.alreadyAdded,
  };
}

/**
 * Group the library the way the screen offers it: what can be used now, and
 * what is already in the catalog.
 *
 * Kept as a function rather than two `.filter()` calls in JSX so the rule —
 * "an added entry stays visible, marked, so a person is not left wondering
 * whether the click worked" — is testable.
 */
export function splitLibrary(entries: readonly LibraryEntryView[]): {
  available: LibraryEntryView[];
  added: LibraryEntryView[];
} {
  return {
    available: entries.filter((entry) => !entry.alreadyAdded),
    added: entries.filter((entry) => entry.alreadyAdded),
  };
}
