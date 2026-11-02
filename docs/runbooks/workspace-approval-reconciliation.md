# Workspace approval reconciliation (issue #907 F03)

A short operator runbook for the two stuck states the #907 audit found in the
workspace approval engine, and for the live re-check the issue's acceptance
criteria ask for.

## When to run this

- After deploying the release that contains migration `0258_workspace_approval_integrity.sql`
  and the F02/F03 service changes.
- When an approver reports the same subject twice in the inbox, or a contract
  shows «در انتظار تأیید» while the approvals inbox is empty.

## 1. Report (always safe)

```bash
DATABASE_URL=postgres://… npm run workspace:approvals
# one tenant
DATABASE_URL=postgres://… npm run workspace:approvals -- --business=<uuid>
# machine-readable
DATABASE_URL=postgres://… npm run workspace:approvals -- --json
```

It opens a read-only connection, reports and exits. Exit codes: `0` clean, `1`
findings, `2` bad invocation.

What it reports:

- **Duplicate live requests** — one subject with more than one `pending` row.
  The newest is marked `[keep]`, the older ones `[cancel — duplicate]`.
- **Stranded subjects** — a contract in `pending_approval` or a document in
  `in_review` with no pending request behind it, each with the remediation that
  applies.

## 2. Repair

```bash
DATABASE_URL=postgres://… npm run workspace:approvals -- --business=<uuid> --apply
```

`--apply` is the operator's authorization and is off by default. It:

- cancels older duplicate requests (a note is appended saying why; nothing is
  deleted, and the newest stays pending — the same choice migration 0258 makes);
- returns stranded subjects to `draft`, the state they were in before the
  request that is no longer there;
- writes one `workspace_activity` row per repaired subject, so the change shows
  on the project's feed with actor «reconciliation»;
- re-checks every row as it writes and leaves alone anything that changed
  between the report and the repair (printed as `left alone: …`).

It never approves anything, never activates a contract, and never deletes a row.
After the repair it re-reports and prints the exit code for what remains.

An ordinary edit **cannot** do this on purpose: after #907 F02 the forms may
neither enter nor leave a workflow state (`contract_status_requires_workflow` /
`document_status_requires_workflow`), because a form that can write
`pending_approval` is exactly what produced the orphan state in the first place.

## 3. Routine cancellations

An approval cancelled from the inbox («لغو») now reverts its subject in the same
transaction when it was the last pending request. That is the everyday path —
the script exists for rows written before the fix.

## 4. What is *not* repaired here

AEC registers (variations, payment certificates, material requests, commitments,
submittal revisions) own their own status and revert it through their module, so
this script does not touch them. If an AEC subject is stranded, the fix belongs
in that register's own action chain, not in the workspace approval table.
