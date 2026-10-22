# BM-SPIKE-2 — `docs/mcp/` file inventory

Files directly inside `docs/mcp/`, with their line counts (`wc -l` at the time of
writing) and what each one is for.

| File | Lines | Purpose |
|---|---|---|
| [`coverage-matrix.md`](mcp/coverage-matrix.md) | 164 | A generated, machine-reviewable matrix mapping every tenant and platform API route/domain to the MCP verbs that serve it, flagging each row as covered, partial, MCP gap, backend gap, route-only by design or n/a. |
| [`issue-883-authorization.md`](mcp/issue-883-authorization.md) | 172 | The hand-written authorization contract for the MCP connector, describing the ordered gate chain (token, host binding, authority, feature, catalogue filter, dispatcher, write path) and the rules each gate enforces on every call. |
| [`verb-inventory.md`](mcp/verb-inventory.md) | 469 | A generated, machine-reviewable inventory of the current MCP verb surface — read and write verbs with their app bucket, branch policy, gating permission, enforcing tests, and the deliberate exclusions. |
