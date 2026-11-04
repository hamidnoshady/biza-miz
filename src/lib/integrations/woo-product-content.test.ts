import { describe, expect, it } from "vitest";
import { productContentFromMeta } from "./woo-product-content";

describe("productContentFromMeta — what the store told us, and nothing else", () => {
  it("reads the store's descriptions, imagery and watermark", () => {
    const content = productContentFromMeta({
      remoteStatus: "publish",
      remoteShortDescription: "کوتاه",
      remoteDescription: "<p>بلند</p>",
      remoteImageSrc: "https://shop.example/a.jpg",
      remoteImageAlt: "جاکفشی چوبی",
      remoteGallery: [
        { src: "https://shop.example/b.jpg", alt: "از پهلو" },
        { src: "https://shop.example/c.jpg", alt: "" },
      ],
      remoteGalleryCount: 3,
      remoteModifiedAt: "2026-10-30T10:00:00Z",
    });
    expect(content.shortDescription).toBe("کوتاه");
    expect(content.description).toBe("<p>بلند</p>");
    expect(content.image).toEqual({ src: "https://shop.example/a.jpg", alt: "جاکفشی چوبی" });
    expect(content.gallery).toEqual([
      { src: "https://shop.example/b.jpg", alt: "از پهلو" },
      { src: "https://shop.example/c.jpg", alt: "" },
    ]);
    expect(content.galleryCount).toBe(3);
    expect(content.remoteModifiedAt).toBe("2026-10-30T10:00:00Z");
  });

  it("never fabricates a description the store did not send", () => {
    const content = productContentFromMeta({});
    expect(content.shortDescription).toBeNull();
    expect(content.description).toBeNull();
    expect(content.image).toBeNull();
    expect(content.gallery).toEqual([]);
    expect(content.galleryCount).toBeNull();
    expect(content.remoteModifiedAt).toBeNull();
  });

  it("treats a blank store field as «no text», not as an empty description", () => {
    const content = productContentFromMeta({ remoteShortDescription: "   ", remoteDescription: "" });
    expect(content.shortDescription).toBeNull();
    expect(content.description).toBeNull();
  });

  it("drops malformed gallery entries instead of rendering broken images", () => {
    const content = productContentFromMeta({
      remoteGallery: [{ src: "https://shop.example/ok.jpg", alt: "x" }, { alt: "بدون نشانی" }, null, "نشانی"],
    });
    expect(content.gallery).toHaveLength(1);
    expect(content.galleryCount).toBeNull();
  });

  it("ignores a non-boolean-typed gallery count rather than printing NaN", () => {
    expect(productContentFromMeta({ remoteGalleryCount: "3" }).galleryCount).toBeNull();
    expect(productContentFromMeta({ remoteGalleryCount: 2 }).galleryCount).toBe(2);
  });

  it("survives a null metadata blob (a mapping written before the snapshot existed)", () => {
    expect(() => productContentFromMeta(null)).not.toThrow();
    expect(productContentFromMeta(undefined).description).toBeNull();
  });
});
