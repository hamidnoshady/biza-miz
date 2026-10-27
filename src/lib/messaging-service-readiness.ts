/**
 * Issue #902 — the TENANT-facing messaging configuration.
 *
 * `getPublicMessageConfig()` (messaging-billing.ts) is the console's view: it
 * carries provider names, a sender line and a key hint because a Superadmin
 * needs them to operate the account. Serialising that object into a tenant
 * response was the leak this module closes — `/api/messaging`,
 * `/api/growth/settings` and `/api/messaging/preview` all returned it before.
 *
 * The tenant view keeps exactly the fields a Growth screen uses (`enabled`,
 * `configured`, `rate`) and adds the managed-service readiness shape. No
 * supplier name, no sender line, no key hint, no wholesale tariff. A screen
 * that needs a sentence about why sending is paused reads `service`.
 */
import { resolveMessageConfig, type MessageResolvedConfig } from "./messaging-billing";
import type { MessageRate } from "./messaging-billing-pure";
import type { TenantManagedServiceView } from "./managed-services/contract";
import { getTenantSmsReadiness, hasManagedSmsAccount } from "./kavenegar/credentials";

export interface TenantMessagingConfig {
  /** The platform's master send switch. */
  enabled: boolean;
  /** True when this business can actually send at least one channel now. */
  configured: boolean;
  /** Retail price per segment/send. Billing-owned; safe to show. */
  rate: MessageRate;
  /** First-party readiness for the SMS capability. */
  service: TenantManagedServiceView;
}

export async function getTenantMessagingConfig(businessId: string): Promise<TenantMessagingConfig> {
  const [platform, service, managed] = await Promise.all([
    resolveMessageConfig(),
    getTenantSmsReadiness(businessId),
    hasManagedSmsAccount(businessId),
  ]);
  return {
    enabled: platform.enabled,
    configured: isConfigured(platform, service, managed),
    rate: platform.rate,
    service,
  };
}

/**
 * Whether the business can send right now.
 *
 * The SMS half follows the managed account when one exists: `ready` is the one
 * state that may send. Without an account, the platform's own configuration
 * decides, exactly as it did before the managed rollout.
 */
export function isConfigured(
  platform: MessageResolvedConfig,
  service: TenantManagedServiceView,
  managedAccountExists: boolean,
): boolean {
  const smsUsable = managedAccountExists
    ? service.status === "ready"
    : platform.smsProvider === "noop" || platform.kavenegarConfigured;
  const emailUsable = platform.emailProvider === "noop" || platform.smtpConfigured;
  return platform.enabled && smsUsable && emailUsable;
}
