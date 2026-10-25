/**
 * Unprivileged Next.js side of Electron's fixed backup/restore worker channel.
 * No database credential is accepted or returned by this boundary.
 */
export function desktopPrivilegedConfigured(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return Boolean(env.DESKTOP_PRIVILEGED_URL || env.DESKTOP_PRIVILEGED_TOKEN);
}

export async function tryDesktopPrivilegedOperation<T>(
  operation: "dump" | "restore",
  payload: Record<string, unknown>,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): Promise<{ handled: true; result: T } | { handled: false }> {
  if (!desktopPrivilegedConfigured(env)) return { handled: false };
  const baseUrl = env.DESKTOP_PRIVILEGED_URL?.replace(/\/$/, "");
  const token = env.DESKTOP_PRIVILEGED_TOKEN;
  if (!baseUrl || !token) throw new Error("desktop_privileged_channel_misconfigured");
  const response = await fetch(`${baseUrl}/operations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operation, ...payload }),
    cache: "no-store",
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; result?: T; error?: string } | null;
  if (!response.ok || !body || body.ok !== true) {
    throw new Error(body?.error || `desktop_privileged_operation_failed:${response.status}`);
  }
  return { handled: true, result: body.result as T };
}
