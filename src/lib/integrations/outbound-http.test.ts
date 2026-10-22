import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { connectionFetch, connectionUrl, isPublicAddress, validateConnectionAddresses } from "./outbound-http";

afterEach(() => vi.unstubAllEnvs());

describe("credentialed outbound destination policy", () => {
  it.each([
    "http://shop.example.com", "https://user:secret@shop.example.com", "https://shop.example.com/#x",
    "https://shop.example.com/?secret=x", "https://localhost", "https://store.local",
    "https://127.1", "https://2130706433", "https://0x7f000001", "https://10.1.2.3",
    "https://169.254.169.254/latest/meta-data", "https://[::1]", "https://[::ffff:127.0.0.1]",
    "https://[fc00::1]", "https://[fe80::1]", "https://100.64.0.1", "https://192.168.0.1",
  ])("rejects unsafe setup/use target %s", (url) => expect(() => connectionUrl(url)).toThrow());

  it("canonicalizes public destinations without permitting arbitrary query/userinfo", () => {
    expect(connectionUrl(" HTTPS://SHOP.Example.com:443/store ").toString()).toBe("https://shop.example.com/store");
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects rebinding/mixed DNS responses at socket resolution", () => {
    expect(() => validateConnectionAddresses("shop.example.com", [{ address: "8.8.8.8", family: 4 }])).not.toThrow();
    for (const address of ["127.0.0.1", "10.0.0.1", "::ffff:169.254.169.254", "fc00::1"]) {
      expect(() => validateConnectionAddresses("shop.example.com", [
        { address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 },
      ])).toThrow("unsafe_connection_destination");
    }
  });

  it("never enables the explicit local-development exception in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONNECTION_HTTP_DEV_HOSTS", "127.0.0.1");
    expect(() => connectionUrl("http://127.0.0.1")).toThrow();
  });

  it("refuses a real redirect without forwarding Authorization to its destination", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CONNECTION_HTTP_DEV_HOSTS", "127.0.0.1");
    let redirectedRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/credential-sink") redirectedRequests++;
      response.writeHead(302, { Location: "/credential-sink" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      await expect(connectionFetch(`http://127.0.0.1:${address.port}/start`, {
        headers: { Authorization: "Bearer must-not-redirect" },
      })).rejects.toThrow("connection_request_failed");
      expect(redirectedRequests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
