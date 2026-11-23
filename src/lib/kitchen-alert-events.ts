/**
 * A tiny browser-local bridge between the durable kitchen print worker (mounted
 * once in the workspace shell) and whichever KDS tab is open.
 *
 * The print worker already owns the visual warning and the shared print
 * behaviour's `notifications` policy decides whether it may show it. This event
 * only lets the KDS add its own opt-in sound/onscreen acknowledgement without
 * creating a second print-notification system.
 */
export const KITCHEN_PRINT_FAILURE_EVENT = "bizamiz:kitchen-print-failure";

export interface KitchenPrintFailureDetail {
  dispatchId: string;
  ambiguous: boolean;
  errorCode?: string;
}

export function emitKitchenPrintFailure(detail: KitchenPrintFailureDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<KitchenPrintFailureDetail>(KITCHEN_PRINT_FAILURE_EVENT, { detail }),
  );
}

export function subscribeKitchenPrintFailures(
  listener: (detail: KitchenPrintFailureDetail) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    listener((event as CustomEvent<KitchenPrintFailureDetail>).detail);
  };
  window.addEventListener(KITCHEN_PRINT_FAILURE_EVENT, handler);
  return () => window.removeEventListener(KITCHEN_PRINT_FAILURE_EVENT, handler);
}

export function kitchenPrintFailureText(detail: KitchenPrintFailureDetail): string {
  return detail.ambiguous
    ? "وضعیت چاپ آشپزخانه نامشخص است؛ برای جلوگیری از چاپ تکراری، ارسال خودکار متوقف شد."
    : "ارسال سفارش به چاپگر آشپزخانه انجام نشد؛ دستگاه چاپ را بررسی کنید.";
}
