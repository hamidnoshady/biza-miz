import { describe, expect, it } from "vitest";
import { parseAttachmentSource } from "./ai-attachment-source";
describe("attachment source grammar", () => {
  it("keeps only source identifiers, never client URLs or credentials", () => {
    expect(parseAttachmentSource({ library: "cms", id: "image-1", url: "https://private.test", token: "secret" }))
      .toEqual({ library: "cms", id: "image-1" });
  });
  it("rejects malformed and incomplete source references", () => {
    for (const raw of [null, {}, { library: "cms", id: "../../private" },
      { library: "media", id: "other-business" }, { library: "wordpress", id: "11111111-1111-4111-8111-111111111111" }]) {
      expect(parseAttachmentSource(raw)).toBeNull();
    }
  });
});
