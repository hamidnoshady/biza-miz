/**
 * The class B meters (issue #998): work a Hybrid or Full Offline device runs
 * itself, rated and debited by the cloud at settlement.
 *
 * `credit_offline_meters` (migration 0257) is the live registry and the
 * superadmin can change a row's mode without a deploy. These seeds are the
 * agreed starting list, so a test can pin the migration to it. A function that
 * already runs in the cloud (AI, messaging, website, media) is class A and a
 * time or volume charge is class C; neither belongs here.
 */
import type { LockPolicy } from "./policy";

export type OfflineMeterMode = "off" | "shadow" | "enforced";
export type OfflineInstall = "hybrid" | "local";

export interface OfflineMeterSeed {
  key: string;
  unit: string;
  installs: readonly OfflineInstall[];
  /** Every meter starts in shadow: measured and rated, never enforced. */
  mode: OfflineMeterMode;
}

export const OFFLINE_METER_SEEDS: readonly OfflineMeterSeed[] = [
  { key: "pos.sale_closed", unit: "order", installs: ["hybrid", "local"], mode: "shadow" },
  { key: "ledger.payroll_run_posted", unit: "run", installs: ["local"], mode: "shadow" },
  { key: "stock.count_posted", unit: "count", installs: ["local"], mode: "shadow" },
];

/** Re-exported so a caller that reads the registry has the lock vocabulary beside it. */
export type { LockPolicy };
