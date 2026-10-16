/**
 * Toast feedback for the sign-out surfaces that have no room of their own —
 * the sidebar menu (its panel closes on select) and the signed-in notice once
 * it has navigated away.
 *
 * The app's one `<Toaster dir="rtl">` lives in the root layout, so a toast
 * raised here survives the navigation to /login and is announced through
 * sonner's polite live region. A failure toast stays until dismissed (it
 * carries a close button and a «تلاش دوباره» action) — a security warning that
 * vanishes after four seconds is one the member may never read.
 */
import { toast } from "sonner";
import {
  LOGOUT_MESSAGES,
  signOutResultMessage,
  type SignOutResult,
} from "@/lib/logout-contract";
import { signOutAgain } from "./sign-out";

export const SIGN_OUT_TOAST_ID = "sign-out-status";

/**
 * Say what happened, and offer `onRetry` when there is something left to do.
 * A clean sign-out clears any earlier warning instead of announcing itself.
 */
export function announceSignOutResult(result: SignOutResult, onRetry: () => void): void {
  const message = signOutResultMessage(result);
  if (!message) {
    toast.dismiss(SIGN_OUT_TOAST_ID);
    return;
  }
  const options = {
    id: SIGN_OUT_TOAST_ID,
    duration: Number.POSITIVE_INFINITY,
    closeButton: true,
    action: { label: LOGOUT_MESSAGES.retryLabel, onClick: onRetry },
  };
  if (result.kind === "unconfirmed") toast.warning(message, options);
  else toast.error(message, options);
}

/**
 * The retry for an `unconfirmed` sign-out, usable after the component that
 * started it has unmounted (the browser has already left the page): it needs
 * nothing but the httpOnly retry ticket the server set.
 */
export async function retryUnconfirmedSignOut(): Promise<SignOutResult> {
  const result = await signOutAgain({
    kind: "unconfirmed",
    pendingRevocations: 1,
    sessionCookieCleared: true,
  });
  if (result.kind === "signed_out") {
    toast.success(LOGOUT_MESSAGES.confirmedAfterRetry, { id: SIGN_OUT_TOAST_ID, duration: 6000 });
  } else {
    announceSignOutResult(result, () => void retryUnconfirmedSignOut());
  }
  return result;
}
