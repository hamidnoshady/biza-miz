/**
 * Typed access to the key/value `settings` table.
 * location_id NULL = business-wide setting (all wizard settings are business-wide).
 */
import type { PoolClient } from "pg";
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
  /**
   * WizardProgress (see below) — { steps: Record<string, string>,
   * completedAt: string|null }, step → ISO time done.
   *
   * `completedAt` is the canonical "the onboarding wizard has formally
   * finished" marker (stamped only by POST /api/setup/complete, provisioning
   * and pairing). `steps` records which steps were visited and drives the
   * wizard's ordering/`/setup` landing; it is *not* what makes a business
   * operational, and `isSetupComplete()` does not read it — readiness is
   * derived from the domain data (src/lib/setup-state.ts).
   */
  wizardProgress: "setup.progress",
  /** { centralUrl, token, enabled } — this location's push target (Phase 9) */
  rollupConfig: "rollup.config",
  /** { lastAttemptAt, lastSuccessAt, lastSuccessDay, lastError } — local push status (Phase 9) */
  rollupSyncState: "rollup.sync_state",
  /** { remoteUrl, token, enabled, batchSize } — bidirectional server-to-server sync target (Phase 11) */
  serverSyncConfig: "server_sync.config",
  /** ServerSyncState (src/lib/server-sync.ts) — push/pull high-water marks + status (Phase 11) */
  serverSyncState: "server_sync.state",
  /** MasterSyncState (src/lib/master-sync-transport.ts) — master-data feed cursors, desktop side (migration 0190) */
  masterSyncState: "server_sync.master_state",
  /** DriftState (src/lib/sync-health-service.ts) — last comparison of settled figures with the central server */
  syncDriftState: "server_sync.drift_state",
  /** Phase 45: the desktop's copy of the cloud's branch settings and switches (site-profile-service.ts). */
  siteProfileState: "server_sync.site_profile_state",
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

/**
 * Marks one step done, in a single atomic statement.
 *
 * Deliberately not "read the whole row, mutate, write the whole row": two
 * concurrent callers (a wizard step's own save, a skip, a repair pass, or two
 * staff on two devices) both read the same old object and the later write then
 * erases the other's marker. The `||` below is evaluated by PostgreSQL against
 * the row as it is *at update time*, so every caller's own step is merged into
 * whatever the row currently holds — including a `completedAt` stamped by a
 * concurrent `/api/setup/complete`.
 *
 * Pass `client` to participate in a caller's transaction (the opening step
 * does: its marker must commit with the accounting rows it describes, or not
 * at all).
 */
export async function markStepDone(
  businessId: string,
  step: string,
  client?: PoolClient,
): Promise<WizardProgress> {
  const sql = `
    INSERT INTO settings (business_id, location_id, key, value)
    VALUES ($1, NULL, $2, jsonb_build_object(
      'steps', jsonb_build_object($3::text, to_jsonb(now()::text)),
      'completedAt', NULL))
    ON CONFLICT (business_id, location_id, key) DO UPDATE
    SET value = COALESCE(settings.value, '{}'::jsonb) || jsonb_build_object(
          'steps',
          COALESCE(settings.value -> 'steps', '{}'::jsonb)
            || jsonb_build_object($3::text, to_jsonb(now()::text))),
        updated_at = now()
    RETURNING value`;
  const params = [businessId, SETTING_KEYS.wizardProgress, step];
  const { rows } = client
    ? await client.query<{ value: WizardProgress }>(sql, params)
    : await query<{ value: WizardProgress }>(sql, params);
  return rows[0]?.value ?? { steps: { [step]: new Date().toISOString() }, completedAt: null };
}

/**
 * Reconciles step markers with the persisted domain state, atomically.
 *
 * Setup readiness is derived from real data (a chart of accounts exists, a
 * costing method is set, a sellable item exists for F&B), so a marker that
 * disagrees with that data is stale in one of two ways: a failed progress write
 * left a step unmarked although its data committed, or an older flow marked a
 * step done on weaker evidence (the menu step used to complete on creating a
 * *category*). `done` marks steps whose data is present, `undone` clears
 * markers whose data is not. One statement, so a concurrent `markStepDone`
 * cannot be lost. A business that already finished is never rewritten — the
 * stamp is preserved and callers skip reconciliation for it.
 */
export async function reconcileWizardSteps(
  businessId: string,
  diff: { done: string[]; undone: string[] },
): Promise<WizardProgress> {
  const done: Record<string, string> = {};
  const now = new Date().toISOString();
  for (const step of diff.done) done[step] = now;
  const sql = `
    INSERT INTO settings (business_id, location_id, key, value)
    VALUES ($1, NULL, $2, jsonb_build_object(
      'steps', $3::jsonb,
      'completedAt', NULL))
    ON CONFLICT (business_id, location_id, key) DO UPDATE
    SET value = jsonb_set(
          jsonb_set(
            COALESCE(settings.value, '{}'::jsonb),
            '{steps}',
            (COALESCE(settings.value -> 'steps', '{}'::jsonb) - $4::text[]) || $3::jsonb,
            true),
          '{completedAt}',
          COALESCE(settings.value -> 'completedAt', 'null'::jsonb),
          true),
        updated_at = now()
    RETURNING value`;
  const params = [
    businessId,
    SETTING_KEYS.wizardProgress,
    JSON.stringify(done),
    diff.undone,
  ];
  const { rows } = await query<{ value: WizardProgress }>(sql, params);
  return rows[0]?.value ?? { steps: done, completedAt: null };
}

export interface SetupCompletion {
  progress: WizardProgress;
  /**
   * True only for the call that actually stamped `completedAt`. A retry (or a
   * second device) gets `false`, which is what keeps the completion audit
   * event written exactly once.
   */
  stamped: boolean;
}

/**
 * The canonical interactive completion transition: stamp `completedAt` if it
 * is not already set, in one atomic statement.
 *
 * The `WHERE` on the conflict update is what makes "exactly once" safe under
 * concurrency: two simultaneous Finish presses cannot both observe an unset
 * `completedAt`, because the second one's update matches no row and returns
 * nothing.
 */
export async function markSetupComplete(
  businessId: string,
  client?: PoolClient,
): Promise<SetupCompletion> {
  const sql = `
    WITH upsert AS (
      INSERT INTO settings (business_id, location_id, key, value)
      VALUES ($1, NULL, $2, jsonb_build_object(
        'steps', '{}'::jsonb,
        'completedAt', to_jsonb(now()::text)))
      ON CONFLICT (business_id, location_id, key) DO UPDATE
      SET value = jsonb_set(
            COALESCE(settings.value, '{}'::jsonb),
            '{completedAt}',
            to_jsonb(now()::text),
            true),
          updated_at = now()
      WHERE settings.value ->> 'completedAt' IS NULL
      RETURNING value
    )
    SELECT (SELECT value FROM upsert) AS value`;
  const params = [businessId, SETTING_KEYS.wizardProgress];
  const { rows } = client
    ? await client.query<{ value: WizardProgress | null }>(sql, params)
    : await query<{ value: WizardProgress | null }>(sql, params);
  const stampedProgress = rows[0]?.value ?? null;
  if (stampedProgress) return { progress: stampedProgress, stamped: true };
  return { progress: await getWizardProgress(businessId), stamped: false };
}
