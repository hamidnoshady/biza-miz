/**
 * The pixel half of the deterministic Cloudinary/Canva-style transforms
 * (migration 0175) — crop / rotate / resize, local and free (no AI provider,
 * no wallet cost), unlike the paid AI 'enhanced' refine (ai-media-service.ts).
 * `media.ts` decided what a legal request even looks like; this module is
 * the one place that actually touches sharp, so a native-binding failure
 * (an unreadable/corrupt image, an out-of-bounds crop) has exactly one
 * translation into an error code the route can answer with.
 */
import sharp, { type Sharp } from "sharp";
import type { MediaTransformInput } from "./media";

export type MediaTransformErrorCode = "unsupported_image" | "out_of_bounds" | "processing_failed";

export class MediaTransformError extends Error {
  code: MediaTransformErrorCode;
  constructor(code: MediaTransformErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "MediaTransformError";
  }
}

/**
 * Apply one crop/rotate/resize to an image's bytes and return the result as
 * PNG — the same "always PNG" convention the AI enhance path already
 * established, so a derived asset's format is never a surprise to the code
 * that reads it back.
 */
export async function applyMediaTransform(bytes: Buffer, input: MediaTransformInput): Promise<Buffer> {
  let pipeline: Sharp;
  try {
    // Auto-orient from EXIF first: a crop rectangle is drawn against the
    // image the operator SEES, not the sensor's raw storage orientation.
    pipeline = sharp(bytes, { failOn: "error" }).rotate();
    const metadata = await pipeline.clone().metadata();
    if (!metadata.width || !metadata.height) {
      throw new MediaTransformError("unsupported_image", "این تصویر قابل پردازش نیست.");
    }

    if (input.operation === "crop") {
      const { x, y, width, height } = input.params;
      if (x + width > metadata.width || y + height > metadata.height) {
        throw new MediaTransformError("out_of_bounds", "ناحیهٔ برش بیرون از مرز تصویر است.");
      }
      pipeline = pipeline.extract({ left: x, top: y, width, height });
    } else if (input.operation === "rotate") {
      pipeline = pipeline.rotate(input.params.degrees, { background: "#ffffff" });
    } else {
      pipeline = pipeline.resize({
        width: input.params.width,
        height: input.params.height,
        fit: input.params.fit,
        background: "#ffffff",
      });
    }

    return await pipeline.png().toBuffer();
  } catch (err) {
    if (err instanceof MediaTransformError) throw err;
    throw new MediaTransformError("processing_failed", "پردازش تصویر ناموفق بود.");
  }
}
