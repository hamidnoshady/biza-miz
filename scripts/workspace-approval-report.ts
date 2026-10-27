/**
 * Issue #907 F03 — `npm run workspace:approvals`, the reconciliation report (and,
 * on explicit request, the repair) for stuck workspace approvals.
 *
 * The rules live in `src/lib/workspace-approval-report.ts` — which shape counts as
 * a duplicate or a stranded subject, which request is kept, and how a repair is
 * written. This file is only the database connection, the arguments and the
 * printing.
 *
 * Usage:
 *   npm run workspace:approvals                        # report only, every tenant
 *   npm run workspace:approvals -- --business=<uuid>   # report only, one tenant
 *   npm run workspace:approvals -- --json              # machine output
 *   npm run workspace:approvals -- --apply             # report, then repair
 *
 * `--apply` is off by default and is the operator's explicit authorization: the
 * repair returns a stranded subject to `draft` and cancels older duplicate
 * requests, writing a `workspace_activity` row for every subject it moves. It
 * never approves, activates or deletes anything. Without it this command only
 * reads.
 *
 * Exit status: 0 when the register is clean (or after a repair that leaves it
 * clean), 1 when findings remain, 2 on a bad invocation — so the live re-check in
 * the issue's acceptance criteria is a command whose code means something.
 *
 * `main()` is wrapped rather than using top-level await: the root package.json
 * is CommonJS, under which tsx rejects top-level await (see the same note in
 * scripts/media-reconcile-orphans.ts).
 */
import "dotenv/config";
import { Client } from "pg";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith("--") ? next : "";
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required.");
    return 2;
  }
  const businessId = arg("business") || null;
  if (businessId === "") {
    console.error("--business needs a business uuid.");
    return 2;
  }
  const asJson = process.argv.includes("--json");
  const apply = process.argv.includes("--apply");

  // Dynamic import so the module graph loads after `dotenv/config`.
  const { buildApprovalReport, applyApprovalRepairs } = await import("../src/lib/workspace-approval-report");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Reads only. The tables carry FORCE RLS and this is a cross-tenant
    // maintenance tool, so it says so rather than inventing a tenant scope it
    // does not have. Nothing is written.
    await client.query("SELECT set_config('app.rls_bypass', 'on', false)");
    const report = await buildApprovalReport(client, businessId);
    // The repair is written against the report the operator was shown, never a
    // fresh query, so nothing outside what the printout named can change.
    const outcome = apply
      ? await applyApprovalRepairs(client, report, { businessId })
      : null;

    if (asJson) {
      console.log(JSON.stringify(outcome ? { report, outcome } : report, null, 2));
    } else if (report.duplicateRequests.length === 0 && report.orphanSubjects.length === 0) {
      console.log("Workspace approvals: clean — one live request per subject and no stranded subjects.");
    } else {
      for (const group of report.duplicateRequests) {
        console.log(
          `Duplicate live requests: ${group.subjectType} «${group.subjectTitle || group.subjectId}» ` +
            `(${group.businessId})`,
        );
        for (const request of group.pending) {
          console.log(
            `  - ${request.approvalId} ${request.createdAt} ${request.requestedByName || "بدون نام"}` +
              ` ${request.keeps ? "[keep]" : "[cancel — duplicate]"}`,
          );
        }
        console.log("  Remediation: cancel the duplicates from the approvals inbox; the newest stays live.");
      }
      for (const orphan of report.orphanSubjects) {
        console.log(
          `Stranded ${orphan.subjectType}: «${orphan.title}» is ${orphan.status} with no pending request ` +
            `(${orphan.businessId} / ${orphan.subjectId})`,
        );
        console.log(`  Remediation: ${orphan.remediation}`);
      }
    }

    if (outcome) {
      console.log(
        `\nRepaired: ${outcome.cancelled.length} duplicate request(s) cancelled, ` +
          `${outcome.reverted.length} stranded subject(s) returned to draft` +
          (outcome.skipped.length > 0 ? `, ${outcome.skipped.length} left alone (changed since the report).` : "."),
      );
      for (const row of outcome.skipped) {
        console.log(`  - left alone: ${row.subjectType} ${row.subjectId} — ${row.reason}`);
      }
      // Report what is actually true now, rather than claiming success.
      const after = await buildApprovalReport(client, businessId);
      const remaining = after.duplicateRequests.length + after.orphanSubjects.length;
      console.log(remaining === 0 ? "The register is clean." : `${remaining} finding(s) remain.`);
      return remaining === 0 ? 0 : 1;
    }

    return report.duplicateRequests.length === 0 && report.orphanSubjects.length === 0 ? 0 : 1;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 2;
  });
