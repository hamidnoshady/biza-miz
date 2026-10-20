import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pushEndpoint, postWebPush } from "./notification-transport";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("notification outbound policy", () => {
  it("accepts genuine Apple, Google and Mozilla provider endpoints", () => {
    for (const endpoint of [
      "https://web.push.apple.com/QAbC",
      "https://fcm.googleapis.com/fcm/send/token",
      "https://fcm.googleapis.com/wp/token",
      "https://updates.push.services.mozilla.com/wpush/v2/token",
    ])
      expect(pushEndpoint(endpoint)).not.toBeNull();
  });
  it("rejects arbitrary hosts, redirects-as-endpoints, credentials, ports and IP encodings", () => {
    for (const host of [
      "127.0.0.1",
      "2130706433",
      "0177.0.0.1",
      "0x7f000001",
      "10.0.0.1",
      "169.254.169.254",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "[fe80::1]",
      "[2001:db8::1]",
      "attacker.example",
      "fcm.googleapis.com.evil.test",
      "fcm.googleapis.com.",
      "evil.push.services.mozilla.com.evil.test",
    ])
      expect(pushEndpoint(`https://${host}/send`)).toBeNull();
    for (const endpoint of [
      "http://fcm.googleapis.com/wp/x",
      "https://fcm.googleapis.com:8443/wp/x",
      "https://user:pass@fcm.googleapis.com/wp/x",
      "https://fcm.googleapis.com/wp/x#secret",
      "https://fcm.googleapis.com/",
    ])
      expect(pushEndpoint(endpoint)).toBeNull();
  });
  it.each([
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:7f00:1",
    "fd00::1",
    "fe80::1",
    "2002:a00:1::",
    "2001:0:1234::",
    "2001:db8::1",
  ])("rejects unsafe DNS destination %s before connecting", async (address) => {
    vi.mocked(lookup).mockResolvedValue([
      { address, family: address.includes(":") ? 6 : 4 },
    ] as never);
    await expect(
      postWebPush("https://fcm.googleapis.com/wp/x", {}, Buffer.alloc(0)),
    ).rejects.toThrow("notification_endpoint_rejected");
    expect(request).not.toHaveBeenCalled();
  });
  it("fails closed for DNS failures and mixed public/private answers", async () => {
    vi.mocked(lookup).mockRejectedValueOnce(new Error("DNS"));
    await expect(
      postWebPush("https://web.push.apple.com/x", {}, Buffer.alloc(0)),
    ).rejects.toThrow();
    vi.mocked(lookup).mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.1.1.1", family: 4 },
    ] as never);
    await expect(
      postWebPush("https://web.push.apple.com/x", {}, Buffer.alloc(0)),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("pins the validated answer, retains TLS hostname verification and never follows a redirect", async () => {
    vi.mocked(lookup)
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    let options: RequestOptions = {};
    vi.mocked(request).mockImplementation((...args: unknown[]) => {
      options = args[1] as RequestOptions;
      const callback = args[2] as (res: IncomingMessage) => void;
      const req = Object.assign(new EventEmitter(), {
        setTimeout: vi.fn(),
        end: vi.fn(() =>
          callback({ statusCode: 302, resume: vi.fn() } as unknown as IncomingMessage),
        ),
        destroy: vi.fn(),
      });
      return req as unknown as ClientRequest;
    });
    expect(await postWebPush("https://fcm.googleapis.com/wp/x", {}, Buffer.alloc(0))).toBe(302);
    const custom = options.lookup as (
      host: string,
      opts: { all?: boolean },
      callback: (...values: unknown[]) => void,
    ) => void;
    const callback = vi.fn();
    custom("fcm.googleapis.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    custom("fcm.googleapis.com", { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(request).toHaveBeenCalledWith(
      new URL("https://fcm.googleapis.com/wp/x"),
      expect.any(Object),
      expect.any(Function),
    );
  });
});
