import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Issue #1206, PERF-06 — the customer-export recovery scan must not run on
 * every page render.
 *
 * The plugin's bootstrap used to list `wp_options` with
 * `LIKE 'pos_connector_customer_export_%'` on `init`, i.e. on every storefront,
 * cart, checkout and REST request, to find a state row that exists for a few
 * minutes a day. Nothing in the Next test suite can execute PHP, so these are
 * source assertions: they pin the guard, the cheap sentinel that makes it
 * cheap, and — most importantly — that recovery still happens, because a scan
 * that got faster by never running would be the worse bug.
 */

const sync = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php", "utf8");

/** One method's body: from its signature to the next method declaration. */
const body = (signature: string) => {
  const start = sync.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const rest = sync.slice(start + signature.length);
  const next = rest.search(/\n\t(?:public|private|protected) static function /);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("#1206 PERF-06 customer-export recovery is not a per-request scan", () => {
  it("guards the bootstrap scan with the recovery check instead of calling it unconditionally", () => {
    const start = sync.indexOf("public static function init()");
    expect(start, "POS_Connector_Sync::init() must exist").toBeGreaterThan(-1);
    const init = sync.slice(start, start + 4000);
    const guard = init.indexOf("self::customer_export_recovery_due()");
    const scan = init.indexOf("self::schedule_pending_customer_exports()");
    expect(guard).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(guard);
    // Both switches are still honoured before the guard is even consulted.
    expect(init).toContain("if ( ! empty( $settings['enabled'] ) && ! empty( $settings['sync_customers'] ) && self::customer_export_recovery_due() ) {");
  });

  it("lets a frontend request out without running the scan, while cron and admin keep it", () => {
    const recovery = body("private static function customer_export_recovery_due()");
    expect(recovery).toContain("if ( ! ( wp_doing_cron() || is_admin() ) ) {");
    expect(recovery).toContain("return false;");
    // The early exit comes before the throttled write and before any return of true.
    expect(recovery.indexOf("return false;")).toBeLessThan(recovery.indexOf("update_option("));
  });

  it("reads an autoloaded counter, not the options table", () => {
    const recovery = body("private static function customer_export_recovery_due()");
    expect(recovery).toContain("get_option( self::CUSTOMER_EXPORT_OPEN_OPTION, 0 )");
    expect(recovery).not.toContain("$wpdb");
    expect(recovery).not.toContain("LIKE");
    // The write that makes the next request cheap must be autoloaded too.
    expect(recovery).toContain("update_option( self::CUSTOMER_EXPORT_RECHECK_OPTION, time(), true );");
    expect(sync).toContain("const CUSTOMER_EXPORT_RECHECK_SECONDS = 300;");
  });

  it("marks an export open when its state row is created and closed when it is deleted", () => {
    const exportCustomers = body("public static function export_customers(");
    const created = exportCustomers.indexOf("add_option( $state_key, $state, '', 'no' )");
    const opened = exportCustomers.indexOf("self::mark_customer_export_open();");
    const deleted = exportCustomers.indexOf("delete_option( $state_key );");
    const closed = exportCustomers.indexOf("self::mark_customer_export_closed();");
    expect(created).toBeGreaterThan(-1);
    expect(opened).toBeGreaterThan(created);
    expect(deleted).toBeGreaterThan(opened);
    expect(closed).toBeGreaterThan(deleted);
    // Only after the completion marker was actually queued: a failed enqueue keeps
    // the export open so the next continuation retries it.
    expect(exportCustomers.slice(deleted - 600, deleted)).toContain("customer_export_marker_enqueue_failed");
  });

  it("keeps the persisted state row as the source of truth for the counter", () => {
    const scan = body("private static function schedule_pending_customer_exports()");
    expect(scan).toContain("LIKE %s");
    expect(scan).toContain("self::schedule_customer_export_continuation( $sync_id );");
    expect(scan).toContain("update_option( self::CUSTOMER_EXPORT_OPEN_OPTION, $open, true );");
    // No live rows means nothing is open, whatever the counter believed.
    expect(scan).toContain("delete_option( self::CUSTOMER_EXPORT_OPEN_OPTION );");
    // The uuid test is what keeps the counter's own option names out of the scan.
    expect(scan).toContain("preg_match( '/\\A[a-f0-9-]{36}\\z/i', $sync_id )");
  });
});
