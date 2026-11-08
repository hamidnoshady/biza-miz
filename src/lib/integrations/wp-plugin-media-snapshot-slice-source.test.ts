import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Issue #1206, PERF-05 — the verified media snapshot (#941) must not walk the
 * whole attachment library inside one cron invocation.
 *
 * It used to: up to 500k attachments, each with its own `GET_LOCK(5)` and
 * `START TRANSACTION … FOR UPDATE`, all inside the daily content sweep on the
 * single PHP worker that also owes checkout its 60-second fast lane.
 *
 * Nothing here can execute plugin PHP, so these are source assertions. They pin
 * the two properties that must both hold: the walk is sliced and resumable, and
 * it still produces one generation with contiguous unique ordinals, because the
 * app proves completeness from those ordinals — never from the marker alone.
 */

const sync = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php", "utf8");

const method = (signature: string) => {
  const start = sync.indexOf(signature);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  const rest = sync.slice(start + signature.length);
  const next = rest.search(/\n\t(?:public|private|protected) static function /);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("#1206 PERF-05 media snapshot is sliced and resumable", () => {
  it("no longer walks the whole library in one call", () => {
    const start = method("private static function export_media_snapshot()");
    // One bounded slice, and the job of the walk handed to a separate method.
    expect(start).toContain("self::resume_media_snapshot()");
    expect(start).toContain("self::start_media_snapshot()");
    expect(start).toContain("self::run_media_snapshot_slice( $state )");
    // The end-to-end loop and its per-row locking moved out of the entry point.
    expect(start).not.toContain("while ( count( $ids ) === 100 )");
    expect(start).not.toContain("GET_LOCK");
  });

  it("bounds a slice by a page size and a wall-clock budget", () => {
    expect(sync).toContain("const MEDIA_SNAPSHOT_PAGE = 100;");
    expect(sync).toContain("const MEDIA_SNAPSHOT_BUDGET_SECONDS = 20;");
    const slice = method("private static function run_media_snapshot_slice(");
    expect(slice).toContain("( microtime( true ) - $started ) >= self::MEDIA_SNAPSHOT_BUDGET_SECONDS");
    expect(slice).toContain("self::schedule_media_snapshot_continuation( (string) $state['snapshot_id'] )");
    // The walk ends on a short page, and only then is the marker queued.
    expect(slice).toContain("count( $ids ) < self::MEDIA_SNAPSHOT_PAGE");
    expect(slice).toContain("self::finish_media_snapshot( $state )");
    expect(slice).not.toContain("media_snapshot_completed");
  });

  it("persists the cursor and the ordinal together after every round", () => {
    const slice = method("private static function run_media_snapshot_slice(");
    const persist = slice.indexOf("POS_Connector_Export_Cursor::set( self::MEDIA_SNAPSHOT_KIND, $state )");
    const shortPage = slice.indexOf("count( $ids ) < self::MEDIA_SNAPSHOT_PAGE");
    expect(persist).toBeGreaterThan(-1);
    // Persisted before the walk can either finish or yield.
    expect(persist).toBeLessThan(shortPage);
    // A resumed walk continues after the last stored id, so ordinals can never
    // be re-issued to a different attachment.
    expect(slice).toContain('"SELECT ID FROM {$wpdb->posts} WHERE post_type = \'attachment\' AND post_status <> \'auto-draft\' AND ID > %d AND ID <= %d ORDER BY ID ASC LIMIT %d"');
    expect(slice).toContain("(int) $state['cursor']");
  });

  it("keeps the per-attachment lock, transaction and generation contract", () => {
    const row = method("private static function export_one_attachment(");
    expect(row).toContain("self::media_payload_lock( $post_id )");
    expect(row).toContain("'SELECT GET_LOCK(%s, 5)'");
    expect(row).toContain("$wpdb->query( 'START TRANSACTION' )");
    expect(row).toContain("FOR UPDATE");
    expect(row).toContain("$wpdb->query( 'COMMIT' )");
    expect(row).toContain("$wpdb->query( 'ROLLBACK' )");
    expect(row).toContain("'SELECT RELEASE_LOCK(%s)'");
    // The ordinal is the running count, and the queue key stays generation-scoped.
    expect(row).toContain("'index'    => (int) $state['count'] + 1,");
    expect(row).toContain("'snapshot:' . $state['snapshot_id'] . ':' . $post_id");
    expect(row).toContain("if ( ! $post ) {");
  });

  it("emits the completion marker only after the walk, with the walk's count", () => {
    const finish = method("private static function finish_media_snapshot(");
    expect(finish).toContain("'content.media_snapshot_completed'");
    expect(finish).toContain("'count'    => $count,");
    expect(finish).toContain("'boundary' => (string) $state['boundary'],");
    // The marker is queued first; the generation is forgotten only if that worked.
    expect(finish.indexOf("POS_Connector_Queue::enqueue(")).toBeLessThan(
      finish.indexOf("POS_Connector_Export_Cursor::clear( self::MEDIA_SNAPSHOT_KIND )"),
    );
  });

  it("resumes only the generation its event names, and gives up on a store that cannot be walked", () => {
    expect(sync).toContain("const MEDIA_SNAPSHOT_HOOK = 'pos_connector_media_snapshot_continue';");
    expect(sync).toContain(
      "add_action( self::MEDIA_SNAPSHOT_HOOK, array( __CLASS__, 'continue_media_snapshot' ), 10, 1 );",
    );
    const continuation = method("public static function continue_media_snapshot(");
    expect(continuation).toContain("(string) $state['snapshot_id'] !== $snapshot_id");
    expect(continuation).toContain("empty( $settings['enabled'] )");
    expect(continuation).toContain("true !== $gate['state']");
    expect(continuation).toContain("self::MEDIA_SNAPSHOT_MAX_FAILURES");
    expect(continuation).toContain("self::schedule_media_snapshot_continuation( $snapshot_id, 60 )");
  });

  // The WordPress PHPUnit bootstrap loads only log + queue + sync. The walk now
  // stores its generation through the export cursor, so the fixture must load
  // that class too — otherwise the first slice is a fatal, which is exactly how
  // this change first failed CI's `wordpress-media` job.
  it("loads the export cursor in the WordPress unit-test bootstrap", () => {
    const bootstrap = readFileSync("wordpress-plugin/tests/bootstrap.php", "utf8");
    const cursor = bootstrap.indexOf("class-pos-export-cursor.php");
    const sync = bootstrap.indexOf("class-pos-sync.php");
    expect(cursor).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(cursor);
    expect(sync).toBeLessThan(bootstrap.indexOf("$tests_dir . '/includes/bootstrap.php'"));
  });

  it("schedules one event per generation and re-arms a lost one from the fast lane", () => {
    const schedule = method("private static function schedule_media_snapshot_continuation(");
    expect(schedule).toContain("if ( wp_next_scheduled( self::MEDIA_SNAPSHOT_HOOK, $args ) ) {");
    expect(schedule).toContain("wp_schedule_single_event( time() + max( 1, (int) $delay ), self::MEDIA_SNAPSHOT_HOOK, $args )");
    expect(sync).toContain("self::schedule_pending_media_snapshot();");
    const rearm = method("private static function schedule_pending_media_snapshot()");
    expect(rearm).toContain("self::resume_media_snapshot()");
    expect(rearm).toContain("self::schedule_media_snapshot_continuation( (string) $state['snapshot_id'] )");
  });
});
