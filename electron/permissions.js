"use strict";

/**
 * Issue #1001 — permissions are denied unless the product actually needs them.
 *
 * Electron's defaults are permissive, and they applied to both the till window
 * and the remote `persist:cloud` webview: geolocation, notifications, MIDI,
 * HID/serial/USB and microphone could all be requested by whatever document was
 * loaded. The window's own pages only need **the camera** (barcode scanning and
 * the inventory vision count — `getUserMedia({ video })`), so:
 *
 *   - requests are denied by default;
 *   - `media` is granted to the app origin only, and only when the request is
 *     video — an audio (microphone) request is refused;
 *   - clipboard *write* (sanitized) stays allowed, because the settings screens
 *     copy tokens and links with `navigator.clipboard.writeText`;
 *   - the cloud partition gets nothing at all: its pages must not reach the
 *     machine's devices through the desktop shell.
 *
 * Every other permission Electron asks about — notifications, geolocation,
 * midi, midiSysex, pointerLock, fullscreen, openExternal, HID, serial, USB,
 * `display-capture`, `clipboard-read`, `speaker-selection` — is refused.
 */

/** Which media types a request is asking for; Electron passes them in `details.mediaTypes`. */
function requestsAudioOnly(details) {
  const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
  return types.length > 0 && !types.includes("video");
}

function requestsVideo(details) {
  const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
  return types.length === 0 || types.includes("video");
}

/**
 * The single decision function both handlers share.
 * `requestingOrigin` is the origin Electron reports for the request.
 */
function permissionDecision(permission, requestingOrigin, { appOrigin, details } = {}) {
  if (!permission) return false;
  // The cloud pane runs a remote document: no device access, ever.
  if (appOrigin && requestingOrigin && requestingOrigin !== appOrigin) return false;
  if (permission === "clipboard-sanitized-write") return true;
  if (permission === "media") {
    if (!appOrigin) return false;
    if (requestsAudioOnly(details)) return false;
    return requestsVideo(details);
  }
  return false;
}

/**
 * Install deny-by-default request/check handlers on a session.
 * `setPermissionCheckHandler` also covers synchronous `navigator.permissions`
 * style checks, which would otherwise report a permission the request handler
 * then refuses.
 */
function installPermissionHandlers(ses, { appOrigin } = {}) {
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const origin = details?.requestingUrl ? safeOrigin(details.requestingUrl) : appOrigin;
    callback(permissionDecision(permission, origin, { appOrigin, details }));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const origin = requestingOrigin || (details?.requestingUrl ? safeOrigin(details.requestingUrl) : appOrigin);
    return permissionDecision(permission, origin, { appOrigin, details });
  });
  return { permissionDecision };
}

function safeOrigin(raw) {
  try {
    return new URL(String(raw)).origin;
  } catch {
    return null;
  }
}

module.exports = { permissionDecision, installPermissionHandlers };
