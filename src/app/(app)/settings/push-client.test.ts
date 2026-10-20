// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentSubscriptionEndpoint, disablePush } from "./push-client";
const unsubscribe = vi.fn();
beforeEach(() => {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => ({
            endpoint: "https://fcm.googleapis.com/wp/current",
            unsubscribe,
          }),
        },
      }),
    },
  });
  vi.stubGlobal("PushManager", class {});
  unsubscribe.mockReset();
  unsubscribe.mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});
describe("browser subscription state reconciliation", () => {
  it("does not equate an existing browser endpoint with active server registration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              devices: [
                { endpoint: "https://fcm.googleapis.com/wp/current", disabledAt: "2026-01-01" },
              ],
            }),
          ),
      ),
    );
    expect(await currentSubscriptionEndpoint()).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              devices: [{ endpoint: "https://fcm.googleapis.com/wp/current", disabledAt: null }],
            }),
          ),
      ),
    );
    expect(await currentSubscriptionEndpoint()).toBe("https://fcm.googleapis.com/wp/current");
  });
  it("does not claim a disable when the server rejects removal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(disablePush()).rejects.toThrow();
    expect(unsubscribe).not.toHaveBeenCalled();
  });
  it("reports browser unsubscribe failure after confirmed server removal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ removed: true }))),
    );
    unsubscribe.mockResolvedValue(false);
    await expect(disablePush()).rejects.toThrow();
    expect(unsubscribe).toHaveBeenCalled();
  });
  it("propagates network failure for an explicit retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(disablePush()).rejects.toThrow("offline");
    await expect(currentSubscriptionEndpoint()).rejects.toThrow("offline");
  });
});
