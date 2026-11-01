# Contract documents, reusable templates and multi-party e-signing (#908)

Status: **phases A–C implemented, D partially, E open.** This page is the map of
what exists, where it lives, and what is honestly still missing. It is written to
be read beside the code, not instead of it.

Scope boundary (from the epic, unchanged): `workspace_contracts` stays the
canonical execution-contract record — this work **extends** it. Contracts are a
Workspace module, **not** a fifth tenant app. The SMS/OTP/wallet stack is the
platform one from #902; there is no second messaging provider. Signing never
posts an accounting entry.

## 1. Data model — `migrations/0258_contract_documents_signing.sql`

| table | what it holds | mutability |
|---|---|---|
| `contract_templates` | the business's own reusable documents | editable, archivable |
| `contract_template_versions` | every published revision of a template | append-only |
| `contract_documents` | the editable draft, one per contract (unique) | editable with optimistic `revision` |
| `contract_document_versions` | frozen snapshots + SHA-256 content hash | insert-only |
| `contract_signing_envelopes` | one signature round per frozen version | status machine |
| `contract_signers` | one person per placement and per phone | until signed |
| `contract_invitations` | the bearer token, stored as an HMAC digest | rotated on resend |
| `contract_signatures` | the evidence row: who, when, which hash, which slot | insert-only |
| `contract_signing_events` | the timeline | insert-only |

Every table carries `business_id`, has **FORCE** row-level security and a
`tenant_isolation` policy with the documented `app_rls_bypass()` escape. The
three evidence tables (`contract_document_versions`, `contract_signatures`,
`contract_signing_events`) grant **SELECT and INSERT only**, so history cannot be
rewritten by the application role — a correction is a new version, not an edit.

Invariants enforced in the database, not only in code:

* one document per contract (`UNIQUE (contract_id)`);
* one **live** envelope per contract (`... WHERE status IN ('draft','sent','partially_signed')`);
* one **live** token per signer (`... WHERE revoked_at IS NULL`), so "resend" burns the old link;
* one signature per signer (`UNIQUE (signer_id)`);
* two people cannot share a signature line or a phone number in the same round.

`src/lib/contracts/schema-contract.test.ts` pins the migration to every column
the service writes, plus the five invariants above. It exists because the first
draft of this branch drifted there (`ip_address`, `cancel_reason`, a missing
`title`) — typechecking cannot see SQL.

## 2. The document model — `src/lib/contracts/blocks.ts`

Dependency-free, so the editor, the print view, the receipt and the public
signing page all render the same document the same way:

* block types: heading, paragraph, article, bullets, numbered, table, divider,
  page break, signature placement;
* variables: `{{key}}`, substituted only through `renderTemplate`, never string
  concatenation;
* `normalizeContractContent` is the trust boundary for anything off the wire:
  unknown block types are dropped, lengths capped, ragged table rows squared,
  duplicate variable keys folded, duplicate signature placements **renumbered**
  (dropping one would silently lose a party's signature line);
* `validateContractContent` returns `{code, message, blockId?, fieldKey?}` so the
  editor can put the sentence next to the block that caused it.

## 3. Autofill and lineage — `src/lib/contracts/bindings.ts`

`CONTRACT_BINDING_CATALOGUE` is the **allow-list** of values a contract may
disclose (contract terms, project, party, business identity) and the same list
the editor offers. Resolution reports where each value came from:
`binding | override | literal | empty`, keeps `boundValue` when the sender typed
over a record, and `changedBindings` turns a source that moved after review into
a `stale` flag on the field.

## 4. Services and API

* `src/lib/contracts/service.ts` — the draft, template library, freezing,
  duplication, and the binding context. Freezing resolves every variable first
  and refuses while any required value is empty; a frozen version stores the
  resolved strings inside its own JSON, so the printed contract stops moving at
  the moment it acquires a hash.
* `src/lib/contracts/signing.ts` — envelopes, signers, invitations, delivery, and
  the whole public session (consent → OTP → signature → receipt).
* `src/lib/contracts/crypto.ts` — canonical-JSON SHA-256 and the HMAC-hashed
  invitation token. The plaintext token exists only in the message that carried
  it.

| route | verbs | authority |
|---|---|---|
| `/api/workspace/contracts/[id]/document` | GET, PUT | `workspace.view` / `workspace.contracts_manage` + `resolveWorkspaceSubject(edit)` |
| `/api/workspace/contracts/[id]/document/versions` | GET, POST | same |
| `/api/workspace/contracts/[id]/document/template` | POST | same |
| `/api/workspace/contracts/[id]/signing` | GET, PUT, POST | same |
| `/api/workspace/contract-templates` | GET, POST, DELETE | view / contracts_manage |
| `/api/workspace/contracts` | POST (+`templateRef`, `duplicateOf`) | contracts_manage |
| `/api/sign/[token]` | GET, POST | **the token only** — no session, no tenant id from the caller |

The public route is the product's only session-less surface apart from the auth
doors. It is listed in `PUBLIC_PATHS`, behind the same Origin check as the
login mutations, and justified in `api-guards.test.ts` `PUBLIC_ROUTES`. Every id
it acts on is resolved **from the token**, never accepted from the request.

## 5. Screens

* `/workspace/contracts` — the existing list; each title links to its document.
* `/workspace/contracts/[id]` — two tabs: **سند** (the three-panel builder) and
  **امضا و ارسال** (signers, delivery, timeline), tab in the URL (`?tab=signing`).
* `/workspace/contracts/[id]/print` — A4 print/PDF of the newest frozen version,
  falling back to the draft with unresolved variables marked.
* `/sign/[token]` — the external signatory's page: frozen document → explicit
  consent → phone OTP → drawn signature → receipt with the content hash.

The builder is RTL-first: library and variables on the leading side, the A4
canvas in the middle, the inspector trailing. Below `lg` the three panels stack.

## 6. Honest gaps (what this branch does NOT claim)

1. **DOCX/PDF import** is not implemented. There is no parser in this change and
   no button pretending there is. Contracts start blank, from a built-in
   template, from a saved template, or as a duplicate.
2. **Notifications on completion** are not wired to the notifications subsystem;
   the timeline and the sender's screen show the state, but no message is pushed.
3. **Settings/AEC autofill sources** are limited to the catalogue in
   `bindings.ts` (contract, project, party, business). AEC commercial terms and
   the CRM party file are covered through the project/party projections; there is
   no per-field AEC binding yet.
4. **No Database/CI proof in this environment.** `npm run test:db` needs a
   PostgreSQL instance that this sandbox does not have; the SQL is verified only
   by the static contract test above. CI must run it.
5. **`npm run build` was not executed** here (the sandbox has 3 GB and the
   previous full `tsc` run exhausted it); a scoped `tsc --noEmit` over every file
   this branch touches passes, and the full `vitest` suite passes.

## 7. Verification commands

```bash
# the new domain modules, end to end
npx vitest run src/lib/contracts

# the repo-wide gates this branch touches
npx vitest run src/app/api/api-guards.test.ts src/app/design-lint.test.ts \
  src/app/dashboard/design-lint.test.ts src/app/dashboard/primitive-lint.test.ts \
  src/app/loading-coverage.test.ts src/lib/client-bundle-boundary.test.ts \
  src/lib/brand-coverage.test.ts src/lib/mcp/registry.test.ts \
  src/lib/billing/catalog/audit.test.ts \
  src/components/ui/numeric-input-architecture.test.ts

# the whole suite (≈12 minutes)
npx vitest run

# the migration, on a database
npm run test:db
```
