import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_CODE_MODES,
  MAX_PARTY_DISPLAY_NAME,
  PARTY_ROLE_LABELS,
  PARTY_ROLES,
  asciiDigits,
  buildPartyPayload,
  deriveDisplayName,
  formatAccountingCode,
  formStateFromParty,
  type PartyApiRecord,
  isAccountingCodeShape,
  isValidEconomicCode,
  isValidIranianIban,
  isValidIranianNationalId,
  isValidPostalCode,
  nextAccountingCode,
  parsePartyRequestBody,
  partyFieldErrorMessage,
  resetPartyForm,
  taxPercentageOf,
  taxPercentageText,
  validatePartyForm,
} from "./parties";

/**
 * The party contract, tested without a database.
 *
 * This module is the single definition of what a counterparty is: every app's form,
 * every route's 400 and the migration's CHECK constraints are all read from it, so
 * these are the tests that decide whether the platform agrees with itself. The
 * numbers are real check-digit cases (a national ID, an economic code, an IBAN, a
 * Luhn card), because a validator that only accepts what it was tested with is the
 * one thing this file exists to prevent.
 */

const VALID_NATIONAL_ID = "0084575980";
const VALID_ECONOMIC_CODE = "41126708611";
const VALID_IBAN = "IR830540102380270014203457";

describe("party roles", () => {
  it("names three roles in Persian and nothing else", () => {
    expect(PARTY_ROLES).toEqual(["Customer", "Employee", "Supplier"]);
    expect(Object.values(PARTY_ROLE_LABELS).join(" ")).toContain("مشتری");
    expect(PARTY_ROLE_LABELS.Supplier).toContain("تأمین");
  });
});

describe("asciiDigits", () => {
  it("reads Persian, Arabic-Indic and Latin digits as the same number", () => {
    expect(asciiDigits("۰۰۸۴۵۷۵۹۸۰")).toBe("0084575980");
    expect(asciiDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(asciiDigits("۰۹۱۲-۳۴۵-۶۷-۸۹")).toBe("09123456789");
  });

  it("drops everything that is not a digit, including a plus", () => {
    expect(asciiDigits("+98 912 345 6789")).toBe("989123456789");
    expect(asciiDigits(null)).toBe("");
    expect(asciiDigits(undefined)).toBe("");
  });
});

describe("identity validators", () => {
  it("accepts a national ID only with a correct check digit", () => {
    expect(isValidIranianNationalId(VALID_NATIONAL_ID)).toBe(true);
    // Persian digits are the way a person types it, and the field must not care.
    expect(isValidIranianNationalId("۰۰۸۴۵۷۵۹۸۰")).toBe(true);
    expect(isValidIranianNationalId("0084575981")).toBe(false);
    expect(isValidIranianNationalId("1111111111")).toBe(false);
    expect(isValidIranianNationalId("123")).toBe(false);
    expect(isValidIranianNationalId("")).toBe(false);
  });

  it("accepts an economic code only with a correct prime-weight check digit", () => {
    expect(isValidEconomicCode(VALID_ECONOMIC_CODE)).toBe(true);
    expect(isValidEconomicCode("41126708610")).toBe(false);
    expect(isValidEconomicCode("1234567890")).toBe(false);
  });

  it("accepts an IBAN by mod-97 over the rearranged form", () => {
    expect(isValidIranianIban(VALID_IBAN)).toBe(true);
    expect(isValidIranianIban("IR83 0540 1023 8027 0014 2034 57")).toBe(true);
    expect(isValidIranianIban("IR820540102380270014203457")).toBe(false);
    expect(isValidIranianIban("DE89370400440532013000")).toBe(false); // right algorithm, wrong country prefix
  });

  it("accepts a postal code as ten digits", () => {
    expect(isValidPostalCode("1234567890")).toBe(true);
    expect(isValidPostalCode("۱۲۳۴۵۶۷۸۹۰")).toBe(true);
    expect(isValidPostalCode("12345")).toBe(false);
  });

  it("checks an accounting code for shape, not for a prefix", () => {
    expect(isAccountingCodeShape("100042")).toBe(true);
    expect(isAccountingCodeShape("2-99")).toBe(true);
    expect(isAccountingCodeShape("")).toBe(false);
    expect(isAccountingCodeShape("۱۰۰۰۴۲")).toBe(false); // the ledger types codes in ASCII
    expect(isAccountingCodeShape("x".repeat(25))).toBe(false);
  });
});

describe("accounting codes", () => {
  it("prefixes by role the way the chart of accounts does", () => {
    expect(formatAccountingCode("Customer", 7)).toBe("100007");
    expect(formatAccountingCode("Supplier", 1)).toBe("200001");
    expect(formatAccountingCode("Employee", 42)).toBe("300042");
  });

  it("continues the highest code of the same role only", () => {
    expect(nextAccountingCode("Customer", ["100007", "100012", null, "200003", "300001"])).toBe("100013");
    expect(nextAccountingCode("Supplier", [])).toBe("200001");
    // A code a person typed by hand that no prefix matches is not a sequence to continue.
    expect(nextAccountingCode("Customer", ["9999"])).toBe("100001");
  });
});

describe("display name", () => {
  it("prefers the explicit name and falls back to first plus last", () => {
    expect(deriveDisplayName({ displayName: " نانوایی شرق ", firstName: "x", lastName: "y" })).toBe("نانوایی شرق");
    expect(deriveDisplayName({ displayName: "", firstName: "مریم", lastName: "رضایی" })).toBe("مریم رضایی");
    expect(deriveDisplayName({ displayName: "", firstName: "مریم", lastName: "" })).toBe("مریم");
    expect(deriveDisplayName({ displayName: "", firstName: "", lastName: "" })).toBe("");
  });
});

describe("validatePartyForm", () => {
  it("needs only a display name from an otherwise empty form", () => {
    const errors = validatePartyForm(resetPartyForm());
    expect(errors.displayName).toBe("required");
    expect(errors.role).toBeUndefined();
    expect(errors["generalInfo.taxPercentage"]).toBeUndefined();
  });

  it("asks for an accounting code in Manual mode and not in Automatic", () => {
    const state = { ...resetPartyForm(), displayName: "فروشگاه" };
    expect(validatePartyForm({ ...state, accountingCodeMode: "Automatic" }).accountingCode).toBeUndefined();
    expect(validatePartyForm({ ...state, accountingCodeMode: "Manual" }).accountingCode).toBe("required");
    expect(
      validatePartyForm({ ...state, accountingCodeMode: "Manual", accountingCode: "100042" }).accountingCode,
    ).toBeUndefined();
  });

  it("refuses a national ID on a legal person and a bad one on a real person", () => {
    const base = { ...resetPartyForm(), displayName: "شرکت آریا", personType: "Legal" as const };
    expect(validatePartyForm(base)["generalInfo.nationalId"]).toBeUndefined();
    expect(validatePartyForm({ ...base, generalInfo: { ...base.generalInfo, nationalId: VALID_NATIONAL_ID } })["generalInfo.nationalId"]).toBe(
      "invalid_national_id",
    );
    const real = { ...resetPartyForm(), displayName: "مریم", personType: "Real" as const };
    expect(
      validatePartyForm({ ...real, generalInfo: { ...real.generalInfo, nationalId: "123" } })["generalInfo.nationalId"],
    ).toBe("invalid_national_id");
  });

  it("keeps the tax percentage a percentage", () => {
    const state = { ...resetPartyForm(), displayName: "x" };
    const taxError = (taxPercentage: unknown) =>
      validatePartyForm({
        ...state,
        generalInfo: { ...state.generalInfo, taxPercentage: taxPercentage as number },
      })["generalInfo.taxPercentage"];

    expect(taxError(120)).toBe("invalid_tax_percent");
    expect(taxError(-1)).toBe("invalid_tax_percent");
    expect(taxError(9)).toBeUndefined();
    // A rate typed in Persian digits is only a string for as long as it is in the
    // input; the coercion below is what lets a stored document hold one.
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "۹" } })).toBe(9);
  });

  it("accepts a fractional rate rather than reading it as a whole number", () => {
    /*
     * The validator read the field through `asciiDigits`, which drops the
     * decimal mark, so it judged «۱۲٫۵» as `125` and refused a legal rate with
     * «نرخ مالیات باید عددی بین ۰ تا ۱۰۰ باشد» — while «۹٫۵» judged as `95`,
     * passed, and was stored ten times too high. The validator and
     * `taxPercentageOf` must agree on what a string means, so they now share a
     * parser.
     */
    const state = { ...resetPartyForm(), displayName: "x" };
    const taxError = (taxPercentage: unknown) =>
      validatePartyForm({
        ...state,
        generalInfo: { ...state.generalInfo, taxPercentage: taxPercentage as number },
      })["generalInfo.taxPercentage"];

    for (const rate of ["۱۲٫۵", "9.5", "۹٫۵", "٩٫٥", 12.5, "0.5"]) {
      expect(taxError(rate), String(rate)).toBeUndefined();
    }
    // The range still applies to the parsed value.
    expect(taxError("۱۲۰٫۵")).toBe("invalid_tax_percent");
    // And a cleared field is «use the default», not a reason to block the save.
    expect(taxError("")).toBeUndefined();
    expect(taxError("   ")).toBeUndefined();
  });

  it("checks the formats it claims to check", () => {
    const state = {
      ...resetPartyForm(),
      displayName: "x",
      contactInfo: { mobile: "", email: "not-an-email", phone: "", website: "ftp://x" },
      addressInfo: { province: "", city: "", street: "", zipCode: "12", postalBox: "" },
      financialInfo: { bankName: "", cardNumber: "1".repeat(16), iban: "IR00", accountNumber: "" },
      generalInfo: { ...resetPartyForm().generalInfo, economicCode: "12345" },
    };
    const errors = validatePartyForm(state);
    expect(errors["contactInfo.email"]).toBe("invalid_email");
    expect(errors["contactInfo.website"]).toBe("invalid_url");
    expect(errors["addressInfo.zipCode"]).toBe("invalid_postal_code");
    expect(errors["financialInfo.iban"]).toBe("invalid_iban");
    expect(errors["generalInfo.economicCode"]).toBe("invalid_economic_code");
  });

  it("caps the fields the database caps", () => {
    const state = { ...resetPartyForm(), displayName: "ن".repeat(MAX_PARTY_DISPLAY_NAME + 1) };
    expect(validatePartyForm(state).displayName).toBe("too_long");
  });

  it("translates a code for the client, and never returns an empty string", () => {
    expect(partyFieldErrorMessage("invalid_iban")).toContain("شبا");
    expect(partyFieldErrorMessage("made_up_code")).toBe(partyFieldErrorMessage("required"));
  });
});

describe("buildPartyPayload / formStateFromParty", () => {
  it("sends the tabs even when empty, so a cleared tab is a cleared tab", () => {
    const payload = buildPartyPayload({ ...resetPartyForm(), displayName: "نانوایی" });
    expect(payload.address_info).toEqual({});
    expect(payload.contact_info).toEqual({});
    expect(payload.general_info.taxPercentage).toBeNull();
    expect(payload.accountingCode).toBeNull();
    expect(payload.accountingCodeMode).toBe("Automatic");
    expect(payload.displayName).toBe("نانوایی");
  });

  it("maps the flat columns the old customer row had onto the tabs", () => {
    const state = {
      ...resetPartyForm(),
      displayName: "مریم رضایی",
      firstName: "مریم",
      lastName: "رضایی",
      contactInfo: { mobile: "09123456789", phone: "", email: "m@example.com", website: "" },
      addressInfo: { province: "تهران", city: "تهران", street: "خیابان ولیعصر", zipCode: "1234567890", postalBox: "" },
      financialInfo: { bankName: "ملی", cardNumber: "6037701689095385", iban: VALID_IBAN, accountNumber: "1234" },
      generalInfo: { nationalId: VALID_NATIONAL_ID, economicCode: VALID_ECONOMIC_CODE, birthday: "", taxPercentage: 10 },
    };
    const payload = buildPartyPayload(state);
    expect(payload.contact_info).toEqual({ mobile: "09123456789", email: "m@example.com" });
    expect(payload.address_info.street).toBe("خیابان ولیعصر");
    expect(payload.general_info).toEqual({
      nationalId: VALID_NATIONAL_ID,
      economicCode: VALID_ECONOMIC_CODE,
      taxPercentage: 10,
    });
    expect(payload.financial_info.cardNumber).toBe("6037701689095385");
  });

  it("round-trips through the API record without losing a tab", () => {
    const state = {
      ...resetPartyForm(),
      displayName: "فروشگاه مرکزی",
      personType: "Legal" as const,
      role: "Supplier" as const,
      accountingCode: "200017",
      accountingCodeMode: "Manual" as const,
      notes: "یکشنبه‌ها تحویل می‌دهد",
      status: false,
      contactInfo: { mobile: "02188776655", phone: "", email: "", website: "" },
      addressInfo: { province: "", city: "کرج", street: "بلوار امامزاده", zipCode: "", postalBox: "" },
      financialInfo: { bankName: "سامان", cardNumber: "", iban: "", accountNumber: "" },
      generalInfo: { nationalId: "", economicCode: "", birthday: "", taxPercentage: 12 },
    };
    const payload = buildPartyPayload(state);
    // The record the service hands back is the payload with the tabs renamed to
    // camelCase and the three mirrored columns beside them; writing that mapping out
    // here is the point — it is the same mapping `toParty` performs on the row.
    const restored = formStateFromParty({
      ...payload,
      id: "11111111-1111-4111-8111-111111111111",
      name: payload.displayName,
      generalInfo: payload.general_info as PartyApiRecord["generalInfo"],
      addressInfo: payload.address_info as PartyApiRecord["addressInfo"],
      contactInfo: payload.contact_info as PartyApiRecord["contactInfo"],
      financialInfo: payload.financial_info as PartyApiRecord["financialInfo"],
      phone: "02188776655",
      email: null,
      address: "بلوار امامزاده",
    });
    expect(restored.displayName).toBe("فروشگاه مرکزی");
    expect(restored.role).toBe("Supplier");
    expect(restored.personType).toBe("Legal");
    expect(restored.status).toBe(false);
    expect(restored.notes).toBe("یکشنبه‌ها تحویل می‌دهد");
    expect(restored.accountingCode).toBe("200017");
    expect(restored.accountingCodeMode).toBe("Manual");
    expect(restored.contactInfo.mobile).toBe("02188776655");
    expect(restored.addressInfo.city).toBe("کرج");
    expect(restored.financialInfo.bankName).toBe("سامان");
    expect(restored.generalInfo.taxPercentage).toBe(12);
  });

  it("reads the tax percentage back defensively", () => {
    expect(taxPercentageOf({})).toBeNull();
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "۱۲" } })).toBe(12);
    // A rate that is not a rate (or is out of range) follows the business rate
    // (null), not a NaN in the ledger's copy of the party and not an assumed 9%.
    expect(taxPercentageOf({ generalInfo: { taxPercentage: null } })).toBeNull();
    expect(taxPercentageOf({ generalInfo: { taxPercentage: -3 } })).toBeNull();
    expect(taxPercentageOf({ generalInfo: { taxPercentage: 101 } })).toBeNull();
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "چیزی" } })).toBeNull();
  });

  it("keeps a fractional rate instead of multiplying it by ten", () => {
    /*
     * This read the text through `asciiDigits`, which strips every non-digit —
     * the decimal mark included. «۱۲٫۵» became `125`, which failed the range
     * check and silently reverted to the old fixed default; «۹٫۵» became `95`, which *passed* it,
     * so a party typed as 9.5% was stored at 95% and every invoice raised
     * against them used that rate. Both spellings of the separator and both
     * digit sets have to survive, because the keyboard decides which arrives.
     */
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "۱۲٫۵" } })).toBe(12.5);
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "۹٫۵" } })).toBe(9.5);
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "9.5" } })).toBe(9.5);
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "٩٫٥" } })).toBe(9.5);
    expect(taxPercentageOf({ generalInfo: { taxPercentage: 9.5 } })).toBe(9.5);
    // A leading zero is not a thousands group: «۰٫۵» is half a percent.
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "۰٫۵" } })).toBe(0.5);
  });

  it("separates «cleared» from «zero»", () => {
    /*
     * 0% is a rate a real business charges (an exempt counterparty), so it can
     * never be what an empty field means. A whitespace-only value used to reach
     * `Number("")` and land on 0, quietly making a party tax-exempt.
     */
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "" } })).toBeNull();
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "   " } })).toBeNull();
    expect(taxPercentageOf({ generalInfo: { taxPercentage: undefined } })).toBeNull();
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "0" } })).toBe(0);
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "۰" } })).toBe(0);
    expect(taxPercentageOf({ generalInfo: { taxPercentage: 0 } })).toBe(0);
  });

  it("assumes no rate for a new party: it follows the business setting (audit F05)", () => {
    expect(resetPartyForm().generalInfo.taxPercentage).toBeNull();
    // The form shows an empty box for «follows the business rate», never «null»
    // and never a guessed number; an explicit 0 stays visible as 0.
    expect(taxPercentageText({})).toBe("");
    expect(taxPercentageText({ generalInfo: { taxPercentage: 0 } })).toBe("0");
    expect(taxPercentageText({ generalInfo: { taxPercentage: "۱۲٫۵" } })).toBe("12.5");
  });
});

describe("parsePartyRequestBody", () => {
  it("emits only the keys the body sent", () => {
    const { input } = parsePartyRequestBody({ status: false }, { partial: true });
    expect(input).toEqual({ status: false });
  });

  it("treats a one-field patch as one field", () => {
    // The bug this guards: a parse built from the whole form state sent every
    // column, so toggling archive through a form-shaped PUT blanked the address,
    // the phone and the notes of a party nobody meant to touch.
    const { input, errors } = parsePartyRequestBody({ status: true }, { partial: true });
    expect(errors).toEqual({});
    expect(input.displayName).toBeUndefined();
    expect(input.contactInfo).toBeUndefined();
    expect(input.addressInfo).toBeUndefined();
  });

  it("requires a name only when the body is the whole form", () => {
    expect(parsePartyRequestBody({}, {}).errors.displayName).toBe("required");
    expect(parsePartyRequestBody({}, { partial: true }).errors).toEqual({});
  });

  it("reports a bad value at the path the form highlights", () => {
    const { errors } = parsePartyRequestBody({
      displayName: "x",
      general_info: { nationalId: "123" },
      financial_info: { iban: "IR00" },
    });
    expect(errors["generalInfo.nationalId"]).toBe("invalid_national_id");
    expect(errors["financialInfo.iban"]).toBe("invalid_iban");
  });

  it("keeps the flat keys the older callers send", () => {
    const { input, errors } = parsePartyRequestBody({ name: "نانوایی شرق", phone: "۰۹۱۲۳۴۵۶۷۸۹" });
    expect(errors).toEqual({});
    expect(input.displayName).toBe("نانوایی شرق");
    expect(input.phone).toBe("۰۹۱۲۳۴۵۶۷۸۹");
  });

  it("lets a tab the body sends win over a flat key of the same field", () => {
    const { input } = parsePartyRequestBody({
      displayName: "x",
      phone: "000",
      contact_info: { mobile: "999" },
    });
    expect(input.contactInfo).toEqual({ mobile: "999" });
  });

  it("rejects an unknown role instead of defaulting it to customer", () => {
    const { errors } = parsePartyRequestBody({ displayName: "x", role: "Vendor" }, { partial: true });
    expect(errors.role).toBe("invalid_role");
  });

  it("keeps a key no tab on this platform knows about", () => {
    // A tab is a document; refusing an unknown key would make adding a field to a
    // tab a coordinated release across every client.
    const { input } = parsePartyRequestBody({ displayName: "x", contact_info: { fns: "+98-21-000" } });
    expect(input.contactInfo).toEqual({ fns: "+98-21-000" });
  });

  it("refuses a tab too large to store", () => {
    const { errors } = parsePartyRequestBody({
      displayName: "x",
      notes: "ی".repeat(20_000),
    });
    expect(errors.notes).toBe("too_long");
  });

  it("accepts the enums the form can send and the ones it cannot", () => {
    expect(ACCOUNTING_CODE_MODES).toEqual(["Automatic", "Manual"]);
    const ok = parsePartyRequestBody({
      displayName: "x",
      role: "Employee",
      personType: "Real",
      accountingCodeMode: "Manual",
      accountingCode: "300001",
    });
    expect(ok.errors).toEqual({});
    expect(ok.input.accountingCode).toBe("300001");
  });
});
