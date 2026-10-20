/** Versioned, strict settings for POS touch/hold interactions (#945). */
export const UI_INTERACTION_VERSION = 1 as const;

export interface UiInteractionSettings {
  version: typeof UI_INTERACTION_VERSION;
  paymentConfirmation: "hold" | "confirm-dialog";
  paymentHoldMs: number;
  addOnMode: "hold-repeat" | "buttons";
  addOnHoldMs: number;
  doubleTapEnabled: boolean;
  doubleTapWindowMs: number;
}

export const DEFAULT_UI_INTERACTION_SETTINGS: UiInteractionSettings = {
  version: UI_INTERACTION_VERSION,
  paymentConfirmation: "hold",
  paymentHoldMs: 4000,
  addOnMode: "hold-repeat",
  addOnHoldMs: 2000,
  doubleTapEnabled: true,
  doubleTapWindowMs: 320,
};

export function normalizeUiInteractionSettings(value: unknown): UiInteractionSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const allowed = new Set(["version", "paymentConfirmation", "paymentHoldMs", "addOnMode", "addOnHoldMs", "doubleTapEnabled", "doubleTapWindowMs"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return null;
  const paymentConfirmation = input.paymentConfirmation;
  const paymentHoldMs = input.paymentHoldMs;
  const addOnMode = input.addOnMode;
  const addOnHoldMs = input.addOnHoldMs;
  const doubleTapWindowMs = input.doubleTapWindowMs;
  if (
    input.version !== UI_INTERACTION_VERSION ||
    (paymentConfirmation !== "hold" && paymentConfirmation !== "confirm-dialog") ||
    typeof paymentHoldMs !== "number" || !Number.isInteger(paymentHoldMs) || paymentHoldMs < 1000 || paymentHoldMs > 5000 ||
    (addOnMode !== "hold-repeat" && addOnMode !== "buttons") ||
    typeof addOnHoldMs !== "number" || !Number.isInteger(addOnHoldMs) || addOnHoldMs < 500 || addOnHoldMs > 4000 ||
    typeof input.doubleTapEnabled !== "boolean" ||
    typeof doubleTapWindowMs !== "number" || !Number.isInteger(doubleTapWindowMs) || doubleTapWindowMs < 200 || doubleTapWindowMs > 800
  ) return null;
  return {
    version: UI_INTERACTION_VERSION,
    paymentConfirmation,
    paymentHoldMs,
    addOnMode,
    addOnHoldMs,
    doubleTapEnabled: input.doubleTapEnabled,
    doubleTapWindowMs,
  };
}

/** Legacy/malformed rows fail closed to the installed-tenant behavior. */
export function parseUiInteractionSettings(value: unknown): UiInteractionSettings {
  return normalizeUiInteractionSettings(value) ?? DEFAULT_UI_INTERACTION_SETTINGS;
}
