import { LEGACY_PRINT_BEHAVIOR, parsePrintPolicy, printBehaviorFor, type PrintBehavior, type PrintPolicyKey } from "./behavior";
import { toast } from "sonner";

export async function readCurrentPrintBehavior(type: PrintPolicyKey): Promise<PrintBehavior> {
  try {
    const response = await fetch("/api/settings/print-behavior", { cache: "no-store", credentials: "same-origin" });
    if (response.ok) {
      const body: { effective?: unknown } = await response.json();
      const policy = parsePrintPolicy(body.effective);
      if (policy) return printBehaviorFor(policy, type);
    }
  } catch {
    // The server independently enforces physical printer settings.
  }
  return LEGACY_PRINT_BEHAVIOR;
}

export async function printBrowserDocument(type: PrintPolicyKey, target: Window = window): Promise<boolean> {
  const behavior = await readCurrentPrintBehavior(type);
  if (behavior.mode === "disabled") {
    toast.error("چاپ این سند در تنظیمات کسب‌وکار غیرفعال است.");
    if (target !== window) target.close();
    return false;
  }
  target.print();
  return true;
}
