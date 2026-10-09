/**
 * Phase 12 — creating a business.
 *
 * Extracted from the first-run bootstrap route so the same code path serves
 * every way a tenant comes into existence: the first-run wizard today, and
 * Phase 15's super-admin console later. Getting a business created *correctly*
 * — identity, membership, branch and branch assignment, all in one
 * transaction — is exactly the thing that should not be written twice.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * parts it leans on (slug generation) are covered in slug.test.ts and the
 * transactional behaviour is covered by the tenancy integration test.
 */
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "@/lib/password-hashing";
import type { PoolClient } from "pg";
import { getPool, withoutTenantScope } from "./db";
import {
  SLUG_FALLBACK,
  slugifyBusinessName,
  subdomainFromBusinessName,
  uniqueSlug,
  validateSubdomain,
} from "./slug";
import { LOCAL_DISABLED_FEATURES, type DeploymentModeName } from "./deployment-mode";
import { SETTING_KEYS, markSetupComplete } from "./settings";
import { coaTemplateForIndustry, nextAccountLevel, type AccountLevel, type TemplateAccount } from "./coa-template";
import { ENABLED_INDUSTRIES, INDUSTRIES, type Industry } from "./industries";
import { industryProfile } from "./industry-profile";
import { lockChartOfAccounts } from "./accounts-service";
import { seedPaymentMethods } from "./payment-methods-service";
import { isMobilePhone, phoneE164 } from "./phone";
import { generateSecret, generateURI } from "otplib";
import { provisionMfaEnrolment } from "./mfa-service";
import { issueRecoveryCodes } from "./mfa-recovery";
import { CURRENT_KEY_VERSION, generateDek, wrapDek } from "./business-keys";
import { getMasterKey } from "./master-key";
import { totpQrDataUrl } from "./totp-qr";
import { createOwnerActivation } from "./owner-activation";
import { randomBytes } from "node:crypto";

export interface ProvisionBusinessInput {
  businessName: string;
  locationName?: string;
  address?: string | null;
  phone?: string | null;
  ownerName: string;
  ownerPhone?: string | null;
  email: string;
  /**
   * Ignored when `ownerActivation` is set — that path deliberately has no
   * password to pass, because nobody but the owner may choose it.
   */
  password?: string;
  timezone?: string;
  /** Defaults to 'food_service' when omitted — every business before Phase 21 is one. */
  industry?: Industry;
  /**
   * Seed the default F&B chart of accounts as part of provisioning.
   *
   * The first-run wizard leaves this off — it walks the owner through the
   * (editable) chart as a deliberate step. Phase 15's console turns it on, so
   * a business an operator provisions is immediately *working*: the ledger's
   * well-known accounts exist, and the owner can log straight in and sell
   * without a setup detour. See coa-template.ts for the template itself.
   */
  seedChartOfAccounts?: boolean;
  /**
   * How this install relates to the online platform. 'local' stamps the
   * deployment-mode setting and seeds `business_features` overrides turning
   * off everything that needs the platform to work (see
   * LOCAL_DISABLED_FEATURES). Absent means 'connected', which writes nothing
   * — so every existing caller (the online console, public signup) is
   * unchanged.
   */
  deploymentMode?: DeploymentModeName;
  /**
   * The business's public host label — the English name a super-admin types by
   * hand in the console's add form, which becomes `{subdomain}.$ROOT_DOMAIN`.
   *
   * Not derived from the business name when it is supplied: a transliterated
   * Persian name makes a poor address, and this one is going to be printed on
   * a receipt and read down a phone. A supplied label is taken verbatim, and a
   * collision is an error the admin resolves rather than something quietly
   * suffixed into `acme-2`.
   *
   * It stays optional for the entry points that have no admin to ask — the
   * first-run wizard and public signup, both of which run on installs with no
   * root domain — where it falls back to the name-derived form.
   */
  subdomain?: string;
  /**
   * Issue #755 §14 — create the owner with an *unusable* password and hand back
   * a single-use activation link instead.
   *
   * The platform console turns this on: an operator should never know, choose
   * or print a tenant owner's permanent credential. The owner sets their own
   * password and receives their own second factor and recovery codes when they
   * follow the link (see owner-activation.ts). The setup wizard and public
   * signup leave it off, because there the person choosing the password *is*
   * the owner, sitting in front of the form.
   */
  ownerActivation?: boolean;
  /** The platform admin provisioning this business, recorded on the
   * activation link so "who invited this owner in" survives it being used. */
  createdBy?: string | null;
  /** Internal-only lifecycle marker. Ordinary provisioning must leave this omitted. */
  ownershipKind?: "platform_internal";
  /**
   * `ownerActivation` only: the email already has a platform login and the
   * caller has acknowledged that it is the same person. Without it the
   * provisioning is refused rather than silently attaching a business to
   * somebody's account.
   */
  confirmExistingOwner?: boolean;
  /**
   * Issue #808 §4 — this call provisions a business that is *finished*:
   * stamp `setup.progress.completedAt` in the same transaction, the way
   * pairing does, so the owner is never routed into the first-run wizard.
   *
   * Set by the callers that promise a ready-to-use business (the platform
   * console, which also seeds the chart of accounts, and the platform's own
   * company workspace). Deliberately NOT set by the first-run bootstrap or
   * public signup: those *are* the wizard's front doors, and their business
   * must stay incomplete until the owner reaches Finish.
   */
  completeSetup?: boolean;
}

export interface ProvisionedBusiness {
  businessId: string;
  businessSlug: string;
  /** Phase 23 — the origin the new business is served from. */
  businessSubdomain: string;
  locationId: string;
  /** users.id — the owner's membership in the new business. */
  userId: string;
  platformUserId: string;
  /**
   * True when the email had no platform login and one was created for it.
   * `false` means the business was added to a person who already had one — the
   * multi-business case — and therefore no activation link was issued, because
   * they already have credentials nobody else needs to know.
   */
  ownerIdentityCreated: boolean;
  /**
   * The one-time link the operator hands to the owner. Present only on the
   * activation path; the plaintext is never stored and cannot be re-read.
   */
  ownerActivation?: { token: string; expiresAt: Date };
  /**
   * Phase 24 Wave 2 — the Owner's first second factor, returned exactly once.
   *
   * A `local` install has no internet and therefore no SMS, so provisioning
   * enrols TOTP and hands the secret back for the caller to *show*. Until this
   * was surfaced, a local Owner was enrolled in a factor whose secret nothing
   * ever displayed — a 2FA requirement with no possible way to satisfy it.
   * Present only on the local path; a connected install enrols SMS to
   * `ownerPhone` instead and has nothing secret to show.
   */
  totpSecret?: string;
  totpUrl?: string;
  /** The `totpUrl` as a scannable PNG data URL. */
  totpQr?: string | null;
  /** Ten single-use recovery codes, plaintext, shown once and never again. */
  recoveryCodes?: string[];
}

/** An email already registered, offered a *different* password. */
export class EmailPasswordMismatchError extends Error {
  constructor() {
    super("email_password_mismatch");
  }
}

/**
 * The requested subdomain belongs to another business (or to one of its old
 * hosts, which still redirect and so cannot be handed out).
 *
 * Only ever raised for a label the caller asked for by name. Appending `-2` to
 * someone's typed address would be worse than refusing: they would leave the
 * form believing they had provisioned `acme.example.com` and hand that address
 * to a customer.
 */
export class SubdomainTakenError extends Error {
  constructor() {
    super("subdomain_taken");
  }
}

/**
 * `ownerActivation` was asked for on an email that already has a platform
 * login, and the caller has not acknowledged it.
 *
 * Issue #755 §14: attaching a second (or third) business to an existing person
 * is the normal group-owner case, but it is still an action on *their*
 * account — so it is never silent. The console surfaces this as "this address
 * already belongs to a platform user; continue?" and repeats the request with
 * `confirmExistingOwner`.
 */
export class ExistingOwnerConfirmationRequiredError extends Error {
  constructor() {
    super("email_already_registered");
  }
}

/**
 * `ownerActivation` was asked for without a mobile number to prove control of.
 *
 * Issue #755 §14 makes redemption require a one-time code texted to the owner,
 * because the activation link itself travels by hand — through the operator. A
 * link without a code would be redeemable by that operator, which is the exact
 * credential handover the flow exists to remove. So a business that is
 * provisioned for activation needs a number *before* it is created, rather than
 * getting a link that can never be honoured.
 */
export class OwnerPhoneRequiredError extends Error {
  constructor() {
    super("owner_phone_required");
  }
}

export const DEFAULT_LOCATION_NAME = "شعبه مرکزی";

/**
 * Whether this deployment accepts self-service business registration.
 *
 * Off unless set to exactly "true", and deliberately so: Phase 12 makes a
 * deployment *capable* of holding many businesses, but who may create one is a
 * product decision, not a consequence of the schema. An on-premise café
 * install and a hosted platform want opposite answers. Phase 15's super-admin
 * console provisions businesses regardless of this setting.
 */
export function publicSignupEnabled(): boolean {
  return process.env.ALLOW_PUBLIC_SIGNUP === "true";
}

/** Raw request body shared by first-run bootstrap and self-service signup. */
export interface ProvisionRequestBody {
  businessName?: string;
  locationName?: string;
  address?: string;
  phone?: string;
  ownerName?: string;
  ownerPhone?: string;
  email?: string;
  password?: string;
  industry?: string;
  /** The public host label, typed in English. Derived from the name when omitted. */
  subdomain?: string;
  /**
   * The email already has a platform login and the caller has acknowledged that
   * it is the same person. Never sent by the interactive wizards; only the
   * console's activation path uses it, after its first attempt was refused.
   */
  confirmExistingOwner?: boolean;
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validates and normalises a provisioning request.
 *
 * Lives here rather than in the route because Next.js route modules may only
 * export handlers — and because both entry points (bootstrap and signup) must
 * apply exactly the same rules. Pure, so it is unit-tested directly.
 *
 * `deploymentMode` decides whether the Owner's mobile is required, because it
 * decides which second factor Phase 24 enrols them with: a connected install
 * gets `sms_otp` and therefore needs a number to send to, while a local one
 * gets TOTP (no signal in an offline café, so an SMS-only Owner would be
 * locked out of their own till the first time the line dropped). Absent, it
 * reads as `connected` — matching `resolveDeploymentMode`, where an install
 * predating the setting is a connected one, and failing closed rather than
 * silently skipping the enrolment.
 */
export function validateProvisionBody(
  body: ProvisionRequestBody,
  options: {
    requireSubdomain?: boolean;
    deploymentMode?: DeploymentModeName;
    /** Issue #755 §14 — no password is supplied or accepted on this path. */
    ownerActivation?: boolean;
  } = {},
): { input: ProvisionBusinessInput; error: null } | { input: null; error: string } {
  const businessName = body.businessName?.trim();
  const ownerName = body.ownerName?.trim();
  const email = body.email?.trim().toLowerCase();
  const password = body.password ?? "";

  if (!businessName || !ownerName || !email) {
    return { input: null, error: "missing_fields" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { input: null, error: "invalid_email" };
  }
  if (!options.ownerActivation) {
    if (!password) return { input: null, error: "missing_fields" };
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { input: null, error: "weak_password" };
    }
  }

  // Checked after the fields above, not before them: an empty form should say
  // "fill everything in", not single out the one field the visitor has never
  // been asked for on this deployment before.
  let ownerPhone: string | null = null;
  // Required on the activation path regardless of deployment mode: redemption
  // needs a code sent to this number (see OwnerPhoneRequiredError), so there is
  // no such thing as an activation link without one. Mobile only — this is who
  // the SMS OTP goes to, and a landline can't receive one.
  if (options.deploymentMode !== "local" || options.ownerActivation) {
    if (!isMobilePhone(body.ownerPhone)) return { input: null, error: "invalid_owner_phone" };
    ownerPhone = phoneE164(body.ownerPhone);
  }

  const industry = (body.industry?.trim() || "food_service") as Industry;
  if (!INDUSTRIES.includes(industry)) {
    return { input: null, error: "invalid_industry" };
  }
  if (!ENABLED_INDUSTRIES.includes(industry)) {
    return { input: null, error: "industry_not_available" };
  }

  // The subdomain is validated as a DNS label rather than silently normalised,
  // because the admin typed it and is going to hand the resulting URL to a
  // customer. `requireSubdomain` is what the console passes: on a multi-tenant
  // deployment the address is a decision, not a by-product of the name. The
  // entry points that leave it off (first-run wizard, public signup) have
  // nobody to ask, and fall back to the derived form in provisionBusiness.
  const subdomain = body.subdomain?.trim().toLowerCase();
  if (subdomain) {
    const invalid = validateSubdomain(subdomain);
    if (invalid) return { input: null, error: invalid };
  } else if (options.requireSubdomain) {
    return { input: null, error: "missing_subdomain" };
  }

  return {
    input: {
      businessName,
      locationName: body.locationName?.trim() || undefined,
      address: body.address?.trim() || null,
      phone: body.phone?.trim() || null,
      ownerName,
      ownerPhone,
      email,
      password: options.ownerActivation ? undefined : password,
      industry,
      subdomain: subdomain || undefined,
      ownerActivation: options.ownerActivation,
    },
    error: null,
  };
}

/**
 * Creates a business, its first branch, and its owner, atomically.
 *
 * The email may already belong to the platform — that is the cross-business
 * identity case, and it is the normal way a group owner opens their second
 * café. When it does, the existing password must be supplied: adding a
 * business to someone's account is an action on *their* identity, so it has to
 * be authenticated as them rather than merely asserted.
 *
 * Runs bypassed throughout, because it creates the tenant that scoping would
 * otherwise have to already exist for.
 */
export async function provisionBusiness(
  input: ProvisionBusinessInput,
): Promise<ProvisionedBusiness> {
  const businessName = input.businessName.trim();
  const locationName = input.locationName?.trim() || DEFAULT_LOCATION_NAME;
  const ownerName = input.ownerName.trim();
  const email = input.email.trim().toLowerCase();
  // Normalised here rather than trusted from the caller. `users.phone_e164` is
  // an E.164 column (it is the address an SMS one-time code is sent to), and
  // the owner-activation flow reads it back to bind the second factor — so a
  // caller that skipped `validateProvisionBody` would otherwise store a form
  // -shaped `0912…` in a column everything downstream treats as `+98912…`.
  const ownerPhone = input.ownerPhone ? phoneE164(input.ownerPhone) : null;
  // Checked before the transaction opens: an activation that could never be
  // redeemed must not create a business. See OwnerPhoneRequiredError.
  if (input.ownerActivation && !ownerPhone) throw new OwnerPhoneRequiredError();

  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      // Serialises slug allocation and the identity upsert against a
      // concurrent signup for the same email — neither is protected by a row
      // lock, because in both cases the row may not exist yet.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('business_provisioning'))");

      const { rows: slugRows } = await client.query<{ slug: string; subdomain: string }>(
        "SELECT slug::text AS slug, subdomain::text AS subdomain FROM businesses",
      );
      const slug = uniqueSlug(
        slugifyBusinessName(businessName),
        slugRows.map((r) => r.slug),
      );

      // The public host, allocated in the same advisory-locked transaction as
      // the slug so two concurrent signups can't claim one origin.
      //
      // A requested label is taken exactly as typed and refused if it is
      // spoken for; only the derived fallback is allowed to settle a collision
      // by suffixing. The namespace checked is the subdomain column plus the
      // alias table, never the slug column: the two are independent the moment
      // anyone renames a subdomain, and handing out a name an alias still
      // redirects would hijack the old address of another business.
      const requested = input.subdomain?.trim().toLowerCase();
      const { rows: aliasRows } = await client.query<{ alias: string }>(
        "SELECT alias::text AS alias FROM business_subdomain_aliases",
      );
      const takenHosts = [...slugRows.map((r) => r.subdomain), ...aliasRows.map((r) => r.alias)];

      let subdomain: string;
      if (requested) {
        if (takenHosts.some((h) => h.toLowerCase() === requested)) throw new SubdomainTakenError();
        subdomain = requested;
      } else {
        subdomain = uniqueSlug(subdomainFromBusinessName(businessName) || SLUG_FALLBACK, takenHosts);
      }

      const { rows: existingIdentity } = await client.query<{
        id: string;
        password_hash: string;
        is_active: boolean;
      }>("SELECT id, password_hash, is_active FROM platform_users WHERE email = $1", [email]);

      const ownerIdentityCreated = existingIdentity.length === 0;
      let platformUserId: string;
      if (existingIdentity[0]) {
        const identity = existingIdentity[0];
        if (!identity.is_active) throw new EmailPasswordMismatchError();
        if (input.ownershipKind === "platform_internal") {
          // The platform-company member mapping is the authorization proof.
          // Never ask an infrastructure operator for a tenant password and
          // never manufacture an impersonation grant for permanent access.
          platformUserId = identity.id;
        } else if (input.ownerActivation) {
          // Nobody types their password for an inbound business, so this is not
          // an authentication but a confirmation. It still refuses to attach a
          // business to somebody's account silently.
          if (!input.confirmExistingOwner) throw new ExistingOwnerConfirmationRequiredError();
          platformUserId = identity.id;
        } else {
          // The password-choosing paths are a person adding a business to their
          // own account, and still have to prove that is who they are.
          if (!(await bcrypt.compare(input.password ?? "", identity.password_hash))) {
            throw new EmailPasswordMismatchError();
          }
          platformUserId = identity.id;
        }
      } else {
        // On the activation path nobody ever knows this password — not the
        // operator, not this code. It is 32 random bytes, replaced by the owner
        // at the activation link, and any comparison against it fails closed.
        const secret = input.ownerActivation || input.ownershipKind === "platform_internal"
          ? randomBytes(32).toString("hex")
          : (input.password ?? "");
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO platform_users (email, password_hash, full_name)
           VALUES ($1, $2, $3) RETURNING id`,
          [email, await bcrypt.hash(secret, BCRYPT_COST), ownerName],
        );
        platformUserId = rows[0].id;
      }

      const { rows: bizRows } = await client.query<{ id: string }>(
        `INSERT INTO businesses (name, slug, subdomain, timezone, industry, ownership_kind)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          businessName,
          slug,
          subdomain,
          input.timezone ?? "Asia/Tehran",
          input.industry ?? "food_service",
          input.ownershipKind ?? "customer",
        ],
      );
      const businessId = bizRows[0].id;

      const { rows: locRows } = await client.query<{ id: string }>(
        `INSERT INTO locations (business_id, name, address, phone, timezone)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          businessId,
          locationName,
          input.address?.trim() || null,
          input.phone?.trim() || null,
          input.timezone ?? "Asia/Tehran",
        ],
      );
      const locationId = locRows[0].id;

      // location_id stays NULL: an owner reaches every branch of their
      // business, and pinning them to the first one would be wrong the moment
      // a second branch exists.
      //
      // Phase 42 — the owner's login phone rides along when one was given
      // (it is the same `ownerPhone` the connected path enrols SMS 2FA
      // against), stored unverified like every provisioned number: the owner
      // proves it with an OTP at their first door login or from the security
      // center, and only then does it open the phone login.
      const { rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO users (business_id, platform_user_id, role, full_name, email, phone_e164, location_id)
         VALUES ($1, $2, 'owner', $3, $4, $5, NULL) RETURNING id`,
        [businessId, platformUserId, ownerName, email, ownerPhone],
      );
      const userId = userRows[0].id;

      await client.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, locationId],
      );

      if (input.seedChartOfAccounts) {
        await seedChartOfAccounts(client, businessId, input.industry ?? "food_service");
      }

      // The payment ways the till offers (migration 0091), in the same
      // transaction as the business itself: a shop that exists but cannot say
      // «نقدی» cannot take money. Seeded rather than implied so the owner can
      // rename and reorder them from day one.
      await seedPaymentMethods(client, businessId, input.industry ?? "food_service");

      // Phase 25 — features this trade has no use for start off, in the same
      // transaction that creates the business so there is never a window where
      // a jewellery shop looks like a café. They remain individually flippable
      // from the platform console: an industry default, not a prohibition.
      await disableFeatures(
        client,
        businessId,
        industryProfile(input.industry ?? "food_service").defaultDisabledFeatures,
      );

      let totpSecret: string | undefined;
      let totpUrl: string | undefined;
      let totpQr: string | null | undefined;

      // Phase 42 — the phone-OTP login policy starts *enforced* for a
      // business created after this feature, stamped in the same transaction:
      // a brand-new business has no legacy staff to protect, and every member
      // it ever gains verifies a number at their first door login anyway.
      // (Migration 0139 gave the businesses already running on an install
      // their 14-day window instead; SMS-less installs stay unenforced at
      // runtime until a Kavenegar key exists — see phone-otp-policy.ts.)
      await client.query(
        `INSERT INTO settings (business_id, location_id, key, value)
         VALUES ($1, NULL, $2, $3)`,
        [
          businessId,
          SETTING_KEYS.phoneOtpPolicy,
          JSON.stringify({ enforcedAt: new Date().toISOString() }),
        ],
      );

      // Issue #755 §14 — on the activation path the second factor and the
      // recovery codes are minted when the *owner* redeems their link
      // (owner-activation.ts), in their own browser, and shown only to them.
      // Creating them here is what used to force the operator to hold the
      // owner's credentials.
      let recoveryCodes: string[] | undefined;
      let ownerActivation: { token: string; expiresAt: Date } | undefined;
      if (!input.ownerActivation && input.ownershipKind !== "platform_internal") {
        if (input.deploymentMode === "local") {
          await client.query(
            `INSERT INTO settings (business_id, location_id, key, value)
             VALUES ($1, NULL, $2, $3)`,
            [businessId, SETTING_KEYS.deploymentProfile, JSON.stringify({ profile: "local", pairedAt: null })],
          );
          await disableFeatures(client, businessId, LOCAL_DISABLED_FEATURES);

          totpSecret = generateSecret();
          totpUrl = generateURI({
            label: email,
            // Phase 42 — the business's own name, so the entry in the
            // authenticator app is tellable apart from every other business
            // this person holds an entry for (see mfa-enrol.ts's TOTP_ISSUER).
            issuer: businessName,
            secret: totpSecret,
            strategy: "totp"
          });
          totpQr = await totpQrDataUrl(totpUrl);
          await provisionMfaEnrolment(client, "platform_user", platformUserId, "totp", true, null, Buffer.from(totpSecret || ""));
        } else {
          await provisionMfaEnrolment(client, "platform_user", platformUserId, "sms_otp", true, ownerPhone, null);
        }

        // Both paths get recovery codes, in the same transaction as the
        // enrolment they back: a rolled-back provision must not leave live codes
        // for a business that was never created. They are the only way back in
        // for an Owner whose phone (or authenticator) is gone, so an enrolment
        // without them is the lockout this wave exists to prevent.
        recoveryCodes = await issueRecoveryCodes("platform_user", platformUserId, client);
      } else if (input.deploymentMode === "local") {
        // The local deployment profile is a property of the install, not of the
        // credentials, so it is still stamped here; only the enrolment moves to
        // the owner's activation.
        await client.query(
          `INSERT INTO settings (business_id, location_id, key, value)
           VALUES ($1, NULL, $2, $3)`,
          [businessId, SETTING_KEYS.deploymentProfile, JSON.stringify({ profile: "local", pairedAt: null })],
        );
        await disableFeatures(client, businessId, LOCAL_DISABLED_FEATURES);
      }

      // Issue #808 §4 — a provisioned-ready business is formally finished
      // before its owner ever logs in. Same canonical transition
      // /api/setup/complete performs; written inside this transaction so a
      // rolled-back provision cannot leave a stray completion marker.
      if (input.completeSetup) {
        await markSetupComplete(businessId, client);
      }

      // Phase 24 Wave 3 — mint the business's data-encryption key inside the
      // same transaction as the business, so the very first customer written
      // is written encrypted and there is never a window where a business
      // exists without a key. Wrapped under the install's KEK; a no-op on an
      // install that has not configured one.
      const kek = getMasterKey();
      if (kek) {
        await client.query(
          `INSERT INTO business_encryption_keys (business_id, key_version, wrapped_dek)
           VALUES ($1, $2, $3) ON CONFLICT (business_id) DO NOTHING`,
          [businessId, CURRENT_KEY_VERSION, wrapDek(generateDek(), kek)],
        );
      }

      // The owner's activation link, inside the same transaction as the
      // business: a rolled-back provision must not leave a live link, and a
      // committed one must never be missing the only way in.
      //
      // Not issued when the email already had a login: that person's credentials
      // are theirs already, the operator learns nothing about them, and asking
      // them to "activate" an account they have used for years would be a lie.
      if (input.ownerActivation && ownerIdentityCreated) {
        ownerActivation = await createOwnerActivation(client, {
          businessId,
          platformUserId,
          userId,
          email,
          createdBy: input.createdBy ?? null,
        });
      }

      await client.query("COMMIT");
      return {
        businessId,
        businessSlug: slug,
        businessSubdomain: subdomain,
        locationId,
        userId,
        platformUserId,
        ownerIdentityCreated,
        ownerActivation,
        totpSecret,
        totpUrl,
        totpQr,
        recoveryCodes,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Seed `business_features` "off" overrides for a list of flags.
 *
 * One loop for both callers that need it — the industry defaults every
 * business gets, and the extra set a local-only install cannot deliver — so the
 * upsert semantics (skip a flag that is not in the catalogue; overwrite an
 * existing override) are written once. An override is a default, not a lock:
 * the platform console can flip any of these back on afterwards.
 */
export async function disableFeatures(
  client: PoolClient,
  businessId: string,
  flagKeys: readonly string[],
): Promise<void> {
  for (const flagKey of flagKeys) {
    await client.query(
      `INSERT INTO business_features (business_id, flag_key, enabled)
       SELECT $1, $2, false
        WHERE EXISTS (SELECT 1 FROM feature_flags WHERE key = $2)
       ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = false, updated_at = now()`,
      [businessId, flagKey],
    );
  }
}

/**
 * Insert the industry-appropriate default chart of accounts for a business.
 *
 * Runs inside the caller's transaction (so a failure rolls the whole business
 * back at provision time) and mirrors the ordering logic of
 * `/api/setup/accounts`: parents before children, so `parent_id` can be
 * resolved from a code→id map built as we go. Each template is already
 * topologically sane (roots first), but resolving by code rather than array
 * position keeps it correct even if a template is later reordered.
 *
 * **Idempotent by code**, which is what makes it safe for the second caller,
 * `changeBusinessIndustry` (platform-service.ts): an account whose code the
 * business already has is left exactly as it is — name, type and any postings
 * against it untouched — and only the codes missing from the new industry's
 * template are inserted. Seeding is therefore purely additive; nothing an
 * operator already uses is rewritten or removed.
 *
 * Returns the codes it actually inserted, so the console can report what a
 * change did.
 */
export async function seedChartOfAccounts(
  client: PoolClient,
  businessId: string,
  industry: Industry,
): Promise<string[]> {
  // A hierarchy writer, so it takes the canonical chart-of-accounts lock
  // (issue #824 review item 6). `changeBusinessIndustry` re-runs this against
  // a business that is already live and being used, where a concurrent edit is
  // entirely possible; in the provisioning case the lock is uncontended and
  // costs one statement. There is deliberately no "we might be alone" branch —
  // one rule for every writer is easier to keep true than a list of exceptions.
  await lockChartOfAccounts(client, businessId);
  const { rows: existing } = await client.query<{ id: string; code: string; level: AccountLevel }>(
    "SELECT id, code, level FROM accounts WHERE business_id = $1",
    [businessId],
  );
  const idByCode = new Map<string, string>(existing.map((a) => [a.code, a.id]));
  const levelByCode = new Map<string, AccountLevel>(existing.map((a) => [a.code, a.level]));
  const inserted: string[] = [];

  const pending = [...coaTemplateForIndustry(industry)].filter((a) => !idByCode.has(a.code));
  while (pending.length > 0) {
    const ready = pending.filter((a) => !a.parentCode || idByCode.has(a.parentCode));
    // The template is a fixed, cycle-free constant and every parentCode in it
    // is either already in the business or earlier in the same template, so
    // `ready` can't be empty; it's never nested past four levels, so
    // nextAccountLevel never returns null here.
    for (const a of ready) {
      const level = nextAccountLevel(a.parentCode ? (levelByCode.get(a.parentCode) ?? null) : null)!;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [businessId, a.parentCode ? idByCode.get(a.parentCode) : null, a.code, a.name, a.type, level, a.isContra ?? false],
      );
      idByCode.set(a.code, rows[0].id);
      levelByCode.set(a.code, level);
      inserted.push(a.code);
      pending.splice(pending.indexOf(a), 1);
    }
  }
  return inserted;
}

// Issue #755 §20: `hasAnyBusiness` used to live here, documented as driving the
// first-run flow. It did not — the setup flow asks `hasAnyUser`
// (src/lib/setup-state.ts) — and no caller existed anywhere in src, integration
// or scripts. Deleted rather than kept "in case": a helper that answers a
// question nothing asks is one more thing to keep correct.
