import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Issue #1206, PERF-02 — a variable-product save must not walk an unbounded
 * catalogue on the request thread.
 *
 * Saving a variable product rewrites its children and WooCommerce fires no hook
 * for the ones it changed, so the plugin fans the family out itself. It did that
 * with `wc_get_products([... 'limit' => -1 ...])`: on a 1,000-variation family
 * that is 1,000 product hydrations and 1,000 payload builds inside the admin
 * request — and inside checkout if the parent is touched there.
 *
 * Nothing in the Next test suite can execute plugin PHP, so these are source
 * assertions: the walk is keyset-paged and bounded inline, the remainder is a
 * cron continuation, and no `limit => -1` fan-out is left anywhere in the
 * plugin.
 */

const sync = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php", "utf8");

const method = (signature: string) => {
  const start = sync.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const rest = sync.slice(start + signature.length);
  const next = rest.search(/\n\t(?:public|private|protected) static function /);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("#1206 PERF-02 variation fan-out is bounded", () => {
  it("keeps the inline fan-out to one bounded page", () => {
    expect(sync).toContain("const VARIATION_FANOUT_PAGE = 100;");
    const fanout = method("private static function enqueue_variations(");
    expect(fanout).toContain("self::enqueue_variation_page( $parent_id, 0 )");
    expect(fanout).toContain("count( $ids ) < self::VARIATION_FANOUT_PAGE");
    expect(fanout).not.toContain("=> -1");
    expect(fanout).not.toContain("wc_get_products(");
  });

  it("pages the family by keyset, so a delete mid-walk cannot skip a child", () => {
    const page = method("private static function enqueue_variation_page(");
    expect(page).toContain("post_parent = %d AND post_type = 'product_variation' AND ID > %d");
    expect(page).toContain("ORDER BY ID ASC LIMIT %d");
    expect(page).toContain("self::VARIATION_FANOUT_PAGE");
    expect(page).not.toContain("offset");
    // One payload build per child of this page, not per child of the family.
    expect(page).toContain("self::product_payload( $child )");
  });

  it("finishes the family on cron instead of the request", () => {
    expect(sync).toContain("const VARIATION_FANOUT_HOOK = 'pos_connector_variation_fanout_continue';");
    expect(sync).toContain(
      "add_action( self::VARIATION_FANOUT_HOOK, array( __CLASS__, 'continue_variation_fanout' ), 10, 1 );",
    );
    const continuation = method("public static function continue_variation_fanout(");
    expect(continuation).toContain("absint( get_option( $state_key, 0 ) )");
    expect(continuation).toContain("self::schedule_variation_fanout( $parent_id, end( $ids ) )");
    // A short page is the end of the family, and then the state goes away.
    expect(continuation).toContain("delete_option( $state_key );");
    // Sync switched off mid-walk stops it instead of queueing into a dead queue.
    expect(continuation).toContain("empty( $settings['sync_products'] )");
  });

  it("never schedules two fan-outs for the same parent, and stores no autoloaded state", () => {
    const schedule = method("private static function schedule_variation_fanout(");
    expect(schedule).toContain("if ( wp_next_scheduled( self::VARIATION_FANOUT_HOOK, array( $parent_id ) ) ) {");
    expect(schedule).toContain("self::variation_fanout_state_key( $parent_id ), $cursor, false )");
    expect(schedule).toContain("wp_schedule_single_event( time() + self::VARIATION_FANOUT_DELAY, self::VARIATION_FANOUT_HOOK, array( $parent_id ) )");
  });

  it("leaves no unbounded expansion anywhere in the plugin", () => {
    expect(sync).not.toContain("'limit'  => -1");
    expect(sync).not.toContain("'limit' => -1");
  });
});
