/**
 * Parties — the business-wide record of every counterparty (migration 0137).
 *
 * One table for the customer who owes money, the supplier who is owed it and the
 * employee whose مساعده runs through the personnel account, because business-wide
 * is exactly the right scope for all three: a customer eats at any branch, a
 * supplier delivers to any branch, a cashier works at any branch. Like the chart of
 * accounts, this is shared data, not per-branch data — which is why the *apps* read
 * it through one service and each shows the slice its own job needs
 * (`src/lib/parties-scopes.ts`).
 *
 * The service owns four things no caller may re-derive:
 *
 *  1. **The wire shape.** `parties.name` is the physical display-name column and
 *     `displayName` is its API name; the identity numbers are physical columns
 *     while the tab's other keys live in the `general_info` document. Both
 *     directions go through the mappers below, so no screen has to know which of
 *     the two a value was read from.
 *  2. **The accounting code.** Generated in `Automatic` mode, honoured as-is in
 *     `Manual` mode, unique per business either way (0137's index).
 *  3. **The encryption transition** — Phase 24 Wave 3's dual write. It lives here,
 *     at the service layer and not in `db.ts`, because a transparent database layer
 *     cannot know which column is which and would silently encrypt the wrong things.
 *  4. **What may be destroyed.** A party with orders, receipts, points or a
 *     location alias is archived rather than deleted, for the same reason
 *     `ar_receipts.customer_id` is `ON DELETE RESTRICT`.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure half of
 * the contract (validation, codes, payload shape) is `parties.ts` and is tested.
 */
import { getBusinessDek } from "./business-keys";
import { query } from "./db";
import { hasMatchingMediaSignature } from "./media";
import { getMediaAsset } from "./media-service";
import {
  blindIndex,
  decryptOptional,
  encryptOptional,
  phoneBlindIndex,
  phoneKind,
  phoneLast4,
} from "./field-crypto";
import { phoneDigits, phoneE164 } from "./phone";
import {
  ACCOUNTING_CODE_MODES,
  partyRoles,
  primaryPartyRole,
  MAX_PARTY_ACCOUNTING_CODE,
  MAX_PARTY_DISPLAY_NAME,
  MAX_PARTY_NOTES,
  PARTY_PERSON_TYPE_STORAGE,
  PARTY_ROLES,
  PARTY_ROLE_STORAGE,
  asciiDigits,
  deriveDisplayName,
  isProfileImageValue,
  isValidIranianNationalId,
  nextAccountingCode,
  partyPersonType,
  partyRole,
  taxPercentageOf,
  DEFAULT_TAX_PERCENTAGE,
  type AccountingCodeMode,
  type PartyAddressInfo,
  type PartyContactInfo,
  type PartyFinancialInfo,
  type PartyGeneralInfo,
  type PartyPersonType,
  type PartyRole,
} from "./parties";

/**
 * Server-side length caps mirrored by the party form's `maxLength`s — see
 * `src/app/dashboard/parties/party-form.tsx`. Kept here because the API is also
 * called by the assistant, an import and (one day) a mobile client.
 */
export const MAX_PARTY_PHONE = 32;
export const MAX_PARTY_ADDRESS = 500;
export const MAX_PARTY_EMAIL = 200;

/** Every party a caller may read, in the shape the REST API returns. */
export interface Party extends Record<string, unknown> {
  id: string;
  /** `parties.name`. The API's `displayName`, aliased here so `c.name` readers and the new screens agree. */
  displayName: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  /** The primary role — the accounting-code prefix and every pre-0148 reader. */
  role: PartyRole;
  /** Every role this party holds (migration 0148); `role` is always one of them. */
  roles: PartyRole[];
  personType: PartyPersonType;
  /** The `status` toggle of the form; `isActive` is the same boolean under its column name. */
  status: boolean;
  isActive: boolean;
  accountingCode: string | null;
  accountingCodeMode: AccountingCodeMode;
  profileImage: string | null;
  /** Migration 0181 — the canonical Media Library asset for an uploaded avatar. */
  profileImageAssetId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  /** The canonical contact row. Mirrored from `contactInfo` so the POS, the picker and the invoice all read one place. */
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  birthday?: string | null;
  tags?: string[];
  marketingConsent?: boolean;
  smsConsent?: boolean;
  generalInfo: Partial<PartyGeneralInfo> & Record<string, unknown>;
  addressInfo: Partial<PartyAddressInfo> & Record<string, unknown>;
  contactInfo: Partial<PartyContactInfo> & Record<string, unknown>;
  financialInfo: Partial<PartyFinancialInfo> & Record<string, unknown>;
  /** The membership this personnel file belongs to, when `role` is Employee. */
  employeeUserId: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A rejected write, named. The route turns the code into a 400 and a Persian message. */
export class PartyValidationError extends Error {
  constructor(
    readonly code: string,
    readonly field?: string,
  ) {
    super(code);
    this.name = "PartyValidationError";
  }
}

/**
 * The one select list for every party read, qualified because every read joins
 * the category table. Writes do not use it: an `UPDATE … RETURNING` cannot reach
 * `pc`, so a mutation reads its row back through `getParty` instead.
 */
const PARTY_COLUMNS = `p.id, p.name, p.first_name AS "firstName", p.last_name AS "lastName",
       p.role, p.roles, p.person_type AS "personType", p.is_active AS "isActive",
       p.accounting_code AS "accountingCode", p.accounting_code_mode AS "accountingCodeMode",
       p.profile_image AS "profileImage", p.profile_image_asset_id AS "profileImageAssetId",
       p.category_id AS "categoryId",
       p.general_info AS "generalInfo", p.address_info AS "addressInfo",
       p.contact_info AS "contactInfo", p.financial_info AS "financialInfo",
       p.national_id AS "nationalId", p.national_id_enc AS "nationalIdEnc",
       p.economic_code AS "economicCode", p.economic_code_enc AS "economicCodeEnc",
       p.employee_user_id AS "employeeUserId",
       p.phone, p.phone_enc AS "phoneEnc", p.address, p.address_enc AS "addressEnc",
       p.notes, p.notes_enc AS "notesEnc", p.email,
       p.birthday::text AS "birthday", p.tags,
       p.marketing_consent AS "marketingConsent", p.sms_consent AS "smsConsent",
       p.created_at AS "createdAt", p.updated_at AS "updatedAt",
       pc.name AS "categoryName"`;

/** The category name comes from the reference table, so every listing needs the join. */
const PARTY_FROM = "parties p LEFT JOIN party_categories pc ON pc.id = p.category_id";

interface PartyRow extends Record<string, unknown> {
  name: string;
  role?: string | null;
  roles?: string[] | null;
  personType?: string | null;
  isActive?: boolean;
  generalInfo?: Record<string, unknown> | null;
  addressInfo?: Record<string, unknown> | null;
  contactInfo?: Record<string, unknown> | null;
  financialInfo?: Record<string, unknown> | null;
  categoryName?: string | null;
  phoneEnc?: unknown;
  addressEnc?: unknown;
  notesEnc?: unknown;
  nationalId?: string | null;
  nationalIdEnc?: unknown;
  economicCode?: string | null;
  economicCodeEnc?: unknown;
  accountingCodeMode?: string | null;
}

/**
 * Row → wire. The two encrypted identity numbers are read from their envelope and
 * put back into the `general_info` document the form expects, so the split in
 * 0137 (columns for what must be searchable, document for the rest) is invisible
 * to every caller.
 */
function toParty(row: PartyRow, dek: Buffer | null): Party {
  const {
    phoneEnc,
    addressEnc,
    notesEnc,
    nationalId,
    nationalIdEnc,
    economicCode,
    economicCodeEnc,
    generalInfo,
    addressInfo,
    contactInfo,
    financialInfo,
    categoryName,
    ...rest
  } = row;
  const general = typeof generalInfo === "object" && generalInfo ? generalInfo : {};
  const party: Party = {
    ...(rest as Record<string, unknown>),
    id: String(row.id),
    displayName: row.name,
    firstName: (row.firstName as string | null) ?? null,
    lastName: (row.lastName as string | null) ?? null,
    name: row.name,
    role: partyRole(row.role),
    // A row written before 0148 has an empty array until the backfill; reading
    // it through `partyRoles` means the wire shape is the same either way.
    roles: partyRoles(row.roles, row.role),
    personType: partyPersonType(row.personType),
    status: row.isActive !== false,
    isActive: row.isActive !== false,
    accountingCode: (row.accountingCode as string | null) ?? null,
    accountingCodeMode: (ACCOUNTING_CODE_MODES as readonly string[]).includes(String(row.accountingCodeMode))
      ? (row.accountingCodeMode as AccountingCodeMode)
      : "Automatic",
    profileImage: (row.profileImage as string | null) ?? null,
    profileImageAssetId: (row.profileImageAssetId as string | null) ?? null,
    categoryId: (row.categoryId as string | null) ?? null,
    categoryName: categoryName ?? null,
    phone: decryptOptional(phoneEnc, dek, (row.phone as string | null) ?? null),
    address: decryptOptional(addressEnc, dek, (row.address as string | null) ?? null),
    notes: decryptOptional(notesEnc, dek, (row.notes as string | null) ?? null),
    email: (row.email as string | null) ?? null,
    generalInfo: {
      ...general,
      nationalId: decryptOptional(nationalIdEnc, dek, nationalId ?? null) ?? "",
      economicCode: decryptOptional(economicCodeEnc, dek, economicCode ?? null) ?? "",
      // Handed over raw: `taxPercentageOf` already distinguishes «unset» from
      // «zero» and parses localized text. Wrapping it in `Number()` first threw
      // that away — `Number("۹٫۵")` is `NaN`, which the coercion could then only
      // read as «not a rate» and replace with the default, so a stored
      // fractional rate came back as 9% on every read.
      taxPercentage: taxPercentageOf({ generalInfo: { taxPercentage: general.taxPercentage } }),
    },
    addressInfo: typeof addressInfo === "object" && addressInfo ? addressInfo : {},
    contactInfo: typeof contactInfo === "object" && contactInfo ? contactInfo : {},
    financialInfo: typeof financialInfo === "object" && financialInfo ? financialInfo : {},
    employeeUserId: (row.employeeUserId as string | null) ?? null,
  };
  return party;
}

/**
 * The tab a caller sent, under either spelling.
 *
 * `buildPartyPayload()` emits `general_info`/`address_info`/… because that is the
 * REST body in the spec; hand-written callers (the assistant's tools, an import,
 * a test) find `generalInfo` more natural. Accepting both at the boundary is two
 * lines here and saves every caller a footgun.
 */
function tabOf<T extends Record<string, unknown>>(
  input: object,
  camel: string,
  snake: string,
): T | undefined {
  const source = input as Record<string, unknown>;
  const value = source[camel] ?? source[snake];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : undefined;
}

function textOf(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/** Everything a write may say. Every field is optional; `undefined` means "unchanged". */
export interface PartyInput {
  status?: boolean;
  role?: string | null;
  /** Migration 0148 — the full role set. Absent means "leave it"/"derive it". */
  roles?: string[] | null;
  personType?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  categoryId?: string | null;
  accountingCodeMode?: string | null;
  accountingCode?: string | null;
  profileImage?: string | null;
  /**
   * Migration 0181 — a Media Library asset id for an uploaded avatar. Not
   * validated for tenant ownership here (`PartyInput` is a plain data
   * bag) — `createParty`/`updateParty` do that against the caller's
   * `businessId` before it is ever written, the same shape
   * `purchase-service.ts`'s `invoiceAssetId` uses.
   */
  profileImageAssetId?: string | null;
  notes?: string | null;
  generalInfo?: (Partial<PartyGeneralInfo> & Record<string, unknown>) | null;
  addressInfo?: (Partial<PartyAddressInfo> & Record<string, unknown>) | null;
  contactInfo?: (Partial<PartyContactInfo> & Record<string, unknown>) | null;
  financialInfo?: (Partial<PartyFinancialInfo> & Record<string, unknown>) | null;
  /** The REST body's snake_case spelling of the same four documents. */
  general_info?: (Partial<PartyGeneralInfo> & Record<string, unknown>) | null;
  address_info?: (Partial<PartyAddressInfo> & Record<string, unknown>) | null;
  contact_info?: (Partial<PartyContactInfo> & Record<string, unknown>) | null;
  financial_info?: (Partial<PartyFinancialInfo> & Record<string, unknown>) | null;
  /** Legacy root writes — the quick-add on the invoice screen and every importer. */
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  tags?: string[];
  birthday?: string | null;
  marketingConsent?: boolean;
  smsConsent?: boolean;
  /** Links a personnel party to its membership. Ignored for the other two roles. */
  employeeUserId?: string | null;
}

interface NormalizedWrite {
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  role: PartyRole;
  roles: PartyRole[];
  personType: PartyPersonType;
  status: boolean;
  categoryId: string | null;
  profileImage: string | null;
  profileImageAssetId: string | null;
  notes: string | null;
  accountingCodeMode: AccountingCodeMode;
  /** Already validated as present-and-shaped when the mode is Manual. */
  accountingCode: string | null;
  nationalId: string | null;
  economicCode: string | null;
  taxPercentage: number;
  extraGeneral: Record<string, unknown>;
  phone: string | null;
  email: string | null;
  address: string | null;
  generalInfo: Record<string, unknown>;
  addressInfo: Record<string, unknown> | null;
  contactInfo: Record<string, unknown> | null;
  financialInfo: Record<string, unknown> | null;
  tags: string[] | undefined;
  birthday: string | null | undefined;
  marketingConsent: boolean | undefined;
  smsConsent: boolean | undefined;
  employeeUserId: string | null | undefined;
}

/**
 * Validate and normalise one write.
 *
 * The tab documents are the source of truth for contact and place, and the *root*
 * columns are what the rest of the platform reads (`orders` joins `parties.phone`
 * for the checkout picker, invoices print `parties.address`). Rather than let the
 * two drift, the root columns are derived from the tabs on every write — and only
 * when the tab was sent, so a caller that knows nothing about tabs (a POS quick-add
 * posting `{displayName, phone}`) still gets exactly the row it asked for.
 */

const PROFILE_IMAGE_DATA_URL_RE = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i;

/**
 * `isProfileImageValue` (src/lib/parties.ts) is the cheap, pure shape check
 * shared with the client form's live field feedback — it never decodes the
 * base64, so it cannot tell a real PNG from four kilobytes of `AAAA…`
 * declared as one. This is the actual trust boundary: a party's profile
 * image is later rendered as `<img src>` (party-form.tsx and every party
 * list that shows an avatar), so a data-URL value gets the same
 * byte-signature check the Media Library gives every upload
 * (`hasMatchingMediaSignature`, src/lib/media.ts) before it is ever written.
 * An `https://` value (a linked, not uploaded, avatar) has no bytes to check.
 */
function validatedProfileImage(value: string | null): string | null {
  if (value === null) return null;
  if (!isProfileImageValue(value)) throw new PartyValidationError("invalid_image", "profileImage");
  const trimmed = value.trim();
  const dataUrlMatch = PROFILE_IMAGE_DATA_URL_RE.exec(trimmed);
  if (dataUrlMatch) {
    const mimeType = dataUrlMatch[1].toLowerCase().replace("image/jpg", "image/jpeg");
    const bytes = Buffer.from(dataUrlMatch[2].replace(/\s+/g, ""), "base64");
    if (bytes.byteLength === 0 || !hasMatchingMediaSignature(mimeType, bytes)) {
      throw new PartyValidationError("invalid_image", "profileImage");
    }
  }
  return value;
}

function normalizePartyWrite(input: PartyInput, existing?: Party | null): NormalizedWrite {
  const general = tabOf<PartyGeneralInfo & Record<string, unknown>>(input, "generalInfo", "general_info");
  const contact = tabOf<PartyContactInfo & Record<string, unknown>>(input, "contactInfo", "contact_info");
  const address = tabOf<PartyAddressInfo & Record<string, unknown>>(input, "addressInfo", "address_info");
  const financial = tabOf<PartyFinancialInfo & Record<string, unknown>>(input, "financialInfo", "financial_info");

  const role = input.role === undefined || input.role === null
    ? (existing?.role ?? "Customer")
    : (() => {
        const value = String(input.role).trim();
        const known = (["Customer", "Employee", "Supplier"] as readonly string[]).includes(value)
          ? value
          : (Object.keys(PARTY_ROLE_STORAGE) as (keyof typeof PARTY_ROLE_STORAGE)[]).find(
              (k) => PARTY_ROLE_STORAGE[k] === value.toLowerCase(),
            );
        if (!known) throw new PartyValidationError("invalid_role", "role");
        return partyRole(known);
      })();

  /**
   * The role *set* (0148), and the primary role re-derived from it.
   *
   * Three callers, three shapes, one answer:
   *  - a form that sends `roles` — authoritative, with `role` folded in;
   *  - a pre-0148 caller that sends only `role` — the set is that one role,
   *    plus whatever the record already held, so a POS quick-add editing a
   *    customer who is also a supplier does not quietly demote them;
   *  - a partial write that names neither — the stored set, unchanged.
   */
  const roles = (() => {
    if (input.roles !== undefined && input.roles !== null) {
      const asked = Array.isArray(input.roles) ? input.roles : [];
      if (asked.length === 0) throw new PartyValidationError("role_required", "roles");
      // Checked against the raw values, before normalisation: `partyRoles`
      // drops what it does not recognise, so validating its *output* would
      // quietly turn a typo into «مشتری» instead of reporting it.
      for (const entry of asked) {
        const value = String(entry).trim();
        const known =
          (PARTY_ROLES as readonly string[]).includes(value) ||
          (Object.keys(PARTY_ROLE_STORAGE) as PartyRole[]).some(
            (candidate) => PARTY_ROLE_STORAGE[candidate] === value.toLowerCase(),
          );
        if (!known) throw new PartyValidationError("invalid_role", "roles");
      }
      // Only a role the *caller* named is folded in. Folding in the stored
      // primary role would make the set append-only: a party wrongly marked as
      // personnel could never be turned back into a plain customer, and
      // «برداشتن نقش» in the form would silently do nothing.
      return partyRoles(asked, input.role ?? undefined);
    }
    const stored = existing?.roles ?? [];
    if (input.role !== undefined && input.role !== null) return partyRoles([...stored, role], role);
    return partyRoles(stored.length > 0 ? stored : [role], role);
  })();
  // The primary role prefers what the caller asked for, but only if it is
  // actually in the set — a code prefix that names a role the party does not
  // hold is a code nobody can read back.
  const primaryRole = primaryPartyRole(roles, role);

  const personType =
    input.personType === undefined || input.personType === null
      ? (existing?.personType ?? "Real")
      : (() => {
          const value = String(input.personType).trim();
          const known = (["Real", "Legal"] as readonly string[]).includes(value)
            ? value
            : (Object.keys(PARTY_PERSON_TYPE_STORAGE) as (keyof typeof PARTY_PERSON_TYPE_STORAGE)[]).find(
                (k) => PARTY_PERSON_TYPE_STORAGE[k] === value.toLowerCase(),
              );
          if (!known) throw new PartyValidationError("invalid_person_type", "personType");
          return partyPersonType(known);
        })();

  const modeValue = input.accountingCodeMode ?? existing?.accountingCodeMode ?? "Automatic";
  const accountingCodeMode = (ACCOUNTING_CODE_MODES as readonly string[]).includes(String(modeValue))
    ? (String(modeValue) as AccountingCodeMode)
    : "Automatic";
  const manualCode = textOf(input.accountingCode ?? existing?.accountingCode ?? null);
  if (accountingCodeMode === "Manual" && !manualCode) {
    throw new PartyValidationError("accounting_code_required", "accountingCode");
  }
  if (manualCode && manualCode.length > MAX_PARTY_ACCOUNTING_CODE) {
    throw new PartyValidationError("too_long", "accountingCode");
  }

  const derived = deriveDisplayName({
    displayName: textOf(input.displayName) ?? "",
    firstName: textOf(input.firstName) ?? existing?.firstName ?? "",
    lastName: textOf(input.lastName) ?? existing?.lastName ?? "",
  });
  // `deriveDisplayName` answers `""` for a body that named nobody, and an empty
  // string is not a value `??` can fall through. Without the `|| null` a partial
  // update — the assistant appending a note, the store fixing one field — would
  // answer «نام نمایشی الزامی است» about a party that has had a name for years.
  const displayName = textOf(input.displayName) ?? (derived || null) ?? existing?.displayName ?? "";
  if (!displayName) throw new PartyValidationError("display_name_required", "displayName");

  const nationalId = general ? textOf(general.nationalId) : (textOf(existing?.generalInfo?.nationalId) ?? null);
  if (nationalId && (personType === "Legal" || !isValidIranianNationalId(nationalId))) {
    throw new PartyValidationError("invalid_national_id", "generalInfo.nationalId");
  }

  const { nationalId: _n, economicCode: _e, taxPercentage: _t, ...extraGeneral } = general ?? {};
  const taxPercentage = general
    ? taxPercentageOf({ generalInfo: { taxPercentage: general.taxPercentage } })
    : (existing?.generalInfo?.taxPercentage as number | undefined) ?? DEFAULT_TAX_PERCENTAGE;

  const phone =
    input.phone !== undefined
      ? textOf(input.phone)
      : contact
        ? (textOf(contact.mobile) ?? textOf(contact.phone))
        : (existing?.phone ?? null);
  if (phone && phone.length > MAX_PARTY_PHONE) throw new PartyValidationError("phone_too_long", "contactInfo.mobile");
  const email =
    input.email !== undefined
      ? textOf(input.email)
      : contact
        ? textOf(contact.email)
        : (existing?.email ?? null);
  if (email && email.length > MAX_PARTY_EMAIL) throw new PartyValidationError("email_too_long", "contactInfo.email");
  const addressValue =
    input.address !== undefined
      ? textOf(input.address)
      : address
        ? textOf(address.street)
        : (existing?.address ?? null);
  if (addressValue && addressValue.length > MAX_PARTY_ADDRESS) {
    throw new PartyValidationError("address_too_long", "addressInfo.street");
  }

  const notes = input.notes !== undefined ? textOf(input.notes) : (existing?.notes ?? null);
  if (notes && notes.length > MAX_PARTY_NOTES) throw new PartyValidationError("notes_too_long", "notes");

  // Migration 0181. Shape-only here (a real string or null); `createParty`/
  // `updateParty` still validate it against the caller's tenant and the
  // asset's kind before it is ever written — this function has no database
  // access and cannot do that part.
  const profileImageAssetId =
    input.profileImageAssetId !== undefined
      ? textOf(input.profileImageAssetId)
      : (existing?.profileImageAssetId ?? null);
  // An asset-backed avatar and the legacy inline/linked one are mutually
  // exclusive: once a party has a canonical Media Library photo, the old
  // column is cleared rather than left holding a value nothing renders
  // anymore (a party can otherwise never be un-migrated by re-uploading).
  const profileImage = profileImageAssetId
    ? null
    : input.profileImage !== undefined
      ? validatedProfileImage(textOf(input.profileImage))
      : (existing?.profileImage ?? null);

  return {
    displayName: displayName.slice(0, MAX_PARTY_DISPLAY_NAME),
    firstName: input.firstName !== undefined ? textOf(input.firstName) : (existing?.firstName ?? null),
    lastName: input.lastName !== undefined ? textOf(input.lastName) : (existing?.lastName ?? null),
    role: primaryRole,
    roles,
    personType,
    // Both `status` and `isActive` are set by `toParty`, and a write that does not
    // name the flag must not invent one: a partial update (an AI note, a tab saved
    // on its own) that defaulted to `true` would silently reactivate a party
    // somebody had archived.
    status: input.status === undefined ? (existing?.status ?? true) : input.status !== false,
    categoryId: input.categoryId !== undefined ? textOf(input.categoryId) : (existing?.categoryId ?? null),
    profileImage,
    profileImageAssetId,
    notes,
    accountingCodeMode,
    accountingCode: accountingCodeMode === "Manual" ? manualCode : null,
    nationalId,
    economicCode: general ? textOf(general.economicCode) : (textOf(existing?.generalInfo?.economicCode) ?? null),
    taxPercentage,
    extraGeneral,
    phone,
    email,
    address: addressValue,
    // `general_info` keeps what the form sent minus the three mapped keys, plus
    // the tax rate — the numbers themselves live in columns (0137 §3b). A write
    // that did not send the tab keeps the stored document whole, so a key another
    // tab wrote is never erased by this one.
    generalInfo: general ? { ...extraGeneral, taxPercentage } : { ...(existing?.generalInfo ?? {}), taxPercentage },
    addressInfo: address ?? null,
    contactInfo: contact ?? null,
    financialInfo: financial ?? null,
    tags: input.tags,
    birthday: input.birthday,
    marketingConsent: input.marketingConsent,
    smsConsent: input.smsConsent,
    employeeUserId: input.employeeUserId,
  };
}

/**
 * The derived-accounting-code lookup: every code already used by this role in this
 * business. Read inside the same statement as the insert, then re-read and retried
 * on the unique violation, which is what makes two simultaneous «ذخیره» clicks land
 * on two codes instead of one error page.
 */
async function usedAccountingCodes(businessId: string, role: PartyRole): Promise<string[]> {
  const { rows } = await query<{ accounting_code: string | null }>(
    `SELECT accounting_code FROM parties WHERE business_id = $1 AND role = $2 AND accounting_code IS NOT NULL`,
    [businessId, PARTY_ROLE_STORAGE[role]],
  );
  return rows.map((row) => row.accounting_code).filter((code): code is string => !!code);
}

/** SQL for "some other party already holds this national ID", ciphertext-first. */
function nationalIdMatchSql(bidxParam: string, plainParam: string): string {
  return (
    `((${bidxParam}::text IS NOT NULL AND national_id_bidx = ${bidxParam})` +
    ` OR (${bidxParam}::text IS NULL AND ${plainParam}::text IS NOT NULL AND national_id = ${plainParam}))`
  );
}

async function assertNationalIdFree(
  businessId: string,
  nationalId: string | null,
  dek: Buffer | null,
  exceptId?: string,
): Promise<void> {
  if (!nationalId) return;
  const digits = asciiDigits(nationalId);
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM parties
      WHERE business_id = $1 AND is_active AND ${nationalIdMatchSql("$2", "$3")}
        AND ($4::uuid IS NULL OR id <> $4)
      LIMIT 1`,
    [businessId, dek && digits ? blindIndex(digits, dek) : null, digits, exceptId ?? null],
  );
  if (rows[0]) throw new PartyValidationError("national_id_taken", "generalInfo.nationalId");
}

/**
 * Migration 0181 — the same tenant-scoped cross-reference check
 * `purchase-service.ts` runs for `invoiceAssetId` and `expense-service.ts`
 * for `receiptAssetId`, reusing `getMediaAsset` rather than a fourth
 * hand-rolled `SELECT`. A stale id (deleted from another tab mid-edit) or
 * one belonging to a different business is refused with the same
 * `invalid_image` code the byte-signature check already uses for this
 * field — one error a caller has to handle for "this avatar is not usable",
 * whichever of the two ways it failed.
 */
async function assertProfileImageAssetOwned(businessId: string, assetId: string | null): Promise<void> {
  if (!assetId) return;
  const asset = await getMediaAsset(businessId, assetId);
  if (!asset || asset.kind !== "image") {
    throw new PartyValidationError("invalid_image", "profileImage");
  }
}

/** The phone/identity derived columns, written as one set — see `phoneColumns` below. */
interface IdentityColumns {
  nationalId: string | null;
  nationalIdEnc: Buffer | null;
  nationalIdBidx: string | null;
  economicCode: string | null;
  economicCodeEnc: Buffer | null;
}

function identityColumns(
  nationalId: string | null,
  economicCode: string | null,
  dek: Buffer | null,
): IdentityColumns {
  const digits = nationalId ? asciiDigits(nationalId) : "";
  return {
    nationalId,
    // Absence round-trips as NULL, never as the ciphertext of an empty string.
    nationalIdEnc: dek ? encryptOptional(nationalId, dek) : null,
    nationalIdBidx: dek && digits ? blindIndex(digits, dek) : null,
    economicCode,
    economicCodeEnc: dek ? encryptOptional(economicCode, dek) : null,
  };
}

/**
 * Everything derived from a typed phone number, written together as one set.
 *
 *  - `phone_enc` / `phone_bidx` — the ciphertext and its equality index; null
 *    on an install with no master key.
 *  - `phone_e164` — the canonical +98… form. It was **not** being maintained
 *    on this path before Phase 24 Wave 3: `crm-service.syncCustomerPhone` exists
 *    for exactly this and has never had a caller, so a party created or edited
 *    from the dashboard was invisible to duplicate detection, to segment
 *    resolution and to the SMS-reachable count until somebody ran
 *    `npm run db:normalize-phones` by hand. Writing it here, beside the blind
 *    index that will replace it, fixes that and keeps the two canonical forms
 *    from drifting apart.
 */
interface PhoneColumns {
  enc: Buffer | null;
  bidx: string | null;
  e164: string | null;
  last4: string | null;
  kind: string | null;
}

function phoneColumns(phone: string | null, dek: Buffer | null): PhoneColumns {
  return {
    enc: dek ? encryptOptional(phone, dek) : null,
    bidx: dek && phone ? phoneBlindIndex(phone, dek) : null,
    e164: phone ? phoneE164(phone) : null,
    // Written unconditionally, key or no key: these are the plaintext remnants
    // that keep last-four search and SMS-reachability alive after step 3, and a
    // business that enables encryption later should not have to re-derive them.
    last4: phoneLast4(phone),
    kind: phoneKind(phone),
  };
}

/**
 * The two keys a *lookup* needs to find the party holding a given number,
 * whichever state the row is in. Exported because three callers outside this file
 * do exactly this lookup — `ai-tools.ts`'s customer search and
 * `integrations/sync-service.ts`'s two "is this shopper already here" probes — and
 * they must agree with the writes above, or an integration sync quietly creates a
 * second copy of a person it failed to recognise.
 */
export interface PhoneMatchKeys {
  bidx: string | null;
  e164: string | null;
  last4: string | null;
}

export async function phoneMatchKeys(businessId: string, phone: string | null): Promise<PhoneMatchKeys> {
  const dek = await getBusinessDek(businessId);
  return {
    bidx: dek && phone ? phoneBlindIndex(phone, dek) : null,
    e164: phone ? phoneE164(phone) : null,
    last4: phoneLast4(phone),
  };
}

/**
 * SQL for "this row holds that number", true in either state.
 *
 * Prefer the blind index; fall back to the canonical plaintext **only for a row
 * that has no blind index yet**. That asymmetry is deliberate and differs from the
 * `coalesce(...) = coalesce(...)` used by the duplicate self-joins: a self-join
 * compares two rows that are almost always in the same state, and a transient miss
 * there costs one delayed suggestion. A lookup compares a typed number against a
 * row mid-backfill, and a miss there makes the caller decide the person does not
 * exist — which, in the WooCommerce sync, means creating a duplicate.
 */
export function phoneMatchSql(alias: string, bidxParam: string, e164Param: string): string {
  const a = alias ? `${alias}.` : "";
  return (
    `((${bidxParam}::text IS NOT NULL AND ${a}phone_bidx = ${bidxParam})` +
    ` OR (${a}phone_bidx IS NULL AND ${e164Param}::text IS NOT NULL AND ${a}phone_e164 = ${e164Param}))`
  );
}

/** Row-to-row key, for the duplicate self-joins. Collapses to `phone_bidx` at step 3. */
export function phonePairKeySql(alias: string): string {
  const a = alias ? `${alias}.` : "";
  return `coalesce(${a}phone_bidx, ${a}phone_e164)`;
}

/**
 * "Can this number actually receive an SMS."
 *
 * Not `phone_e164 IS NOT NULL`, which is what the CRM counted before and means
 * merely "parses as an Iranian number" — a landline included. Reads `phone_kind`
 * where the row has been classified and falls back to the shape of the canonical
 * number where it has not: an Iranian mobile is `+989` plus nine digits, which is
 * the same rule `phone.ts` applies. Yields NULL for a party with no phone, which
 * `count(*) FILTER` correctly declines to count.
 */
export function mobileReachableSql(alias = ""): string {
  const a = alias ? `${alias}.` : "";
  return (
    `(CASE WHEN ${a}phone_kind IS NOT NULL THEN ${a}phone_kind = 'mobile'` +
    ` ELSE ${a}phone_e164 LIKE '+989%' AND length(${a}phone_e164) = 13 END)`
  );
}

/**
 * How a typed search term matches a phone, in the order the columns will outlive
 * each other:
 *
 *   1. `phone_bidx` — an exact match on the whole number, and the only phone
 *      search that survives step 3 intact.
 *   2. `phone_last4` — the till workflow: four or more digits that are not a whole
 *      number are read as "the last four I can see".
 *   3. `phone ILIKE '%…%'` — arbitrary substring, alive only while the plaintext
 *      column is.
 *   4. the same substring over the plaintext with its digits reduced to ASCII —
 *      `translate(...)`. A number typed on a Persian keyboard is stored as typed
 *      (the party write path has never rewritten a person's digits), so without
 *      this clause «۰۹۱۲…» and «0912…» are two different people to the till, to the
 *      CRM and to the assistant. Stripping the separators here is also what makes
 *      `+98 912 …` and `0912…` one number, because the shorter digit run is a
 *      substring of the longer one.
 *
 * The digits clause is search-only by design: normalizing what is *stored* would
 * invalidate the blind index of every row written before the change, which is a
 * backfill of its own and not something a rename should smuggle in.
 */
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/**
 * SQL: the digits of a phone column, ASCII and nothing else.
 *
 * `prefix` is the qualified column prefix the search builder already uses (`"p."`),
 * so it is appended to rather than dotted.
 */
function phoneDigitsSql(prefix: string): string {
  return (
    `regexp_replace(translate(${prefix}phone, '${PERSIAN_DIGITS}${ARABIC_DIGITS}', '01234567890123456789'),` +
    // `'\\D'`, not `'\D'`: a lone backslash before `D` is not an escape sequence
    // JavaScript recognises, so the template literal collapsed it to the plain
    // letter `'D'` and the clause stripped literal Ds from the number instead of
    // every non-digit. A stored «۰۹۱۲ ۳۴۵ ۶۷۸۹» therefore kept its spaces and no
    // typed digit run ever matched it — the one search this clause exists for.
    ` '\\D', '', 'g')`
  );
}
interface PhoneSearchKeys {
  bidx: string | null;
  last4: string | null;
  e164: string | null;
}

function phoneSearchKeys(term: string, dek: Buffer | null): PhoneSearchKeys {
  const digits = phoneDigits(term);
  if (!digits) return { bidx: null, last4: null, e164: null };
  const e164 = phoneE164(term);
  return {
    bidx: dek ? phoneBlindIndex(term, dek) : null,
    last4: e164 === null && digits.length >= 4 ? digits.slice(-4) : null,
    // A complete number compares on the canonical form, not as a substring: this
    // is what lets «+98 912 …», «0098912…», «0912…» and a bare «912…» find one
    // party, and it works on a row whose plaintext has been encrypted away.
    e164,
  };
}

/**
 * Escapes the two wildcards `LIKE` reads in a user-typed term.
 *
 * Without this, «%» typed into the customer search matches every party and «_»
 * matches any single character, so the directory silently answers a search
 * nobody made. The escape character is declared with `ESCAPE '\\'` on every
 * pattern built from `escapeLike`.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The SQL a name/phone search needs, built once so the directory listing and the
 * picker cannot want different things from the same column.
 *
 * Exported as `partySearchClause` below: Growth's customer projection is a
 * second query over the same `parties` rows, and a screen that hand-rolls
 * `LOWER(name) LIKE …` answers a typed phone differently from the directory —
 * and stops answering it at all once `phone` is encrypted away.
 */
function searchClause(
  term: string,
  dek: Buffer | null,
  firstParam: number,
  alias = "p.",
): { sql: string; params: unknown[] } {
  const keys = phoneSearchKeys(term, dek);
  const like = `$${firstParam}`;
  const bidx = `$${firstParam + 1}`;
  const last4 = `$${firstParam + 2}`;
  const digits = `$${firstParam + 3}`;
  const e164 = `$${firstParam + 4}`;
  const termDigits = phoneDigits(term);
  return {
    sql:
      `(${alias}name ILIKE ${like} ESCAPE '\\' OR ${alias}phone ILIKE ${like} ESCAPE '\\'` +
      ` OR (${bidx}::text IS NOT NULL AND ${alias}phone_bidx = ${bidx})` +
      ` OR (${last4}::text IS NOT NULL AND ${alias}phone_last4 = ${last4})` +
      // Four digits is the shortest thing worth comparing: below that the digit run
      // is a name fragment, and a directory that answers «۱۲» with every party whose
      // phone contains it is a directory nobody trusts.
      ` OR (${digits}::text IS NOT NULL AND length(${digits}) >= 4` +
      `   AND ${phoneDigitsSql(alias)} LIKE '%' || ${digits} || '%')` +
      ` OR (${e164}::text IS NOT NULL AND ${alias}phone_e164 = ${e164}))`,
    params: [
      `%${escapeLike(term)}%`,
      keys.bidx,
      keys.last4,
      termDigits.length >= 4 ? termDigits : null,
      keys.e164,
    ],
  };
}

/**
 * The directory's name/phone search, for a query built outside this file.
 *
 * Growth's customer projection joins loyalty points and purchase history onto
 * the same `parties` rows, so it cannot reuse `listParties`; what it must not do
 * is invent a second definition of "matches what I typed". This hands it the
 * exact clause the directory and the till picker use — blind index, last four,
 * Persian digits and all — bound to whatever parameter slot its own query has
 * reached.
 */
export async function partySearchClause(
  businessId: string,
  term: string,
  firstParam: number,
  alias = "p.",
): Promise<{ sql: string; params: unknown[] }> {
  const dek = await getBusinessDek(businessId);
  return searchClause(term.trim(), dek, firstParam, alias);
}

/**
 * Name/phone search for the pickers, one role at a time.
 *
 * `roles` is what makes the same endpoint serve the POS's customer list, the
 * ledger's party list and the store's supplier list without three queries — the
 * picker for a sale asks for `["Customer"]`, the AP screen for `["Supplier"]`.
 */
export async function searchParties(
  businessId: string,
  q: string,
  options: { roles?: PartyRole[]; limit?: number } = {},
): Promise<Party[]> {
  const term = q.trim();
  const dek = await getBusinessDek(businessId);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const roles = options.roles?.length
    ? options.roles.map((role) => PARTY_ROLE_STORAGE[role])
    : ["customer", "employee", "supplier"];

  // `roles && …` rather than `role = ANY(…)`: since 0148 a person can hold
  // several roles, and a supplier who is also a customer must appear in the
  // customer picker too.
  const conditions = [`p.business_id = $1`, "p.is_active", "p.merged_into_id IS NULL", "p.roles && $2::text[]"];
  const params: unknown[] = [businessId, roles];
  if (term) {
    const clause = searchClause(term, dek, params.length + 1);
    conditions.push(clause.sql);
    params.push(...clause.params);
  }
  const limitParam = `$${params.length + 1}`;
  params.push(limit);

  const { rows } = await query<PartyRow>(
    `SELECT ${PARTY_COLUMNS}
      FROM ${PARTY_FROM}
      WHERE ${conditions.join(" AND ")}
      ORDER BY p.created_at DESC
      LIMIT ${limitParam}`,
    params,
  );
  return rows.map((row) => toParty(row, dek));
}

/** The legacy name of the picker search — POS, checkout and the invoice screen still call this. */
export async function searchCustomers(businessId: string, q: string): Promise<Party[]> {
  return searchParties(businessId, q, { roles: ["Customer"] });
}

export interface PartyListOptions {
  q?: string;
  roles?: PartyRole[];
  includeInactive?: boolean;
  categoryId?: string | null;
  page?: number;
  pageSize?: number;
}

export interface PartyListResult {
  parties: Party[];
  total: number;
}

/** Paginated directory listing for the party screens in every app. */
export async function listParties(businessId: string, options: PartyListOptions = {}): Promise<PartyListResult> {
  const term = options.q?.trim() ?? "";
  const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
  const page = Math.max(options.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const dek = await getBusinessDek(businessId);
  const conditions = ["p.business_id = $1"];
  const params: unknown[] = [businessId];
  if (!options.includeInactive) conditions.push("p.is_active");
  if (options.roles?.length) {
    params.push(options.roles.map((role) => PARTY_ROLE_STORAGE[role]));
    // Overlap, not equality — one record, several roles (0148).
    conditions.push(`p.roles && $${params.length}::text[]`);
  }
  if (options.categoryId) {
    params.push(options.categoryId);
    conditions.push(`p.category_id = $${params.length}::uuid`);
  }
  if (term) {
    const clause = searchClause(term, dek, params.length + 1);
    conditions.push(clause.sql);
    params.push(...clause.params);
  }
  const where = conditions.join(" AND ");

  const { rows: countRows } = await query<{ count: string }>(
    `SELECT count(*) AS count FROM parties p WHERE ${where}`,
    params,
  );
  const total = Number(countRows[0]?.count ?? 0);

  const { rows } = await query<PartyRow>(
    `SELECT ${PARTY_COLUMNS} FROM ${PARTY_FROM}
      WHERE ${where}
      ORDER BY p.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );
  return { parties: rows.map((row) => toParty(row, dek)), total };
}

/** The listing, under the name the pages that predate 0137 already import. */
export async function listCustomers(
  businessId: string,
  options: { q?: string; includeInactive?: boolean; page?: number; pageSize?: number },
): Promise<{ customers: Party[]; total: number }> {
  const result = await listParties(businessId, options);
  return { customers: result.parties, total: result.total };
}

/** One party by id, in this business only — the read every mutation re-uses. */
export async function getParty(businessId: string, id: string): Promise<Party | null> {
  const dek = await getBusinessDek(businessId);
  const { rows } = await query<PartyRow>(
    `SELECT ${PARTY_COLUMNS}
      FROM ${PARTY_FROM}
      WHERE p.business_id = $1 AND p.id = $2`,
    [businessId, id],
  );
  return rows[0] ? toParty(rows[0], dek) : null;
}

/**
 * The compatibility getter used by loyalty and checkout paths. A party can
 * carry several roles, but a supplier-only or employee-only record must never
 * receive customer points or a customer-credit liability just because its UUID
 * was supplied to an endpoint.
 */
export async function getCustomer(businessId: string, id: string): Promise<Party | null> {
  const party = await getParty(businessId, id);
  return party?.roles.includes("Customer") ? party : null;
}

/**
 * Create a party.
 *
 * `accountingCode` in `Automatic` mode is not "left empty for later": the number
 * is assigned here, at submission, exactly as the spec requires — because a party
 * the ledger cannot find is a party whose balance will be found by hand.
 */
export async function createParty(
  businessId: string,
  input: PartyInput,
  options: { locationId?: string | null } = {},
): Promise<Party> {
  const dek = await getBusinessDek(businessId);
  const write = normalizePartyWrite(input);
  await assertNationalIdFree(businessId, write.nationalId, dek);
  await assertProfileImageAssetOwned(businessId, write.profileImageAssetId);

  const phoneCols = phoneColumns(write.phone, dek);
  const identity = identityColumns(write.nationalId, write.economicCode, dek);

  // Three attempts at the code, then give up: a fourth collision means something
  // other than a race is wrong, and a clearer error beats a loop.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code =
      write.accountingCodeMode === "Manual"
        ? write.accountingCode
        : nextAccountingCode(write.role, await usedAccountingCodes(businessId, write.role));
    try {
      const { rows } = await query<PartyRow>(
        `INSERT INTO parties (
            business_id, location_id, name, first_name, last_name, role, roles, person_type, is_active,
            accounting_code, accounting_code_mode, profile_image, category_id,
            general_info, address_info, contact_info, financial_info,
            national_id, national_id_enc, national_id_bidx, economic_code, economic_code_enc,
            phone, phone_enc, phone_bidx, phone_e164, phone_last4, phone_kind,
            address, address_enc, notes, notes_enc, email, birthday, tags,
            marketing_consent, sms_consent, employee_user_id, profile_image_asset_id
          )
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11,$12,$13::uuid,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,
                 $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::date,$35,$36,$37,$38::uuid,$39::uuid)
         RETURNING id`,
        [
          businessId,
          options.locationId ?? null,
          write.displayName,
          write.firstName,
          write.lastName,
          PARTY_ROLE_STORAGE[write.role],
          write.roles.map((role) => PARTY_ROLE_STORAGE[role]),
          PARTY_PERSON_TYPE_STORAGE[write.personType],
          write.status,
          code,
          write.accountingCodeMode.toLowerCase(),
          write.profileImage,
          write.categoryId,
          JSON.stringify(write.generalInfo),
          JSON.stringify(write.addressInfo ?? {}),
          JSON.stringify(write.contactInfo ?? {}),
          JSON.stringify(write.financialInfo ?? {}),
          identity.nationalId,
          identity.nationalIdEnc,
          identity.nationalIdBidx,
          identity.economicCode,
          identity.economicCodeEnc,
          write.phone,
          phoneCols.enc,
          phoneCols.bidx,
          phoneCols.e164,
          phoneCols.last4,
          phoneCols.kind,
          write.address,
          dek ? encryptOptional(write.address, dek) : null,
          write.notes,
          dek ? encryptOptional(write.notes, dek) : null,
          write.email,
          write.birthday ?? null,
          write.tags ?? [],
          write.marketingConsent ?? false,
          write.smsConsent ?? false,
          write.roles.includes("Employee") ? (write.employeeUserId ?? null) : null,
          write.profileImageAssetId,
        ],
      );
      const created = rows[0] ? await getParty(businessId, String(rows[0].id)) : null;
      if (created) return created;
    } catch (error) {
      lastError = error;
      if (!isUniqueViolation(error)) throw error;
      // In Manual mode the number came from a person, so retrying would only
      // re-collide with the same row three times before reporting something else's
      // constraint name; say which field is wrong and stop.
      if (write.accountingCodeMode === "Manual") {
        throw new PartyValidationError("accounting_code_taken", "accountingCode");
      }
      // 23505 on the accounting-code index in Automatic mode: someone else took
      // the number between the read and the insert. Recompute and try again.
      continue;
    }
    lastError = null;
    break;
  }
  if (lastError) throw lastError;
  throw new PartyValidationError("accounting_code_taken", "accountingCode");
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

/** The old create, for callers that only ever had a name and a phone. */
export async function createCustomer(
  businessId: string,
  input: {
    name: string;
    phone?: string | null;
    address?: string | null;
    notes?: string | null;
    email?: string | null;
    birthday?: string | null;
    tags?: string[];
    marketingConsent?: boolean;
    smsConsent?: boolean;
  },
): Promise<Party> {
  return createParty(businessId, {
    displayName: input.name,
    phone: input.phone ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
    email: input.email ?? null,
    birthday: input.birthday ?? null,
    tags: input.tags,
    marketingConsent: input.marketingConsent,
    smsConsent: input.smsConsent,
    role: "Customer",
  });
}

/**
 * Edit a party.
 *
 * `general_info` is *merged*, not replaced, so a future tab's keys survive an edit
 * made by a screen that knows nothing about them. The identity numbers are the
 * exception: an explicit `generalInfo` tab is that tab's own truth, and leaving a
 * cleared کد ملی behind in the column would mean the ledger still matches on it.
 */
export async function updateParty(
  businessId: string,
  id: string,
  input: PartyInput,
): Promise<Party | null> {
  const existing = await getParty(businessId, id);
  if (!existing) return null;
  const dek = await getBusinessDek(businessId);
  const write = normalizePartyWrite(input, existing);
  await assertNationalIdFree(businessId, write.nationalId, dek, id);
  // Only re-checked when this write actually touches the field: an edit that
  // never mentions the avatar carries the existing (already-owned) value
  // straight through `normalizePartyWrite`, so re-querying it on every
  // unrelated save (a phone-number fix, a note) would be a wasted lookup.
  if (input.profileImageAssetId !== undefined) {
    await assertProfileImageAssetOwned(businessId, write.profileImageAssetId);
  }

  const sets: string[] = [];
  const params: unknown[] = [businessId, id];
  function add(column: string, value: unknown) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }

  add("name", write.displayName);
  add("first_name", write.firstName);
  add("last_name", write.lastName);
  add("role", PARTY_ROLE_STORAGE[write.role]);
  add("roles", write.roles.map((role) => PARTY_ROLE_STORAGE[role]));
  add("person_type", PARTY_PERSON_TYPE_STORAGE[write.personType]);
  add("is_active", write.status);
  add("accounting_code", write.accountingCode);
  add("accounting_code_mode", write.accountingCodeMode.toLowerCase());
  add("profile_image", write.profileImage);
  add("profile_image_asset_id", write.profileImageAssetId);
  add("category_id", write.categoryId);
  add("general_info", JSON.stringify(write.generalInfo));
  if (write.addressInfo) add("address_info", JSON.stringify(write.addressInfo));
  if (write.contactInfo) add("contact_info", JSON.stringify(write.contactInfo));
  if (write.financialInfo) add("financial_info", JSON.stringify(write.financialInfo));

  const identity = identityColumns(write.nationalId, write.economicCode, dek);
  add("national_id", identity.nationalId);
  add("national_id_enc", identity.nationalIdEnc);
  add("national_id_bidx", identity.nationalIdBidx);
  add("economic_code", identity.economicCode);
  add("economic_code_enc", identity.economicCodeEnc);

  // Each encrypted field is written as a set: plaintext twin, ciphertext, and
  // (phone only) the derived columns. Writing the plaintext without the
  // ciphertext would leave a row the next reader silently reads from the stale
  // `_enc` value — the one failure mode of a dual-write window, and the reason
  // the 0137 trigger exists to catch the same mistake from the other side.
  const phoneCols = phoneColumns(write.phone, dek);
  add("phone", write.phone);
  add("phone_enc", phoneCols.enc);
  add("phone_bidx", phoneCols.bidx);
  add("phone_e164", phoneCols.e164);
  add("phone_last4", phoneCols.last4);
  add("phone_kind", phoneCols.kind);
  add("address", write.address);
  add("address_enc", dek ? encryptOptional(write.address, dek) : null);
  add("notes", write.notes);
  add("notes_enc", dek ? encryptOptional(write.notes, dek) : null);
  add("email", write.email);
  if (write.tags !== undefined) add("tags", write.tags);
  if (write.birthday !== undefined) add("birthday", write.birthday);
  if (write.marketingConsent !== undefined) add("marketing_consent", write.marketingConsent);
  if (write.smsConsent !== undefined) add("sms_consent", write.smsConsent);
  // Only a personnel party carries the membership; the number one link per
  // membership is 0137's unique partial index, so a role change clears it rather
  // than leaving a customer file pointing at somebody's login.
  if (write.roles.includes("Employee")) {
    if (write.employeeUserId !== undefined) add("employee_user_id", write.employeeUserId);
  } else if (existing.employeeUserId) {
    add("employee_user_id", null);
  }

  try {
    const { rows } = await query<PartyRow>(
      `UPDATE parties SET ${sets.join(", ")}, updated_at = now()
        WHERE business_id = $1 AND id = $2
        RETURNING id`,
      params,
    );
    return rows[0] ? await getParty(businessId, id) : null;
  } catch (error) {
    if (isUniqueViolation(error) && write.accountingCodeMode === "Manual") {
      throw new PartyValidationError("accounting_code_taken", "accountingCode");
    }
    throw error;
  }
}

/** The old editor's name, kept for the assistant's tools and the autopilot executors. */
export async function updateCustomer(
  businessId: string,
  id: string,
  input: { name?: string; phone?: string | null; address?: string | null; notes?: string | null } & PartyInput,
): Promise<Party | null> {
  return updateParty(businessId, id, {
    ...input,
    displayName: input.name,
    address: input.address,
  });
}

/**
 * The personnel party of one membership, created on demand and kept named.
 *
 * A cashier added from «مدیریت تیم» is a counterparty from the moment their first
 * مساعده is recorded, and the payroll screen should not have to care whether the
 * owner opened the party form. So the team routes call this rather than writing an
 * `INSERT` of their own: one place decides that a membership has exactly one party
 * row (0137's unique index is what makes "exactly" true), and the link means the
 * Team view and the ledger agree about who the money belongs to.
 *
 * The row is also *repaired*, not just created: when the party already exists and
 * the caller names a display name, the party is renamed with it. The team screen
 * is where a member's name is managed, and the promise its layout makes — the
 * membership above and the personnel file below are two views of one person —
 * is only true if a rename travels to both. A caller that names no name (the
 * suspend button, a status flip) changes nothing but the party's existence.
 */
export async function ensureEmployeeParty(
  businessId: string,
  userId: string,
  details: { displayName?: string | null; phone?: string | null; email?: string | null } = {},
): Promise<Party | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM parties WHERE business_id = $1 AND employee_user_id = $2`,
    [businessId, userId],
  );
  const name = details.displayName?.trim() || null;
  if (rows[0]) {
    if (!name) return getParty(businessId, rows[0].id);
    return updateParty(businessId, rows[0].id, { displayName: name });
  }
  const created = await createParty(businessId, {
    role: "Employee",
    personType: "Real",
    displayName: name ?? "",
    firstName: name ?? "",
    phone: details.phone ?? null,
    email: details.email ?? null,
    employeeUserId: userId,
  });
  return created.id ? created : null;
}

export type RemovePartyResult = "deleted" | "archived" | "not_found";

/**
 * Removes a party from the record.
 *
 * A party with history — an order, an AR receipt, loyalty points, a supplier alias
 * in any branch, a membership link — can never be hard-deleted: `ar_receipts` and
 * the rest are `ON DELETE RESTRICT` for exactly this reason, and an order silently
 * losing its party attribution would corrupt the AR subledger's "always agrees with
 * the control account" guarantee. Such a party is archived (`is_active = false`)
 * instead: they disappear from the pickers and the default listings, and their
 * statement stays intact. A party with no history at all — a duplicate, a test
 * entry — is deleted.
 */
export async function removeParty(businessId: string, id: string): Promise<RemovePartyResult> {
  const { rows: existsRows } = await query<{ id: string }>(
    `SELECT id FROM parties WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  if (!existsRows[0]) return "not_found";

  const { rows: refRows } = await query<Record<string, boolean>>(
    `SELECT
       /*
        * orders is scoped by branch, not by business (0001 predates multi-branch:
        * there is no orders.business_id), so the attribution check walks the
        * location — the same join every other party-aware query here uses. Without
        * it, a party with an order would be hard-deleted and the order would lose
        * the name it was written under.
        */
       EXISTS (
         SELECT 1 FROM orders o
           JOIN locations ol ON ol.id = o.location_id
          WHERE ol.business_id = $1 AND o.customer_id = $2
       ) AS has_orders,
       EXISTS (SELECT 1 FROM ar_receipts WHERE business_id = $1 AND customer_id = $2) AS has_receipts,
       EXISTS (SELECT 1 FROM customer_points WHERE business_id = $1 AND customer_id = $2) AS has_points,
       EXISTS (SELECT 1 FROM suppliers WHERE party_id = $2) AS has_supplier_rows,
       EXISTS (SELECT 1 FROM parties p WHERE p.merged_into_id = $2) AS has_merges`,
    [businessId, id],
  );
  // A party with points (or store credit, which is only ever created for a party
  // with points history) must be archived, never hard-deleted — the same
  // ON DELETE RESTRICT discipline ar_receipts has.
  const hasHistory =
    refRows[0]?.has_orders ||
    refRows[0]?.has_receipts ||
    refRows[0]?.has_points ||
    refRows[0]?.has_supplier_rows ||
    refRows[0]?.has_merges;

  if (hasHistory) {
    await query(`UPDATE parties SET is_active = false, updated_at = now() WHERE business_id = $1 AND id = $2`, [
      businessId,
      id,
    ]);
    return "archived";
  }

  await query(`DELETE FROM parties WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return "deleted";
}

// ---------------------------------------------------------------------------
// Categories — the reference table `category_id` points at
// ---------------------------------------------------------------------------

interface PartyCategoryRow extends Record<string, unknown> {
  id: string;
  name: string;
  /** stored lowercase; null for a category that applies to all three roles */
  role: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface PartyCategory {
  id: string;
  name: string;
  /** null = the category applies to all three roles. */
  role: PartyRole | null;
  sortOrder: number;
  isActive: boolean;
}

const CATEGORY_COLUMNS = `id, name, role, sort_order AS "sortOrder", is_active AS "isActive"`;

export async function listPartyCategories(
  businessId: string,
  options: { role?: PartyRole | null; includeInactive?: boolean } = {},
): Promise<PartyCategory[]> {
  const conditions = ["business_id = $1"];
  const params: unknown[] = [businessId];
  if (!options.includeInactive) conditions.push("is_active");
  if (options.role) {
    params.push(PARTY_ROLE_STORAGE[options.role]);
    conditions.push(`(role = $${params.length} OR role IS NULL)`);
  }
  const { rows } = await query<PartyCategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM party_categories
      WHERE ${conditions.join(" AND ")}
      ORDER BY sort_order, name`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role ? partyRole(row.role) : null,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  }));
}

export async function createPartyCategory(
  businessId: string,
  input: { name: string; role?: PartyRole | null; sortOrder?: number },
): Promise<PartyCategory | null> {
  const name = input.name.trim().slice(0, 80);
  if (!name) return null;
  try {
    const { rows } = await query<PartyCategoryRow>(
      `INSERT INTO party_categories (business_id, name, role, sort_order)
       VALUES ($1, $2, $3, $4)
       RETURNING ${CATEGORY_COLUMNS}`,
      [businessId, name, input.role ? PARTY_ROLE_STORAGE[input.role] : null, input.sortOrder ?? 0],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          name: row.name,
          role: row.role ? partyRole(row.role) : null,
          sortOrder: row.sortOrder,
          isActive: row.isActive,
        }
      : null;
  } catch (error) {
    // The unique index on (business_id, lower(trim(name))) is the one that
    // catches «معلم » vs «معلم»; turn it into the message the form shows.
    if (isUniqueViolation(error)) throw new PartyValidationError("category_exists", "name");
    throw error;
  }
}

export async function updatePartyCategory(
  businessId: string,
  id: string,
  input: { name?: string; role?: PartyRole | null; sortOrder?: number; isActive?: boolean },
): Promise<PartyCategory | null> {
  const sets: string[] = [];
  const params: unknown[] = [businessId, id];
  function add(column: string, value: unknown) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (input.name !== undefined) add("name", input.name.trim().slice(0, 80));
  if (input.role !== undefined) add("role", input.role ? PARTY_ROLE_STORAGE[input.role] : null);
  if (input.sortOrder !== undefined) add("sort_order", Math.trunc(input.sortOrder));
  if (input.isActive !== undefined) add("is_active", input.isActive);
  if (sets.length === 0) return null;
  add("updated_at", "now()");
  sets[sets.length - 1] = "updated_at = now()";
  try {
    const { rows } = await query<PartyCategoryRow>(
      `UPDATE party_categories SET ${sets.join(", ")}
        WHERE business_id = $1 AND id = $2
        RETURNING ${CATEGORY_COLUMNS}`,
      params,
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          name: row.name,
          role: row.role ? partyRole(row.role) : null,
          sortOrder: row.sortOrder,
          isActive: row.isActive,
        }
      : null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new PartyValidationError("category_exists", "name");
    throw error;
  }
}

/** Deactivates a category. The parties keep their `category_id` until it is deleted. */
export async function removePartyCategory(businessId: string, id: string): Promise<"deleted" | "kept" | "not_found"> {
  const { rows } = await query<{ id: string }>(`SELECT id FROM party_categories WHERE business_id = $1 AND id = $2`, [
    businessId,
    id,
  ]);
  if (!rows[0]) return "not_found";
  const { rows: used } = await query<{ in_use: boolean }>(
    `SELECT EXISTS (
        SELECT 1 FROM parties pt
          JOIN party_categories pc ON pc.id = pt.category_id
         WHERE pc.business_id = $1 AND pc.id = $2
     ) AS in_use`,
    [businessId, id],
  );
  if (used[0]?.in_use) {
    await query(`UPDATE party_categories SET is_active = false, updated_at = now() WHERE business_id = $1 AND id = $2`, [
      businessId,
      id,
    ]);
    return "kept";
  }
  await query(`DELETE FROM party_categories WHERE business_id = $1 AND id = $2`, [businessId, id]);
  return "deleted";
}
