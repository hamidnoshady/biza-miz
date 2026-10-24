# billing-contract/v1

Canonical wire shapes between **eshobe-cms** (execution plane) and **cafe-restaurant-pos**
(central Billing). Namespace: `billing-contract/v1`. Usage source: `eshobe-cms`.

## Auth (service-to-service)

| Header | Value |
|---|---|
| `x-eshobe-billing-key` | Credential `keyId` (`bsk_…` on CMS, `cms_…` on platform for usage ingest) |
| `x-eshobe-billing-timestamp` | Unix time in **seconds** (10 digits) |
| `x-eshobe-billing-signature` | `sha256=<hex>` HMAC-SHA256 over `"<timestamp>.<raw body>"` |

Replay window: five minutes. Receivers compare signatures in constant time. CMS also
refuses an identical `(key, timestamp, body)` fingerprint twice within the window.

The pre-v1 platform ingest protocol (`x-billing-*` headers, millisecond timestamp,
nonce, body-hash in the MAC string) lives only under
`src/billing/auth/compat/legacy-nonce-body-hash.ts` and optional outbound
`BILLING_USAGE_AUTH=legacy-nonce` until central Billing ships v1 verification.

## Credentials

| Scope | Issued by | Stored by |
|---|---|---|
| `billing.entitlement.write` | CMS (`POST /api/platform/billing/credentials`, admin session) | Platform operator config — pushes projections to CMS |
| `billing.usage.write` | Platform (`createBillingServiceCredential` on central Billing) | CMS `billing-service-credentials` (encrypted) — outbox publisher only |

CMS never mints `billing.usage.write` for platform; platform never needs CMS's entitlement
secret except as configured by the operator after CMS issuance.

## Files

- `usage-batch.schema.json` — CMS → central Billing batch POST
- `usage-ack.schema.json` — per-event ingest acknowledgement
- `entitlement-projection.schema.json` — central Billing → CMS push body
- `hmac-test-vectors.json` — canonical MAC examples (see `tests/int/billing-contract.int.spec.ts`)
- `fixtures/` — golden JSON bodies
