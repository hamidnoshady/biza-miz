/** Woo recipient data must not be stored as plaintext in general print history. */
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../integrations/secrets";
import type { PrintJob } from "./render-service";
export type StoredPrintJob = PrintJob | { type: "woo-order-sealed"; ciphertext: string };

export function protectWooJob(job: PrintJob, scope: string): StoredPrintJob {
  if (job.type !== "woo-order") return job;
  return { type: "woo-order-sealed", ciphertext: encryptSecret(JSON.stringify({ scope, job }), resolveEncryptionKey(process.env)) };
}
export function restoreWooJob(stored: StoredPrintJob, scope: string): PrintJob {
  if (stored.type !== "woo-order-sealed") return stored;
  const value = JSON.parse(decryptSecret(stored.ciphertext, resolveEncryptionKey(process.env)));
  if (value.scope !== scope || value.job?.type !== "woo-order" || !value.job.data?.sourceRevision) throw new Error("fallback_snapshot_missing");
  return value.job as PrintJob;
}
