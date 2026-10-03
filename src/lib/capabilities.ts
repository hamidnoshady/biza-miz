/**
 * Authoritative deployment/capability policy.
 *
 * UI registries, page gates and API guards consume this file. Plan entitlement,
 * permission, industry and runtime dependency remain separate axes so a caller
 * can explain the actual reason instead of rendering one generic lock.
 */
import type { DeploymentProfile } from "./deployment-mode";
import type { Permission } from "./permissions";
import { GROWTH_APP_PERMISSIONS } from "./growth-access";

export type ExecutionTarget = "local" | "cloud" | "either";
export type CapabilityStatus =
  | "available"
  | "unavailable_by_deployment"
  | "unavailable_by_plan"
  | "unavailable_by_permission"
  | "unavailable_by_business_type"
  | "temporarily_unavailable"
  | "requires_cloud"
  | "requires_internet";

export type CapabilityKey =
  | "app.accounting"
  | "app.crm"
  | "app.growth"
  | "app.website"
  | "app.ai"
  | "app.workspace"
  | "app.support"
  | "support.bug_report"
  | "platform.billing"
  | "cloud.messaging"
  | "operation.pos"
  | "operation.local_reporting"
  | "operation.local_backup"
  | "operation.site_sync"
  | "cloud.multi_location"
  | "cloud.integrations"
  | "cloud.sync";

export interface RuntimeCapabilityState {
  internet?: "connected" | "unreachable" | "unknown" | "connecting";
  cloud?: "connected" | "unreachable" | "unknown" | "connecting" | "not_configured";
}

export interface CapabilityContext {
  deployment: DeploymentProfile;
  entitlements?: Readonly<Record<string, boolean>>;
  permissions?: ReadonlySet<string> | readonly string[];
  businessType?: string;
  runtime?: RuntimeCapabilityState;
  runtimeRole?: "central" | "site";
}

export interface CapabilityDefinition {
  key: CapabilityKey;
  executionTarget: ExecutionTarget;
  profiles: readonly DeploymentProfile[];
  planCapability?: string;
  requiredAnyPermission?: readonly Permission[];
  businessTypes?: readonly string[];
  cloudDependency?: "none" | "cloud" | "internet";
}

export interface CapabilityResolution {
  key: CapabilityKey;
  status: CapabilityStatus;
  available: boolean;
  executionTarget: ExecutionTarget;
  code: CapabilityErrorCode | null;
}

export type CapabilityErrorCode =
  | "REQUIRES_CLOUD_CONNECTION"
  | "FEATURE_NOT_IN_PLAN"
  | "INSUFFICIENT_PERMISSION"
  | "CLOUD_TEMPORARILY_UNAVAILABLE"
  | "INTERNET_REQUIRED"
  | "DEPLOYMENT_UNSUPPORTED"
  | "BUSINESS_TYPE_UNSUPPORTED"
  | "WRONG_EXECUTION_TARGET";

export const CAPABILITY_REGISTRY: Readonly<Record<CapabilityKey, CapabilityDefinition>> = {
  "app.accounting": { key: "app.accounting", executionTarget: "either", profiles: ["cloud", "hybrid", "local"] },
  "app.crm": { key: "app.crm", executionTarget: "either", profiles: ["cloud", "hybrid", "local"] },
  "app.growth": { key: "app.growth", executionTarget: "cloud", profiles: ["cloud", "hybrid"], requiredAnyPermission: GROWTH_APP_PERMISSIONS, cloudDependency: "cloud" },
  "app.website": { key: "app.website", executionTarget: "cloud", profiles: ["cloud", "hybrid"], requiredAnyPermission: ["website.view", "cms.view", "woocommerce.view"], cloudDependency: "cloud" },
  "app.ai": { key: "app.ai", executionTarget: "cloud", profiles: ["cloud", "hybrid"], planCapability: "ai_assistant", cloudDependency: "cloud" },
  "app.workspace": { key: "app.workspace", executionTarget: "cloud", profiles: ["cloud", "hybrid"], cloudDependency: "cloud" },
  // Explicit Local-only exceptions: support and bug reporting may contact the
  // cloud, but they never become write authorities for operational data.
  "app.support": { key: "app.support", executionTarget: "cloud", profiles: ["cloud", "hybrid", "local"], cloudDependency: "internet" },
  "support.bug_report": { key: "support.bug_report", executionTarget: "cloud", profiles: ["cloud", "hybrid", "local"], cloudDependency: "internet" },
  "platform.billing": { key: "platform.billing", executionTarget: "cloud", profiles: ["cloud", "hybrid"], cloudDependency: "cloud" },
  "cloud.messaging": { key: "cloud.messaging", executionTarget: "cloud", profiles: ["cloud", "hybrid"], cloudDependency: "cloud" },
  "operation.pos": { key: "operation.pos", executionTarget: "local", profiles: ["hybrid", "local"], requiredAnyPermission: ["orders.create"] },
  "operation.local_reporting": { key: "operation.local_reporting", executionTarget: "local", profiles: ["hybrid", "local"] },
  "operation.local_backup": { key: "operation.local_backup", executionTarget: "local", profiles: ["hybrid", "local"], requiredAnyPermission: ["backup.manage"] },
  "operation.site_sync": { key: "operation.site_sync", executionTarget: "either", profiles: ["cloud", "hybrid"], planCapability: "site_cloud_sync" },
  "cloud.multi_location": { key: "cloud.multi_location", executionTarget: "either", profiles: ["cloud", "hybrid"], planCapability: "multi_location", cloudDependency: "cloud" },
  "cloud.integrations": { key: "cloud.integrations", executionTarget: "cloud", profiles: ["cloud", "hybrid"], planCapability: "integrations", cloudDependency: "cloud" },
  "cloud.sync": { key: "cloud.sync", executionTarget: "cloud", profiles: ["cloud", "hybrid"], planCapability: "site_cloud_sync", cloudDependency: "cloud" },
};

function permissionSet(value: CapabilityContext["permissions"]): ReadonlySet<string> | null {
  if (!value) return null;
  return value instanceof Set ? value : new Set(value);
}

export function resolveCapability(key: CapabilityKey, context: CapabilityContext): CapabilityResolution {
  const definition = CAPABILITY_REGISTRY[key];
  const result = (status: CapabilityStatus, code: CapabilityErrorCode | null): CapabilityResolution => ({
    key,
    status,
    available: status === "available",
    executionTarget: definition.executionTarget,
    code,
  });

  if (!definition.profiles.includes(context.deployment)) {
    return context.deployment === "local" && (definition.executionTarget === "cloud" || definition.cloudDependency === "cloud")
      ? result("requires_cloud", "REQUIRES_CLOUD_CONNECTION")
      : result("unavailable_by_deployment", "DEPLOYMENT_UNSUPPORTED");
  }
  // A Hybrid site's local process is authoritative for operations, but it is
  // not a substitute Cloud runtime. Support/Bug Report are deliberate relay
  // exceptions; every other cloud target executes only on the central role.
  if (context.runtimeRole === "site" && definition.executionTarget === "cloud" && key !== "app.support" && key !== "support.bug_report") {
    return result("unavailable_by_deployment", "WRONG_EXECUTION_TARGET");
  }
  if (definition.businessTypes && context.businessType && !definition.businessTypes.includes(context.businessType)) {
    return result("unavailable_by_business_type", "BUSINESS_TYPE_UNSUPPORTED");
  }
  if (definition.planCapability && context.entitlements?.[definition.planCapability] === false) {
    return result("unavailable_by_plan", "FEATURE_NOT_IN_PLAN");
  }
  const permissions = permissionSet(context.permissions);
  if (permissions && definition.requiredAnyPermission?.length && !definition.requiredAnyPermission.some((p) => permissions.has(p))) {
    return result("unavailable_by_permission", "INSUFFICIENT_PERMISSION");
  }
  // Cloud SaaS executes in cloud already; browser network failures are handled
  // by the request boundary. Hybrid explicitly depends on its cloud channel.
  if (context.deployment !== "cloud" && definition.cloudDependency) {
    if (context.runtime?.internet === "unreachable") return result("requires_internet", "INTERNET_REQUIRED");
    if (definition.cloudDependency === "cloud" && (context.runtime?.cloud === "unreachable" || context.runtime?.cloud === "not_configured")) {
      return result("temporarily_unavailable", "CLOUD_TEMPORARILY_UNAVAILABLE");
    }
  }
  return result("available", null);
}

const API_CAPABILITIES: readonly [string, CapabilityKey][] = [
  // Local-only's two intentional cloud exceptions are explicit entries, not
  // accidental omissions from the guard.
  ["/api/support", "app.support"],
  ["/api/bug-report", "support.bug_report"],
  ["/api/ai", "app.ai"],
  ["/api/workspace", "app.workspace"],
  ["/api/billing", "platform.billing"],
  ["/api/messaging", "cloud.messaging"],
  ["/api/growth", "app.growth"],
  ["/api/cms", "app.website"],
  ["/api/website", "app.website"],
  ["/api/connections/website", "app.website"],
  ["/api/integrations", "cloud.integrations"],
  ["/api/mcp", "app.ai"],
  ["/api/connections/mcp", "app.ai"],
  ["/api/branches", "cloud.multi_location"],
  ["/api/rollup/push", "operation.site_sync"],
  ["/api/rollup", "cloud.multi_location"],
  ["/api/server-sync/config/generate-token", "cloud.sync"],
  ["/api/server-sync/config", "operation.site_sync"],
  ["/api/server-sync/reconcile", "operation.site_sync"],
];

export function capabilityForApiPath(pathname: string): CapabilityKey | null {
  return API_CAPABILITIES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1] ?? null;
}

export function capabilityHttpStatus(code: CapabilityErrorCode | null): number {
  if (code === "CLOUD_TEMPORARILY_UNAVAILABLE" || code === "INTERNET_REQUIRED") return 503;
  return 403;
}
