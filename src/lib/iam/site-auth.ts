import { resolveSyncCredential, type SyncCredentialIdentity } from "../server-sync";

export type IamSiteIdentity = SyncCredentialIdentity & { siteDeviceId: string };

export async function authenticateIamSite(request: Request): Promise<IamSiteIdentity | null> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return null;
  const credential = await resolveSyncCredential(token);
  if (!credential?.siteDeviceId || !credential.businessId) return null;
  return { ...credential, siteDeviceId: credential.siteDeviceId };
}
