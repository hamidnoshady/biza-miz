/**
 * Issue #902 — resolving "which account sends for this business?" server-side.
 *
 * Before this module, every marketing send used the single platform master key
 * stored in `platform_message_config`. That made the sender shared across
 * tenants and made a cross-tenant send a configuration detail rather than an
 * impossibility. The rule now is:
 *
 *   * a business with an ACTIVE managed child sends through **that child's**
 *     key, resolved by the business id of the row being drained — never from a
 *     request body, never for another tenant;
 *   * a business whose child is not active sends **nothing** through SMS
 *     (fail closed): the outbox rows stay queued, and the tenant sees a
 *     first-party readiness state;
 *   * a business with no managed account at all keeps the pre-#902 platform
 *     key while the rollout is in progress. That legacy path is explicit here,
 *     countable, and removed by deleting one branch.
 *
 * Authentication OTP never comes through here: it keeps its own platform
 * credential (`sms-config.ts`), so disabling Growth, exhausting a tenant's
 * retail credit or suspending a child cannot break login (acceptance #9).
 *
 * The credential table itself is platform-only under RLS, so every read below
 * goes through the documented `kavenegar-credentials` bypass. The account row
 * is tenant-scoped on purpose: a tenant may see its own READINESS, and the
 * readiness view is the contract's provider-free shape.
 */
import { query, withoutTenantScope } from "../db";
import { getRealmSecret } from "../jwt-secret";
import {
  toTenantManagedServiceView,
  type ManagedServiceDetailKey,
  type TenantManagedServiceView,
} from "../managed-services/contract";
import { MANAGED_SERVICES } from "../managed-services/contract";
import {
  CURRENT_CHILD_KEY_VERSION,
  childApiKeyHint,
  decryptChildApiKey,
  encryptChildApiKey,
} from "./secrets";
import type { ProvisionState } from "./provisioning";

export type BusinessAccountRow = {
  id: string;
  business_id: string;
  localid: string;
  username: string;
  provision_state: ProvisionState;
  attention_reason: string | null;
  provider_status: string | null;
  plan_id: number | null;
  pricing_name: string | null;
  sms_farsi_cost_rial: string | number | null;
  sms_english_cost_rial: string | number | null;
  min_allowed_credit_rial: string | number | null;
  sender_lines: string[];
  adopted: boolean;
  provisioned_at: Date | null;
  last_synced_at: Date | null;
  suspended_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * The business's account row in the caller's current scope.
 *
 * Callers are either a tenant-scoped request (the row is its own) or the
 * provisioning service inside `withTenant`. Never use this to read a business
 * other than the scoped one.
 */
export async function readBusinessAccount(businessId: string): Promise<BusinessAccountRow | null> {
  const { rows } = await query<BusinessAccountRow>(
    `SELECT id, business_id, localid, username, provision_state, attention_reason,
            provider_status, plan_id, pricing_name, sms_farsi_cost_rial,
            sms_english_cost_rial, min_allowed_credit_rial, sender_lines, adopted,
            provisioned_at, last_synced_at, suspended_at, created_at, updated_at
       FROM kavenegar_business_accounts
      WHERE business_id = $1`,
    [businessId],
  );
  return rows[0] ?? null;
}

export interface StoredCredential {
  apiKey: string;
  hint: string | null;
  version: number;
}

/**
 * Read and decrypt a child key by an **explicit** account id that the caller
 * already established belongs to the business being served. The bypass exists
 * for this one shape and is documented in `db.ts`.
 */
export async function readAccountApiKey(
  accountId: string,
): Promise<{ ok: true; credential: StoredCredential } | { ok: false; reason: "missing" | "undecryptable" }> {
  const row = await withoutTenantScope("kavenegar-credentials", async () => {
    const { rows } = await query<{
      api_key_enc: Buffer;
      api_key_version: number;
      api_key_hint: string | null;
    }>(
      `SELECT api_key_enc, api_key_version, api_key_hint
         FROM kavenegar_account_credentials WHERE account_id = $1`,
      [accountId],
    );
    return rows[0] ?? null;
  });
  if (!row) return { ok: false, reason: "missing" };

  try {
    const secret = await getRealmSecret("platform");
    const apiKey = decryptChildApiKey(Buffer.from(row.api_key_enc), secret, row.api_key_version);
    return { ok: true, credential: { apiKey, hint: row.api_key_hint, version: row.api_key_version } };
  } catch {
    // Fail closed. Never fall back to the master/platform key: that is exactly
    // the cross-tenant send this module exists to prevent.
    return { ok: false, reason: "undecryptable" };
  }
}

/** Store (or rotate) the child key. The only writer of the credential table. */
export async function writeAccountApiKey(accountId: string, apiKey: string): Promise<string | null> {
  const secret = await getRealmSecret("platform");
  const encrypted = encryptChildApiKey(apiKey, secret);
  const hint = childApiKeyHint(apiKey);
  await withoutTenantScope("kavenegar-credentials", async () => {
    await query(
      `INSERT INTO kavenegar_account_credentials
         (account_id, api_key_enc, api_key_version, api_key_hint, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (account_id) DO UPDATE
         SET api_key_enc = $2,
             api_key_version = $3,
             api_key_hint = $4,
             rotated_at = now(),
             updated_at = now()`,
      [accountId, encrypted, CURRENT_CHILD_KEY_VERSION, hint],
    );
  });
  return hint;
}

export interface BusinessSmsSender {
  mode: "managed" | "legacy_platform";
  /** Null in legacy mode: the platform config already carries the key. */
  apiKey: string | null;
  sender: string;
  state: ProvisionState | null;
  detailKey: ManagedServiceDetailKey;
}

/**
 * Which SMS sender a business's marketing drain may use.
 *
 * `mode: "legacy_platform"` means "no managed account exists yet; keep using
 * the platform configuration". Once the account row exists, the decision is
 * final for that business: only `active` plus a decryptable key yields a
 * sender, and every other state yields none.
 */
export async function resolveBusinessSmsSender(businessId: string): Promise<BusinessSmsSender> {
  const account = await readBusinessAccount(businessId);
  if (!account) {
    return {
      mode: "legacy_platform",
      apiKey: null,
      sender: "",
      state: null,
      detailKey: "provisioning",
    };
  }

  if (account.provision_state !== "active") {
    return {
      mode: "managed",
      apiKey: null,
      sender: "",
      state: account.provision_state,
      detailKey: detailForKey(account.provision_state),
    };
  }

  const key = await readAccountApiKey(account.id);
  if (!key.ok) {
    return {
      mode: "managed",
      apiKey: null,
      sender: "",
      state: account.provision_state,
      detailKey: "needs_support",
    };
  }

  return {
    mode: "managed",
    apiKey: key.credential.apiKey,
    sender: account.sender_lines[0] ?? "",
    state: account.provision_state,
    detailKey: "ready",
  };
}

/**
 * The tenant-facing readiness for managed SMS. Reads no credential and returns
 * only the contract shape — safe to serialise into any tenant response.
 */
export async function getTenantSmsReadiness(businessId: string): Promise<TenantManagedServiceView> {
  const account = await readBusinessAccount(businessId);
  const detailKey = account ? detailForKey(account.provision_state) : "provisioning";
  return toTenantManagedServiceView({
    definition: MANAGED_SERVICES.messagingSms,
    detailKey,
    checkedAt: account?.last_synced_at ?? account?.updated_at ?? null,
  });
}

/** Internal state -> contract reason. Provider wording has no path in. */
export function detailForKey(state: ProvisionState): ManagedServiceDetailKey {
  switch (state) {
    case "active":
      return "ready";
    case "not_provisioned":
    case "pending":
    case "provisioning":
    case "retry_pending":
      return "provisioning";
    case "attention_required":
      return "needs_support";
    case "suspended":
      return "suspended_by_plan";
  }
}

/** True when the row exists: the legacy platform-key fallback no longer applies. */
export async function hasManagedSmsAccount(businessId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM kavenegar_business_accounts WHERE business_id = $1
     ) AS exists`,
    [businessId],
  );
  return rows[0]?.exists ?? false;
}
