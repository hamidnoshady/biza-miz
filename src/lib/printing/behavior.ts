import type { DocType } from "../print-template";

export const PRINT_POLICY_KEYS = [
  "receipt", "invoice", "kitchen", "label", "shipping_label", "woo_invoice",
  "accounting_document", "inventory_document", "report", "contract",
] as const;
export type PrintPolicyKey = (typeof PRINT_POLICY_KEYS)[number];
export type PrintMode = "automatic" | "manual" | "disabled";
export type PrintNotifications = "all" | "failures" | "off";
export interface PrintBehavior { mode: PrintMode; notifications: PrintNotifications }
export type PrintPolicy = Partial<Record<PrintPolicyKey, PrintBehavior>>;

export const LEGACY_PRINT_BEHAVIOR: PrintBehavior = { mode: "automatic", notifications: "all" };

export function parsePrintPolicy(input: unknown): PrintPolicy | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const result: PrintPolicy = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!PRINT_POLICY_KEYS.includes(key as PrintPolicyKey) || !raw || typeof raw !== "object") return null;
    const { mode, notifications } = raw as Partial<PrintBehavior>;
    if (mode !== "automatic" && mode !== "manual" && mode !== "disabled") return null;
    if (notifications !== "all" && notifications !== "failures" && notifications !== "off") return null;
    result[key as PrintPolicyKey] = { mode, notifications };
  }
  return result;
}

export function printBehaviorFor(policy: PrintPolicy, type: DocType | PrintPolicyKey): PrintBehavior {
  return policy[type] ?? LEGACY_PRINT_BEHAVIOR;
}
