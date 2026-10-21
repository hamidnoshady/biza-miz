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
  it("accepts documented Chrome stable/non-stable, Edge/WNS, Safari and Firefox forms", () => {
    for (const endpoint of [
      "https://web.push.apple.com/QAbC",
      "https://fcm.googleapis.com/fcm/send/token",
      "https://fcm.googleapis.com/wp/token",
      "https://fcm.googleapis.com/preprod/wp/token",
      "https://jmt17.google.com/fcm/send/token",
      "https://wns2-db5p.notify.windows.com/w/?token=opaque%2Btoken%3D",
      "https://wns2-am2p.notify.windows.com/w/?token=opaque",
      "https://cloud.notify.windows.com/?token=opaque%2Ftoken",
      "https://region.service.notify.windows.com/w/?token=opaque",
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
      "wns2-db5p.notify.windows.com.evil.test",
      "evilnotify.windows.com",
      "notify.windows.com.evil.test",
      "wns2-db5p.notify.windows.com.",
      "-bad.notify.windows.com",
      "bad-.notify.windows.com",
      "other.googleapis.com",
      "jmt17.google.com.evil.test",
      "other.google.com",
      "android.googleapis.com", // Legacy GCM key authentication is not Web Push/VAPID.
      "fcm-x.googleapis.com", // No current browser-emission source; do not guess hosts.
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
  it("applies the same connect-time DNS defenses to accepted WNS and staging hosts", async () => {
    for (const endpoint of [
      "https://wns2-db5p.notify.windows.com/w/?token=opaque",
      "https://jmt17.google.com/fcm/send/token",
    ]) {
      vi.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
      await expect(postWebPush(endpoint, {}, Buffer.alloc(0))).rejects.toThrow(
        "notification_endpoint_rejected",
      );
    }
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
