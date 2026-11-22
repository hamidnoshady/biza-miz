/**
 * Issue #1367 — `npm run research:retire`, the reconciliation tool for Deep
 * Research work that was open when the workflow was retired.
 *
 * Retirement itself is a code deploy (see
 * `docs/architecture/deep-research-retirement.md`). This script exists for the
 * one operational question the deploy cannot answer by itself: which runs were
 * still `awaiting_approval` or `running` at cutover, and what should their
 * terminal state be? The policy lives in `src/lib/ai-research-reconcile.ts`.
 *
 * Usage:
 *   npm run research:retire                        # report only, every tenant
 *   npm run research:retire -- --business=<uuid>   # report only, one tenant
 *   npm run research:retire -- --json              # machine output
 *   npm run research:retire -- --apply             # report, then reconcile
 *
 * `--apply` is the operator's explicit authorization and does exactly two
 * things:
 *
 *   awaiting_approval → cancelled  (never started; creation writes no cost)
 *   running + expired → failed     (started once; "failed" is the truth)
 *
 * It never approves, executes, reprices or deletes a run. A `running` row that
 * has not passed its environment TTL is left alone on purpose — an old instance
 * may still be finishing during a rolling deploy.
 *
 * Exit status: 0 when nothing is open (or after an apply that leaves nothing
 * open), 1 when open runs remain, 2 on a bad invocation. The access pattern
 * mirrors `scripts/workspace-approval-report.ts`: FORCE RLS is stood down for
 * this cross-tenant maintenance session, exactly as `withoutTenantScope()` does.
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
  const { reconcileResearchRetirement } = await import("../src/lib/ai-research-reconcile");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT set_config('app.rls_bypass', 'on', false)");
    const outcome = await reconcileResearchRetirement(client, { businessId, apply });

    if (asJson) {
      console.log(JSON.stringify({ ...outcome, businessId }, null, 2));
    } else {
      const scope = businessId ? `business ${businessId}` : "every tenant";
      console.log(`Deep Research runs open for ${scope}:`);
      console.log(`  awaiting approval : ${outcome.before.pending}`);
      console.log(`  running (expired) : ${outcome.before.runningExpired}`);
      console.log(`  running (live)    : ${outcome.before.runningLive}`);
      if (outcome.applied) {
        console.log(
          `\nApplied: ${outcome.applied.cancelled} pending run(s) cancelled, ` +
            `${outcome.applied.failed} expired running run(s) marked failed.`,
        );
      } else if (outcome.before.pending + outcome.before.running > 0) {
        console.log("\nReport only. Re-run with --apply once the approval window has drained.");
      }
      const open = outcome.after.pending + outcome.after.running;
      console.log(
        open === 0
          ? "No open Deep Research runs remain."
          : `${open} open run(s) remain; live running runs are left alone until their TTL passes.`,
      );
    }

    return outcome.after.pending + outcome.after.running === 0 ? 0 : 1;
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
