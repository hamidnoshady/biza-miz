/**
 * Phase 46 — the desktop's half of «ورود با حساب ابری» (see desktop-cloud-login.ts):
 * which business this install signs into, and whether one-click sign-in is
 * available at all (a paired Hybrid desktop with a device credential).
 */
import { withTenant } from "./db";
import { readDeploymentProfile } from "./deployment-mode";
import { deploymentRole } from "./deployment-role";
import { resolveLoginBusinessId } from "./employee-service";
import { getServerSyncConfig } from "./server-sync";

export interface DesktopCloudLoginContext {
  businessId: string;
  remoteUrl: string;
  token: string;
  devicePublicId: string;
}

export async function desktopCloudLoginContext(host: string | null): Promise<DesktopCloudLoginContext | null> {
  if (deploymentRole() !== "site") return null;
  const { businessId } = await resolveLoginBusinessId({ host });
  if (!businessId) return null;
  return withTenant(businessId, async () => {
    const [deployment, config] = await Promise.all([readDeploymentProfile(businessId), getServerSyncConfig(businessId)]);
    const remoteUrl = config?.remoteUrl?.trim();
    const token = config?.token?.trim();
    if (deployment.profile !== "hybrid" || !config?.enabled || !remoteUrl || !token || !config.siteDevicePublicId) {
      return null;
    }
    return { businessId, remoteUrl, token, devicePublicId: config.siteDevicePublicId };
  });
}
