/**
 * Device-local kitchen sound preferences — the storage half.
 *
 * The matrix itself (defaults, parsing, per-event policy) lives in
 * `kitchen-alerts.ts`; what lives here is the browser plumbing: the two
 * `localStorage` keys, read/write with the legacy fallback, and the
 * change notification that lets «تنظیمات ← اعلان‌ها» and an already-open KDS
 * board on the same device agree without a server round trip.
 *
 * Sound is a device decision, never a server one — the same reason it is
 * opt-in and never autoplayed (see the policy module).
 */
import {
  DEFAULT_KITCHEN_SOUND_PREFERENCES,
  parseKitchenSoundPreferences,
  type KitchenSoundPreferences,
} from "./kitchen-alerts";

/** The pre-matrix master switch, still written for devices mid-upgrade. */
export const KITCHEN_SOUND_ENABLED_STORAGE_KEY = "kds.sound-alerts";
export const KITCHEN_SOUND_PREFERENCES_STORAGE_KEY = "kds.sound-preferences";

/**
 * Fired on `window` after a write on this device; the `storage` event covers
 * the other tabs. The KDS board re-reads on either instead of owning a second
 * copy of the state.
 */
export const KITCHEN_SOUND_PREFERENCES_EVENT = "biza:kitchen-sound-preferences";

function defaultSoundPreferences(): KitchenSoundPreferences {
  return {
    ...DEFAULT_KITCHEN_SOUND_PREFERENCES,
    events: { ...DEFAULT_KITCHEN_SOUND_PREFERENCES.events },
  };
}

/**
 * The device's current preferences. A cold boot with no entry (or one a
 * private-browsing wipe corrupted) falls back to the platform default; an
 * explicit legacy "on" choice is honoured so an upgraded device is not
 * silently muted.
 */
export function readKitchenSoundPreferences(): KitchenSoundPreferences {
  if (typeof window === "undefined") return defaultSoundPreferences();
  try {
    const legacy = window.localStorage.getItem(KITCHEN_SOUND_ENABLED_STORAGE_KEY);
    const raw = window.localStorage.getItem(KITCHEN_SOUND_PREFERENCES_STORAGE_KEY);
    const parsed = parseKitchenSoundPreferences(raw ? JSON.parse(raw) : null);
    return legacy === "true" ? { ...parsed, enabled: true } : parsed;
  } catch {
    // Storage denial must not prevent use of the KDS — visual alerts stay on.
    return defaultSoundPreferences();
  }
}

/** Persist the device's choice and tell every listening screen on this device. */
export function writeKitchenSoundPreferences(preferences: KitchenSoundPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      KITCHEN_SOUND_ENABLED_STORAGE_KEY,
      String(preferences.enabled),
    );
    window.localStorage.setItem(
      KITCHEN_SOUND_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
  } catch {
    // Preferences are optional; inaccessible storage falls back to defaults.
  }
  window.dispatchEvent(
    new CustomEvent<KitchenSoundPreferences>(KITCHEN_SOUND_PREFERENCES_EVENT, {
      detail: preferences,
    }),
  );
}

/**
 * Subscribe to preference changes from anywhere on this device — the settings
 * panel writing directly, or another tab via the `storage` event.
 */
export function subscribeKitchenSoundPreferences(
  listener: (preferences: KitchenSoundPreferences) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onChange = () => listener(readKitchenSoundPreferences());
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === KITCHEN_SOUND_ENABLED_STORAGE_KEY ||
      event.key === KITCHEN_SOUND_PREFERENCES_STORAGE_KEY
    ) {
      listener(readKitchenSoundPreferences());
    }
  };
  window.addEventListener(KITCHEN_SOUND_PREFERENCES_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(KITCHEN_SOUND_PREFERENCES_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
