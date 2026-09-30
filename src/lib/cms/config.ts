/**
 * Eshobe CMS — configuration resolution.
 *
 * Split from the client so the env contract lives in one place:
 *
 * - `ESHOBE_CMS_URL` — the CMS control-plane origin (no trailing slash).
 * - `ESHOBE_CMS_PLATFORM_API_KEY` — optional `role: "platform"` key used by
 *   the operator console (provision sites, issue site keys).
 * - `ESHOBE_CMS_WEBHOOK_SECRET` — the CMS's `PAYLOAD_SECRET`; verifies the
 *   HMAC on `POST /api/cms/revalidate`.
 *
 * Per-business site keys are NOT env vars: they are stored encrypted in
 * `eshobe_cms_connections` (see ./connections.ts) and decrypted on the way
 * out, which is how a customer website's credential stays inside its tenant.
 */

/** The secret that authenticates publish webhooks from the CMS. */
export function cmsWebhookSecret(env: Record<string, string | undefined>): string | null {
  const secret = env.ESHOBE_CMS_WEBHOOK_SECRET?.trim();
  return secret || null;
}
