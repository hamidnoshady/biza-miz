const { isTrustedAppFrame } = require("./ipc-sender");

// #934 hub boundary; gateway transport/provisioning remains owned by #766.
// Never trust a role, origin, cookie or approval bit supplied in IPC payloads.
// The sender test itself is shared with every other `desktop:*` handler since
// issue #1001 — see ipc-sender.js — and keeps this module's error name so the
// gateway's own refusal stays distinguishable in logs and tests.
function assertGatewaySender(event, window, appUrl) {
  if (!isTrustedAppFrame(event, window, appUrl)) {
    throw new Error("gateway_sender_forbidden");
  }
}

async function authorizeGatewayInvocation(event, window, appUrl) {
  assertGatewaySender(event, window, appUrl);
  // Electron's own session supplies HttpOnly cookies. Fixed local backend,
  // no renderer-supplied endpoint and no redirects to a different authority.
  const response = await window.webContents.session.fetch(
    new URL("/api/connections/local-gateway/authorize", appUrl).toString(),
    { method: "POST", credentials: "include", redirect: "error",
      headers: { Origin: new URL(appUrl).origin }, signal: AbortSignal.timeout(8000) },
  );
  if (!response.ok || (await response.json()).authorized !== true) {
    throw new Error("gateway_owner_required");
  }
  // The renderer might have navigated while the live role check was in flight.
  assertGatewaySender(event, window, appUrl);
}

module.exports = { assertGatewaySender, authorizeGatewayInvocation };
