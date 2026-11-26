/**
 * The database half of first-run app selection (issue #1239 / ESH-90).
 *
 * This module only ever READS commercial state (published tariffs, wallet
 * balance, activations) and writes ONE non-commercial row: the selected-app
 * intent in `settings`. It deliberately never calls `activateService`,
 * `postWalletEntryTx`, `chargeFeatureUse` or any other money mover — selecting
 * an app here is a draft, not a purchase.
 */
import { query, withTenant } from "./db";
import { APPS, type AppKey } from "./apps";
import { readDeploymentProfile } from "./deployment-mode";
import type { Industry } from "./industries";
import { getBusinessIndustry } from "./industry-guard";
import { effectiveAppAvailability } from "./app-availability-service";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { serviceTariffAt } from "./service-activation/pricing-service";
import {
  getServiceWizardState,
  listBusinessServiceActivations,
} from "./service-activation/activation-service";
import { SERVICE_STATE_META } from "./service-activation/catalog";
import { wizardProgress, wizardStepsFor } from "./service-activation/wizard";
import {
  buildSetupAppCard,
  normalizeSelectedApps,
  selectionRecord,
  setupAppPricing,
  setupAppTotals,
  STANDARD_SETUP_OFFER,
  type SetupAppCard,
  type SetupAppCatalogData,
  type SetupAppOffer,
} from "./setup-apps";
import {
  resolveSignupOffersForBusiness,
  type EffectiveSignupOffer,
} from "./complimentary-grant-service";

export type SetupAppCatalog = SetupAppCatalogData;

export interface SelectedAppSetupStatus {
  key: AppKey;
  label: string;
  setupComplete: boolean;
  nextStep: string | null;
  completedSteps: number;
  totalSteps: number;
}

/**
 * A read-only wallet balance. `wallet-service.getWallet()` inserts a zero row
 * on first read; onboarding must be able to show "no debit yet" without even
 * creating a wallet as a side effect.
 */
export async function readSetupWalletBalanceRial(businessId: string): Promise<number> {
  const { rows } = await withTenant(businessId, () =>
    query<{ balance_rial: string }>(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [businessId],
    ),
  );
  return Number(rows[0]?.balance_rial ?? 0);
}

/** The stored selection; null means no explicit choice has ever been saved. */
export async function getSelectedSetupApps(businessId: string): Promise<AppKey[] | null> {
  const stored = await getSetting<unknown>(businessId, SETTING_KEYS.setupSelectedApps);
  return stored == null ? null : normalizeSelectedApps(stored);
}

/** Project the resolver's offer onto the card's client-safe shape. */
function setupOfferOf(offer: EffectiveSignupOffer | undefined): SetupAppOffer {
  if (!offer || !offer.policy) return STANDARD_SETUP_OFFER;
  return {
    mode: offer.mode,
    freeDays: offer.freeDays,
    waiveSetup: offer.waiveSetup,
    waiveRental: offer.waiveRental,
    scope: offer.scope,
    policyVersion: offer.policyVersion,
  };
}

function activationFor(
  rows: Awaited<ReturnType<typeof listBusinessServiceActivations>>,
  key: AppKey,
): SetupAppCard["activation"] {
  const row = rows.find((candidate) => candidate.kind === "app" && candidate.key === key);
  if (!row) return null;
  return {
    state: row.state,
    stateLabel: SERVICE_STATE_META[row.state]?.label ?? row.state,
    setupPaid: row.setupPaid,
    active: SERVICE_STATE_META[row.state]?.enabled === true,
  };
}

async function setupStatusFor(
  businessId: string,
  key: AppKey,
): Promise<{
  hasSetupProgress: boolean;
  setupComplete: boolean;
  nextStep: string | null;
}> {
  const steps = wizardStepsFor("app", key);
  const wizard = await getServiceWizardState(businessId, { kind: "app", key });
  if (!wizard) {
    return { hasSetupProgress: false, setupComplete: false, nextStep: steps[0]?.key ?? null };
  }
  const progress = wizardProgress(steps, wizard.progress);
  return {
    hasSetupProgress: wizard.version > 0,
    setupComplete: progress.complete,
    nextStep: progress.nextStep?.key ?? null,
  };
}

/** Every app card the onboarding gallery shows, with live prices and state. */
export async function getSetupAppCatalog(businessId: string): Promise<SetupAppCatalog> {
  const [industryRaw, deployment, availability, stored, prefs, activations, walletBalanceRial] =
    await Promise.all([
      getBusinessIndustry(businessId),
      readDeploymentProfile(businessId),
      effectiveAppAvailability(businessId),
      getSetting<unknown>(businessId, SETTING_KEYS.setupSelectedApps),
      getSetting<{ currencyDisplay?: "toman" | "rial" }>(businessId, SETTING_KEYS.businessPrefs),
      listBusinessServiceActivations(businessId),
      readSetupWalletBalanceRial(businessId),
    ]);

  const industry: Industry = industryRaw ?? "food_service";
  const deploymentProfile = deployment.profile;
  const selected = stored == null ? [] : normalizeSelectedApps(stored);
  const selectedSet = new Set(selected);

  // The effective signup offer per app, resolved once from the policy
  // catalogue; the card and the save endpoint both read this same decision.
  const offers = await resolveSignupOffersForBusiness(
    businessId,
    APPS.map((app) => app.key),
  );

  const cards = await Promise.all(
    APPS.map(async (app) => {
      const tariff = await serviceTariffAt({ kind: "app", key: app.key });
      const status = selectedSet.has(app.key)
        ? await setupStatusFor(businessId, app.key)
        : { hasSetupProgress: false, setupComplete: false, nextStep: null };
      return buildSetupAppCard({
        app,
        industry,
        deploymentProfile,
        available: availability[app.key]?.usable ?? true,
        pricing: setupAppPricing(tariff),
        offer: setupOfferOf(offers.get(app.key)),
        selected: selectedSet.has(app.key),
        ...status,
        activation: activationFor(activations, app.key),
      });
    }),
  );

  return {
    industry,
    deploymentProfile,
    currencyDisplay: prefs?.currencyDisplay === "rial" ? "rial" : "toman",
    walletBalanceRial,
    selected,
    cards,
    totals: setupAppTotals(cards),
  };
}

/**
 * Save the draft selection. This is the endpoint's whole write: a settings row.
 * An app that is unavailable, unsupported or unpriced cannot be selected, so
 * the gallery and the server agree on what "eligible" means.
 */
export async function saveSelectedSetupApps(
  businessId: string,
  apps: readonly AppKey[],
): Promise<{ ok: true; selected: AppKey[] } | { ok: false; error: "invalid_app" }> {
  const catalog = await getSetupAppCatalog(businessId);
  const selectable = new Set(
    catalog.cards.filter((card) => card.selectable).map((card) => card.key),
  );
  if (apps.some((key) => !selectable.has(key))) {
    return { ok: false, error: "invalid_app" };
  }
  const record = selectionRecord(apps);
  await setSetting(businessId, SETTING_KEYS.setupSelectedApps, record);
  return { ok: true, selected: record.apps };
}

/** Per-app setup progress for Finish, the dashboard notice and the server gate. */
export async function selectedAppSetupStatuses(
  businessId: string,
  selectedOverride?: readonly AppKey[] | null,
): Promise<SelectedAppSetupStatus[]> {
  const selected = selectedOverride === undefined
    ? await getSelectedSetupApps(businessId)
    : selectedOverride;
  if (!selected) return [];

  return Promise.all(
    selected.map(async (key) => {
      const app = APPS.find((candidate) => candidate.key === key);
      const steps = wizardStepsFor("app", key);
      const wizard = await getServiceWizardState(businessId, { kind: "app", key });
      const progress = wizardProgress(steps, wizard?.progress ?? {});
      return {
        key,
        label: app?.label ?? key,
        setupComplete: progress.complete,
        nextStep: progress.nextStep?.key ?? null,
        completedSteps: progress.completedSteps.length,
        totalSteps: steps.length,
      };
    }),
  );
}
