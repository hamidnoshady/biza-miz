/**
 * Issue #894 Wave 3 — turning a **pending approval** into an **authorized shop**.
 *
 * `shop-generator.ts` speaks to Torob; this file owns the row. Three transitions,
 * and each is written so that the state cannot be reached by anything except the
 * fact that justifies it:
 *
 *   not_authorized/revoked → pending_approval   only after Torob returned a
 *                                               connection with an `approve_url`
 *   pending_approval       → authorized         only after Torob confirmed the
 *                                               one-time code and answered `active`
 *   pending_approval       → revoked            only when the merchant denied it
 *
 * Two rules the issue states outright, and which are the reason for most of the
 * code below:
 *
 *   1. **An accepted request is not an approved shop.** Torob's flow has five
 *      states and the platform has four; the mapping is written once, here, and
 *      `pending`/`approved` both mean "still waiting" — never "connected".
 *   2. **The callback's `connection_id` must be the one this shop requested.**
 *      Torob's own document names the attack: without that check, "a user of the
 *      platform could add another shop's domain and get the real owner to approve
 *      it". So the callback resolves the shop *by* the stored connection id —
 *      never by a shop id the browser supplied.
 *
 * The 15-minute window is enforced on both sides: Torob refuses late codes, and
 * this file refuses to bother Torob with one and marks the row `expired` with a
 * reason a merchant can act on.
 */
import { query } from "../db";
import { readTorobShop, readTorobShopByConnection, TorobShopError, type TorobShop } from "./shop-service";
import {
  TOROB_PARTNER_FAILURE_COPY,
  TorobPartnerError,
  confirmTorobConnection,
  requestTorobConnection,
  type TorobConnection,
  type TorobPartnerFailure,
} from "./shop-generator";

/** Torob's window for the whole flow, in milliseconds. */
export const TOROB_APPROVAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * What a row may record as the reason approval did not happen.
 *
 * Torob's own failures arrive as `TorobPartnerFailure`; `denied` and `expired` are
 * the two the *merchant* produces (a refusal, and a window that ran out). The
 * database's CHECK constraint carries the same list.
 */
export type TorobAuthorizationError = "denied" | "expired" | TorobPartnerFailure;

/** What a merchant reads for the two states Torob's API cannot describe. */
export const TOROB_AUTHORIZATION_ERROR_COPY: Readonly<Record<"denied" | "expired", string>> = {
  denied: "درخواست اتصال در ترب رد شد.",
  expired: "مهلت ۱۵ دقیقه‌ای تأیید در ترب تمام شد؛ درخواست تازه بفرستید.",
};

/** One sentence for any reason a screen might have to show. */
export function authorizationErrorCopy(error: string | null): string | null {
  if (!error) return null;
  if (error === "denied" || error === "expired") return TOROB_AUTHORIZATION_ERROR_COPY[error];
  return TOROB_PARTNER_FAILURE_COPY[error as TorobPartnerFailure] ?? "تأیید اتصال انجام نشد.";
}

/** Whether the stored request is still inside Torob's 15 minutes. */
export function approvalWindowOpen(requestedAt: string | null, now: Date = new Date()): boolean {
  if (!requestedAt) return false;
  const started = new Date(requestedAt).getTime();
  if (!Number.isFinite(started)) return false;
  return now.getTime() - started < TOROB_APPROVAL_WINDOW_MS;
}

async function rememberError(businessId: string, shopId: string, error: TorobAuthorizationError): Promise<void> {
  // Best-effort and separate from the state change: the caller rethrows the
  // provider's failure either way, and a screen that cannot say *why* is still
  // better than one that says the transfer succeeded.
  await query(
    `UPDATE torob_shops SET authorization_error = $3, updated_at = now()
      WHERE id = $1 AND business_id = $2 AND authorization_state <> 'authorized'`,
    [shopId, businessId, error],
  );
}

export interface BeginAuthorizationResult {
  shop: TorobShop;
  connection: TorobConnection;
}

/**
 * Ask Torob for a connection to this shop, and record what came back.
 *
 * Re-requesting is a feature, not a retry: Torob reuses the same `connection_id`,
 * replaces the `return_url` and restarts the 15 minutes — which is exactly what a
 * merchant whose first window lapsed needs. Asking again for a shop whose
 * connection is already `active` returns that connection, and the row is brought
 * to `authorized` to match reality rather than left claiming it is pending.
 */
export async function beginPartnerAuthorization(input: {
  businessId: string;
  shopId: string;
  returnUrl: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<BeginAuthorizationResult> {
  const shop = await readTorobShop({ businessId: input.businessId, shopId: input.shopId });
  if (!shop) throw new TorobShopError("shop_not_found");

  let connection: TorobConnection;
  try {
    connection = await requestTorobConnection({
      shopDomain: shop.domain,
      returnUrl: input.returnUrl,
      env: input.env,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    if (error instanceof TorobPartnerError) {
      await rememberError(input.businessId, shop.id, error.code);
    }
    throw error;
  }

  if (connection.status === "active") {
    // Torob already has this shop connected — bring the row to the truth instead
    // of showing a merchant an approval page for a connection that exists.
    const { rows } = await query<Record<string, never>>(
      `UPDATE torob_shops
          SET authorization_state = 'authorized',
              auth_mode = 'partner',
              provider_shop_id = $3,
              approve_url = NULL,
              authorization_requested_at = NULL,
              authorization_error = NULL,
              token_ciphertext = NULL,
              token_hint = NULL,
              updated_at = now()
        WHERE id = $1 AND business_id = $2
        RETURNING id`,
      [input.shopId, input.businessId, connection.connectionId],
    );
    if (!rows[0]) throw new TorobShopError("shop_not_found");
  } else if (connection.status === "pending") {
    if (!connection.approveUrl) {
      // A pending connection with nowhere to approve is not a state a merchant can
      // act on; it is a provider answer this platform cannot use.
      await rememberError(input.businessId, shop.id, "provider_error");
      throw new TorobPartnerError("provider_error", "pending connection without approve_url");
    }
    const { rows } = await query<Record<string, never>>(
      `UPDATE torob_shops
          SET authorization_state = 'pending_approval',
              auth_mode = 'partner',
              provider_shop_id = $3,
              approve_url = $4,
              authorization_requested_at = now(),
              authorization_error = NULL,
              token_ciphertext = NULL,
              token_hint = NULL,
              updated_at = now()
        WHERE id = $1 AND business_id = $2
        RETURNING id`,
      [input.shopId, input.businessId, connection.connectionId, connection.approveUrl],
    );
    if (!rows[0]) throw new TorobShopError("shop_not_found");
  } else {
    // `revoked`/`expired` are not answers to a *request*; treating them as success
    // would move the row on the strength of a failure.
    await rememberError(input.businessId, shop.id, "provider_error");
    throw new TorobPartnerError("provider_error", `unexpected connection status ${connection.status}`);
  }

  const updated = await readTorobShop({ businessId: input.businessId, shopId: input.shopId });
  if (!updated) throw new TorobShopError("shop_not_found");
  return { shop: updated, connection };
}

/**
 * Complete the flow with the one-time code the merchant's browser carried back.
 *
 * Idempotent for an already-authorized shop: a replayed callback is a browser
 * refresh, not an error, and answering loudly would teach the merchant to ignore
 * the message that matters.
 */
export async function completePartnerAuthorization(input: {
  businessId: string;
  connectionId: string;
  code: string;
  now?: Date;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<TorobShop> {
  const shop = await readTorobShopByConnection({
    businessId: input.businessId,
    connectionId: input.connectionId,
  });
  // An unknown connection is indistinguishable from one belonging to somebody
  // else: both answer "not found", because the callback names no shop.
  if (!shop) throw new TorobShopError("shop_not_found");
  if (shop.authorizationState === "authorized") return shop;
  if (shop.authorizationState !== "pending_approval") throw new TorobShopError("not_authorizable");

  if (!approvalWindowOpen(shop.authorizationRequestedAt, input.now ?? new Date())) {
    await query(
      `UPDATE torob_shops
          SET authorization_state = 'not_authorized',
              approve_url = NULL,
              authorization_requested_at = NULL,
              authorization_error = 'expired',
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [shop.id, input.businessId],
    );
    throw new TorobPartnerError("code_invalid", "approval window elapsed");
  }

  let connection: TorobConnection;
  try {
    connection = await confirmTorobConnection({
      connectionId: input.connectionId,
      code: input.code,
      env: input.env,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    if (error instanceof TorobPartnerError) await rememberError(input.businessId, shop.id, error.code);
    throw error;
  }

  if (connection.status !== "active") {
    await rememberError(input.businessId, shop.id, "provider_error");
    throw new TorobPartnerError("provider_error", `confirm answered ${connection.status}`);
  }

  const { rows } = await query<Record<string, never>>(
    `UPDATE torob_shops
        SET authorization_state = 'authorized',
            auth_mode = 'partner',
            provider_shop_id = $3,
            approve_url = NULL,
            authorization_requested_at = NULL,
            authorization_error = NULL,
            token_ciphertext = NULL,
            token_hint = NULL,
            updated_at = now()
      WHERE id = $1 AND business_id = $2
      RETURNING id`,
    [shop.id, input.businessId, connection.connectionId],
  );
  if (!rows[0]) throw new TorobShopError("shop_not_found");

  const updated = await readTorobShop({ businessId: input.businessId, shopId: shop.id });
  if (!updated) throw new TorobShopError("shop_not_found");
  return updated;
}

/**
 * The merchant denied the request.
 *
 * The row goes to `revoked` rather than back to `not_authorized`, because a denial
 * is a decision: it is the state that says "they said no", and re-requesting from
 * either state is allowed anyway.
 */
export async function denyPartnerAuthorization(input: {
  businessId: string;
  connectionId: string;
}): Promise<TorobShop> {
  const shop = await readTorobShopByConnection({
    businessId: input.businessId,
    connectionId: input.connectionId,
  });
  if (!shop) throw new TorobShopError("shop_not_found");
  const { rows } = await query<Record<string, never>>(
    `UPDATE torob_shops
        SET authorization_state = 'revoked',
            approve_url = NULL,
            authorization_requested_at = NULL,
            authorization_error = 'denied',
            enabled = false,
            updated_at = now()
      WHERE id = $1 AND business_id = $2 AND authorization_state <> 'authorized'
      RETURNING id`,
    [shop.id, input.businessId],
  );
  if (!rows[0]) {
    // Already authorized: a stale denial arriving after approval must not revoke a
    // live connection. The merchant's own disconnect is the only way to do that.
    return shop;
  }
  const updated = await readTorobShop({ businessId: input.businessId, shopId: shop.id });
  if (!updated) throw new TorobShopError("shop_not_found");
  return updated;
}
