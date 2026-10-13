/**
 * "Which door did this browser last use to sign in?" — the missing piece the
 * audit found: a tenant's origin used to jump straight into the staff
 * quick-login roster with no way to discover the owner/manager door (`/admin`)
 * existed at all, unless a member happened to be in the phone-OTP grace
 * window's number-entry step, where a single sentence named it in passing.
 *
 * This is deliberately NOT an authorization boundary — `/admin` and `/login`
 * already enforce who may sign in where server-side (see
 * `admin-login-form.tsx`, `login-form.tsx`, `/api/auth/login`,
 * `/api/auth/pin-login`). It is only a *device-local UI shortcut*: which door
 * this browser is shown first, so a shared till skips the chooser after the
 * first visit while an owner's laptop can still switch doors at any time.
 *
 * Deliberately separate from `device-token.ts`: that module is a *server*
 * credential (a paired-device row, biometric registration). This is pure
 * client-side memory with no security meaning — clearing it, or a private
 * window never writing it, only ever re-shows the chooser.
 */

export type LoginDoor = "admin" | "staff";

const STORAGE_KEY = "pos:loginDoor";

interface StoredChoice {
  door: LoginDoor;
  /** Only a remembered choice with this set to true skips the chooser. */
  remember: boolean;
}

function isLoginDoor(value: unknown): value is LoginDoor {
  return value === "admin" || value === "staff";
}

/**
 * Issue #948 P1-4 — the remembered choice, with old values resolved.
 *
 * The chooser briefly offered «ورود آفلاین (محلی)» as its own card (removed
 * from Cloud/Hybrid as a duplicate of the staff door). A browser that
 * remembered that choice must land on the *staff* door — the same flow it
 * always mounted — never on a re-shown chooser or a dead option.
 */
function normalizeStoredDoor(value: unknown): LoginDoor | null {
  if (isLoginDoor(value)) return value;
  if (value === "offline") return "staff";
  return null;
}

/** The last door this browser chose, if it asked to be remembered. Never throws. */
export function readRememberedLoginDoor(): LoginDoor | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChoice>;
    const door = normalizeStoredDoor(parsed.door);
    if (parsed.remember === true && door) return door;
    return null;
  } catch {
    return null;
  }
}

/**
 * Records which door was chosen. `remember: false` still records the choice
 * (so returning to the chooser can pre-select it) but keeps the chooser
 * showing on the next visit — "remember this device" is opt-in, not implied
 * by merely picking a door once.
 */
export function rememberLoginDoor(door: LoginDoor, remember: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ door, remember } satisfies StoredChoice));
  } catch {
    // Best-effort UI memory only; a blocked/full localStorage just means the
    // chooser reappears next time, which is a safe fallback, not a failure.
  }
}

/** "Change login type" / "forget this device": back to always asking. */
export function clearRememberedLoginDoor(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is already unavailable.
  }
}
