/**
 * The service-activation background tick (issue #1041).
 *
 * Four passes every five minutes:
 *
 *   1. settle due enabled time — charge each active service's elapsed seconds at
 *      the price version its interval was opened at, honouring prepaid service
 *      coverage and approved plan inclusion, and suspend any service whose
 *      wallet can no longer cover the due segment (no uncovered debt);
 *   2. renew the prepaid service terms that explicitly opted in (ESH-193) —
 *      same term, published offer, wallet-funded, once;
 *   3. warn the owner once when a disabled service enters its policy's
 *      notification-lead window (the deadline is a policy fact, so a restart
 *      cannot lose the warning and a re-run writes nothing);
 *   4. run due retention purges — only after a *customer* disable's deadline has
 *      actually expired, and only for the reviewed `owned` scope.
 *
 * Every pass is idempotent: a restarted or duplicated tick produces duplicates,
 * never a second debit or a second deletion. The tick is scheduled on the
 * central runtime (the books are authoritative there), the same as the other
 * billing ticks in `server.ts`.
 */
import { settleDueServiceRuntime, type RuntimeTickResult } from "./activation-service";
import { renewDueServiceTerms, type ServiceTermRenewalRun } from "../billing/resolver/service";
import {
  notifyRetentionWarnings,
  runDueServicePurges,
  type PurgeRunResult,
  type RetentionWarningRun,
} from "./retention-service";

export const SERVICE_ACTIVATION_TICK_INTERVAL_MS = 5 * 60 * 1000;

export interface ServiceActivationTickResult {
  runtime: RuntimeTickResult;
  termRenewal: ServiceTermRenewalRun;
  warning: RetentionWarningRun;
  purge: PurgeRunResult;
}

export async function runServiceActivationTick(
  now: Date = new Date(),
): Promise<ServiceActivationTickResult> {
  const runtime = await settleDueServiceRuntime({ now });
  const termRenewal = await renewDueServiceTerms(now);
  const warning = await notifyRetentionWarnings(now);
  const purge = await runDueServicePurges({ now });
  return { runtime, termRenewal, warning, purge };
}
