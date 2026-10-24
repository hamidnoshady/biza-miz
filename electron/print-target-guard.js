"use strict";

/**
 * Issue #1001 — the print IPC is not a raw TCP primitive.
 *
 * `native-printing.js` deliberately accepts a renderer-supplied
 * `{type:"network", ip, port}` target, because the settings screen and the POS
 * print to whichever ESC/POS printer the owner saved. But an unrestricted
 * target means the privileged preload turns into "send arbitrary bytes to any
 * TCP port this machine can reach" — including `127.0.0.1` services (the app's
 * own loopback server, PostgreSQL) and any internet host. A compromised or
 * merely foreign page in the main frame would inherit that.
 *
 * So the main process narrows the target before dispatch, in `main.js`:
 *
 *   - `network` targets must be an RFC1918 IPv4 address that is on one of this
 *     machine's own LAN subnets (the same addresses discovery sweeps), never
 *     loopback, link-local or a public address;
 *   - the port must be on the raw-print allow-list (9100 by default);
 *   - `windows` targets keep a non-empty queue name (the spooler is already the
 *     OS boundary) and page jobs a non-empty printer name;
 *   - the payload is capped before it is decoded, so a hostile renderer cannot
 *     make the main process allocate an unbounded buffer.
 *
 * Refusals use the product's existing `invalid_printer` error code — the
 * settings UI already renders it as «چاپگر معتبر نیست» — rather than a new
 * code that the client would not know.
 */

const { isPrivateIpv4, listLanInterfaces } = require("./network-interfaces");

/** Raw-print ports a saved network printer may use; 9100 is the ESC/POS default. */
const ALLOWED_NETWORK_PRINT_PORTS = Object.freeze([9100, 9101, 9102, 9103]);
const DEFAULT_NETWORK_PRINT_PORT = 9100;
const MAX_RAW_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PAGE_PAYLOAD_BYTES = 8 * 1024 * 1024;

function ipv4ToInt(address) {
  const parts = String(address ?? "").trim().split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function isIpv4(address) {
  return ipv4ToInt(address) !== null;
}

/**
 * A /24 mask derived from the interface address when Windows reports no usable
 * netmask — the same assumption `native-printing.js`'s discovery already makes.
 */
function effectiveMask(netmask, address) {
  const mask = ipv4ToInt(netmask);
  if (mask !== null && mask !== 0) return mask;
  const base = ipv4ToInt(address);
  return base === null ? null : (0xffffff00 & base) >>> 0;
}

/** Is `ip` inside this interface's subnet (address + netmask)? */
function ipInInterfaceSubnet(ip, item) {
  const address = ipv4ToInt(item?.address);
  const candidate = ipv4ToInt(ip);
  if (address === null || candidate === null) return false;
  const mask = effectiveMask(item?.netmask, item?.address);
  if (mask === null) return false;
  return ((candidate & mask) >>> 0) === ((address & mask) >>> 0);
}

function onLocalSubnet(ip, interfaces) {
  return (interfaces ?? []).some((item) => ipInInterfaceSubnet(ip, item));
}

function refusal(detail) {
  return { ok: false, error: "invalid_printer", detail };
}

/**
 * Normalise a renderer-supplied target, or refuse it.
 * Returns `{ ok: true, target }` with the exact shape `native-printing.js`
 * dispatches on, or `{ ok: false, error: "invalid_printer", detail }`.
 */
function validatePrintTarget(
  target,
  { listInterfaces = listLanInterfaces, allowedPorts = ALLOWED_NETWORK_PRINT_PORTS } = {},
) {
  if (!target || typeof target !== "object") return refusal("The print target is missing.");

  if (target.type === "windows") {
    const systemName = typeof target.systemName === "string" ? target.systemName.trim() : "";
    if (!systemName) return refusal("The Windows printer queue name is missing.");
    return { ok: true, target: { type: "windows", systemName } };
  }

  if (target.type !== "network") return refusal("The printer connection type is not supported.");

  const ip = typeof target.ip === "string" ? target.ip.trim() : "";
  const port = target.port === undefined || target.port === null ? DEFAULT_NETWORK_PRINT_PORT : Number(target.port);
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
    return refusal(`The network print port must be one of ${allowedPorts.join(", ")}.`);
  }
  if (!isIpv4(ip) || !isPrivateIpv4(ip)) {
    return refusal("The network printer must be a private LAN IPv4 address.");
  }
  if (!onLocalSubnet(ip, listInterfaces())) {
    return refusal("The network printer is not on a local subnet of this computer.");
  }
  return { ok: true, target: { type: "network", ip, port } };
}

/**
 * Decode and bound a base64 payload. The length is checked *before* decoding so
 * an oversized string never becomes an oversized Buffer.
 */
function readPrintPayload(dataBase64, { maxBytes = MAX_RAW_PAYLOAD_BYTES } = {}) {
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
    return refusal("The print data is empty.");
  }
  if (dataBase64.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    return refusal(`The print data exceeds the ${maxBytes}-byte limit.`);
  }
  if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    return refusal("The print data is not valid base64.");
  }
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0) return refusal("The print data is empty.");
  if (bytes.length > maxBytes) return refusal(`The print data exceeds the ${maxBytes}-byte limit.`);
  return { ok: true, bytes };
}

module.exports = {
  ALLOWED_NETWORK_PRINT_PORTS,
  DEFAULT_NETWORK_PRINT_PORT,
  MAX_RAW_PAYLOAD_BYTES,
  MAX_PAGE_PAYLOAD_BYTES,
  ipv4ToInt,
  isIpv4,
  ipInInterfaceSubnet,
  onLocalSubnet,
  validatePrintTarget,
  readPrintPayload,
};
