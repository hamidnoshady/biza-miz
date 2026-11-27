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
  | "tariff"
  /** Removed from the public signup offer by an active Superadmin policy. */
  | "not_selectable";

/**
 * The effective commercial offer shown on a signup card (GitHub #1579).
 *
 * `standard` means ordinary published pricing; the two free modes carry the
 * waived charges so the card and the confirmation can be truthful. Metered
 * consumption (AI, SMS, provider costs) is never included in any of them.
 */
export interface SetupAppOffer {
  mode: "standard" | "free_days" | "free_indefinite" | "not_selectable";
  freeDays: number | null;
  waiveSetup: boolean;
  waiveRental: boolean;
  /** The scope that produced the offer — global, business type, or business. */
  scope: "global" | "business_type" | "business" | null;
  policyVersion: number | null;
}

export const STANDARD_SETUP_OFFER: SetupAppOffer = {
  mode: "standard",
  freeDays: null,
  waiveSetup: false,
  waiveRental: false,
  scope: null,
  policyVersion: null,
};

/** The truthful Persian badge for an offer, or null for ordinary paid access. */
export function setupAppOfferLabel(offer: SetupAppOffer): string | null {
  if (offer.mode === "free_days") return `${offer.freeDays ?? 0} روز رایگان`;
  if (offer.mode === "free_indefinite") return "رایگان دائمی";
  if (offer.mode === "not_selectable") return "فعلاً در دسترس نیست";
  return "نیاز به پرداخت";
}

/** Whether the offer removes both the setup fee and the rental charge. */
export function isFullyComplimentaryOffer(offer: SetupAppOffer): boolean {
  return (
    (offer.mode === "free_days" || offer.mode === "free_indefinite") &&
    offer.waiveSetup &&
    offer.waiveRental
  );
}

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
  /** The effective signup offer; never inferred from a missing tariff. */
  offer: SetupAppOffer;
  /** The card's badge text, already localized for display. */
  offerLabel: string | null;
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
  /** An explicit, fully complimentary policy authorizes a zero-cost offer. */
  freeActivatable: boolean,
): SetupAppUnavailableReason | null {
  if (!industrySupportsApp(industry, app)) return "industry";
  if (!deploymentSupportsApp(profile, app)) return "deployment";
  if (!available) return "availability";
  // A missing tariff is only survivable under an explicit fully-complimentary
  // policy; every other case still fails closed.
  if (!pricing && !freeActivatable) return "tariff";
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
  offer?: SetupAppOffer | null;
  selected: boolean;
  hasSetupProgress?: boolean;
  setupComplete?: boolean;
  nextStep?: string | null;
  activation?: SetupAppCard["activation"];
}): SetupAppCard {
  const offer = input.offer ?? STANDARD_SETUP_OFFER;
  // A policy can make an app unselectable even when it is technically ready;
  // the technical reasons always come first because they are stronger.
  const technicalReason = firstReason(
    input.industry,
    input.app,
    input.deploymentProfile,
    input.available,
    input.pricing,
    // A fully complimentary offer may activate without a published paid
    // tariff, so the tariff is not a blocker in that case.
    isFullyComplimentaryOffer(offer),
  );
  const reason =
    technicalReason ?? (offer.mode === "not_selectable" ? "not_selectable" : null);
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
    offer,
    offerLabel: setupAppOfferLabel(offer),
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
      if (!card.selected) return totals;
      // A waived charge contributes nothing to the owner's expected total.
      if (card.pricing && !(card.offer.mode !== "standard" && card.offer.waiveSetup)) {
        totals.setupRial += card.pricing.setupRial;
      }
      if (card.pricing && !(card.offer.mode !== "standard" && card.offer.waiveRental)) {
        totals.estimated24hRial += card.pricing.estimated24hRial;
      }
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
