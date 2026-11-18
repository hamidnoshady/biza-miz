/**
 * The client-safe half of the business-logo contract: the size cap and the
 * four accepted MIME types. `business-logo.ts` keeps the storage record and the
 * byte-signature check (which pulls in the media module), so a client form can
 * reject an oversized/wrong-typed file before uploading without importing any
 * server-only code.
 */

export const LOGO_MAX_BYTES = 256 * 1024;

export const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
export type LogoMimeType = (typeof LOGO_MIME_TYPES)[number];

export function isLogoMimeType(value: unknown): value is LogoMimeType {
  return typeof value === "string" && (LOGO_MIME_TYPES as readonly string[]).includes(value);
}
