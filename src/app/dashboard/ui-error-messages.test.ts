import { describe, expect, it } from "vitest";
import { EMBEDDED_MEDIA_MESSAGE, MEDIA_URL_MESSAGES } from "@/lib/embedded-media-guard";
import { errorMessage } from "./ui";

/**
 * GH #1567 F5 — the embedded-media guard's refusal codes reach several screens
 * (item meta, menu, store product push) as a bare `error` code. Each must read
 * as the guard's own sentence, never the generic «خطای غیرمنتظره».
 */
describe("embedded-media error codes", () => {
  it("map to the guard's shared Persian messages", () => {
    expect(errorMessage("embedded_media")).toBe(EMBEDDED_MEDIA_MESSAGE);
    expect(errorMessage("media_url_too_long")).toBe(MEDIA_URL_MESSAGES.media_url_too_long);
    expect(errorMessage("media_url_host_not_allowed")).toBe(MEDIA_URL_MESSAGES.media_url_host_not_allowed);
    expect(errorMessage("invalid_media_url")).not.toBe(errorMessage("definitely_not_a_code"));
  });
});
