import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, validateProvisionBody } from "./business-provisioning";
import { ENABLED_INDUSTRIES, INDUSTRIES } from "./industries";

const VALID = {
  businessName: "کافه نادری",
  ownerName: "مالک",
  email: "Owner@Example.COM",
  password: "correct-horse",
  // Phase 24 — a connected install enrols the Owner in SMS OTP as the business
  // is created, so provisioning needs a mobile to send to. Every case below
  // that isn't specifically about the phone carries a valid one.
  ownerPhone: "09121234567",
};

describe("validateProvisionBody", () => {
  it("accepts a complete body and normalises it", () => {
    const result = validateProvisionBody({ ...VALID, locationName: "  شعبه یک  ", phone: " 021 " });
    expect(result.error).toBeNull();
    expect(result.input).toMatchObject({
      businessName: "کافه نادری",
      ownerName: "مالک",
      // Lower-cased so it matches the citext identity column consistently.
      email: "owner@example.com",
      locationName: "شعبه یک",
      phone: "021",
    });
  });

  it("leaves locationName undefined so the caller's default applies", () => {
    expect(validateProvisionBody(VALID).input?.locationName).toBeUndefined();
    expect(validateProvisionBody({ ...VALID, locationName: "   " }).input?.locationName).toBeUndefined();
  });

  it("turns blank optional fields into null rather than empty strings", () => {
    const { input } = validateProvisionBody({ ...VALID, address: "  ", phone: "" });
    expect(input?.address).toBeNull();
    expect(input?.phone).toBeNull();
  });

  it("rejects a body missing any required field", () => {
    for (const key of ["businessName", "ownerName", "email", "password"] as const) {
      const body = { ...VALID, [key]: undefined };
      expect(validateProvisionBody(body).error, `missing ${key}`).toBe("missing_fields");
    }
  });

  it("treats whitespace-only required fields as missing", () => {
    expect(validateProvisionBody({ ...VALID, businessName: "   " }).error).toBe("missing_fields");
    expect(validateProvisionBody({ ...VALID, ownerName: "  " }).error).toBe("missing_fields");
  });

  it("rejects a malformed email", () => {
    for (const email of ["nope", "a@b", "a b@example.com", "@example.com", "a@"]) {
      expect(validateProvisionBody({ ...VALID, email }).error, email).toBe("invalid_email");
    }
  });

  it("rejects a password shorter than the minimum", () => {
    expect(validateProvisionBody({ ...VALID, password: "a".repeat(MIN_PASSWORD_LENGTH - 1) }).error).toBe(
      "weak_password",
    );
    expect(validateProvisionBody({ ...VALID, password: "a".repeat(MIN_PASSWORD_LENGTH) }).error).toBeNull();
  });

  it("does not trim the password — leading and trailing spaces are part of it", () => {
    const password = "  spaced  ";
    expect(validateProvisionBody({ ...VALID, password }).input?.password).toBe(password);
  });

  it("defaults industry to food_service when omitted", () => {
    expect(validateProvisionBody(VALID).input?.industry).toBe("food_service");
  });

  it("accepts an explicit, enabled industry", () => {
    for (const industry of [
      "food_service",
      "jewelry",
      "watch",
      "accessories",
      "cosmetics",
      "wholesale",
      "tools_fittings",
      "haberdashery",
    ]) {
      expect(validateProvisionBody({ ...VALID, industry }).input?.industry, industry).toBe(industry);
    }
  });

  it("rejects an unknown industry value", () => {
    expect(validateProvisionBody({ ...VALID, industry: "bakery" }).error).toBe("invalid_industry");
  });

  it("takes a typed subdomain as-is, lower-cased and trimmed", () => {
    expect(validateProvisionBody({ ...VALID, subdomain: "  AcmeCafe  " }).input?.subdomain).toBe(
      "acmecafe",
    );
  });

  it("rejects a subdomain that is not a usable DNS label", () => {
    expect(validateProvisionBody({ ...VALID, subdomain: "ab" }).error).toBe("invalid_subdomain");
    expect(validateProvisionBody({ ...VALID, subdomain: "-acme" }).error).toBe("invalid_subdomain");
    expect(validateProvisionBody({ ...VALID, subdomain: "کافه" }).error).toBe("invalid_subdomain");
    expect(validateProvisionBody({ ...VALID, subdomain: "admin" }).error).toBe("reserved_subdomain");
  });

  it("requires a subdomain only when the caller asks for one", () => {
    // The console does (a super-admin is there to type the business's public
    // English address); the first-run wizard and public signup do not, and
    // fall back to the name-derived label inside provisionBusiness.
    expect(validateProvisionBody(VALID).error).toBeNull();
    expect(validateProvisionBody(VALID, { requireSubdomain: true }).error).toBe("missing_subdomain");
    expect(validateProvisionBody({ ...VALID, subdomain: "   " }, { requireSubdomain: true }).error).toBe(
      "missing_subdomain",
    );
    expect(
      validateProvisionBody({ ...VALID, subdomain: "acme" }, { requireSubdomain: true }).error,
    ).toBeNull();
  });

  it("requires the Owner's mobile on a connected install, and normalises it to E.164", () => {
    // Phase 24: `provisionBusiness` writes an sms_otp enrolment in the same
    // transaction, so a business cannot exist without somewhere to send the
    // code. Absent `deploymentMode` reads as connected, matching
    // resolveDeploymentMode — an install predating the setting is a connected
    // one, and the requirement fails closed rather than skipping enrolment.
    expect(validateProvisionBody({ ...VALID, ownerPhone: undefined }).error).toBe("invalid_owner_phone");
    expect(validateProvisionBody({ ...VALID, ownerPhone: "  " }).error).toBe("invalid_owner_phone");
    expect(validateProvisionBody({ ...VALID, ownerPhone: "12345" }).error).toBe("invalid_owner_phone");

    // The forms are Persian, so the digits may be too.
    for (const typed of ["09121234567", "+989121234567", "989121234567", "۰۹۱۲۱۲۳۴۵۶۷", "0912 123 4567"]) {
      expect(validateProvisionBody({ ...VALID, ownerPhone: typed }).input?.ownerPhone, typed).toBe(
        "+989121234567",
      );
    }
  });

  it("does not ask a local install for a mobile — it enrols TOTP instead", () => {
    // An offline café has no signal, so an SMS-only Owner would be locked out
    // of their own till the first time the line dropped.
    const local = validateProvisionBody({ ...VALID, ownerPhone: undefined }, { deploymentMode: "local" });
    expect(local.error).toBeNull();
    expect(local.input?.ownerPhone).toBeNull();
  });

  it("reports a missing mobile only once the rest of the form is filled in", () => {
    // Ordering matters for the message the visitor sees: an empty form should
    // say "fill everything in", not single out the one field this deployment
    // has never asked for before.
    expect(validateProvisionBody({ ...VALID, businessName: "", ownerPhone: "" }).error).toBe("missing_fields");
    expect(validateProvisionBody({ ...VALID, email: "nope", ownerPhone: "" }).error).toBe("invalid_email");
    expect(validateProvisionBody({ ...VALID, password: "short", ownerPhone: "" }).error).toBe("weak_password");
  });

  it("never derives the subdomain from the business name", () => {
    // A transliterated Persian name is a poor public address, so an omitted
    // subdomain stays omitted here rather than being quietly filled in.
    expect(validateProvisionBody(VALID).input?.subdomain).toBeUndefined();
  });

  it("offers every industry the platform names, now that every trade has shipped", () => {
    // Until Wave 6 this asserted the opposite for watch/accessories — that a
    // real-but-not-yet-built industry is rejected with industry_not_available.
    // The gate itself is unchanged (the validator still checks
    // ENABLED_INDUSTRIES, not INDUSTRIES); there is simply nothing left
    // behind it.
    for (const industry of INDUSTRIES) {
      expect(ENABLED_INDUSTRIES.includes(industry), industry).toBe(true);
    }
  });
});
