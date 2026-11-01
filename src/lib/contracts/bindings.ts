/**
 * Issue #908 — the VARIABLE CATALOGUE and its resolver.
 *
 * A contract field may be a literal the sender types, or a binding to a record
 * the business already owns: the project this contract delivers, the
 * counterparty on it, the contract row itself, or the business's own identity.
 * Binding is what stops a manager re-typing the project name, the counterparty
 * and the value — and getting one of the three wrong — into a document that
 * somebody will sign.
 *
 * Three rules hold the whole thing together:
 *
 *  1. **The catalogue is closed.** `path` is never free text from the client:
 *     `normalizeContractContent` accepts any `source`/`path` pair, but
 *     `resolveBindings` only honours pairs listed in `CONTRACT_BINDING_CATALOGUE`
 *     and reports the rest as `field_binding_unsupported`. A tenant can
 *     therefore never widen what a contract may read about a customer.
 *  2. **Provenance is visible.** Every resolved value comes back with where it
 *     came from (`binding`/`override`/`literal`/`empty`), so the editor can show
 *     «از پروژه» beside it and mark a manual override — the epic's "visible
 *     source lineage". A manual override is a normal, permitted act; it is
 *     never silent.
 *  3. **Stale values are surfaced, not repaired.** When a bound record changes
 *     after a draft was reviewed, re-resolving simply produces the new value,
 *     and `changedBindings` reports which keys moved. A frozen version never
 *     re-resolves at all — that is the point of freezing.
 *
 * Pure by construction: the caller loads the rows and passes a plain context.
 */
import {
  referencedTokens,
  CONTRACT_BINDING_SOURCES,
  type ContractBindingSource,
  type ContractDocumentContent,
  type ContractField,
  type ContractFieldType,
} from "./blocks";

export interface ContractBindingEntry {
  source: ContractBindingSource;
  path: string;
  label: string;
  /** The field type a binding of this shape should default to in the inspector. */
  type: ContractFieldType;
  /** Persian name of the group, for the searchable variable library. */
  group: string;
}

/**
 * Every binding the product offers.
 *
 * Deliberately short. Each entry is a value a contract demonstrably needs
 * (parties, dates, amounts, identity) and each one is already visible to anyone
 * who may read the contract itself. Adding a path here is a product decision
 * about what a signed document may disclose, not a convenience.
 */
export const CONTRACT_BINDING_CATALOGUE: readonly ContractBindingEntry[] = [
  { source: "contract", path: "title", label: "عنوان قرارداد", type: "text", group: "قرارداد" },
  { source: "contract", path: "type", label: "نوع قرارداد", type: "text", group: "قرارداد" },
  { source: "contract", path: "value", label: "مبلغ قرارداد", type: "money", group: "قرارداد" },
  { source: "contract", path: "start_date", label: "تاریخ شروع", type: "date", group: "قرارداد" },
  { source: "contract", path: "end_date", label: "تاریخ پایان", type: "date", group: "قرارداد" },
  { source: "contract", path: "today", label: "تاریخ امروز", type: "date", group: "قرارداد" },
  { source: "project", path: "name", label: "نام پروژه", type: "text", group: "پروژه" },
  { source: "project", path: "description", label: "شرح پروژه", type: "multiline", group: "پروژه" },
  { source: "project", path: "start_date", label: "شروع پروژه", type: "date", group: "پروژه" },
  { source: "project", path: "end_date", label: "پایان پروژه", type: "date", group: "پروژه" },
  { source: "project", path: "party_name", label: "کارفرمای پروژه", type: "text", group: "پروژه" },
  { source: "party", path: "name", label: "نام طرف حساب", type: "text", group: "طرف حساب" },
  { source: "party", path: "role", label: "نقش طرف حساب", type: "text", group: "طرف حساب" },
  { source: "party", path: "phone", label: "تلفن طرف حساب", type: "text", group: "طرف حساب" },
  { source: "party", path: "national_id", label: "کد ملی / شناسهٔ ملی", type: "text", group: "طرف حساب" },
  { source: "business", path: "name", label: "نام کسب‌وکار", type: "text", group: "کسب‌وکار" },
  { source: "business", path: "phone", label: "تلفن کسب‌وکار", type: "text", group: "کسب‌وکار" },
  { source: "business", path: "address", label: "نشانی کسب‌وکار", type: "multiline", group: "کسب‌وکار" },
] as const;

const CATALOGUE_KEYS = new Set(
  CONTRACT_BINDING_CATALOGUE.map((entry) => `${entry.source}.${entry.path}`),
);

export function bindingSupported(binding: { source: string; path: string } | null): boolean {
  return binding ? CATALOGUE_KEYS.has(`${binding.source}.${binding.path}`) : false;
}

export function bindingLabel(binding: { source: string; path: string } | null): string | null {
  if (!binding) return null;
  const entry = CONTRACT_BINDING_CATALOGUE.find(
    (candidate) => candidate.source === binding.source && candidate.path === binding.path,
  );
  return entry ? `${entry.group} · ${entry.label}` : null;
}

/** Grouped for the inspector's picker, in catalogue order. */
export function bindingGroups(): { group: string; entries: ContractBindingEntry[] }[] {
  const groups: { group: string; entries: ContractBindingEntry[] }[] = [];
  for (const entry of CONTRACT_BINDING_CATALOGUE) {
    const existing = groups.find((candidate) => candidate.group === entry.group);
    if (existing) existing.entries.push(entry);
    else groups.push({ group: entry.group, entries: [entry] });
  }
  return groups;
}

/**
 * The records a document may read. Raw values, unformatted: formatting depends
 * on the business's display unit and happens once, in `resolveBindings`.
 */
export interface ContractBindingContext {
  contract: {
    title: string;
    contractType: string;
    contractTypeLabel: string;
    valueRial: number | null;
    startDate: string | null;
    endDate: string | null;
    today: string;
  };
  project: {
    name: string;
    description: string;
    startDate: string | null;
    endDate: string | null;
    partyName: string;
  } | null;
  party: {
    name: string;
    role: string;
    phone: string;
    nationalId: string;
  } | null;
  business: { name: string; phone: string; address: string };
}

/** An empty context — the shape a blank document validates against. */
export function emptyBindingContext(contractTitle = "", today = ""): ContractBindingContext {
  return {
    contract: {
      title: contractTitle,
      contractType: "other",
      contractTypeLabel: "",
      valueRial: null,
      startDate: null,
      endDate: null,
      today,
    },
    project: null,
    party: null,
    business: { name: "", phone: "", address: "" },
  };
}

export type ContractValueProvenance = "binding" | "override" | "literal" | "empty";

export interface ResolvedContractField {
  key: string;
  value: string;
  provenance: ContractValueProvenance;
  /** The value the binding alone would give, when it differs from `value`. */
  boundValue: string | null;
  bindingSupported: boolean;
}

export interface ResolvedContractValues {
  values: Record<string, string>;
  fields: ResolvedContractField[];
  /** Keys whose `{{token}}` has no definition at all. */
  undefinedTokens: string[];
}

function formatIsoAsDisplay(iso: string, formatDate?: (iso: string) => string): string {
  return formatDate ? formatDate(iso) : iso;
}

/**
 * Resolve every field of a document against its context.
 *
 * The precedent order is: a manual value wins when the field has no binding
 * (a literal), and wins as an OVERRIDE when it does (and says so). An
 * unavailable record — a contract with no project, a deleted party — resolves
 * to an empty string and shows up as `empty`, never as an error page: a
 * framework contract legitimately has no project.
 */
export function resolveBindings(
  content: ContractDocumentContent,
  context: ContractBindingContext,
  formatters: {
    formatMoney?: (rial: string) => string;
    formatDate?: (iso: string) => string;
  } = {},
): ResolvedContractValues {
  const values: Record<string, string> = {};
  const fields: ResolvedContractField[] = [];

  for (const field of content.fields) {
    const bound = boundValue(field, context, formatters);
    const manual = field.value.trim();
    let provenance: ContractValueProvenance = "empty";
    let value = "";
    if (bound !== null) {
      if (manual) {
        provenance = "override";
        value = manual;
      } else {
        provenance = bound ? "binding" : "empty";
        value = bound;
      }
    } else if (manual) {
      provenance = "literal";
      value = manual;
    } else if (field.type === "checkbox") {
      provenance = "literal";
      value = "false";
    }
    values[field.key] = value;
    fields.push({
      key: field.key,
      value,
      provenance,
      boundValue: bound,
      bindingSupported: field.binding === null || bindingSupported(field.binding),
    });
  }

  const defined = new Set(content.fields.map((field) => field.key));
  const undefinedTokens = referencedTokens(content).filter((key) => !defined.has(key));

  return { values, fields, undefinedTokens };
}

function boundValue(
  field: ContractField,
  context: ContractBindingContext,
  formatters: { formatMoney?: (rial: string) => string; formatDate?: (iso: string) => string },
): string | null {
  if (!field.binding) return null;
  if (!bindingSupported(field.binding)) return null;
  const { source, path } = field.binding;

  const pick = (): string => {
    if (source === "contract") {
      switch (path) {
        case "title":
          return context.contract.title;
        case "type":
          return context.contract.contractTypeLabel || context.contract.contractType;
        case "value":
          return context.contract.valueRial === null ? "" : String(context.contract.valueRial);
        case "start_date":
          return context.contract.startDate ?? "";
        case "end_date":
          return context.contract.endDate ?? "";
        case "today":
          return context.contract.today;
        default:
          return "";
      }
    }
    if (source === "project") {
      if (!context.project) return "";
      switch (path) {
        case "name":
          return context.project.name;
        case "description":
          return context.project.description;
        case "start_date":
          return context.project.startDate ?? "";
        case "end_date":
          return context.project.endDate ?? "";
        case "party_name":
          return context.project.partyName;
        default:
          return "";
      }
    }
    if (source === "party") {
      if (!context.party) return "";
      switch (path) {
        case "name":
          return context.party.name;
        case "role":
          return context.party.role;
        case "phone":
          return context.party.phone;
        case "national_id":
          return context.party.nationalId;
        default:
          return "";
      }
    }
    if (source === "business") {
      switch (path) {
        case "name":
          return context.business.name;
        case "phone":
          return context.business.phone;
        case "address":
          return context.business.address;
        default:
          return "";
      }
    }
    return "";
  };

  const raw = pick().trim();
  if (!raw) return "";
  if (field.type === "money" && formatters.formatMoney && /^\d+$/.test(raw)) {
    return formatters.formatMoney(raw);
  }
  if (field.type === "date") {
    return formatIsoAsDisplay(raw, formatters.formatDate);
  }
  return raw;
}

/**
 * Which bound values moved between two resolutions — the "stale source" notice
 * in the editor, and the check that refuses to send a frozen copy whose sources
 * changed after review (the epic's «detected stale source values»).
 */
export function changedBindings(
  previous: Readonly<Record<string, string>>,
  next: Readonly<Record<string, string>>,
): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].filter((key) => (previous[key] ?? "") !== (next[key] ?? ""));
}

/** True when a source/path pair is a valid `CONTRACT_BINDING_SOURCES` value. */
export function isBindingSource(value: string): value is ContractBindingSource {
  return (CONTRACT_BINDING_SOURCES as readonly string[]).includes(value);
}
