/**
 * Issue #984 — the business's own `support_access_policy`, applied to the
 * companion surface.
 *
 * `businesses.support_access_policy` is the tenant's control over support
 * (set at Settings → Security → support access). Until now it only gated the
 * *application impersonation* grant in `platform-service.ts`; the
 * companion services — diagnostics, assistance sessions, repair proposals
 * and on-site token issuance — never read it, so a business that had turned
 * support **off** still received operator-initiated device work.
 *
 * This module is deliberately narrow:
 *
 * - `disabled` refuses every **operator-initiated** companion action. That is
 *   the one word whose meaning is unambiguous ("this business does not accept
 *   support"), so it is enforced here rather than guessed.
 * - `standard` allows, as today.
 * - `strict` / `approval_required` are **not** reinterpreted. Their existing
 *   meaning is about the application-impersonation grant (`strict` refuses the
 *   grant; `approval_required` allows read-only). Attended desktop work needs
 *   a separate local-approval protocol that this repo has not specified yet,
 *   so inventing those semantics here would silently change what the tenant
 *   agreed to. They are returned for callers/UI to show, not enforced.
 * - A customer filing their own request is never blocked by this: withdrawing
 *   support capability from the tenant's own hand is not the policy's job,
 *   and the customer's Stop controls stay independent of it.
 *
 * The read needs the platform bypass the console routes already run under
 * (`withPlatformScope`). An unreadable row means "no policy recorded", which
 * is `standard` — today's behaviour — never a silent block.
 */
import { query } from "../db";

export type SupportAccessPolicy = "standard" | "approval_required" | "strict" | "disabled";

const POLICIES: readonly string[] = ["standard", "approval_required", "strict", "disabled"];

function normalize(value: unknown): SupportAccessPolicy {
  return typeof value === "string" && POLICIES.includes(value)
    ? (value as SupportAccessPolicy)
    : "standard";
}

/** The business's current policy; `standard` when the row is not readable. */
export async function businessSupportPolicy(businessId: string): Promise<SupportAccessPolicy> {
  const { rows } = await query<{ support_access_policy: string | null }>(
    `SELECT support_access_policy FROM businesses WHERE id = $1`,
    [businessId],
  );
  return normalize(rows[0]?.support_access_policy);
}

/**
 * Whether an **operator-initiated** companion action must be refused.
 *
 * Only an explicit `disabled` blocks. Everything else keeps the behaviour the
 * services had before this module existed, so no tenant is surprised by a
 * newly invented refusal. Callers turn `true` into their own
 * `support_access_disabled` error and the routes answer 409.
 */
export async function operatorSupportBlocked(businessId: string): Promise<boolean> {
  return (await businessSupportPolicy(businessId)) === "disabled";
}
