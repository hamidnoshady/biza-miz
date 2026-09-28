/**
 * Typed access to the key/value `settings` table.
 * location_id NULL = business-wide setting (all wizard settings are business-wide).
 */
import { query } from "./db";

export const SETTING_KEYS = {
  /** { name, currencyDisplay: 'toman'|'rial', language: 'fa', calendar: 'jalali' } */
  businessPrefs: "business.prefs",
  /** { legalName, taxId, email, website, receiptFooter } — operational business profile */
  businessProfile: "business.profile",
  /**
   * BusinessLogo (src/lib/business-logo.ts) — { dataUrl, mimeType, byteLength,
   * updatedAt }. The logo printed on receipts and invoices, stored inline as a
   * data URL because the print agent renders with no session and often no
   * route back to the app server (see that file's header). Absent until a
   * business uploads one.
   */
  businessLogo: "business.logo",
  /** { method: 'fifo'|'lifo'|'weighted_average', system?: 'perpetual'|'periodic', lockedAt: string|null } */
  costing: "inventory.costing",
  /** { defaultRate: number } — percent, applied to new menu categories */
  tax: "tax.config",
  /** { steps: Record<string, string>, completedAt: string|null } — step → ISO time done */
  wizardProgress: "setup.progress",
  /** { centralUrl, token, enabled } — this location's push target (Phase 9) */
  rollupConfig: "rollup.config",
  /** { lastAttemptAt, lastSuccessAt, lastSuccessDay, lastError } — local push status (Phase 9) */
  rollupSyncState: "rollup.sync_state",
  /** { remoteUrl, token, enabled, batchSize } — bidirectional server-to-server sync target (Phase 11) */
  serverSyncConfig: "server_sync.config",
  /** ServerSyncState (src/lib/server-sync.ts) — push/pull high-water marks + status (Phase 11) */
  serverSyncState: "server_sync.state",
  /** BackupConfig (src/lib/backup.ts) — schedule/retention/cloud settings (Phase 10) */
  backupConfig: "backup.config",
  /** PricingConfig — menu cost-plus margin, overhead policy and cost-drift threshold */
  pricing: "pricing.config",
  /** AppUpdateStatus — local cache of the authenticated Desktop release target and separated Central provenance */
  appUpdateStatus: "app_update.status",
  /** Desktop update check/download policy; executable installation is always explicit. */
  desktopUpdatePolicy: "desktop_update.policy",
  /** DeploymentProfileRecord — { profile: 'cloud'|'hybrid'|'local', pairedAt }. */
  deploymentProfile: "deployment.profile",
  /** @deprecated Pre-0172 compatibility key. Read only; new code writes deployment.profile. */
  deploymentMode: "deployment.mode",
  /** OnlinePlatformsConfig (src/lib/online-platforms-service.ts) — per-platform commission %, e.g. SnapFood (issue #160 §4) */
  onlinePlatforms: "online_platforms.config",
  /**
   * MfaPolicy (src/lib/mfa-policy.ts) — { requireForManagers: boolean }.
   *
   * Phase 24 Wave 2's documented opt-in: a business may extend the two-factor
   * requirement from `owner` to `manager`. Off by default, and absent from the
   * table until someone turns it on, so every existing business keeps exactly
   * today's behaviour.
   */
  mfaPolicy: "mfa.policy",
  /**
   * PhoneOtpPolicy (src/lib/phone-otp-policy.ts) — { enforcedAt: string | null }.
   *
   * Phase 42's adoption window: from `enforcedAt`, every member of this
   * business signs in with a phone-OTP (Kavenegar) at least once every 7
   * days, with the PIN quick-login valid only inside that window. Migration
   * 0139 stamped `now() + 14 days` for every business already running on the
   * install; provisionBusiness stamps `now` for businesses created after it.
   * Absent row = the feature has never been turned on for this business.
   */
  phoneOtpPolicy: "auth.phoneOtp",
} as const;

export async function getSetting<T>(businessId: string, key: string): Promise<T | null> {
  const { rows } = await query<{ value: T }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = $2`,
    [businessId, key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(businessId: string, key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [businessId, key, JSON.stringify(value)],
  );
}

export interface WizardProgress {
  steps: Record<string, string>;
  completedAt: string | null;
}

export async function getWizardProgress(businessId: string): Promise<WizardProgress> {
  const p = await getSetting<WizardProgress>(businessId, SETTING_KEYS.wizardProgress);
  return p ?? { steps: {}, completedAt: null };
}

export async function markStepDone(businessId: string, step: string): Promise<WizardProgress> {
  const progress = await getWizardProgress(businessId);
  progress.steps[step] = new Date().toISOString();
  await setSetting(businessId, SETTING_KEYS.wizardProgress, progress);
  return progress;
}
