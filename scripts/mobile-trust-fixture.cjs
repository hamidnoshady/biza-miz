#!/usr/bin/env node
"use strict";

// Browser trust fixture for Android emulator and iOS simulator CI. It uses the
// production certificate manager, then proves both HTTPS and same-origin WSS.
// It does not claim physical-device UX; real-device evidence is a separate gate.
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { createCertificateManager } = require("../electron/certificate-manager.js");

const value = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const certificateAddress = value("address", "127.0.0.1");
const bindAddress = value("bind", "0.0.0.0");
const port = Number(value("https-port", "9443"));
const outputDir = path.resolve(value("output-dir", path.join(os.tmpdir(), "business-suite-mobile-trust")));
fs.mkdirSync(outputDir, { recursive: true });
const logger = { info() {}, warn() {}, error() {}, path: path.join(outputDir, "fixture.log") };
const certificates = createCertificateManager(outputDir, logger);
const certificateReady = certificates.ensureLeaf([certificateAddress]);
const reportPath = path.join(outputDir, "browser-result.json");
const metadataPath = path.join(outputDir, "fixture.json");
let httpsSeen = false;
let wssSeen = false;
let platform = null;

function writeResult() {
  fs.writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    scope: "simulator-or-emulator",
    platform,
    https: httpsSeen ? "PASS" : "PENDING",
    wss: wssSeen ? "PASS" : "PENDING",
    completed: httpsSeen && wssSeen,
    at: new Date().toISOString(),
  }, null, 2)}\n`);
}

let server = null;
// The certificate is generated (async) before the server reads it.
certificateReady.then((certificate) => {
server = https.createServer(certificates.tlsOptions(), (request, response) => {
  const url = new URL(request.url || "/", `https://${certificateAddress}:${port}`);
  if (url.pathname === "/acceptance") {
    platform = url.searchParams.get("platform") || "unknown";
    httpsSeen = true;
    writeResult();
    const html = `<!doctype html><meta charset="utf-8"><title>Business Suite mobile trust acceptance</title>
      <p id="state">HTTPS trusted; checking WSS…</p>
      <script>
        const ws = new WebSocket('wss://' + location.host + '/acceptance-socket');
        ws.onopen = () => { document.getElementById('state').textContent = 'HTTPS and WSS trusted'; ws.send('acceptance'); };
        ws.onerror = () => { document.getElementById('state').textContent = 'WSS failed'; };
      </script>`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self' wss:",
      "x-content-type-options": "nosniff",
    });
    response.end(html);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
  response.end("Not found");
});
server.on("upgrade", (request, socket) => {
  const expectedOrigin = `https://${certificateAddress}:${port}`;
  if (request.url !== "/acceptance-socket" || request.headers.origin !== expectedOrigin || !request.headers["sec-websocket-key"]) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  wssSeen = true;
  writeResult();
  setTimeout(() => socket.end(), 250).unref();
});
server.listen(port, bindAddress, () => {
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    schemaVersion: 1,
    address: certificateAddress,
    port,
    caCertPath: certificates.caCertPath,
    caFingerprint: certificate.caFingerprint,
    url: `https://${certificateAddress}:${port}/acceptance`,
  }, null, 2)}\n`);
  writeResult();
  console.log(`Mobile trust fixture listening on ${bindAddress}:${port} for certificate address ${certificateAddress}`);
});
});

function stop() { if (server) server.close(() => process.exit(0)); else process.exit(0); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
