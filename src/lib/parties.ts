/**
 * Parties — the one record for everyone the business keeps a ledger about.
 *
 * «شخص» (plural «اشخاص») is the word the product uses for *any* counterparty:
 * the customer who owes money, the supplier who is owed it, the employee whose
 * مساعده runs through حساب جاری کارکنان. They are three roles over one kind of
 * record — an identity, a place, a way to reach them, and the numbers that make
 * them settleable — so they get one table (`parties`, formerly `customers`),
 * one validation contract (this file) and one form. The app that *shows* them
 * differs (see `parties-scopes.ts`); the data does not.
 *
 * This module is the pure half of that contract — the same split
 * `industry-profile.ts` and `apps.ts` make: no `db`, no `next/`, no `"use
 * client"`, so the dashboard form, the REST route, the assistant's tools and a
 * vitest run all read the *same* rules and cannot drift. The DB half is
 * `parties-service.ts`.
 *
 * Two naming decisions worth stating before they are rediscovered:
 *
 *  - **`displayName` is the physical `name` column.** The wire name is
 *    `displayName` because a party may also carry `firstName`/`lastName`, and a
 *    legal person has no first name at all. `name` was renamed at the API
 *    boundary only: 80-odd queries across twelve services already read
 *    `c.name`, and a column rename that touches all of them buys nothing a
 *    mapper does not. The two never diverge — the service is the only writer.
 *  - **The nested tab objects are stored exactly as they are sent.** `general_info`,
 *    `address_info`, `contact_info` and `financial_info` are jsonb *documents*,
 *    not columns, so a future tab can add a key without a migration and an old
 *    client cannot lose a key it does not know about. `general_info` is the one
 *    the UI reads today, so its three known keys are validated and typed here.
 */

// The only import this module takes, and it keeps the same promise: `digits.ts`
// is pure string formatting with no imports of its own, so the contract stays
// runnable in a route, a client component and a bare vitest process alike.
import { normalizeNumericText } from "./digits";

/** The three roles a party can hold. The API and the form use these literals. */
export const PARTY_ROLES = ["Customer", "Employee", "Supplier"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];

/** The same three as stored in `parties.role` (lowercase, the repo's column dialect). */
export const PARTY_ROLE_STORAGE = {
  Customer: "customer",
  Employee: "employee",
  Supplier: "supplier",
} as const satisfies Record<PartyRole, string>;

export type PartyRoleStorage = (typeof PARTY_ROLE_STORAGE)[PartyRole];

/** Role → the label a Persian-speaking owner reads. One copy, so no screen retranslates it. */
export const PARTY_ROLE_LABELS: Record<PartyRole, string> = {
  Customer: "مشتری",
  Employee: "کارمند",
  Supplier: "تأمین‌کننده",
};

export const PARTY_ROLE_TAB_LABELS: Record<PartyRole, string> = {
  Customer: "مشتریان",
  Employee: "کارکنان",
  Supplier: "تأمین‌کنندگان",
};

/**
 * Parse a role from anywhere it arrives — the wire literal, the stored literal,
 * or nothing at all.
 *
 * Defaults to `Customer` rather than throwing: `parties.role` is read by screens
 * that only list (the POS picker, a segment), and a row written before this
 * column existed is a customer. A *write* rejects an unknown value outright —
 * see the `role` field in `PARTY_SCHEMA`.
 */
export function partyRole(value: unknown): PartyRole {
  if (typeof value !== "string") return "Customer";
  const trimmed = value.trim().toLowerCase();
  for (const role of PARTY_ROLES) {
    if (role.toLowerCase() === trimmed || PARTY_ROLE_STORAGE[role] === trimmed) return role;
  }
  return "Customer";
}

/**
 * Every role a party holds, normalised — the set, where `partyRole` answers
 * the scalar.
 *
 * Migration 0148 added `parties.roles`; the scalar `role` stays the *primary*
 * role (it decides the accounting-code prefix and the personnel link), and the
 * set is what the directory filters on. The invariant both ends keep is
 * `role ∈ roles`, so a caller that knows only one of the two still describes a
 * consistent record:
 *
 *  - given a set, the primary role is folded in;
 *  - given nothing, the answer is the primary role alone — which is exactly
 *    what every row written before 0148 holds.
 *
 * Sorted and de-duplicated so two callers that named the same roles in a
 * different order produce the same value (the DB trigger does the same, so a
 * round-trip is stable).
 */
export function partyRoles(value: unknown, primary?: unknown): PartyRole[] {
  const out: PartyRole[] = [];
  const push = (role: PartyRole) => {
    if (!out.includes(role)) out.push(role);
  };
  const read = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const trimmed = candidate.trim().toLowerCase();
    for (const role of PARTY_ROLES) {
      if (role.toLowerCase() === trimmed || PARTY_ROLE_STORAGE[role] === trimmed) push(role);
    }
  };
  if (Array.isArray(value)) for (const entry of value) read(entry);
  else read(value);
  // The primary role is a member of its own set, always — including when the
  // caller sent no set at all, which is the pre-0148 row.
  if (primary !== undefined) push(partyRole(primary));
  if (out.length === 0) push("Customer");
  return out.sort((a, b) => PARTY_ROLES.indexOf(a) - PARTY_ROLES.indexOf(b));
}

/**
 * The primary role of a set — the one that decides the accounting-code prefix.
 *
 * Not "the first one the caller typed": the prefixes are a numbering scheme a
 * business reads off a code (۱ مشتری، ۲ تأمین‌کننده، ۳ کارکنان), so when a
 * person holds several roles the record needs one stable answer. Customer wins
 * over supplier wins over employee, because that is the order a shop meets
 * them in and the order the existing codes were generated in.
 */
export function primaryPartyRole(roles: readonly PartyRole[], preferred?: unknown): PartyRole {
  const set = roles.length > 0 ? roles : (["Customer"] as PartyRole[]);
  if (preferred !== undefined) {
    const candidate = partyRole(preferred);
    if (set.includes(candidate)) return candidate;
  }
  for (const role of PARTY_ROLES) if (set.includes(role)) return role;
  return set[0];
}

/** "real" and "legal" person — the distinction that makes national ID vs. company registration apply at all. */
export const PARTY_PERSON_TYPES = ["Real", "Legal"] as const;
export type PartyPersonType = (typeof PARTY_PERSON_TYPES)[number];

export const PARTY_PERSON_TYPE_STORAGE = { Real: "real", Legal: "legal" } as const;
export type PartyPersonTypeStorage = (typeof PARTY_PERSON_TYPE_STORAGE)[PartyPersonType];

export const PARTY_PERSON_TYPE_LABELS: Record<PartyPersonType, string> = {
  Real: "حقیقی",
  Legal: "حقوقی",
};

export function partyPersonType(value: unknown): PartyPersonType {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    for (const personType of PARTY_PERSON_TYPES) {
      if (personType.toLowerCase() === trimmed || PARTY_PERSON_TYPE_STORAGE[personType] === trimmed) {
        return personType;
      }
    }
  }
  // A legal person is the exception, so the fallback is the ordinary case.
  return "Real";
}

/**
 * Who decides the party's accounting code.
 *
 * `Manual` is the "our chart of accounts already numbers this person" case — the
 * Holoo/WooCommerce migrations and any shop that migrated its coding scheme.
 * `Automatic` is the default, and the only one that may be left as-is on a fresh
 * record: the backend assigns the number on submission (see `nextAccountingCode`).
 */
export const ACCOUNTING_CODE_MODES = ["Automatic", "Manual"] as const;
export type AccountingCodeMode = (typeof ACCOUNTING_CODE_MODES)[number];

export const ACCOUNTING_CODE_MODE_LABELS: Record<AccountingCodeMode, string> = {
  Automatic: "خودکار",
  Manual: "دستی",
};

/** VAT rate a new party is assumed to carry until somebody says otherwise. */
export const DEFAULT_TAX_PERCENTAGE = 9;

/** Length caps. Mirrored by the form's `maxLength`s, enforced again by the route. */
export const MAX_PARTY_DISPLAY_NAME = 200;
export const MAX_PARTY_NAME_PART = 100;
export const MAX_PARTY_ACCOUNTING_CODE = 24;
export const MAX_PARTY_NOTES = 2000;
export const MAX_PARTY_TEXT_FIELD = 300;
/** ~300 KB of base64 — an avatar, not a scanned contract. Keeps one row off the 1 GB path. */
export const MAX_PROFILE_IMAGE_CHARS = 400_000;
export const MAX_TAB_JSON_CHARS = 16_000;

/** The tab documents. `general_info` is the only one with a required shape today. */
export interface PartyGeneralInfo {
  nationalId: string;
  economicCode: string;
  taxPercentage: number;
}

export interface PartyAddressInfo {
  province: string;
  city: string;
  street: string;
  zipCode: string;
  postalBox: string;
}

export interface PartyContactInfo {
  phone: string;
  mobile: string;
  email: string;
  website: string;
}

export interface PartyFinancialInfo {
  bankName: string;
  cardNumber: string;
  iban: string;
  accountNumber: string;
}

/**
 * The flat form state — what the inputs hold, before any of it is shaped into a
 * request. Deliberately all-strings (except the booleans/number) because an input
 * is a string and a `null` in a controlled input is the React bug this avoids.
 */
export interface PartyFormState {
  status: boolean;
  /**
   * The *primary* role — the accounting-code prefix, and what every service
   * that predates migration 0148 reads. Always a member of `roles`; the form
   * derives it rather than asking for it (see `withPartyRoles`).
   */
  role: PartyRole;
  /**
   * Every role this person holds. One record can be a customer *and* a
   * supplier — the ordinary case for a shop that buys from somebody it also
   * sells to — so the form offers checkboxes over this set, not one radio over
   * `role`.
   */
  roles: PartyRole[];
  accountingCodeMode: AccountingCodeMode;
  accountingCode: string;
  /**
   * An `https://` link, or (only for a row saved before migration 0181)
   * a legacy inline `data:` URL. A *new* avatar from this form always goes
   * through `profileImageAssetId` instead — see that field's own comment.
   */
  profileImage: string;
  /**
   * Migration 0181 — the canonical Media Library asset id for an uploaded
   * avatar, picked through the same `MediaPickerDialog` every catalogue item
   * photo uses. When set, it is authoritative and `profileImage` is cleared
   * on write (`parties-service.ts`'s `normalizePartyWrite` enforces this):
   * one party never carries both an asset-backed photo and an inline one at
   * the same time.
   */
  profileImageAssetId: string;
  personType: PartyPersonType;
  displayName: string;
  firstName: string;
  lastName: string;
  categoryId: string;
  notes: string;
  generalInfo: PartyGeneralInfo;
  addressInfo: PartyAddressInfo;
  contactInfo: PartyContactInfo;
  financialInfo: PartyFinancialInfo;
}

/** A draft id / the record being edited, carried alongside the state, never inside it. */
export interface PartyFormContext {
  partyId?: string | null;
  draftId?: string | null;
}

/**
 * The one place defaults are written. `resetPartyForm()` clones this, and the
 * API's PUT treats a missing tab as "leave it", so a form that starts here and a
 * record that was written five phases ago round-trip through the same values.
 */
export const PARTY_FORM_DEFAULTS: PartyFormState = {
  status: true,
  role: "Customer",
  roles: ["Customer"],
  accountingCodeMode: "Automatic",
  accountingCode: "",
  profileImage: "",
  profileImageAssetId: "",
  personType: "Real",
  displayName: "",
  firstName: "",
  lastName: "",
  categoryId: "",
  notes: "",
  generalInfo: { nationalId: "", economicCode: "", taxPercentage: DEFAULT_TAX_PERCENTAGE },
  addressInfo: { province: "", city: "", street: "", zipCode: "", postalBox: "" },
  contactInfo: { phone: "", mobile: "", email: "", website: "" },
  financialInfo: { bankName: "", cardNumber: "", iban: "", accountNumber: "" },
};

/**
 * A fresh form. Returns a new object graph (not a shared frozen constant) so the
 * caller can hand it straight to `setState` and every nested tab is writable.
 */
export function resetPartyForm(): PartyFormState {
  return {
    ...PARTY_FORM_DEFAULTS,
    roles: [...PARTY_FORM_DEFAULTS.roles],
    generalInfo: { ...PARTY_FORM_DEFAULTS.generalInfo },
    addressInfo: { ...PARTY_FORM_DEFAULTS.addressInfo },
    contactInfo: { ...PARTY_FORM_DEFAULTS.contactInfo },
    financialInfo: { ...PARTY_FORM_DEFAULTS.financialInfo },
  };
}

/**
 * Set the role set on a form state, and re-derive the primary role with it.
 *
 * The one place the two fields are changed together, so no screen can leave a
 * state whose `role` is not in its own `roles` — the invariant the API, the
 * service and the DB trigger all also keep. An empty set falls back to the
 * role the state already had, because "no role at all" is not a party.
 */
export function withPartyRoles(state: PartyFormState, roles: readonly PartyRole[]): PartyFormState {
  const next = partyRoles(roles.length > 0 ? roles : [state.role]);
  return { ...state, roles: next, role: primaryPartyRole(next, state.role) };
}

/** Whether this person holds a role — what a checkbox reads. */
export function hasPartyRole(state: Pick<PartyFormState, "roles">, role: PartyRole): boolean {
  return state.roles.includes(role);
}

/** Add or remove one role, keeping the last one from being removed. */
export function togglePartyRole(state: PartyFormState, role: PartyRole): PartyFormState {
  const next = state.roles.includes(role)
    ? state.roles.filter((entry) => entry !== role)
    : [...state.roles, role];
  // Refusing the last removal here rather than in the form means the API, the
  // assistant and a future client obey it too.
  return withPartyRoles(state, next.length > 0 ? next : state.roles);
}

// ---------------------------------------------------------------------------
// Iranian identity numbers
// ---------------------------------------------------------------------------

/** Digits only, Persian and Arabic-Indic digits folded to ASCII first. */
export function asciiDigits(value: unknown): string {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\D/g, "");
}

/**
 * Iranian national identity number (کد ملی): ten digits, last one a check digit.
 *
 * The weights run 10→2 over the first nine digits; the remainder of their sum by
 * 11 decides the tenth. `r < 2` means the check digit *is* the remainder,
 * otherwise it is `11 − r`. Repeated digits ("1111111111") pass that arithmetic,
 * so they are rejected by name — they are never issued, and accepting them turns
 * a typo into a plausible person.
 */
export function isValidIranianNationalId(value: unknown): boolean {
  const digits = asciiDigits(value);
  if (digits.length !== 10) return false;
  if (/^(\d)\1{9}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(digits[i]) * (10 - i);
  const remainder = sum % 11;
  const check = Number(digits[9]);
  return remainder < 2 ? check === remainder : check === 11 - remainder;
}

/**
 * Economic code (کد اقتصادی): eleven digits whose last is a check digit over a
 * fixed prime-weight ladder (29,27,23,19,17 twice). A remainder below 2 is not a
 * valid code at all — the issuer avoids it — so such a row is rejected rather
 * than silently accepted.
 */
export function isValidEconomicCode(value: unknown): boolean {
  const digits = asciiDigits(value);
  if (digits.length !== 11) return false;
  const weights = [29, 27, 23, 19, 17, 29, 27, 23, 19, 17];
  let sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(digits[i]) * weights[i];
  const remainder = sum % 11;
  if (remainder < 2) return false;
  return Number(digits[10]) === 11 - remainder;
}

/** Sheba (IR + 24 alphanumerics) — mod-97 with the ISO rearrangement. */
export function isValidIranianIban(value: unknown): boolean {
  const raw = String(value ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");
  if (!/^IR\d{24}$/.test(raw)) return false;
  const rearranged = raw.slice(4) + raw.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  // Long-digit mod by streaming the remainder: no BigInt, no 26-digit overflow.
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}

/** Card number (شبا not included): sixteen digits and a Luhn check. */
export function isValidCardNumber(value: unknown): boolean {
  const digits = asciiDigits(value);
  if (digits.length !== 16) return false;
  let sum = 0;
  for (let i = 0; i < 16; i += 1) {
    let d = Number(digits[15 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Iranian postal code: ten digits, the last four being the P.O. box. */
export function isValidPostalCode(value: unknown): boolean {
  return asciiDigits(value).length === 10 && /^[0-9]{10}$/.test(asciiDigits(value));
}

/** UUID — the shape every `*_id` column in this schema is. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/** An avatar is either a small image data URL or a URL that points at one. */
export function isProfileImageValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_PROFILE_IMAGE_CHARS) return false;
  if (/^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(raw)) return true;
  return /^https?:\/\/\S+$/i.test(raw);
}

// ---------------------------------------------------------------------------
// Accounting codes
// ---------------------------------------------------------------------------

/**
 * The hundreds digit is the ledger's own grouping: ۱ for accounts receivable
 * (customers), ۲ for accounts payable (suppliers), ۳ for the personnel
 * running account. A code therefore reads its role before it reads a lookup —
 * and the three sequences never collide, which is what lets one unique index
 * cover all three.
 */
export const ACCOUNTING_CODE_PREFIX: Record<PartyRole, string> = {
  Customer: "1",
  Supplier: "2",
  Employee: "3",
};

/** `Customer` + 7 → `100007`. */
export function formatAccountingCode(role: PartyRole, sequence: number): string {
  const n = Math.max(1, Math.floor(sequence));
  return `${ACCOUNTING_CODE_PREFIX[role]}${String(n).padStart(5, "0")}`;
}

/**
 * The next free code for a role, given the codes already taken in that business.
 *
 * Pure and sequence-of-rows based rather than `max()+1` in SQL because the caller
 * is inside the same transaction as the insert it is feeding: reading the current
 * codes is the serialisation point (`SELECT … FOR UPDATE` upstream), and a
 * database sequence would hand out holes on every rolled-back party.
 */
export function nextAccountingCode(role: PartyRole, existingCodes: readonly (string | null)[]): string {
  const prefix = ACCOUNTING_CODE_PREFIX[role];
  let max = 0;
  for (const code of existingCodes) {
    if (typeof code !== "string") continue;
    const trimmed = code.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const tail = Number(trimmed.slice(prefix.length));
    if (Number.isFinite(tail) && tail > max) max = tail;
  }
  return formatAccountingCode(role, max + 1);
}

/** A manual code has to survive being typed into a ledger, so: digits/letters/dashes, 1–24. */
export function isAccountingCodeShape(value: unknown): boolean {
  return typeof value === "string" && /^[0-9A-Za-z-]{1,24}$/.test(value.trim());
}

// ---------------------------------------------------------------------------
// The validation schema
// ---------------------------------------------------------------------------

/** What a field can be, decided once here so the form and the route agree. */
export type PartyFieldKind = "text" | "uuid" | "role" | "roleSet" | "personType" | "accountingMode" | "nationalId" | "economicCode" | "iban" | "cardNumber" | "postalCode" | "taxPercent" | "email" | "url" | "image";

export interface PartyFieldSpec {
  /** Dot path into `PartyFormState` — also the key the API reports errors under. */
  path: string;
  /** Persian label, so a 400 can name the field without the client re-deriving it. */
  label: string;
  kind: PartyFieldKind;
  maxLength?: number;
  /**
   * Conditional presence. `false` → the field is not validated and is dropped
   * from the payload; this is what makes `accountingCode` required *only* in
   * `Manual` mode without a second schema for it.
   */
  when?: (state: PartyFormState) => boolean;
  required?: boolean | ((state: PartyFormState) => boolean);
}

export const PARTY_SCHEMA: readonly PartyFieldSpec[] = [
  { path: "role", label: "نقش", kind: "role", required: true },
  // The full set. Validated as its own field so a 400 can name «نقش‌ها»
  // rather than blaming the primary role for a set the caller got wrong.
  { path: "roles", label: "نقش‌ها", kind: "roleSet", required: true },
  { path: "personType", label: "نوع شخص", kind: "personType", required: true },
  { path: "displayName", label: "نام نمایشی", kind: "text", maxLength: MAX_PARTY_DISPLAY_NAME, required: true },
  { path: "firstName", label: "نام", kind: "text", maxLength: MAX_PARTY_NAME_PART },
  { path: "lastName", label: "نام خانوادگی", kind: "text", maxLength: MAX_PARTY_NAME_PART },
  { path: "categoryId", label: "دسته‌بندی", kind: "uuid" },
  { path: "notes", label: "یادداشت", kind: "text", maxLength: MAX_PARTY_NOTES },
  { path: "profileImage", label: "تصویر پروفایل", kind: "image" },
  { path: "accountingCodeMode", label: "نوع کد حسابداری", kind: "accountingMode", required: true },
  {
    path: "accountingCode",
    label: "کد حسابداری",
    kind: "text",
    maxLength: MAX_PARTY_ACCOUNTING_CODE,
    required: true,
    when: (state) => state.accountingCodeMode === "Manual",
  },
  {
    path: "generalInfo.nationalId",
    label: "کد ملی",
    kind: "nationalId",
    // A legal person has no national ID; the company's registration stands in.
    when: (state) => state.personType === "Real",
  },
  { path: "generalInfo.economicCode", label: "کد اقتصادی", kind: "economicCode" },
  { path: "generalInfo.taxPercentage", label: "نرخ مالیات", kind: "taxPercent", required: true },
  { path: "contactInfo.phone", label: "تلفن ثابت", kind: "text", maxLength: 32 },
  { path: "contactInfo.mobile", label: "تلفن همراه", kind: "text", maxLength: 32 },
  { path: "contactInfo.email", label: "پست الکترونیکی", kind: "email" },
  { path: "contactInfo.website", label: "وب‌سایت", kind: "url" },
  { path: "addressInfo.province", label: "استان", kind: "text", maxLength: 100 },
  { path: "addressInfo.city", label: "شهر", kind: "text", maxLength: 100 },
  { path: "addressInfo.street", label: "نشانی", kind: "text", maxLength: MAX_PARTY_TEXT_FIELD },
  { path: "addressInfo.zipCode", label: "کد پستی", kind: "postalCode" },
  { path: "addressInfo.postalBox", label: "صندوق پستی", kind: "text", maxLength: 20 },
  { path: "financialInfo.bankName", label: "نام بانک", kind: "text", maxLength: 100 },
  { path: "financialInfo.cardNumber", label: "شماره کارت", kind: "cardNumber" },
  { path: "financialInfo.iban", label: "شبا", kind: "iban" },
  { path: "financialInfo.accountNumber", label: "شماره حساب", kind: "text", maxLength: 40 },
];

/** Error codes are data: the API returns them, the client translates them. */
export const PARTY_FIELD_ERROR_MESSAGES: Record<string, string> = {
  required: "این فیلد الزامی است.",
  too_long: "طول این فیلد بیش از حد مجاز است.",
  invalid_role: "نقش انتخابی معتبر نیست.",
  role_required: "دست‌کم یک نقش باید انتخاب شود.",
  invalid_person_type: "نوع شخص باید حقیقی یا حقوقی باشد.",
  invalid_code_mode: "نوع کد حسابداری باید خودکار یا دستی باشد.",
  invalid_accounting_code: "کد حسابداری باید ۱ تا ۲۴ نویسه باشد (رقم، حرف لاتین یا خط تیره).",
  invalid_national_id: "کد ملی معتبر نیست (۱۰ رقم با رقم کنترلی صحیح).",
  invalid_economic_code: "کد اقتصادی معتبر نیست (۱۱ رقم با رقم کنترلی صحیح).",
  invalid_iban: "شبا معتبر نیست (IR به‌همراه ۲۴ رقم).",
  invalid_card_number: "شماره کارت معتبر نیست.",
  invalid_postal_code: "کد پستی باید ۱۰ رقم باشد.",
  invalid_tax_percent: "نرخ مالیات باید عددی بین ۰ تا ۱۰۰ باشد.",
  invalid_email: "پست الکترونیکی معتبر نیست.",
  invalid_url: "نشانی وب‌سایت معتبر نیست.",
  invalid_image: "تصویر پروفایل باید یک فایل تصویر یا نشانی آن باشد.",
  invalid_uuid: "شناسه انتخابی معتبر نیست.",
};

/** Field path → error code. The form renders it under the input; the API echoes it back. */
export type PartyFieldErrors = Record<string, string>;

function readPath(state: PartyFormState, path: string): unknown {
  const [head, tail] = path.split(".");
  if (tail === undefined) return (state as unknown as Record<string, unknown>)[head];
  const group = (state as unknown as Record<string, Record<string, unknown> | undefined>)[head];
  return group ? group[tail] : undefined;
}

/**
 * The schema plus the two rules no per-field check can express: a legal person
 * must not carry a national ID, and an inactive party cannot be created from a
 * draft that was started as an active one without saying so.
 *
 * Returns `{}` when the state is submittable.
 */
export function validatePartyForm(state: PartyFormState): PartyFieldErrors {
  const errors: PartyFieldErrors = {};

  for (const field of PARTY_SCHEMA) {
    if (field.when && !field.when(state)) continue;
    const raw = readPath(state, field.path);

    if (field.kind === "roleSet") {
      const value = Array.isArray(raw) ? raw : [];
      const known = value.every((entry) => (PARTY_ROLES as readonly string[]).includes(String(entry)));
      // A party with no role is not a party; a party with an unknown one is a
      // bug in the caller, not a default.
      if (value.length === 0) errors[field.path] = "required";
      else if (!known) errors[field.path] = "invalid_role";
      else if (!value.includes(state.role)) errors[field.path] = "invalid_role";
      continue;
    }

    if (field.kind === "taxPercent") {
      /*
       * Validated exactly the way it is coerced.
       *
       * This read the text through `asciiDigits` too, so it disagreed with
       * `taxPercentageOf` about the same string: «۱۲٫۵» validated as `125`,
       * out of range, and the form refused a rate that is perfectly legal —
       * while «۹٫۵» validated as `95`, passed, and was then *stored* as 95%.
       * Asking the coercion means the answer the person sees and the number
       * that reaches the column can no longer differ.
       */
      const text = typeof raw === "number" ? String(raw) : normalizeNumericText(String(raw ?? ""));
      // Empty means «use the default», which `taxPercentageOf` supplies; it is
      // not a validation failure, or clearing the box would block the save.
      if (text && text !== "-" && text !== ".") {
        const value = Number(text);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          errors[field.path] = "invalid_tax_percent";
        }
      }
      continue;
    }

    const value = String(raw ?? "").trim();
    const required =
      typeof field.required === "function" ? field.required(state) : field.required === true;
    if (value.length === 0) {
      if (required) errors[field.path] = "required";
      continue;
    }
    if (field.maxLength && value.length > field.maxLength) {
      errors[field.path] = "too_long";
      continue;
    }

    const invalid = (code: string) => {
      errors[field.path] = code;
    };
    switch (field.kind) {
      case "role":
        if (!(PARTY_ROLES as readonly string[]).includes(value)) invalid("invalid_role");
        break;
      case "personType":
        if (!(PARTY_PERSON_TYPES as readonly string[]).includes(value)) invalid("invalid_person_type");
        break;
      case "accountingMode":
        if (!(ACCOUNTING_CODE_MODES as readonly string[]).includes(value)) invalid("invalid_code_mode");
        break;
      case "uuid":
        if (!isUuid(value)) invalid("invalid_uuid");
        break;
      case "nationalId":
        if (!isValidIranianNationalId(value)) invalid("invalid_national_id");
        break;
      case "economicCode":
        if (!isValidEconomicCode(value)) invalid("invalid_economic_code");
        break;
      case "iban":
        if (!isValidIranianIban(value)) invalid("invalid_iban");
        break;
      case "cardNumber":
        if (!isValidCardNumber(value)) invalid("invalid_card_number");
        break;
      case "postalCode":
        if (!isValidPostalCode(value)) invalid("invalid_postal_code");
        break;
      case "email":
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) invalid("invalid_email");
        break;
      case "url":
        if (!/^https?:\/\/[^\s]+$/i.test(value)) invalid("invalid_url");
        break;
      case "image":
        if (!isProfileImageValue(value)) invalid("invalid_image");
        break;
      case "text":
        // The one text field with a shape of its own, because the ledger reads it.
        if (field.path === "accountingCode" && !isAccountingCodeShape(value)) invalid("invalid_accounting_code");
        break;
    }
  }

  // A legal person's identity is its registration number, not a کد ملی. Keeping
  // this here rather than in the form means the assistant and the REST API obey it too.
  if (state.personType === "Legal" && String(state.generalInfo.nationalId ?? "").trim() !== "") {
    errors["generalInfo.nationalId"] = "invalid_national_id";
  }

  return errors;
}

export function partyFieldErrorMessage(code: string | undefined): string {
  return PARTY_FIELD_ERROR_MESSAGES[code ?? ""] ?? PARTY_FIELD_ERROR_MESSAGES.required;
}

// ---------------------------------------------------------------------------
// Payload building
// ---------------------------------------------------------------------------

/**
 * The name a row is listed under.
 *
 * The form makes `displayName` required, but the party created from the POS, the
 * invoice screen or an import has first/last only — so the *derived* name is what
 * both validation and submission use, and the two can never disagree.
 */
export function deriveDisplayName(state: Pick<PartyFormState, "displayName" | "firstName" | "lastName">): string {
  const explicit = String(state.displayName ?? "").trim();
  if (explicit) return explicit;
  return [String(state.firstName ?? "").trim(), String(state.lastName ?? "").trim()]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** The REST body: root fields flat, every tab its own nested object. */
export interface PartyPayload {
  status: boolean;
  /** The primary role — the accounting-code prefix, and every pre-0148 reader. */
  role: PartyRole;
  /** Every role this person holds; `role` is always one of them. */
  roles: PartyRole[];
  personType: PartyPersonType;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  categoryId: string | null;
  accountingCodeMode: AccountingCodeMode;
  /** Sent only in `Manual` mode. In `Automatic` mode the backend assigns it. */
  accountingCode: string | null;
  profileImage: string | null;
  /** Migration 0181. Sent alongside `profileImage`; the server decides precedence. */
  profileImageAssetId: string | null;
  notes: string | null;
  general_info: {
    nationalId: string | null;
    economicCode: string | null;
    taxPercentage: number;
  } & Record<string, unknown>;
  address_info: Record<string, unknown>;
  contact_info: Record<string, unknown>;
  financial_info: Record<string, unknown>;
}

function trimmedOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/** Drop the empty strings: an absent key means "no value", not "". */
function compactTab<T extends Record<string, unknown>>(tab: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tab)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

/**
 * Flat form state → structured REST payload.
 *
 * Tabs are emitted even when empty (`{}`) so the route can tell "the address tab
 * was cleared" from "this client predates the address tab": the service treats an
 * *absent* key as leave-alone and an empty object as cleared.
 */
export function buildPartyPayload(state: PartyFormState): PartyPayload {
  const manual = state.accountingCodeMode === "Manual";
  // Derived rather than trusted: a draft written before the role set existed,
  // or a caller that only set `role`, still produces a consistent pair.
  const roles = partyRoles(state.roles, state.role);
  return {
    status: state.status !== false,
    role: primaryPartyRole(roles, state.role),
    roles,
    personType: partyPersonType(state.personType),
    displayName: deriveDisplayName(state).slice(0, MAX_PARTY_DISPLAY_NAME),
    firstName: trimmedOrNull(state.firstName)?.slice(0, MAX_PARTY_NAME_PART) ?? null,
    lastName: trimmedOrNull(state.lastName)?.slice(0, MAX_PARTY_NAME_PART) ?? null,
    categoryId: isUuid(state.categoryId) ? state.categoryId.trim() : null,
    accountingCodeMode: manual ? "Manual" : "Automatic",
    accountingCode: manual ? trimmedOrNull(state.accountingCode) : null,
    profileImage: trimmedOrNull(state.profileImage),
    profileImageAssetId: isUuid(state.profileImageAssetId) ? state.profileImageAssetId.trim() : null,
    notes: trimmedOrNull(state.notes)?.slice(0, MAX_PARTY_NOTES) ?? null,
    general_info: {
      nationalId: state.personType === "Real" ? trimmedOrNull(state.generalInfo.nationalId) : null,
      economicCode: trimmedOrNull(state.generalInfo.economicCode),
      // Always sent: 9 is the assumption the whole platform makes, and an
      // explicit 9 is what lets the ledger distinguish "unset" from "set to 9".
      taxPercentage: taxPercentageOf(state),
    },
    address_info: compactTab({ ...state.addressInfo }),
    contact_info: compactTab({ ...state.contactInfo }),
    financial_info: compactTab({ ...state.financialInfo }),
  };
}

/**
 * The payload for a scope that shows the ledger's numbers read-only (or hides
 * them): everything `buildPartyPayload` emits except the keys the route gates
 * on `ledger.view` — the accounting code and its mode, the tax rate and the
 * bank tab. The identity numbers stay: they are «who the person is», writable
 * with `parties.manage` alone.
 *
 * An omitted key means «leave it» on the server, so a form that never let the
 * member type a tax rate sends nothing for it, and a cashier's save no longer
 * round-trips its way into a 403.
 */
export type NonAccountingPartyPayload = Omit<
  PartyPayload,
  "accountingCode" | "accountingCodeMode" | "financial_info" | "general_info"
> & {
  general_info: {
    nationalId: string | null;
    economicCode: string | null;
  } & Record<string, unknown>;
};

export function buildNonAccountingPayload(state: PartyFormState): NonAccountingPartyPayload {
  const full = buildPartyPayload(state);
  const { accountingCode: _code, accountingCodeMode: _mode, financial_info: _bank, ...rest } = full;
  void _code;
  void _mode;
  void _bank;
  const { taxPercentage: _tax, ...general } = full.general_info;
  void _tax;
  return { ...rest, general_info: general };
}

/**
 * Coerced so a half-typed form can never post `NaN` into a jsonb column.
 *
 * Takes the loose shape rather than `PartyGeneralInfo` because both callers are
 * mid-parse: the form has a string from an input, and the service has whatever a
 * stored document held. Both are wrong in the same direction, so both get 9.
 *
 * Fractional rates are real and must survive this function. It used to read the
 * text through `asciiDigits`, which strips *every* non-digit — including the
 * decimal mark — so «۹٫۵» arrived as `95`: a rate inside the valid range, stored
 * without complaint, ten times what was typed and applied to that party's
 * invoices from then on. «۱۲٫۵» became `125`, failed the range check, and came
 * back as the 9% default instead, which at least was visible. `normalizeNumericText`
 * is the shared parser that understands both Persian «٫» and Arabic-Indic
 * digits, and it is what `PersianNumberInput` emits, so the form and the service
 * now read a rate the same way.
 */
export function taxPercentageOf(state: {
  generalInfo?: { taxPercentage?: unknown } | null;
}): number {
  const raw = state.generalInfo?.taxPercentage;
  // "unset" has to mean the default, because 0 is a rate a business really uses:
  // a party stored before this field existed, or one whose tab was written by an
  // importer that knew nothing about it, must not become tax-free on its first
  // re-save. An empty string is the same case, arriving from a cleared input.
  if (raw === undefined || raw === null) return DEFAULT_TAX_PERCENTAGE;
  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else {
    // Whitespace-only is a cleared field, not «۰»: `asciiDigits("  ")` was `""`
    // and `Number("")` is 0, which made a party accidentally tax-exempt.
    const text = normalizeNumericText(String(raw), { allowNegative: true });
    if (!text || text === "-" || text === ".") return DEFAULT_TAX_PERCENTAGE;
    value = Number(text);
  }
  if (!Number.isFinite(value) || value < 0 || value > 100) return DEFAULT_TAX_PERCENTAGE;
  // Two decimal places: enough for any published rate, and it keeps the stored
  // number free of binary-float tails like 9.299999999999999.
  return Math.round(value * 100) / 100;
}

/**
 * The API record (whatever `parties-service` returns) → form state, so editing a
 * party and loading a draft hydrate through the same function.
 */
export interface PartyApiRecord {
  id?: string;
  status?: boolean;
  isActive?: boolean;
  role?: string;
  /** Migration 0148. Absent on a record read by a client older than it. */
  roles?: string[] | null;
  personType?: string;
  displayName?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  categoryId?: string | null;
  accountingCodeMode?: string;
  accountingCode?: string | null;
  profileImage?: string | null;
  /** Migration 0181. */
  profileImageAssetId?: string | null;
  notes?: string | null;
  /**
   * The canonical contact columns. `parties-service` mirrors them from the contact
   * tab on write and reads them back beside it, so a client that has no tabs (the
   * POS's picker, an older saved draft) still finds the phone number — and so the
   * form's hydration does not have to reach through a cast to get them.
   */
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  generalInfo?: Partial<PartyGeneralInfo> | null;
  addressInfo?: Partial<PartyAddressInfo> | null;
  contactInfo?: Partial<PartyContactInfo> | null;
  financialInfo?: Partial<PartyFinancialInfo> | null;
}

export function formStateFromParty(party: PartyApiRecord | null | undefined): PartyFormState {
  const state = resetPartyForm();
  if (!party) return state;
  state.status = party.status ?? party.isActive ?? true;
  state.roles = partyRoles(party.roles, party.role);
  state.role = primaryPartyRole(state.roles, party.role);
  state.personType = partyPersonType(party.personType);
  state.displayName = party.displayName ?? party.name ?? "";
  state.firstName = party.firstName ?? "";
  state.lastName = party.lastName ?? "";
  state.categoryId = party.categoryId ?? "";
  state.accountingCodeMode = (ACCOUNTING_CODE_MODES as readonly string[]).includes(String(party.accountingCodeMode))
    ? (party.accountingCodeMode as AccountingCodeMode)
    : "Automatic";
  state.accountingCode = party.accountingCode ?? "";
  state.profileImage = party.profileImage ?? "";
  state.profileImageAssetId = party.profileImageAssetId ?? "";
  state.notes = party.notes ?? "";
  state.generalInfo = {
    nationalId: party.generalInfo?.nationalId ?? "",
    economicCode: party.generalInfo?.economicCode ?? "",
    taxPercentage:
      typeof party.generalInfo?.taxPercentage === "number"
        ? party.generalInfo.taxPercentage
        : DEFAULT_TAX_PERCENTAGE,
  };
  state.addressInfo = mergeTab(state.addressInfo, party.addressInfo);
  state.contactInfo = mergeTab(state.contactInfo, party.contactInfo);
  state.financialInfo = mergeTab(state.financialInfo, party.financialInfo);
  // The root columns are the canonical ones the POS and the ledger read; the
  // contact tab mirrors them so the form shows what is actually stored.
  const contact = party.contactInfo ?? {};
  if (!contact.phone && !contact.mobile) {
    state.contactInfo = {
      ...state.contactInfo,
      mobile: partyRootPhone(party) ?? "",
      email: partyRootEmail(party) ?? "",
    };
  }
  if (!state.addressInfo.street) {
    state.addressInfo = { ...state.addressInfo, street: partyRootAddress(party) ?? "" };
  }
  return state;
}

/**
 * Merge a stored tab into the form's copy of it.
 *
 * `null` becomes `""` here rather than reaching an input: a tab written by an
 * importer can hold a real JSON null, and `value={null}` on a controlled input is
 * how a form silently becomes uneditable-looking-but-empty.
 */
function mergeTab<T extends object>(target: T, source: Record<string, unknown> | null | undefined): T {
  if (!source) return target;
  const out = { ...target } as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) out[key] = value ?? "";
  return out as T;
}

type PartyRootMirrors = PartyApiRecord & {
  phone?: string | null;
  email?: string | null;
  address?: string | null;
};

function partyRootPhone(party: PartyApiRecord): string | null {
  return (party as PartyRootMirrors).phone ?? null;
}
function partyRootEmail(party: PartyApiRecord): string | null {
  return (party as PartyRootMirrors).email ?? null;
}
function partyRootAddress(party: PartyApiRecord): string | null {
  return (party as PartyRootMirrors).address ?? null;
}

// ---------------------------------------------------------------------------
// Reading a request body
// ---------------------------------------------------------------------------

/** The write a request is asking for: only the keys it actually sent. */
export interface PartyWriteInput {
  status?: boolean;
  role?: string | null;
  roles?: string[] | null;
  personType?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  categoryId?: string | null;
  accountingCodeMode?: string | null;
  accountingCode?: string | null;
  profileImage?: string | null;
  /** Migration 0181. */
  profileImageAssetId?: string | null;
  notes?: string | null;
  generalInfo?: Record<string, unknown> | null;
  addressInfo?: Record<string, unknown> | null;
  contactInfo?: Record<string, unknown> | null;
  financialInfo?: Record<string, unknown> | null;
  employeeUserId?: string | null;
  /** Legacy root writes: the POS quick-add and every importer post these. */
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  tags?: string[];
  birthday?: string | null;
  marketingConsent?: boolean;
  smsConsent?: boolean;
}

export interface PartyParsedBody {
  /**
   * What to hand the service. Present-only by construction, which is what makes a
   * PATCH `{status: false}` archive an active party instead of wiping its address,
   * its phone and its notes — the failure a body-shaped-as-the-form would cause.
   */
  input: PartyWriteInput;
  /** The merged form state, so a caller can show the form on top of a partial body. */
  state: PartyFormState;
  errors: PartyFieldErrors;
}

const ROOT_STRING_FIELDS = [
  "displayName",
  "firstName",
  "lastName",
  "categoryId",
  "accountingCode",
  "profileImage",
  "notes",
  "phone",
  "email",
  "address",
  "birthday",
] as const;

const GENERAL_KEYS = ["nationalId", "economicCode", "taxPercentage"] as const;
const ADDRESS_KEYS = ["province", "city", "street", "zipCode", "postalBox"] as const;
const CONTACT_KEYS = ["phone", "mobile", "email", "website"] as const;
const FINANCIAL_KEYS = ["bankName", "cardNumber", "iban", "accountNumber"] as const;

function asTab(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Parse an untrusted request body into a write plus the field errors that explain
 * why it is not submittable yet.
 *
 * Two modes, because the platform has two kinds of caller:
 *
 *  - **full** (the party form's submit): every tab is sent, so every rule applies
 *    and a missing required field is an error.
 *  - **partial** (`PATCH`-shaped writes — the directory's archive toggle, a screen
 *    that only owns one field): a key the body does not mention is not a key the
 *    caller is clearing, so `required` is not asked of it. Format rules still
 *    apply to everything the body *did* send.
 *
 * The route owns the two decisions a form never makes: an unknown `role` is a bug
 * rather than a default, and a tab document must stay small — a jsonb column is not
 * a place to store a 40 MB paste.
 */
export function parsePartyRequestBody(
  body: unknown,
  options: { partial?: boolean } = {},
): PartyParsedBody {
  const raw = (body ?? {}) as Record<string, unknown>;
  const partial = options.partial === true;
  const errors: PartyFieldErrors = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(raw, key);
  const input: PartyWriteInput = {};
  const state = resetPartyForm();

  // --- scalars -------------------------------------------------------------
  if (has("status")) {
    const value = raw.status !== false && raw.status !== "false";
    input.status = value;
    state.status = value;
  }
  for (const field of ROOT_STRING_FIELDS) {
    if (!has(field)) continue;
    const value = String(raw[field] ?? "").trim();
    (input as Record<string, unknown>)[field] = value;
    if (field === "displayName" || field === "firstName" || field === "lastName" || field === "categoryId" || field === "accountingCode" || field === "profileImage" || field === "notes") {
      (state as unknown as Record<string, string>)[field] = value;
    }
  }
  if (has("tags") && Array.isArray(raw.tags)) {
    input.tags = (raw.tags as unknown[]).map((tag) => String(tag).trim()).filter(Boolean).slice(0, 40);
  }
  for (const flag of ["marketingConsent", "smsConsent"] as const) {
    if (has(flag)) (input as Record<string, unknown>)[flag] = raw[flag] === true;
  }

  // --- the three enums, each rejected rather than defaulted ---------------
  if (has("role")) {
    const value = String(raw.role ?? "").trim();
    if (!(PARTY_ROLES as readonly string[]).includes(value)) errors.role = "invalid_role";
    input.role = value;
    state.role = partyRole(value);
    if (!has("roles")) state.roles = partyRoles(state.role);
  }
  if (has("roles")) {
    const sent = Array.isArray(raw.roles) ? raw.roles : [];
    const known = sent.every((entry) => (PARTY_ROLES as readonly string[]).includes(String(entry).trim()));
    if (sent.length === 0) errors.roles = "role_required";
    else if (!known) errors.roles = "invalid_role";
    input.roles = sent.map((entry) => String(entry).trim());
    if (known && sent.length > 0) {
      state.roles = partyRoles(input.roles, has("role") ? raw.role : undefined);
      state.role = primaryPartyRole(state.roles, has("role") ? raw.role : undefined);
    }
  }
  if (has("personType")) {
    const value = String(raw.personType ?? "").trim();
    if (!(PARTY_PERSON_TYPES as readonly string[]).includes(value)) errors.personType = "invalid_person_type";
    input.personType = value;
    state.personType = partyPersonType(value);
  }
  if (has("accountingCodeMode")) {
    const value = String(raw.accountingCodeMode ?? "").trim();
    if (!(ACCOUNTING_CODE_MODES as readonly string[]).includes(value)) errors.accountingCodeMode = "invalid_code_mode";
    input.accountingCodeMode = value;
    state.accountingCodeMode = (ACCOUNTING_CODE_MODES as readonly string[]).includes(value)
      ? (value as AccountingCodeMode)
      : "Automatic";
  }
  if (has("employeeUserId")) input.employeeUserId = trimmedOrNull(raw.employeeUserId);
  if (has("profileImageAssetId")) {
    const value = trimmedOrNull(raw.profileImageAssetId);
    input.profileImageAssetId = value;
    state.profileImageAssetId = value ?? "";
  }

  // --- the tabs -------------------------------------------------------------
  const tabs = [
    { sent: ["general_info", "generalInfo"] as const, keys: GENERAL_KEYS, stateKey: "generalInfo" as const },
    { sent: ["address_info", "addressInfo"] as const, keys: ADDRESS_KEYS, stateKey: "addressInfo" as const },
    { sent: ["contact_info", "contactInfo"] as const, keys: CONTACT_KEYS, stateKey: "contactInfo" as const },
    { sent: ["financial_info", "financialInfo"] as const, keys: FINANCIAL_KEYS, stateKey: "financialInfo" as const },
  ];
  for (const tab of tabs) {
    const sentKey = tab.sent.find((key) => has(key));
    if (!sentKey) continue;
    const sent = asTab(raw[sentKey]);
    const out: Record<string, unknown> = {};
    for (const key of tab.keys) {
      if (!Object.prototype.hasOwnProperty.call(sent, key)) continue;
      const value = key === "taxPercentage" ? sent[key] : String(sent[key] ?? "").trim();
      out[key] = value;
      (state[tab.stateKey] as unknown as Record<string, unknown>)[key] = value;
    }
    // A key no tab on this platform knows about is still the caller's data — the
    // tab is a document, and refusing it would make a future tab a coordinated
    // release across every client. It is size-checked below all the same.
    for (const [key, value] of Object.entries(sent)) {
      if (!(tab.keys as readonly string[]).includes(key)) out[key] = value;
    }
    if (tab.stateKey === "generalInfo") {
      input.generalInfo = out;
    } else if (tab.stateKey === "addressInfo") {
      input.addressInfo = out;
    } else if (tab.stateKey === "contactInfo") {
      input.contactInfo = out;
    } else {
      input.financialInfo = out;
    }
    if (JSON.stringify(out).length > MAX_TAB_JSON_CHARS) {
      errors[sentKey === "generalInfo" ? "general_info" : sentKey] = "too_long";
    }
  }

  // --- root-level convenience keys ------------------------------------------
  //
  // The party form sends the nested shape above; other callers send the flat names
  // the old `customers` row had — the order screen adds «مشتری جدید» with
  // `{ name, phone }`, the Holoo importer maps its source columns to `email` and
  // `address`, and an AI edit names `notes` alone. They are accepted here and
  // written to the column that owns the value, so no caller has to be rewritten for
  // this change and none of them re-reads a tab it did not send. A caller that
  // *does* send the tab wins: these keys only fill a field the tabs left empty.
  if (!has("displayName") && has("name")) {
    const value = String(raw.name ?? "").trim();
    input.displayName = value;
    state.displayName = value;
  }
  const phoneKey = has("phone") ? "phone" : has("mobile") ? "mobile" : null;
  if (phoneKey && !state.contactInfo.mobile && !state.contactInfo.phone) {
    const value = String(raw[phoneKey] ?? "").trim();
    input.phone = value;
    state.contactInfo.mobile = value;
  }
  if (has("email") && !state.contactInfo.email) {
    const value = String(raw.email ?? "").trim();
    input.email = value;
    state.contactInfo.email = value;
  }
  if (has("address") && !state.addressInfo.street) {
    const value = String(raw.address ?? "").trim();
    input.address = value;
    state.addressInfo.street = value;
  }

  // --- validate -------------------------------------------------------------
  // In full mode the body is the whole form, so `displayName` is missing when the
  // state has none. In partial mode a field the body never mentioned cannot be
  // "required": the caller is not claiming it should be empty.
  const present = new Set<string>([...ROOT_STRING_FIELDS, "status", "role", "personType", "accountingCodeMode"]);
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    present.add(key);
  }
  const found = validatePartyForm(state);
  for (const [path, code] of Object.entries(found)) {
    if (partial && code === "required" && !pathIsPresent(path, input)) continue;
    errors[path] = code;
  }
  void present;

  return { input, state, errors };
}

/** Whether a schema path was sent by this body, tab key included. */
function pathIsPresent(path: string, input: PartyWriteInput): boolean {
  const [head, tail] = path.split(".");
  if (tail === undefined) return (input as Record<string, unknown>)[head] !== undefined;
  const tab = (input as unknown as Record<string, Record<string, unknown> | undefined>)[
    head === "generalInfo"
      ? "generalInfo"
      : head === "addressInfo"
        ? "addressInfo"
        : head === "contactInfo"
          ? "contactInfo"
          : "financialInfo"
  ];
  return !!tab && Object.prototype.hasOwnProperty.call(tab, tail);
}
