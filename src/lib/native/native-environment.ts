/**
 * Recognises that this page is running inside a Biza Miz Android Trusted Web
 * Activity (issue #884).
 *
 * Chrome sets `document.referrer` to `android-app://<package>` for a page opened
 * from a TWA. That is good evidence, not proof: any site can link from its own
 * `android-app://` referrer, and some browsers blank the referrer on reload. So
 * detection is a two-step check:
 *   1. the package must be one of our three allowlisted applicationIds, and
 *   2. the first accepted package is remembered in sessionStorage so a reload
 *      inside the same TWA session is still recognised.
 *
 * Detection is a hint for UI only. It grants no privilege. Every native action
 * still goes through the bridge and is checked again on the server.
 */
import environments from "../../../config/android-environments.json";
import type { NativeEnvironment } from "./bridge-contract";

export const NATIVE_STORAGE_KEY = "biza-miz:native-package";

/** applicationId → environment, built from config/android-environments.json. */
export const ANDROID_PACKAGE_ENVIRONMENTS: Readonly<Record<string, NativeEnvironment>> = Object.freeze(
  Object.fromEntries(
    Object.entries(environments.environments).map(([env, spec]) => [spec.applicationId, env as NativeEnvironment]),
  ),
);

const ANDROID_REFERRER_PATTERN = /^android-app:\/\/([^/?#\s]+)(?:[/?#]|$)/i;

/**
 * Extracts the package from an `android-app://` referrer, but only when the
 * package is allowlisted. Returns `null` for everything else, including a
 * lookalike such as `com.bizamiz.app.evil`.
 */
export function androidPackageFromReferrer(referrer: string): string | null {
  const match = ANDROID_REFERRER_PATTERN.exec(referrer);
  if (!match) return null;
  const candidate = match[1];
  return Object.prototype.hasOwnProperty.call(ANDROID_PACKAGE_ENVIRONMENTS, candidate) ? candidate : null;
}

export type NativeRuntimeKind = "web" | "android-twa";

export interface NativeRuntimeDetection {
  kind: NativeRuntimeKind;
  androidPackage: string | null;
  environment: NativeEnvironment | null;
  /** True when the package came from the live referrer (so the caller should remember it). */
  fromReferrer: boolean;
}

export function detectNativeRuntime(input: { referrer: string; remembered: string | null }): NativeRuntimeDetection {
  const fromReferrer = androidPackageFromReferrer(input.referrer);
  const remembered =
    input.remembered !== null && Object.prototype.hasOwnProperty.call(ANDROID_PACKAGE_ENVIRONMENTS, input.remembered)
      ? input.remembered
      : null;
  const androidPackage = fromReferrer ?? remembered;
  if (!androidPackage) {
    return { kind: "web", androidPackage: null, environment: null, fromReferrer: false };
  }
  return {
    kind: "android-twa",
    androidPackage,
    environment: ANDROID_PACKAGE_ENVIRONMENTS[androidPackage],
    fromReferrer: fromReferrer !== null,
  };
}
