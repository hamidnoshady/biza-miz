import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config.ts", () => {
  // Issue #1003 item 7 — `X-Powered-By: Next.js` names the framework (and so
  // the advisories to try first) to every scanner; nothing of ours reads it.
  it("does not advertise the framework in X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
