"use client";

/**
 * Issue #854 (P1.19) — one business-selection step, used by every door that can
 * answer `needsBusinessSelection`.
 *
 * The backend has produced this response for a long time: a member who belongs
 * to two businesses cannot be signed in until they say which one, so the login
 * route answers `{ needsBusinessSelection: true, businesses: [...] }` with no
 * session and waits to be asked again with a `businessId`.
 *
 * The password door (`/admin`) never handled it. `res.ok` was true, the body
 * carried no session, and the form pushed the user to their destination — where
 * the app immediately bounced them back to the login screen, with nothing on
 * either screen to explain why. That is the defect; the fix is that every door
 * renders *this* rather than its own copy of the step.
 *
 * What each door differs in is only how the choice is spent:
 *
 *  - password: the credentials are posted again together with the `businessId`
 *    (the route re-verifies them; there is no bearer token to replay).
 *  - phone OTP: the code is already proven, so the choice is posted with the
 *    short-lived `selectionToken` the verify response issued.
 *
 * So the component owns the *presentation and state*, and the caller owns the
 * one line that spends the choice. `BusinessChoice`/`NeedsBusinessSelection`
 * come from `auth-contracts.ts` so the response shape is typed the same place
 * the route's is.
 */
import { useState } from "react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import type { BusinessChoice } from "@/lib/auth-contracts";

/** The pending selection a door holds while the member decides. */
export interface BusinessSelectionState {
  businesses: BusinessChoice[];
  /** Present for token-carrying doors (phone OTP); absent for password. */
  token?: string;
}

/**
 * The wrapper both doors use, so "what is on screen while a selection is
 * pending" cannot differ between them.
 */
export function useBusinessSelection() {
  const [selection, setSelection] = useState<BusinessSelectionState | null>(null);
  return {
    selection,
    /** Returns true when the response was a selection request and was handled. */
    capture(response: {
      needsBusinessSelection?: boolean;
      businesses?: BusinessChoice[];
      selectionToken?: string;
    }): boolean {
      if (!response.needsBusinessSelection) return false;
      setSelection({
        businesses: response.businesses ?? [],
        token: response.selectionToken,
      });
      return true;
    },
    clear: () => setSelection(null),
  };
}

/**
 * The step itself.
 *
 * A list of buttons rather than a `<select>`: each option is one tap on a
 * phone, the roles/businesses are read at a glance, and there is no submit step
 * to get wrong. It is announced as a named group so a screen reader hears
 * "choose a business" before the names.
 */
export function BusinessPicker({
  selection,
  busy = false,
  error = null,
  onChoose,
  onCancel,
  description = "این حساب در چند کسب‌وکار عضویت دارد؛ وارد کدام می‌شوید؟",
}: {
  selection: BusinessSelectionState;
  busy?: boolean;
  error?: string | null;
  onChoose: (businessId: string) => void;
  onCancel: () => void;
  description?: string;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-bold">انتخاب کسب‌وکار</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {selection.businesses.length === 0 ? (
        /*
         * An empty list is not "no business" — the server only sends this shape
         * when it has at least one usable membership, so an empty array means
         * the response was truncated or the contract drifted. Say so instead of
         * rendering an empty box with a cancel button.
         */
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            فهرست کسب‌وکارها دریافت نشد. دوباره وارد شوید.
          </p>
          <LoadingSkeleton rows={2} />
        </div>
      ) : (
        <ul
          role="group"
          aria-label="کسب‌وکارها"
          className="space-y-2"
        >
          {selection.businesses.map((business) => (
            <li key={business.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onChoose(business.id)}
                className="w-full rounded-lg border border-input px-3 py-2.5 text-sm font-semibold transition hover:bg-primary/10 focus-visible:ring focus-visible:ring-ring/50 disabled:opacity-50 outline-none"
              >
                {business.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {busy ? <LoadingSkeleton rows={1} /> : null}

      <div className="text-center">
        <button
          type="button"
          onClick={onCancel}
          className="rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring focus-visible:ring-ring/50 outline-none"
        >
          انصراف و بازگشت
        </button>
      </div>
    </div>
  );
}
