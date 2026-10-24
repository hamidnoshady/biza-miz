"use strict";

/**
 * Issue #1001 — the packaged smoke probe is not part of the shipped shell.
 *
 * This was `runSmokeProbe()` inside `electron/main.js`: an unattended launch can
 * bootstrap an owner account with a **hardcoded password** when
 * `DESKTOP_SMOKE_BOOTSTRAP=1`. Shipping that in the production main process
 * means whoever can set one environment variable on the installed app can
 * create a known owner login on a machine that has no owner yet.
 *
 * The probe now lives here, in its own module, and is called only while
 * `DESKTOP_SMOKE_MARKER` is set (the smoke harness's own signal). Account
 * creation additionally requires either an unpackaged build or the explicit
 * `DESKTOP_SMOKE_PACKAGED_PROBE=1` that only `electron/scripts/smoke-packaged.js`
 * (not shipped — it is not in `build.files`) sets, so the released app cannot
 * be told to create a known-password owner by a stray environment variable.
 *
 * Everything the probe touches is injectable (`fetchImpl`, `env`,
 * `writeMarker`) so `src/lib/desktop-smoke-probe.test.ts` can exercise the gate
 * and the marker without a packaged app, a database or a network.
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { computePaths } = require("./app-paths");

/** May this run create the throwaway owner account? */
function mayBootstrap({ env = process.env, isPackaged = true } = {}) {
  if (env.DESKTOP_SMOKE_BOOTSTRAP !== "1") return false;
  return !isPackaged || env.DESKTOP_SMOKE_PACKAGED_PROBE === "1";
}

/** The mock cloud activation service the local bootstrap redeems against. */
function startMockCloudActivation({ privateKey, publicKeyPem, cloudBusinessId, cloudLocationId, credentialId }) {
  const crypto = require("node:crypto");
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      const installationId = body.installationId || crypto.randomUUID();
      const now = new Date();
      const expires = new Date(now.getTime() + 30 * 86_400_000);
      const leasePayload = {
        protocol: "biza_local_activation_v1",
        installationId,
        cloudBusinessId,
        issuedAt: now.toISOString(),
        expiresAt: expires.toISOString(),
        enforceOfflineLease: false,
      };
      const signature = crypto
        .sign(null, Buffer.from(JSON.stringify(leasePayload), "utf8"), privateKey)
        .toString("base64url");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          protocol: "biza_local_activation_v1",
          installationPublicId: "loc_smoke001",
          credentialId,
          token: "LOC1-smoke-credential-token-0123456789abcdef",
          lease: { payload: leasePayload, signature, publicKeyPem },
          businessBundle: {
            protocol: "biza_local_activation_v1",
            businessId: cloudBusinessId,
            name: "Packaged Runtime Test",
            slug: "packaged-runtime-test",
            subdomain: "packaged-runtime-test",
            industry: "food_service",
            status: "active",
            plan: "standard",
            supportAccessPolicy: "owner_consent",
            location: { id: cloudLocationId, name: "Windows Test Site", address: null, phone: null },
            features: [],
            appAvailability: [],
            policy: {
              policyVersion: 1,
              entitlementVersion: 1,
              enforceOfflineLease: false,
              offlineLeaseDays: 30,
              minSupportedVersion: null,
              requireExplicitLocalOwnerSupportApproval: true,
            },
            profileMetadata: {},
            revision: "rev_smoke_1",
            digest: "0000000000000000000000000000000000000000000000000000000000000001",
          },
        }),
      );
    });
  });
}

/**
 * Run the unattended launch's acceptance checks and write the smoke marker.
 * Throws if the app is not actually serving; the caller turns that into an
 * exit code and a failure marker.
 */
async function runSmokeProbe({
  appUrl,
  userDataDir,
  instanceId,
  env = process.env,
  isPackaged = true,
  fetchImpl = fetch,
  writeMarker,
} = {}) {
  const marker = env.DESKTOP_SMOKE_MARKER;
  if (!marker) throw new Error("DESKTOP_SMOKE_MARKER is required in smoke mode");

  const firstStateResponse = await fetchImpl(`${appUrl}/api/setup/state`, { cache: "no-store" });
  if (!firstStateResponse.ok) throw new Error(`setup state returned HTTP ${firstStateResponse.status}`);
  let state = await firstStateResponse.json();
  let authenticated = false;

  if (mayBootstrap({ env, isPackaged }) && state.needsBootstrap) {
    const crypto = require("node:crypto");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const cloudBusinessId = crypto.randomUUID();
    const cloudLocationId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const mockCloud = startMockCloudActivation({
      privateKey,
      publicKeyPem,
      cloudBusinessId,
      cloudLocationId,
      credentialId,
    });
    await new Promise((resolve) => mockCloud.listen(0, "127.0.0.1", resolve));
    const cloudPort = mockCloud.address().port;
    try {
      const bootstrap = await fetchImpl(`${appUrl}/api/setup/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: "Packaged Runtime Test",
          locationName: "Windows Test Site",
          ownerName: "Test Owner",
          email: "packaged-runtime@example.invalid",
          password: "Packaged-Test-Password-2026",
          industry: "food_service",
          deploymentMode: "local",
          cloudUrl: `http://127.0.0.1:${cloudPort}`,
          offlineToken: "OFL1-BCDF-GHJK-MNPQ",
        }),
      });
      if (!bootstrap.ok) throw new Error(`bootstrap returned HTTP ${bootstrap.status}: ${await bootstrap.text()}`);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] || "";
      const me = await fetchImpl(`${appUrl}/api/auth/me`, { headers: { cookie } });
      authenticated = me.ok;
      state = await (await fetchImpl(`${appUrl}/api/setup/state`, { headers: { cookie }, cache: "no-store" })).json();
    } finally {
      await new Promise((resolve) => mockCloud.close(() => resolve()));
    }
  }

  const result = {
    ok: true,
    needsBootstrap: Boolean(state.needsBootstrap),
    authenticated,
    instanceId,
    pgdata: fs.existsSync(path.join(computePaths(userDataDir).pgDataDir, "PG_VERSION")),
  };
  const write = writeMarker ?? ((contents) => fs.writeFileSync(marker, contents));
  write(JSON.stringify(result, null, 2));
  return result;
}

module.exports = { mayBootstrap, runSmokeProbe, startMockCloudActivation };
