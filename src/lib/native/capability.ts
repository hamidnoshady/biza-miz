/**
 * Decides whether a capability is available on this device, and through what.
 *
 * Two providers can supply a capability: the Android app (over the bridge) or a
 * browser API that this page can use directly. The native provider wins when it
 * is present, is new enough, and reports the capability. Otherwise the browser
 * API is used. When neither applies, the caller learns whether an app update
 * would help, so the page can say «update the app» instead of implying that the
 * device lacks the feature.
 *
 * Native availability is a UI decision only. The server still enforces the
 * user's Biza Miz role on every action, whatever this module reports.
 */
import {
  NATIVE_CAPABILITIES,
  NATIVE_CAPABILITY_MIN_BRIDGE,
  type NativeAppInfo,
  type NativeCapability,
} from "./bridge-contract";

export const BROWSER_FEATURE_KEYS = ["barcodeDetector", "webAuthn", "pushManager", "webShare"] as const;
export type BrowserFeature = (typeof BROWSER_FEATURE_KEYS)[number];

export type BrowserFeatures = Readonly<Record<BrowserFeature, boolean>>;

export const NO_BROWSER_FEATURES: BrowserFeatures = Object.freeze({
  barcodeDetector: false,
  webAuthn: false,
  pushManager: false,
  webShare: false,
});

/** Browser features that can stand in for each capability when the app does not provide it. */
export const WEB_CAPABILITY_PROVIDERS: Readonly<Record<NativeCapability, readonly BrowserFeature[]>> = Object.freeze({
  "barcode.scan": ["barcodeDetector"],
  printer: [],
  "crm.caller-id": [],
  biometric: ["webAuthn"],
  notifications: ["pushManager"],
  share: ["webShare"],
});

export type CapabilityProvider = "native" | "web";

export interface CapabilityResolution {
  available: boolean;
  provider: CapabilityProvider | null;
  /**
   * True when the capability is unavailable and the installed app predates the
   * bridge version that introduced it. Only then is «update the app» the honest
   * message. An up-to-date app that lacks a capability means the device lacks it.
   */
  updateRequired: boolean;
}

export function resolveCapability(
  capability: NativeCapability,
  browser: BrowserFeatures,
  native: NativeAppInfo | null,
): CapabilityResolution {
  const minimumBridge = NATIVE_CAPABILITY_MIN_BRIDGE[capability];
  if (native && native.capabilities.includes(capability) && native.bridgeVersion >= minimumBridge) {
    return { available: true, provider: "native", updateRequired: false };
  }
  if (WEB_CAPABILITY_PROVIDERS[capability].some((feature) => browser[feature])) {
    return { available: true, provider: "web", updateRequired: false };
  }
  const appPredatesCapability = native !== null && native.bridgeVersion < minimumBridge;
  return { available: false, provider: null, updateRequired: appPredatesCapability };
}

export function resolveAllCapabilities(
  browser: BrowserFeatures,
  native: NativeAppInfo | null,
): Readonly<Record<NativeCapability, CapabilityResolution>> {
  const entries = NATIVE_CAPABILITIES.map((capability) => [capability, resolveCapability(capability, browser, native)]);
  return Object.freeze(Object.fromEntries(entries) as Record<NativeCapability, CapabilityResolution>);
}
