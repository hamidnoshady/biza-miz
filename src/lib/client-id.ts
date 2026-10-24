/**
 * A client-side unique id, safe outside secure contexts.
 *
 * `crypto.randomUUID()` only exists on `window.crypto` in a secure context
 * (HTTPS, or `localhost`). `docs/architecture/server-sync.md` explicitly documents
 * connecting café devices over plain `http://<laptop-lan-ip>:3000` on the
 * shop's LAN — a deployment mode where `crypto.randomUUID` is `undefined`
 * and calling it throws. This is a purely local, non-cryptographic key (cart
 * line React keys, idempotency tokens for one browser tab), so a
 * `Date.now()` + `Math.random()` fallback is exactly as good for the job.
 */
export function safeRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
