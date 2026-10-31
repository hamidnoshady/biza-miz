# Managed services — the platform-wide rule (issue #902 §0)

Every provider-backed capability in Bizamiz is a **Bizamiz managed service**. A business buys,
switches on and uses a first-party capability inside the app that owns it. Bizamiz holds the
supplier relationship, the credentials, the wholesale tariff and the operational dashboards; the
business holds one thing — the platform wallet, priced at retail.

That is a product rule, not a Kavenegar implementation detail, so it is written once here, enforced
by code, and inherited by every integration that follows rather than re-derived per adapter.

## 1. The four properties of a managed service

A capability is *managed* when all four hold. Three out of four is how the leak this issue fixed
happened in the first place.

1. **First-party vocabulary.** No tenant surface names the supplier, its account ids, its status
   codes or its prices. Not in a card, not in an error, not in an export cell, not in an audit note.
2. **Our credential.** The supplier key lives in a store the platform administers — a
   deployment-wide encrypted singleton, or one child account per business minted by provisioning.
   A business never types a supplier key, and a supplier key never reaches a tenant response.
3. **One wallet.** Retail is charged through the central billing domain (`wallet_ledger`, price
   versions, hold → settle → refund-once). Wholesale is a separate, tenant-invisible fact
   (`billing_vendor_cost_events`). A managed service never creates a second balance.
4. **A guard, not a promise.** A test that reads the sources and the payloads fails CI when the
   rule is broken. `src/lib/managed-services/contract.ts` + `inventory.test.ts` are that guard.

## 2. The inventory

`src/lib/managed-services/inventory.ts` lists every provider-backed capability with five facts: who
supplies it today (internal only), where the credential lives, which console screen administers it,
which tenant files render it, and **how far the migration has actually got**.

| Maturity | Meaning |
| --- | --- |
| `managed` | All four properties hold and a guard pins them. |
| `partial` | First-party vocabulary holds; one other property (usually the wholesale ledger) does not. |
| `vendor_visible` | A tenant surface names the supplier today. Each entry carries the issue that removes it. |

The table is tested like code: every path it names must exist, every `vendor_visible` entry must
name its follow-up issue, and a service in `MANAGED_SERVICES` must also be in the inventory. A
roadmap that says "all managed" while three screens name a supplier is exactly the failure this
file exists to prevent.

Current state (see the file for the table itself): SMS is managed end to end — child account per
business, platform-auth transport for login codes, retail settled once per message. Media storage is
managed (per-business prefixes in one bucket). Email relay, the AI credential and the payment
gateway are `partial`: first-party in tenant copy, missing a wholesale cost line. The WordPress
integration is deliberately listed with `supplier: null` — the tenant's own site is the product, and
hiding a name it chose itself would be the confusing kind of first-party. Torob (#894) and Divar
(#896) are `vendor_visible` and not built: listed so the audit is complete rather than flattering.

## 3. The rules, in the order they bite

**A tenant response is never a supplier view.** The only shape a tenant surface may render is
`TenantManagedServiceView`: a first-party label, one of four states, a Persian sentence, and — when
the business can act — a link to a first-party screen. The type has no field for a provider name, an
account id, a key hint, a wholesale price or a provider status code. A shape that cannot carry a
leak is cheaper to keep honest than a promise that nobody will put one there.

**Internal reasons are translated, never forwarded.** An adapter maps a supplier's error code to
`ManagedServiceDetailKey` (`provisioning`, `wallet_empty`, `suspended_by_plan`, …) and the contract
picks the sentence. That indirection is why a raw provider code has no route to tenant copy.

**Distinguish, don't name.** Where a screen genuinely needs to know *how* something happens — is a
top-up taken by a gateway or recorded as a manual transfer? — the API answers the distinction in
first-party words (`paymentMode: "online" | "manual"`), never the supplier's name. The billing page
used to compare a raw `gateway` string against a supplier to decide its copy; it now reads the
mode.

**Supplier names are internal even in English.** Logs, console screens, adapter code and migrations
may say Kavenegar, Parspack or Zarinpal; a tenant file may not, in either alphabet. `SUPPLIER_NAME_PATTERN`
is the single definition, shared by the payload guard and the source guard — two patterns would
drift. It allows zero-width non-joiner as a separator, because «کاوه‌نگار» is how the name is
actually typed and `\s` does not match ZWNJ (the first version of the pattern only caught the spaced
spelling nobody uses). It deliberately does *not* include words that are also ordinary Persian
(«دیوار» is a retaining wall; «ترب» is a word): a guard that cries wolf gets deleted, and then it
guards nothing.

**The console is where provider detail lives.** `/platform/*` screens — the managed-account card, the
media console, the AI and billing consoles — are the one place a supplier's name, key hint, tariff
and status code belong. They require a platform capability, never a tenant permission.

**Money never crosses the boundary in a tenant direction.** Wholesale cost is written by the adapter
(`billing_vendor_cost_events`, `tenant_visible = false`); retail is written by Billing. A tenant
wallet entry may carry a price *version* number, never a markup.

## 3a. Readiness for every integration, in one shape

Issue #902 §9 item 5 took the contract beyond messaging. `src/lib/managed-services/readiness.ts`
holds one small, pure adapter per integration — AI, payments, media, the email relay — that turns a
handful of booleans and internal reasons into a `ManagedServiceDetailKey`; `readiness-service.ts`
reads the deployment's actual configuration; `/api/managed-services` serves the resulting views and
passes them through `assertTenantSafePayload` on the way out. `/settings/services` renders them.

The ordering rule inside every adapter is the part worth remembering:

1. **Our side first.** If the platform has not set the service up, that is the answer. Telling a
   business to buy a plan for something we cannot deliver is the one sentence this vocabulary must
   never produce, so `platform_setup_incomplete` is checked *before* the entitlement layer.
2. **Then their side.** A working service the business is not entitled to is `suspended_by_plan`,
   which carries a first-party link that fixes it.
3. **Then limits and money.** `usage_limit_reached` (a support conversation) and `wallet_empty`
   (a top-up) are separate states because the fix differs; folding either into `needs_support`
   would send a business to the wrong page.

Two states exist only for the newer integrations and are documented here rather than reused:
`usage_limit_reached` and `no_access`. The second is about the *member* asking, not the business, so
it offers no link — the fix is another member granting the role, not a page.

Torob (#894) and Divar (#896) are deliberately **not** in `MANAGED_SERVICES` yet: a definition
promises a readiness shape, and there is nothing to report on until those issues are built. The
inventory lists them as `vendor_visible` so the audit stays complete rather than flattering.

## 4. What a new integration inherits

1. Register the service in `MANAGED_SERVICES` (`contract.ts`) with a `TenantManagedServiceView` for
   the tenant screen, and in `MANAGED_SERVICE_INVENTORY` with its credential store and maturity.
2. Translate its failures into `ManagedServiceFaultCode`; never let a supplier's message reach a
   tenant.
3. Charge retail through the existing wallet; record wholesale as a tenant-invisible vendor cost.
4. Add its readiness adapter in `readiness.ts` and a row to the payload in `readiness-service.ts`,
   with the our-side-first ordering above.
5. Run `npx vitest run src/lib/managed-services` — if a screen you added names the supplier, the
   inventory's guard fails, which is the point; `readiness.test.ts` walks every state of every
   integration through the same leak guard the API applies.

## 5. Known exceptions, stated rather than hidden

- **OAuth redirects.** A payment gateway's own hosted page names itself while the browser is on it.
  That is the supplier's page, not ours, and it is unavoidable at that moment. No tenant screen we
  render names it.
- **The MCP panel** (`src/app/(app)/settings/connections/mcp-panel.tsx`) names Claude and ChatGPT
  because those are the *tenant's own* AI clients being connected to our MCP server. They are not a
  supplier Bizamiz resells, so the guard allows that file by name and by nothing else.
- **The tenant's own installations.** WordPress/WooCommerce, a business's own SMTP account and its
  own domain are the business's property; the inventory records them with `supplier: null`.
