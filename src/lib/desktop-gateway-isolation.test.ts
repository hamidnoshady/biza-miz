import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createCertificateManager } = require("../../electron/certificate-manager.js");
const { GatewayManager } = require("../../electron/gateway-manager.js");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map((cleanup) => cleanup()));
});

async function listen(server: http.Server, host = "127.0.0.1", port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return (server.address() as net.AddressInfo).port;
}

async function availablePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = net.createServer();
    const port = await listen(probe as unknown as http.Server);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (port >= 65_534) continue;
    const next = net.createServer();
    try {
      await listen(next as unknown as http.Server, "127.0.0.1", port + 1);
      await new Promise<void>((resolve) => next.close(() => resolve()));
      return port;
    } catch {
      next.close();
    }
  }
  throw new Error("could not reserve adjacent gateway ports");
}

function isRetryableListenError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: string }).code;
  return code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL";
}

function secureGet(url: string, ca?: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { ca, rejectUnauthorized: true }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
  });
}

describe("desktop mobile gateway boundary", () => {
  it("keeps the app HTTPS-only while exposing only the public CA on isolated HTTP onboarding", async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), "suite-gateway-test-"));
    const messages: unknown[] = [];
    const logger = {
      path: path.join(userData, "desktop.log"),
      info: (...args: unknown[]) => messages.push(args),
      warn: (...args: unknown[]) => messages.push(args),
      error: (...args: unknown[]) => messages.push(args),
    };
    const upstream = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url, forwardedProto: request.headers["x-forwarded-proto"] }));
    });
    const appPort = await listen(upstream);
    const certificates = createCertificateManager(userData, logger);
    let gatewayPort = 0;
    const gateway = new GatewayManager({
      backend: {
        config: { appPort, gatewayPort: 0, gateway: { enabled: true, selectedAddress: "127.0.0.1" } },
        app: { isPackaged: false },
      },
      certificateManager: certificates,
      logger,
    });
    gateway.availableInterfaces = () => [{ name: "test", address: "127.0.0.1", netmask: "255.0.0.0", mac: "00:00:00:00:00:00" }];
    cleanups.push(async () => {
      await gateway.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await fs.rm(userData, { recursive: true, force: true });
    });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      gatewayPort = await availablePortPair();
      gateway.backend.config.gatewayPort = gatewayPort;
      try {
        await gateway.start("127.0.0.1", gatewayPort);
        break;
      } catch (error) {
        if (!isRetryableListenError(error) || attempt === 29) throw error;
      }
    }
    const status = gateway.status();
    expect(status.url).toBe(`https://127.0.0.1:${gatewayPort}`);
    expect(status.caDownloadUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${gatewayPort + 1}/__business-suite/onboarding/[A-Za-z0-9_-]+/business-suite-local-ca\\.crt$`));
    expect(status.onboardingScope).toBe("ca-certificate-only");
    expect(new Date(status.certificate.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(398 * 24 * 60 * 60_000);

    await expect(secureGet(`${status.url}/api/health`)).rejects.toThrow();
    const ca = await fs.readFile(certificates.caCertPath);
    const secured = await secureGet(`${status.url}/api/health`, ca);
    expect(secured.status).toBe(200);
    expect(JSON.parse(secured.body.toString("utf8"))).toEqual({ path: "/api/health", forwardedProto: "https" });

    const certificateResponse = await fetch(status.caDownloadUrl);
    expect(certificateResponse.status).toBe(200);
    expect(certificateResponse.headers.get("content-type")).toBe("application/x-x509-ca-cert");
    expect(await certificateResponse.text()).toContain("BEGIN CERTIFICATE");

    const forbiddenApp = await fetch(`http://127.0.0.1:${gatewayPort + 1}/api/health`);
    expect(forbiddenApp.status).toBe(404);
    expect(await forbiddenApp.text()).toBe("Not found");
    expect(gateway.status().onboardingDownloads).toBe(1);
  }, 30_000);
});
