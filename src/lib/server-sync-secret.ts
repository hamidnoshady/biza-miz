/** Authenticated at-rest protection for the reversible server-sync bearer token. */
import { getMasterKey } from "./master-key";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./integrations/secrets";

const MASTER_PREFIX = "mk1.";
const INTEGRATION_PREFIX = "ik1.";

export function sealServerSyncToken(token: string): string {
  const masterKey = getMasterKey();
  return masterKey
    ? `${MASTER_PREFIX}${encryptSecret(token, masterKey)}`
    : `${INTEGRATION_PREFIX}${encryptSecret(token, resolveEncryptionKey(process.env))}`;
}

export function openServerSyncToken(ciphertext: string): string {
  if (ciphertext.startsWith(MASTER_PREFIX)) {
    const masterKey = getMasterKey();
    if (!masterKey) throw new Error("server_sync_token_master_key_unavailable");
    return decryptSecret(ciphertext.slice(MASTER_PREFIX.length), masterKey);
  }
  if (ciphertext.startsWith(INTEGRATION_PREFIX)) {
    return decryptSecret(ciphertext.slice(INTEGRATION_PREFIX.length), resolveEncryptionKey(process.env));
  }
  throw new Error("server_sync_token_ciphertext_unrecognized");
}

export function hasPlaintextServerSyncToken(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).token === "string" &&
    ((value as Record<string, unknown>).token as string).length > 0,
  );
}

/** Stored form: no plaintext token when a token exists. Already-sealed input is retained. */
export function sealServerSyncConfig<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string") return value;
  const { token, tokenCiphertext: _previous, ...rest } = record;
  if (!token) return { ...rest, token: "" } as T;
  return { ...rest, tokenCiphertext: sealServerSyncToken(token) } as T;
}

/** Runtime form: callers continue to consume config.token. Legacy plaintext is readable for CAS migration. */
export function openServerSyncConfig<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.tokenCiphertext !== "string") return value;
  const { tokenCiphertext, token: _legacy, ...rest } = record;
  return { ...rest, token: openServerSyncToken(tokenCiphertext) } as T;
}
