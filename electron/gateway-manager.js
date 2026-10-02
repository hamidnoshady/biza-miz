"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { listLanInterfaces } = require("./network-interfaces");

function proxyHeaders(request) {
  return {
    ...request.headers,
    "x-forwarded-proto": "https",
    "x-forwarded-for": request.socket.remoteAddress || "",
  };
}

class GatewayManager {
  constructor({ backend, certificateManager, logger }) {
    this.backend = backend;
    this.certificates = certificateManager;
    this.logger = logger;
    this.server = null;
    this.onboardingServer = null;
    this.onboardingToken = null;
    this.onboardingDownloads = 0;
    this.lastOnboardingDownloadAt = null;
    this.tlsErrorCount = 0;
    this.lastTlsError = null;
    this.clients = new Map();
  }

  availableInterfaces() {
    return listLanInterfaces();
  }

  rememberClient(socket, kind) {
    const address = socket.remoteAddress || "unknown";
    this.clients.set(`${kind}:${address}`, { address, kind, lastSeenAt: new Date().toISOString() });
    if (this.clients.size > 100) this.clients.delete(this.clients.keys().next().value);
  }

  async start(address, port, forceCertificate = false) {
    if (this.server) await this.stop();
    const available = this.availableInterfaces();
    if (!available.some((item) => item.address === address)) {
      throw new Error(`The selected private IPv4 address is no longer active: ${address}`);
    }
    const certificate = forceCertificate
      ? await this.certificates.regenerate(available.map((item) => item.address))
      : await this.certificates.ensureLeaf(available.map((item) => item.address));
    const appPort = this.backend.config.appPort;
    this.server = https.createServer(this.certificates.tlsOptions(), (request, response) => {
      this.rememberClient(request.socket, "https");
      if (request.url === "/__business-suite/local-ca.crt") {
        response.writeHead(200, {
          "Content-Type": "application/x-x509-ca-cert",
          "Content-Disposition": 'attachment; filename="business-suite-local-ca.crt"',
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        fs.createReadStream(this.certificates.caCertPath).pipe(response);
        return;
      }
      const upstream = http.request({
        host: "127.0.0.1",
        port: appPort,
        method: request.method,
        path: request.url,
        headers: proxyHeaders(request),
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on("error", (error) => {
        this.logger.warn("Gateway HTTP proxy error", error);
        if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Business Suite local server is temporarily unavailable.");
      });
      request.pipe(upstream);
    });

    this.server.on("upgrade", (request, socket, head) => {
      this.rememberClient(socket, "websocket");
      const upstreamRequest = http.request({
        host: "127.0.0.1",
        port: appPort,
        method: request.method,
        path: request.url,
        headers: proxyHeaders(request),
      });
      upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
        const status = `HTTP/${upstreamResponse.httpVersion} ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n`;
        const headers = Object.entries(upstreamResponse.headers)
          .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}\r\n`) : value !== undefined ? [`${name}: ${value}\r\n`] : [])
          .join("");
        socket.write(`${status}${headers}\r\n`);
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket).pipe(socket);
      });
      upstreamRequest.on("response", (upstreamResponse) => {
        socket.write(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || "Rejected"}\r\n\r\n`);
        socket.destroy();
      });
      upstreamRequest.on("error", (error) => {
        this.logger.warn("Gateway WebSocket proxy error", error);
        socket.destroy();
      });
      upstreamRequest.end();
    });
    this.server.on("tlsClientError", (error) => {
      this.tlsErrorCount += 1;
      this.lastTlsError = {
        code: typeof error?.code === "string" ? error.code : "TLS_CLIENT_ERROR",
        message: String(error?.message || "TLS handshake failed").slice(0, 240),
        at: new Date().toISOString(),
      };
      this.logger.warn("Gateway TLS client error", this.lastTlsError);
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: address, port, exclusive: true }, resolve);
    });

    // Certificate bootstrap cannot depend on trusting the certificate it is
    // trying to install. This second listener serves exactly one public CA
    // file behind an ephemeral unguessable path; it never proxies the app,
    // accepts writes, cookies, credentials or WebSockets. The desktop displays
    // the SHA-256 fingerprint that the operator must compare on the device.
    const onboardingPort = port + 1;
    this.onboardingToken = crypto.randomBytes(24).toString("base64url");
    const onboardingPath = `/__business-suite/onboarding/${this.onboardingToken}/business-suite-local-ca.crt`;
    this.onboardingServer = http.createServer((request, response) => {
      const pathname = new URL(request.url || "/", "http://onboarding.invalid").pathname;
      if (request.method !== "GET" || pathname !== onboardingPath) {
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        });
        response.end("Not found");
        return;
      }
      this.onboardingDownloads += 1;
      this.lastOnboardingDownloadAt = new Date().toISOString();
      response.writeHead(200, {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="business-suite-local-ca.crt"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
        "Referrer-Policy": "no-referrer",
      });
      fs.createReadStream(this.certificates.caCertPath).pipe(response);
    });
    try {
      await new Promise((resolve, reject) => {
        this.onboardingServer.once("error", reject);
        this.onboardingServer.listen({ host: address, port: onboardingPort, exclusive: true }, resolve);
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.address = address;
    this.port = port;
    this.onboardingPort = onboardingPort;
    this.onboardingPath = onboardingPath;
    this.logger.info("Local HTTPS gateway and CA-only onboarding listener started", { address, port, onboardingPort });
    return { address, port, onboardingPort, certificate };
  }

  async stop() {
    const servers = [this.server, this.onboardingServer].filter(Boolean);
    if (!servers.length) return;
    this.server = null;
    this.onboardingServer = null;
    this.onboardingToken = null;
    this.onboardingPath = null;
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
      setTimeout(resolve, 5000).unref();
    })));
    this.logger.info("Local HTTPS gateway and CA onboarding listener stopped");
  }

  status() {
    const interfaces = this.availableInterfaces();
    const configured = this.backend.config?.gateway || { enabled: false, selectedAddress: null };
    const address = this.address || configured.selectedAddress;
    return {
      supported: process.platform === "win32" || !this.backend.app.isPackaged,
      enabled: Boolean(configured.enabled),
      running: Boolean(this.server?.listening),
      computerName: require("node:os").hostname(),
      interfaces,
      selectedAddress: address || null,
      port: this.backend.config?.gatewayPort || 8443,
      url: address ? `https://${address}:${this.backend.config?.gatewayPort || 8443}` : null,
      caDownloadUrl: address && this.onboardingPath && this.onboardingServer?.listening
        ? `http://${address}:${this.onboardingPort}${this.onboardingPath}`
        : null,
      onboardingPort: this.onboardingPort || (this.backend.config?.gatewayPort || 8443) + 1,
      onboardingScope: "ca-certificate-only",
      onboardingDownloads: this.onboardingDownloads,
      lastOnboardingDownloadAt: this.lastOnboardingDownloadAt,
      tlsDiagnostics: { count: this.tlsErrorCount, last: this.lastTlsError },
      certificate: this.certificates.describe(),
      clients: [...this.clients.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, 20),
      addressActive: address ? interfaces.some((item) => item.address === address) : false,
    };
  }
}

module.exports = { GatewayManager, proxyHeaders };
