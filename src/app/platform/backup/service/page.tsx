/**
 * Issue #903 §6 — the console's managed-tenant-backup service page.
 *
 * One page, three questions an operator actually asks:
 *
 *   ۱ کجا؟      the destination the whole fleet writes to, and whether it works
 *                right now (`check` is one signed request, not a hope).
 *   ۲ با چه کلیدی؟  the custody that seals the destination credential and can
 *                open every tenant artifact — reported as "available"/"not",
 *                never as a key.
 *   ۳ با چه سیاستی؟ the defaults a new managed backup inherits: interval,
 *                retention ceiling, keep count, artifact ceiling.
 *
 * Secrets are write-only here exactly like the whole-system page: the server
 * answers `accessKeyHint` and `hasSecretKey`, so an empty field means
 * "unchanged", never "clear".
 *
 * Tenant data is not on this page at all. Per-business inventory, custody and
 * restore live under `/platform/businesses/[id]/backups`, scoped to the business
 * in the path, because "which tenant's backup is this?" must never be answerable
 * from a global page.
 */
import { TenantBackupServicePanel } from "./service-panel";

export default function PlatformTenantBackupServicePage() {
  return <TenantBackupServicePanel />;
}
