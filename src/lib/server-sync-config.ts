/**
 * Pure resolution logic for PUT /api/server-sync/config, split out from
 * server-sync.ts (DB-touching, not unit-tested directly per repo convention)
 * the same way offline-sync.ts holds sync-events.ts's pure conflict logic.
 */
import { isLegacySyncToken, parseSyncToken } from "./sync-token";

export interface ServerSyncConfig {
  /** Full URL of the remote server, e.g. https://pos.eshobe.com */
  remoteUrl: string;
  /**
   * Bearer token shared with the peer server for this business, in the
   * canonical POS1-… form produced by generateSyncToken(). Both sides store
   * the canonical form, so both hash the same bytes (server-sync.ts hashes
   * the string verbatim). Legacy 64-char hex secrets minted before the format
   * existed are still accepted — see resolveConfigUpdate.
   */
  token: string;
  enabled: boolean;
  /** How many events to push/pull per batch (default 100) */
  batchSize?: number;
  /** Set by desktop pairing; scopes credentials and events to one site. */
  siteDeviceId?: string;
  siteDevicePublicId?: string;
  locationId?: string;
  /** Pending cloud acknowledgement after the local snapshot transaction committed. */
  pairingSessionId?: string;
  /** Stable Electron backend instance identity, bound to the pairing session. */
  installationId?: string;
}

export interface ServerSyncConfigUpdateInput {
  remoteUrl?: string;
  /** Present only when the owner typed a new token — GET only ever returns a masked one. */
  token?: string;
  enabled?: boolean;
  batchSize?: number;
}

export type ResolveConfigUpdateResult =
  | { ok: true; config: ServerSyncConfig }
  | {
      ok: false;
      error:
        | "missing_fields"
        | "invalid_url"
        | "bad_prefix"
        | "bad_length"
        | "bad_charset"
        | "bad_checksum";
    };

/** Which of the two accepted token shapes a stored token is, for the UI to flag. */
export type SyncTokenFormat = "current" | "legacy";

export function syncTokenFormat(token: string): SyncTokenFormat | null {
  if (!token) return null;
  return parseSyncToken(token).ok ? "current" : "legacy";
}

/**
 * Resolves a config update against the existing config. The client can't see
 * the real token once saved (only a masked preview), so it only sends a
 * `token` field when the owner typed a new one; omitting it keeps the
 * existing token, so toggling `enabled` or changing `batchSize` doesn't force
 * re-entering the secret every time.
 *
 * A newly typed token is validated for *format*, not merely for length: the
 * whole point of the POS1 format is that a typo, a truncated paste, or a
 * Persian-digit paste is caught here rather than surfacing as a silent 401 at
 * the next push. The canonical form is what gets stored, so the two sides
 * hash identical bytes no matter how the owner typed it.
 *
 * Legacy 64-char hex secrets are accepted verbatim: every laptop paired
 * before this format existed holds one, and rejecting them would break each
 * of those installs on upgrade. The UI flags them for rotation instead.
 */
export function resolveConfigUpdate(
  existing: ServerSyncConfig | null,
  body: ServerSyncConfigUpdateInput,
): ResolveConfigUpdateResult {
  const remoteUrl = body.remoteUrl?.trim() ?? "";
  const enabled = Boolean(body.enabled);
  const batchSize = Number.isFinite(body.batchSize)
    ? Math.min(Math.max(Number(body.batchSize), 1), 200)
    : 100;

  const tokenProvided = typeof body.token === "string";
  let token = tokenProvided ? body.token!.trim() : (existing?.token ?? "");

  if (remoteUrl && !/^https?:\/\//.test(remoteUrl))
    return { ok: false, error: "invalid_url" };
  if (tokenProvided && token && !isLegacySyncToken(token)) {
    const parsed = parseSyncToken(token);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    token = parsed.canonical;
  }
  if (enabled && (!remoteUrl || !token))
    return { ok: false, error: "missing_fields" };

  return {
    ok: true,
    config: {
      remoteUrl,
      token,
      enabled,
      batchSize,
      ...(existing?.siteDeviceId
        ? { siteDeviceId: existing.siteDeviceId }
        : {}),
      ...(existing?.siteDevicePublicId
        ? { siteDevicePublicId: existing.siteDevicePublicId }
        : {}),
      ...(existing?.locationId ? { locationId: existing.locationId } : {}),
      ...(existing?.pairingSessionId
        ? { pairingSessionId: existing.pairingSessionId }
        : {}),
      ...(existing?.installationId
        ? { installationId: existing.installationId }
        : {}),
    },
  };
}
