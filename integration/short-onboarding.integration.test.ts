/**
 * ESH-202 / #1387 — the short post-signup onboarding against a real database.
 *
 * The properties this file proves:
 *
 *  - the industry list is the canonical `ENABLED_INDUSTRIES` registry;
 *  - each step persists once, resumes, and treats a skip as a completed step;
 *  - no business, membership, branch, wallet, subscription or activation exists
 *    until the explicit submission;
 *  - the canonical provisioning service creates exactly one business, branch
 *    and owner membership, with the captured name/contact/logo;
 *  - retries and concurrent submissions return the same business;
 *  - an identity that already belongs to a business is refused rather than
 *    given a duplicate;
 *  - email verification and encrypted national-ID storage use #1384's services,
 *    never a plaintext draft column.
 *
 * The database is disposable and dropped afterwards. No real SMS/email is sent.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: typeof import("../src/lib/db");
let onboarding: typeof import("../src/lib/onboarding");
let identities: typeof import("../src/lib/iam/global-identity-service");
let profiles: typeof import("../src/lib/iam/identity-profile");
let logoService: typeof import("../src/lib/business-logo");
let provisioning: typeof import("../src/lib/business-provisioning");
let setupState: typeof import("../src/lib/setup-state");
let industries: typeof import("../src/lib/industries");

let phoneSequence = 0;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

function uniquePhone(): string {
  phoneSequence += 1;
  const tail = String((Date.now() + phoneSequence) % 10_000_000).padStart(7, "0");
  return `+98913${tail}`;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.withoutTenantScope("onboarding-test", () =>
    db.query<{ n: string }>(sql, params),
  );
  return Number(rows[0]?.n ?? 0);
}

async function newIdentity(fullName = "نگار احمدی"): Promise<string> {
  const result = await identities.createVerifiedPersonalIdentity({
    fullName,
    phone: uniquePhone(),
  });
  if (!result.ok) throw new Error(`identity creation failed: ${result.error}`);
  return result.platformUserId;
}

async function saveIndustry(platformUserId: string, industry: string) {
  return onboarding.saveOnboardingStep(platformUserId, {
    step: "industry",
    industry,
  });
}

async function saveBasics(
  platformUserId: string,
  overrides: Partial<{
    businessName: string;
    locationName: string;
    address: string;
    phone: string;
  }> = {},
) {
  return onboarding.saveOnboardingStep(platformUserId, {
    step: "basics",
    businessName: overrides.businessName ?? "کافه بهار",
    locationName: overrides.locationName ?? "شعبه مرکزی",
    address: overrides.address ?? "تهران، خیابان ولیعصر",
    phone: overrides.phone ?? "02188880000",
  });
}

beforeAll(async () => {
  databaseName = `pos_onboarding_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.JWT_SECRET = "onboarding-integration-secret-".padEnd(64, "x");
  process.env.POS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  delete (globalThis as { pgPool?: unknown }).pgPool;

  db = await import("../src/lib/db");
  identities = await import("../src/lib/iam/global-identity-service");
  profiles = await import("../src/lib/iam/identity-profile");
  logoService = await import("../src/lib/business-logo");
  provisioning = await import("../src/lib/business-provisioning");
  setupState = await import("../src/lib/setup-state");
  industries = await import("../src/lib/industries");
  onboarding = await import("../src/lib/onboarding");
}, 300_000);

afterAll(async () => {
  await db?.getPool().end().catch(() => {});
  delete (globalThis as { pgPool?: unknown }).pgPool;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
  delete process.env.POS_MASTER_KEY;
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("the canonical industry registry", () => {
  it("offers all and only ENABLED_INDUSTRIES", async () => {
    const platformUserId = await newIdentity();
    const state = await onboarding.loadOnboardingState(platformUserId);
    expect(state).not.toBeNull();
    expect(state!.industries.map((item) => item.key)).toEqual(
      industries.ENABLED_INDUSTRIES,
    );
    expect(state!.industries.every((item) => item.label.length > 0)).toBe(true);
    expect(state!.membershipsExist).toBe(false);
    expect(state!.provisioned).toBe(false);
  });

  it("accepts every enabled industry on the industry step", async () => {
    const platformUserId = await newIdentity();
    for (const industry of industries.ENABLED_INDUSTRIES) {
      const saved = await saveIndustry(platformUserId, industry);
      expect(saved.ok).toBe(true);
    }
    const state = await onboarding.loadOnboardingState(platformUserId);
    expect(state!.draft.industry).toBe(
      industries.ENABLED_INDUSTRIES[industries.ENABLED_INDUSTRIES.length - 1],
    );
  });

  it("refuses a disabled or invented industry", async () => {
    const platformUserId = await newIdentity();
    const saved = await onboarding.saveOnboardingStep(platformUserId, {
      step: "industry",
      industry: "not_a_real_industry",
    });
    expect(saved).toEqual({ ok: false, error: "invalid_industry" });
  });
});

describe("step persistence and skip paths", () => {
  it("persists basics once and resumes them after a reload", async () => {
    const platformUserId = await newIdentity();
    expect((await saveIndustry(platformUserId, "food_service")).ok).toBe(true);
    expect((await saveBasics(platformUserId)).ok).toBe(true);

    const first = await onboarding.loadOnboardingState(platformUserId);
    expect(first!.draft.businessName).toBe("کافه بهار");
    expect(first!.draft.locationName).toBe("شعبه مرکزی");
    expect(first!.draft.address).toBe("تهران، خیابان ولیعصر");
    expect(first!.draft.phone).toBe("02188880000");
    expect(first!.draft.completedSteps).toEqual(["industry", "basics"]);

    // A retry is an upsert, not a second draft.
    expect((await saveBasics(platformUserId, { businessName: "کافه بهار ۲" })).ok).toBe(true);
    expect(
      await count(
        "SELECT count(*)::text AS n FROM platform_onboarding_drafts WHERE platform_user_id = $1",
        [platformUserId],
      ),
    ).toBe(1);
    const second = await onboarding.loadOnboardingState(platformUserId);
    expect(second!.draft.businessName).toBe("کافه بهار ۲");
  });

  it("refuses basics before an industry is chosen", async () => {
    const platformUserId = await newIdentity();
    const saved = await saveBasics(platformUserId);
    expect(saved).toEqual({ ok: false, error: "industry_required" });
    expect(
      await count(
        "SELECT count(*)::text AS n FROM platform_onboarding_drafts WHERE platform_user_id = $1",
        [platformUserId],
      ),
    ).toBe(0);
  });

  it("treats a skipped logo and profile as completed, not as missing data", async () => {
    const platformUserId = await newIdentity();
    expect((await saveIndustry(platformUserId, "jewelry")).ok).toBe(true);
    expect((await saveBasics(platformUserId)).ok).toBe(true);
    expect((await onboarding.saveOnboardingStep(platformUserId, { step: "logo" })).ok).toBe(true);
    expect((await onboarding.saveOnboardingStep(platformUserId, { step: "profile" })).ok).toBe(true);

    const state = await onboarding.loadOnboardingState(platformUserId);
    expect(state!.draft.logo).toBeNull();
    expect(state!.draft.completedSteps).toEqual(["industry", "basics", "logo", "profile"]);
    expect(state!.identity.hasNationalId).toBe(false);
    expect(state!.identity.email).toBeNull();
  });

  it("stores and removes a valid canonical logo record", async () => {
    const platformUserId = await newIdentity();
    expect((await saveIndustry(platformUserId, "food_service")).ok).toBe(true);
    expect((await saveBasics(platformUserId)).ok).toBe(true);

    const logo = logoService.buildBusinessLogo({
      mimeType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    await onboarding.saveOnboardingLogo(platformUserId, logo);
    let state = await onboarding.loadOnboardingState(platformUserId);
    expect(state!.draft.logo?.dataUrl).toBe(logo.dataUrl);
    expect(state!.draft.completedSteps).toContain("logo");

    await onboarding.removeOnboardingLogo(platformUserId);
    state = await onboarding.loadOnboardingState(platformUserId);
    expect(state!.draft.logo).toBeNull();
    expect(state!.draft.completedSteps).toContain("logo");
  });
});

describe("optional personal profile", () => {
  it("sets email through #1384, mints a hashed proof, and encrypts the national ID", async () => {
    const platformUserId = await newIdentity("سارا رضایی");
    expect((await saveIndustry(platformUserId, "cosmetics")).ok).toBe(true);
    expect((await saveBasics(platformUserId)).ok).toBe(true);

    const saved = await onboarding.saveOnboardingStep(platformUserId, {
      step: "profile",
      email: "sara@example.invalid",
      nationalId: "0012345679",
    });
    expect(saved.ok).toBe(true);

    const identity = await db.withoutTenantScope("onboarding-test", async () => {
      const { rows } = await db.query<{
        email: string | null;
        email_verified_at: Date | null;
        national_id_ciphertext: string | null;
        national_id_bidx: string | null;
      }>(
        `SELECT email::text AS email, email_verified_at,
                national_id_ciphertext, national_id_bidx
           FROM platform_users WHERE id = $1`,
        [platformUserId],
      );
      return rows[0];
    });
    expect(identity.email).toBe("sara@example.invalid");
    // Setting an address does not verify it.
    expect(identity.email_verified_at).toBeNull();
    expect(identity.national_id_ciphertext).toBeTruthy();
    expect(identity.national_id_ciphertext).not.toContain("0012345679");
    expect(identity.national_id_bidx).toMatch(/^[0-9a-f]{64}$/);

    const read = await profiles.readNationalId({
      platformUserId,
      actorPlatformUserId: platformUserId,
    });
    expect(read).toEqual({ ok: true, nationalId: "0012345679" });

    const proof = await db.withoutTenantScope("onboarding-test", async () => {
      const { rows } = await db.query<{ token_hash: string; email: string }>(
        "SELECT token_hash, email::text AS email FROM platform_email_verifications WHERE platform_user_id = $1",
        [platformUserId],
      );
      return rows[0];
    });
    expect(proof.email).toBe("sara@example.invalid");
    expect(proof.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const actions = await db.withoutTenantScope("onboarding-test", async () => {
      const { rows } = await db.query<{ action: string }>(
        "SELECT action FROM platform_identity_events WHERE platform_user_id = $1 ORDER BY id",
        [platformUserId],
      );
      return rows.map((row) => row.action);
    });
    expect(actions).toContain("email_changed");
    expect(actions).toContain("email_verification_issued");
    expect(actions).toContain("national_id_set");

    const state = await onboarding.loadOnboardingState(platformUserId);
    expect(state!.identity.email).toBe("sara@example.invalid");
    expect(state!.identity.emailVerified).toBe(false);
    expect(state!.identity.hasNationalId).toBe(true);
    // The response shape carries no national ID value at all.
    expect(JSON.stringify(state)).not.toContain("0012345679");
  });

  it("keeps one identity's draft and national ID out of another's", async () => {
    const first = await newIdentity("اول");
    const second = await newIdentity("دوم");
    expect((await saveIndustry(first, "food_service")).ok).toBe(true);
    expect((await saveBasics(first, { businessName: "کسب‌وکار اول" })).ok).toBe(true);
    expect((await onboarding.saveOnboardingStep(first, {
      step: "profile",
      nationalId: "0084575948",
    })).ok).toBe(true);

    expect((await saveIndustry(second, "automotive")).ok).toBe(true);
    expect((await saveBasics(second, { businessName: "کسب‌وکار دوم" })).ok).toBe(true);

    const firstState = await onboarding.loadOnboardingState(first);
    const secondState = await onboarding.loadOnboardingState(second);
    expect(firstState!.draft.businessName).toBe("کسب‌وکار اول");
    expect(secondState!.draft.businessName).toBe("کسب‌وکار دوم");
    expect(secondState!.identity.hasNationalId).toBe(false);

    const forbidden = await profiles.readNationalId({
      platformUserId: first,
      actorPlatformUserId: second,
    });
    expect(forbidden).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("confirmation-gated provisioning", () => {
  it("creates nothing while the owner is still filling the steps", async () => {
    const before = {
      businesses: await count("SELECT count(*)::text AS n FROM businesses"),
      users: await count("SELECT count(*)::text AS n FROM users"),
      locations: await count("SELECT count(*)::text AS n FROM locations"),
      settings: await count("SELECT count(*)::text AS n FROM settings"),
    };

    const platformUserId = await newIdentity();
    expect((await saveIndustry(platformUserId, "food_service")).ok).toBe(true);
    expect((await saveBasics(platformUserId)).ok).toBe(true);
    await onboarding.saveOnboardingStep(platformUserId, { step: "logo" });
    await onboarding.saveOnboardingStep(platformUserId, { step: "profile" });

    expect(await count("SELECT count(*)::text AS n FROM businesses")).toBe(before.businesses);
    expect(await count("SELECT count(*)::text AS n FROM users")).toBe(before.users);
    expect(await count("SELECT count(*)::text AS n FROM locations")).toBe(before.locations);
    expect(await count("SELECT count(*)::text AS n FROM settings")).toBe(before.settings);
  });

  it("provisions one business, branch and owner membership with the captured profile", async () => {
    const platformUserId = await newIdentity("مریم کریمی");
    expect((await saveIndustry(platformUserId, "architecture_construction")).ok).toBe(true);
    expect((await saveBasics(platformUserId, {
      businessName: "دفتر مهندسی سازه",
      locationName: "دفتر مرکزی",
      address: "تهران، سعادت‌آباد",
      phone: "02122334455",
    })).ok).toBe(true);
    const logo = logoService.buildBusinessLogo({
      mimeType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
    });
    await onboarding.saveOnboardingLogo(platformUserId, logo);
    expect((await onboarding.saveOnboardingStep(platformUserId, {
      step: "profile",
      email: "maryam@example.invalid",
    })).ok).toBe(true);

    const result = await onboarding.submitOnboarding(platformUserId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.alreadyProvisioned).toBe(false);

    const business = await db.withoutTenantScope("onboarding-test", async () => {
      const { rows } = await db.query<{
        name: string;
        industry: string;
        slug: string;
      }>("SELECT name, industry, slug::text AS slug FROM businesses WHERE id = $1", [
        result.businessId,
      ]);
      return rows[0];
    });
    expect(business.name).toBe("دفتر مهندسی سازه");
    expect(business.industry).toBe("architecture_construction");

    const location = await db.withoutTenantScope("onboarding-test", async () => {
      const { rows } = await db.query<{
        name: string;
        address: string | null;
        phone: string | null;
      }>(
        "SELECT name, address, phone FROM locations WHERE business_id = $1",
        [result.businessId],
      );
      return rows[0];
    });
    expect(location.name).toBe("دفتر مرکزی");
    expect(location.address).toBe("تهران، سعادت‌آباد");
    expect(location.phone).toBe("02122334455");

    const member = await db.withoutTenantScope("onboarding-test", async () => {
      const { rows } = await db.query<{
        role: string;
        full_name: string;
        email: string | null;
        phone_e164: string | null;
      }>(
        `SELECT role::text AS role, full_name, email::text AS email, phone_e164
           FROM users WHERE id = $1`,
        [result.userId],
      );
      return rows[0];
    });
    expect(member.role).toBe("owner");
    expect(member.full_name).toBe("مریم کریمی");
    expect(member.email).toBe("maryam@example.invalid");
    expect(member.phone_e164).toMatch(/^\+98913/);

    const logoSetting = await db.withoutTenantScope("onboarding-test", async () => {
      const { rows } = await db.query<{ value: { dataUrl?: string } }>(
        "SELECT value FROM settings WHERE business_id = $1 AND key = 'business.logo'",
        [result.businessId],
      );
      return rows[0]?.value;
    });
    expect(logoSetting?.dataUrl).toBe(logo.dataUrl);

    // The existing /setup business step reads exactly this state: the captured
    // industry/name/location/logo are prefilled, and the step is still *not*
    // marked done because #1239 owns the wizard's completion.
    const handoff = await setupState.computeSetupState(result.businessId);
    expect(handoff.business?.name).toBe("دفتر مهندسی سازه");
    expect(handoff.business?.industry).toBe("architecture_construction");
    expect(handoff.location?.name).toBe("دفتر مرکزی");
    expect(handoff.location?.address).toBe("تهران، سعادت‌آباد");
    expect(handoff.location?.phone).toBe("02122334455");
    expect(handoff.logo?.dataUrl).toBe(logo.dataUrl);
    expect(handoff.progress.steps.business).toBeUndefined();
    expect(handoff.progress.completedAt).toBeNull();

    const wizardProgress = await count(
      "SELECT count(*)::text AS n FROM settings WHERE business_id = $1 AND key = 'setup.progress'",
      [result.businessId],
    );
    expect(wizardProgress).toBe(0);

    expect(await count(
      "SELECT count(*)::text AS n FROM business_wallets WHERE business_id = $1",
      [result.businessId],
    )).toBe(0);
    expect(await count(
      "SELECT count(*)::text AS n FROM business_subscriptions WHERE business_id = $1",
      [result.businessId],
    )).toBe(0);
    expect(await count(
      "SELECT count(*)::text AS n FROM business_service_activations WHERE business_id = $1",
      [result.businessId],
    )).toBe(0);

    const draft = await db.withoutTenantScope("onboarding-test", async () => {
      const { rows } = await db.query<{
        submitted_at: Date | null;
        provisioned_business_id: string | null;
      }>(
        `SELECT submitted_at, provisioned_business_id
           FROM platform_onboarding_drafts WHERE platform_user_id = $1`,
        [platformUserId],
      );
      return rows[0];
    });
    expect(draft.submitted_at).toBeInstanceOf(Date);
    expect(draft.provisioned_business_id).toBe(result.businessId);

    // A retry returns the same result and creates nothing else.
    const again = await onboarding.submitOnboarding(platformUserId);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(again.error);
    expect(again.businessId).toBe(result.businessId);
    expect(again.alreadyProvisioned).toBe(true);
    expect(await count(
      "SELECT count(*)::text AS n FROM users WHERE platform_user_id = $1",
      [platformUserId],
    )).toBe(1);
  });

  it("converges concurrent submissions on one business", async () => {
    const platformUserId = await newIdentity();
    expect((await saveIndustry(platformUserId, "automotive")).ok).toBe(true);
    expect((await saveBasics(platformUserId, { businessName: "نمایشگاه امید" })).ok).toBe(true);

    const [first, second] = await Promise.all([
      onboarding.submitOnboarding(platformUserId),
      onboarding.submitOnboarding(platformUserId),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("concurrent submit failed");
    expect(first.businessId).toBe(second.businessId);
    expect(await count(
      "SELECT count(*)::text AS n FROM users WHERE platform_user_id = $1",
      [platformUserId],
    )).toBe(1);
    expect(await count(
      "SELECT count(*)::text AS n FROM businesses WHERE id = $1",
      [first.businessId],
    )).toBe(1);
  });

  it("refuses to create a duplicate for a person who already belongs to a business", async () => {
    const platformUserId = await newIdentity("عضو موجود");
    const existing = await provisioning.provisionBusiness({
      businessName: "کسب‌وکار قبلی",
      ownerName: "عضو موجود",
      email: null,
      platformUserId,
      industry: "jewelry",
    });

    expect((await saveIndustry(platformUserId, "food_service")).ok).toBe(true);
    expect((await saveBasics(platformUserId, { businessName: "کسب‌وکار تکراری" })).ok).toBe(true);

    const before = await count("SELECT count(*)::text AS n FROM businesses");
    const result = await onboarding.submitOnboarding(platformUserId);
    expect(result).toEqual({ ok: false, error: "memberships_exist" });
    expect(await count("SELECT count(*)::text AS n FROM businesses")).toBe(before);
    expect(await count(
      "SELECT count(*)::text AS n FROM users WHERE platform_user_id = $1",
      [platformUserId],
    )).toBe(1);
    expect(existing.businessId).toBeTruthy();
  });

  it("counts an inactive membership as an existing account, not a new business", async () => {
    const platformUserId = await newIdentity("عضو غیرفعال");
    const existing = await provisioning.provisionBusiness({
      businessName: "کسب‌وکار غیرفعال",
      ownerName: "عضو غیرفعال",
      email: null,
      platformUserId,
      industry: "watch",
    });
    await db.withoutTenantScope("onboarding-test", () =>
      db.query("UPDATE users SET is_active = false WHERE id = $1", [existing.userId]),
    );

    expect((await saveIndustry(platformUserId, "food_service")).ok).toBe(true);
    expect((await saveBasics(platformUserId, { businessName: "کسب‌وکار دوم" })).ok).toBe(true);

    const before = await count("SELECT count(*)::text AS n FROM businesses");
    const result = await onboarding.submitOnboarding(platformUserId);
    expect(result).toEqual({ ok: false, error: "memberships_exist" });
    expect(await count("SELECT count(*)::text AS n FROM businesses")).toBe(before);
  });

  it("refuses submission without a required business name", async () => {
    const platformUserId = await newIdentity();
    // The industry step creates the draft row but deliberately does not invent
    // a business name; submission must refuse rather than provision.
    expect((await saveIndustry(platformUserId, "food_service")).ok).toBe(true);

    const before = await count("SELECT count(*)::text AS n FROM businesses");
    const result = await onboarding.submitOnboarding(platformUserId);
    expect(result).toEqual({ ok: false, error: "missing_business_name" });
    expect(await count("SELECT count(*)::text AS n FROM businesses")).toBe(before);
  });
});
