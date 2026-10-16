# MCP connector — authorization contract (issue #883)

What a connected AI client (Claude's and ChatGPT's MCP connectors, or any client
holding a `posmcp_…` token) may do is decided **server-side, on every call, from
current state** — never from anything captured when the connection was created.
This file is the written form of that contract: what each gate checks, in what
order, and which side of a boundary each decision lives on. If code and this
file disagree, code is a bug to fix; the tests pin this file's sentences.

## The chain a call passes, in order

```
bearer token (hash lookup, active, unexpired, business+location active)
        │
        ▼
host binding  (token's business == host's business; single-origin installs exempt)
        │
        ▼
authority  (authorized_by member exists, active — their CURRENT effective
            permissions ride along on the authentication object)
        │
        ▼
feature  (business has api_platform)
        │
        ▼
catalogue filter  (tools/list & resources/list: connection scopes AND
                   authorizer permissions AND module flags, intersected)
        │
        ▼
dispatcher  (tools/call: same filter enforced by name — a hidden tool is an
             unreachable tool; resources/read: domain gate before any SQL)
        │
        ▼
write path  (pos.write required; then the write contract below)
```

Every one of those checks **fails closed**: the absence of an answer is a no.

## The two rules that changed the shape of the code

### 1. Authority is re-resolved, never remembered (P0-1)

The permission set a tool runs under is the authorizing member's *current*
effective permissions — preset ∪ overrides — read on that very call
(`authenticateMcp` → `resolveMcpAuthority`). Consequences:

* a membership removed or deactivated kills the credential on its next call
  (`401`), even though the row in `mcp_connections` still exists;
* a permission revoked from the authorizer's role drops the matching tools
  from their connector's catalogue on the next `tools/list`, with no cache to
  wait out and no restart to schedule;
* reads that used to flow through `SYSTEM_AI_READ_PERMISSIONS` (literally "all
  permissions, always") now intersect with the member's own set — a desktop
  connector authorized by a cashier sees exactly a cashier's business, not an
  owner's.

`resources/read` is a second gate for the same reason locks have two
cylinders: even if a catalogue bug ever exposed a resource, the read itself
re-maps the URI through the permission matrix before any SQL runs.

### 2. Writes belong to people, and are re-judged at the moment they act (P0-5)

`AI_ACTION_PERMISSION_MAP` maps every write action to one domain permission.
An MCP write — immediate (`apply` mode) or queued-then-approved (`approve`
mode) — must find that permission in the *acting member's current* set:

* **immediate** — the connection's authorizer, resolved fresh by
  `authenticateMcp` (P0-5a);
* **approval** — the human pressing Approve, resolved fresh at decision time
  (P0-5b). A refusal here puts the row *back* to `proposed`: the remedy is an
  approver who does hold the permission, not a discarded change.

An action with no mapping fails closed; a new catalogue entry ships inert
until its mapping lands.

And inside the executor boundary (not only at the edge), every MCP write
passes issue #812's central authority gate — existence, active flag,
permissions, and reach over the target branch — so a machine write is held to
exactly the authorization a human-supervised autopilot write is.

## The concurrency contract for approvals (P0-3)

`ai_action_audit.status` is now `proposed → processing → applied|failed|…`.
Claiming is a single `UPDATE … WHERE status = 'proposed'` CAS: two owners (or
a battered retry) racing the same proposal produce **exactly one execution**,
and only the claimant's finalize CAS (`WHERE status = 'processing'`) may close
the row out.

* **Idempotency** — an apply-mode call may carry `_meta.idempotencyKey`,
  persisted under a partial unique index scoped `(business, connection, key)`
  (migration `0216_mcp_write_hardening`). A replay returns the original call's durable outcome —
  same audit id, no repeated effect — and answers `processing` rows with "in
  flight, ask again".
* **No retained authority** — approving a queued write re-reads the
  connection and requires it to still be `active` with `pos.write`. Revoking
  or narrowing a connection *dismisses* its outstanding proposals
  (`cancelOutstandingProposals`), so the queue can never execute on authority
  that has been taken back.

## Branch boundary (P0-2)

A connection is minted for one branch (`connections.location_id`). Before the
executor runs, `executeClaimedProposal` resolves the write's target branch
from the payload via the executors' own `executorTargetLocation` (plus
`resolveBranchRef` for branch-filed payloads like expenses) and refuses with
`branch_forbidden` when it names another branch — a connector minted for
branch A never moves a row whose branch is B, whatever its authorizer may see.

* `single_branch` install → the boundary is the whole business; the check is
  trivially satisfied and stays as a safety net.
* `multi_branch` → per-connection boundary as above.

Reads are scoped by RLS per business (branch scoping for reads stays
advisory, matching the rest of the app — see `tenant-context.ts`).

## Management-API policy: owner-only (P0-4)

The consent screen's promise — *"only the owner can do this"* — is now the
server's rule, carried by the dedicated **owner-only** permission
`mcp.manage` (`PERMISSIONS.mcpManage`, in `OWNER_ONLY_PERMISSIONS` beside
`api.manage`). These five routes require it:

| Route | Uses |
| --- | --- |
| `POST /api/connections/mcp` | mint a static token |
| `PATCH /api/connections/mcp/[id]` | narrow scopes / switch write mode |
| `DELETE /api/connections/mcp/[id]` | revoke |
| `POST /api/connections/mcp/consent` | OAuth "allow" |
| `POST /api/connections/mcp/pending/[id]` | decide a queued write |

`GET /api/connections/mcp` (listing) and the consent page's own GET read stay
on `integrations.view`. The UI (`mcp-panel.tsx`) self-gates on the `canManage`
flag the GET now returns — the server never trusts `ConsentForm.isOwner`.

## Endpoint hygiene (P1-7)

* request body cap 1 MiB (413) at `/api/mcp`;
* batch cap `MAX_BATCH_MESSAGES = 20` per JSON-RPC envelope;
* OAuth (`/api/mcp/oauth/*`) unchanged: PKCE S256, static clients, refresh
  rotation — deliberately untouched by this issue.

## Request limits, origins, and what this issue did NOT do

* **Host binding (P1-6)**: a token answers only on its own business's MCP
  host, except single-origin installs where the token *is* the tenant
  selector.
* The **scope vocabulary** is still `pos.read` / `pos.write` — widening it is
  its own migration-gated project (the 0101 CHECK constraint), deliberately
  not done here.
* The **superadmin MCP realm** (`/api/platform/mcp`) is issue #883's second
  half and lands separately; nothing in this change relaxes any platform-side
  guard.

## Coverage matrix

| Gate | Unit | Integration (real PG/RLS) |
| --- | --- | --- |
| fail closed on deleted/deactivated authorizer | — | ✓ two bearers survive revocation only |
| tools/list intersects scopes ∧ permissions | ✓ `tools.test.ts` | ✓ cashier catalogue |
| revoked permission disappears mid-life | — | ✓ crm.view drop |
| hidden tool refuses by name | ✓ | ✓ |
| resources/read RBAC gate | ✓ | ✓ payroll/VAT/refund/report |
| host binding | ✓ `origin.test.ts` ×5 | ✓ wrong-host bearer 401 |
| write = authorizer's current permission | — | ✓ cashier set_item_price refused, owner applies |
| approve mode re-judges approver | ✓ (guard mock) | ✓ queued write claims once |
| concurrent approvers — exactly one | — | ✓ Promise.all, one applied |
| idempotency replay | — | ✓ apply-mode double call |
| branch_forbidden | — | ✓ cross-branch price write |
| revoke/narrow dismisses proposals | — | ✓ cancelled reason persisted |
| management routes → `mcp.manage` only | ✓ `management-policy.test.ts` ×9 | — |
| batch/body caps | ✓ | — |
