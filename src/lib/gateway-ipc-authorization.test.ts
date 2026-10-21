import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { authorizeGatewayInvocation } = require("../../electron/gateway-ipc-authorization.js");

function fixture() {
  const frame = { url: "http://127.0.0.1:3000/settings/connections" };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ authorized: true }) }));
  const webContents = { mainFrame: frame, session: { fetch } };
  const window = { isDestroyed: () => false, webContents };
  return { window, fetch, event: { sender: webContents, senderFrame: frame } };
}

describe("local-gateway IPC authority", () => {
  it("uses main-process session cookies and a fixed backend endpoint on every invocation", async () => {
    const f = fixture();
    await authorizeGatewayInvocation(f.event, f.window, "http://127.0.0.1:3000");
    await authorizeGatewayInvocation(f.event, f.window, "http://127.0.0.1:3000");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch).toHaveBeenCalledWith("http://127.0.0.1:3000/api/connections/local-gateway/authorize", expect.objectContaining({ credentials: "include", redirect: "error" }));
  });
  it("rejects webviews, subframes and navigated foreign origins before checking authority", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.event.sender = {} as never; },
      (f: ReturnType<typeof fixture>) => { f.event.senderFrame = { url: "http://127.0.0.1:3000/frame" }; },
      (f: ReturnType<typeof fixture>) => { f.event.senderFrame.url = "https://evil.example"; },
    ]) {
      const f = fixture(); mutate(f);
      await expect(authorizeGatewayInvocation(f.event, f.window, "http://127.0.0.1:3000")).rejects.toThrow("gateway_sender_forbidden");
      expect(f.fetch).not.toHaveBeenCalled();
    }
  });
  it("fails closed for a denied/demoted user or a backend failure", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue({ ok: false, json: async () => ({ authorized: false }) });
    await expect(authorizeGatewayInvocation(f.event, f.window, "http://127.0.0.1:3000")).rejects.toThrow("gateway_owner_required");
    f.fetch.mockRejectedValue(new Error("offline"));
    await expect(authorizeGatewayInvocation(f.event, f.window, "http://127.0.0.1:3000")).rejects.toThrow("offline");
  });
  it("rechecks frame provenance after an asynchronous role lookup", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => {
      f.event.senderFrame.url = "https://evil.example";
      return { ok: true, json: async () => ({ authorized: true }) };
    });
    await expect(authorizeGatewayInvocation(f.event, f.window, "http://127.0.0.1:3000")).rejects.toThrow("gateway_sender_forbidden");
  });
});
