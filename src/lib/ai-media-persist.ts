/**
 * Phase G, Part 2 — persist AI chat media into the Media Library.
 *
 * The dashboard policy persists validated images best-effort in the canonical
 * Media Library, tagged with AI provenance (media_assets.source / created_by_ai /
 * conversation_id / project_id); PDFs remain ephemeral after text extraction.
 * This module is the image write path.
 *
 * The split mirrors the rest of the AI subsystem: the PURE half here
 * (`decodeImageDataUrl`) validates and decodes a base64 image data URL with no
 * I/O and is unit-tested; the DB/S3 half (`persistChatImageAttachments`) is a
 * thin, BEST-EFFORT orchestration that the chat route calls alongside the
 * turn. Persisting a file must never fail or slow a turn, so every
 * failure here is swallowed and logged — the library gains a file or it does
 * not, but the conversation is unaffected.
 */
import { createHash } from "node:crypto";
import { hasMatchingMediaSignature, mediaKindForMime } from "./media";
import {
  getMediaConfig,
  isMediaStorageReady,
  storeMediaAsset,
  type MediaAssetRecord,
} from "./media-service";
import type { ChatAttachment } from "./ai-service";

/** The image MIME types the chat accepts (mirrors ai-receipt's allowlist). */
const CHAT_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

const IMAGE_DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;

export interface DecodedImage {
  mimeType: string;
  bytes: Buffer;
  sha256: string;
}

/**
 * Validate and decode a `data:image/...;base64,...` string into bytes, with the
 * SAME fail-closed rules the library's own upload path applies: a known image
 * MIME, and bytes whose signature actually matches that MIME (a "photo" that is
 * really a script is refused, never stored). Returns null on any mismatch so the
 * caller simply skips persistence rather than storing something dangerous.
 */
export function decodeImageDataUrl(dataUrl: string): DecodedImage | null {
  const match = IMAGE_DATA_URL_RE.exec(dataUrl.trim());
  if (!match) return null;
  const [, mimeType, base64] = match;
  if (!CHAT_IMAGE_MIMES.has(mimeType)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (bytes.byteLength === 0) return null;
  // The byte signature must back the claimed MIME — the same check
  // storeMediaAsset's callers rely on for a browser upload.
  if (!hasMatchingMediaSignature(mimeType, bytes)) return null;
  if (mediaKindForMime(mimeType) !== "image") return null;
  return { mimeType, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const EXT_FOR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** A stable, human-readable file name for a persisted chat image. */
export function chatAttachmentFileName(attachment: ChatAttachment, mimeType: string): string {
  const raw = (attachment.name ?? "").trim();
  if (raw) return raw.slice(0, 200);
  const ext = EXT_FOR_MIME[mimeType] ?? "img";
  return `chat-attachment.${ext}`;
}

/**
 * Persist the IMAGE attachments of a chat turn into the Media Library, tagged
 * with their provenance (source='ai_attachment', and the conversation/project
 * they came from). PDFs are not stored: their value to the assistant is the
 * extracted text, and a document library entry for every uploaded PDF is noise
 * the operator did not ask for — images are the reusable asset.
 *
 * Best-effort by contract: returns the assets it managed to store, and never
 * throws. If media storage is not configured, it does nothing.
 */
export async function persistChatImageAttachments(input: {
  businessId: string;
  userId: string | null;
  conversationId: string | null;
  projectId: string | null;
  attachments: ChatAttachment[];
}): Promise<MediaAssetRecord[]> {
  const images = input.attachments.filter(
    (a) => (a.kind ?? "image") === "image" && typeof a.dataUrl === "string" && a.dataUrl,
  );
  if (images.length === 0) return [];

  let config;
  try {
    config = await getMediaConfig();
  } catch {
    return [];
  }
  if (!isMediaStorageReady(config)) return [];

  const stored: MediaAssetRecord[] = [];
  for (const attachment of images) {
    const decoded = decodeImageDataUrl(attachment.dataUrl as string);
    if (!decoded) continue;
    try {
      const asset = await storeMediaAsset({
        businessId: input.businessId,
        userId: input.userId,
        config,
        kind: "image",
        fileName: chatAttachmentFileName(attachment, decoded.mimeType),
        mimeType: decoded.mimeType,
        bytes: decoded.bytes,
        sha256: decoded.sha256,
        source: "ai_attachment",
        conversationId: input.conversationId,
        projectId: input.projectId,
      });
      stored.push(asset);
    } catch (err) {
      console.error("ai chat attachment persistence failed", err);
    }
  }
  return stored;
}
