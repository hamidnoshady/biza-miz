/**
 * The pixel half of the deterministic crop/rotate/resize transforms
 * (migration 0175). No database, no S3 — just sharp against real bytes, so
 * this runs in the plain unit suite (`npx vitest run`), not the DB-backed one.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { applyMediaTransform, MediaTransformError } from "./media-transform";

/** A real, decodable 100×60 PNG — sharp refuses to guess at malformed bytes. */
async function testPng(width = 100, height = 60): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

describe("applyMediaTransform", () => {
  it("crops to exactly the requested rectangle", async () => {
    const source = await testPng(100, 60);
    const result = await applyMediaTransform(source, { operation: "crop", params: { x: 10, y: 10, width: 40, height: 20 } });
    const meta = await sharp(result).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(20);
    expect(meta.format).toBe("png");
  });

  it("refuses a crop rectangle that runs past the image's own bounds", async () => {
    const source = await testPng(100, 60);
    await expect(
      applyMediaTransform(source, { operation: "crop", params: { x: 90, y: 0, width: 50, height: 10 } }),
    ).rejects.toMatchObject({ code: "out_of_bounds" });
  });

  it("rotates 90° and swaps the reported width/height", async () => {
    const source = await testPng(100, 60);
    const result = await applyMediaTransform(source, { operation: "rotate", params: { degrees: 90 } });
    const meta = await sharp(result).metadata();
    expect(meta.width).toBe(60);
    expect(meta.height).toBe(100);
  });

  it("resizes within bounds ('inside') without exceeding either requested dimension", async () => {
    const source = await testPng(200, 100);
    const result = await applyMediaTransform(source, {
      operation: "resize",
      params: { width: 80, height: 80, fit: "inside" },
    });
    const meta = await sharp(result).metadata();
    expect(meta.width).toBeLessThanOrEqual(80);
    expect(meta.height).toBeLessThanOrEqual(80);
  });

  it("resizes to fill exact target dimensions with 'fill'", async () => {
    const source = await testPng(200, 100);
    const result = await applyMediaTransform(source, {
      operation: "resize",
      params: { width: 50, height: 50, fit: "fill" },
    });
    const meta = await sharp(result).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });

  it("refuses bytes that are not a decodable image", async () => {
    const garbage = Buffer.from("this is not an image at all, just text bytes");
    await expect(applyMediaTransform(garbage, { operation: "rotate", params: { degrees: 90 } })).rejects.toBeInstanceOf(
      MediaTransformError,
    );
  });
});
