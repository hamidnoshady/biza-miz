/**
 * Issue #984 — mints the two support-token key sets and prints them for the
 * operator to store in the deployment's secret manager. Nothing is written
 * to disk: redirect stdout yourself, then set SUPPORT_TOKEN_SIGNING_KEY and
 * SUPPORT_OFFLINE_TOKEN_SIGNING_KEY from the printed JWK JSON objects.
 *
 *   npx tsx scripts/mint-support-keys.mts
 */
import {
  generateOfflineTokenKeys,
  generateSupportTokenKeys,
} from "../src/lib/support-companion/access-tokens";

const session = await generateSupportTokenKeys();
const offline = await generateOfflineTokenKeys();

console.log("# Ed25519 — server-minted, server-verified session JWTs");
console.log(`SUPPORT_TOKEN_KEY_ID=v1`);
console.log(`SUPPORT_TOKEN_SIGNING_KEY=${JSON.stringify(session.privateJwk)}`);
console.log("# ES256 (P-256) — offline on-site tokens verified by the companion");
console.log(`SUPPORT_OFFLINE_TOKEN_KEY_ID=offline-v1`);
console.log(`SUPPORT_OFFLINE_TOKEN_SIGNING_KEY=${JSON.stringify(offline.privateJwk)}`);
console.log("# Public halves for the companion's approved-keys bundle:");
console.log(JSON.stringify({ session: session.publicJwk, offline: offline.publicJwk }));
