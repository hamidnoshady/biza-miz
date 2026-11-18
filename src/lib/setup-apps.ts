/**
 * First-run app selection — the pure vocabulary shared by the setup wizard,
 * its API and the dashboard handoff (issue #1239 / ESH-90).
 *
 * Deliberately framework-free: the gallery renders these shapes on the client,
 * the route builds them on the server, and the tests pin the arithmetic without
 * a database. No billing happens here — selection is an *intent*, never an
 * activation, and this module never imports the wallet or activation service.
 */
import { APPS, isAppKey, type AppDef, type AppKey } from "./apps";
import type { Industry } from "./industries";
import type { DeploymentProfile } from "./deployment-mode";
import { industryProfile, labelFor } from "./industry-profile";
import {
  SECONDS_PER_HOUR,
  enabledRialForSeconds,
  setupFeeRial,
  type ServiceTariff,
} from "./service-activation/catalog";

/** The durable setting is `{ apps, updatedAt }`; older/defensive shapes are also accepted. */
export interface SetupAppSelectionRecord {
  apps: AppKey[];
  updatedAt: string | null;
}

/** What a published tariff means for an onboarding card. Null = not offered. */
export interface SetupAppPricing {
  version: number;
  setupRial: number;
  hourlyRial: number;
  /** Published hourly rate × 24, exactly as the issue's card asks. */
  estimated24hRial: number;
}

export type SetupAppUnavailableReason =
  | "industry"
  | "deployment"
  | "availability"
  | "tariff";

export interface SetupAppCard {
  key: AppKey;
  label: string;
  description: string;
  /** 2–3 industry-flavoured lines; the gallery shows them in the card body. */
  features: string[];
  compatible: boolean;
  available: boolean;
  selectable: boolean;
  unavailableReason: SetupAppUnavailableReason | null;
  pricing: SetupAppPricing | null;
  selected: boolean;
  /** True when this app has resumable per-app setup answers saved. */
  hasSetupProgress: boolean;
  setupComplete: boolean;
  /** The service wizard's next step key, or null when complete/not started. */
  nextStep: string | null;
  activation: {
    state: string;
    stateLabel: string;
    setupPaid: boolean;
    active: boolean;
  } | null;
}

export interface SetupAppTotals {
  setupRial: number;
  estimated24hRial: number;
}

/** The gallery payload — also the client's response type. */
export interface SetupAppCatalogData {
  industry: Industry;
  deploymentProfile: DeploymentProfile;
  currencyDisplay: "toman" | "rial";
  walletBalanceRial: number;
  selected: AppKey[];
  cards: SetupAppCard[];
  totals: SetupAppTotals;
}

/**
 * Normalise a selection read from settings or a request body.
 *
 * Unknown keys are dropped (a stale app key must not survive a rename), the
 * order is the registry's order so every page and every save agree, and an
 * unreadable value yields an empty selection rather than throwing inside a
 * render.
 */
export function normalizeSelectedApps(value: unknown): AppKey[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { apps?: unknown }).apps)
      ? (value as { apps: unknown[] }).apps
      : [];
  const keys = raw.filter((entry): entry is AppKey => typeof entry === "string" && isAppKey(entry));
  const order = new Map(APPS.map((app, index) => [app.key, index] as const));
  return [...new Set(keys)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** The setting value written after a gallery save. */
export function selectionRecord(apps: readonly AppKey[], now = new Date()): SetupAppSelectionRecord {
  return { apps: normalizeSelectedApps(apps), updatedAt: now.toISOString() };
}

function appDef(key: AppKey): AppDef {
  const found = APPS.find((app) => app.key === key);
  if (!found) throw new Error(`Unknown app key: ${key}`);
  return found;
}

/** The published tariff as the card shows it; unpublished/absent is not free. */
export function setupAppPricing(tariff: ServiceTariff | null | undefined): SetupAppPricing | null {
  if (!tariff || tariff.published === false) return null;
  const hourlyRial = Math.max(0, Math.floor(Number(tariff.hourlyRateRial ?? 0)));
  return {
    version: tariff.version,
    setupRial: setupFeeRial(tariff),
    hourlyRial,
    estimated24hRial: enabledRialForSeconds(24 * SECONDS_PER_HOUR, hourlyRial),
  };
}

/** Whether the trade's modules include at least one this app owns. */
export function industrySupportsApp(industry: Industry, app: AppDef): boolean {
  const modules = industryProfile(industry).modules;
  return app.modules.some((module) => modules.includes(module));
}

/** Whether this deployment profile may sell/run the app (local has no Growth/Website). */
export function deploymentSupportsApp(profile: DeploymentProfile, app: AppDef): boolean {
  return app.supportedProfiles.includes(profile);
}

function firstReason(
  industry: Industry,
  app: AppDef,
  profile: DeploymentProfile,
  available: boolean,
  pricing: SetupAppPricing | null,
): SetupAppUnavailableReason | null {
  if (!industrySupportsApp(industry, app)) return "industry";
  if (!deploymentSupportsApp(profile, app)) return "deployment";
  if (!available) return "availability";
  if (!pricing) return "tariff";
  return null;
}

/** The industry-aware 2–3 feature lines shown on a card. */
export function setupAppFeatures(key: AppKey, industry: Industry): string[] {
  switch (key) {
    case "accounting":
      return [
        labelFor(industry, "sellScreen"),
        labelFor(industry, "saleDocumentPlural"),
        "دفتر حساب‌ها، خرید و انبار، گزارش‌ها",
      ];
    case "crm":
      return ["پروندهٔ مشتری", "قیف فروش", "پیگیری‌ها و تیکت‌های خدمات"];
    case "growth":
      return ["باشگاه مشتریان", "کمپین و پیامک", "کارت هدیه و پورسانت"];
    case "website":
      return ["سایت‌ساز Eshobe", "وردپرس و ووکامرس", "مدیریت محصولات سایت"];
    default:
      return [];
  }
}

/** Assemble one card. The service fills the live availability/setup fields. */
export function buildSetupAppCard(input: {
  app: AppDef;
  industry: Industry;
  deploymentProfile: DeploymentProfile;
  available: boolean;
  pricing: SetupAppPricing | null;
  selected: boolean;
  hasSetupProgress?: boolean;
  setupComplete?: boolean;
  nextStep?: string | null;
  activation?: SetupAppCard["activation"];
}): SetupAppCard {
  const reason = firstReason(
    input.industry,
    input.app,
    input.deploymentProfile,
    input.available,
    input.pricing,
  );
  return {
    key: input.app.key,
    label: input.app.label,
    description: input.app.description,
    features: setupAppFeatures(input.app.key, input.industry),
    compatible: industrySupportsApp(input.industry, input.app) &&
      deploymentSupportsApp(input.deploymentProfile, input.app),
    available: input.available,
    selectable: reason === null,
    unavailableReason: reason,
    pricing: input.pricing,
    selected: input.selected,
    hasSetupProgress: input.hasSetupProgress === true,
    setupComplete: input.setupComplete === true,
    nextStep: input.nextStep ?? null,
    activation: input.activation ?? null,
  };
}

/** Totals over the *selected* cards; unavailable prices contribute nothing. */
export function setupAppTotals(cards: readonly SetupAppCard[]): SetupAppTotals {
  return cards.reduce<SetupAppTotals>(
    (totals, card) => {
      if (!card.selected || !card.pricing) return totals;
      totals.setupRial += card.pricing.setupRial;
      totals.estimated24hRial += card.pricing.estimated24hRial;
      return totals;
    },
    { setupRial: 0, estimated24hRial: 0 },
  );
}

/**
 * Which app owns a step of the *business* first-run sequence. Accounts/tax/
 * costing/menu are the Accounting app's setup; everything else is shared
 * business onboarding. Used to skip an unselected app's steps — never to
 * re-declare availability.
 */
export function setupStepApp(step: string): AppKey | null {
  if (step === "accounts" || step === "costing" || step === "tax" || step === "menu") {
    return "accounting";
  }
  return null;
}

/**
 * Whether a required step applies to this business.
 *
 * `selectedApps == null` is the legacy/unset state: behave exactly as before
 * this flow existed (all industry-required steps). An explicit empty selection
 * means the owner chose no apps, so no app-owned step is required.
 */
export function setupStepRequired(
  step: string,
  selectedApps: readonly AppKey[] | null | undefined,
): boolean {
  const app = setupStepApp(step);
  if (!app) return true;
  if (selectedApps == null) return true;
  return selectedApps.includes(app);
}

/** The app definition for a key, for server callers that already validated it. */
export function setupAppDefinition(key: AppKey): AppDef {
  return appDef(key);
}
