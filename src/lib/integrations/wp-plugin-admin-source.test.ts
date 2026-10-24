import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync("wordpress-plugin/pos-accounting-connector/pos-accounting-connector.php", "utf8");
const admin = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-admin.php", "utf8");
const settings = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-settings.php", "utf8");
const sync = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php", "utf8");
const queue = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-queue.php", "utf8");
const updater = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-updater.php", "utf8");
const workflow = readFileSync(".github/workflows/build-plugin-zip.yml", "utf8");

describe("WordPress plugin admin architecture", () => {
  it("registers a top-level Eshobe menu instead of a WooCommerce submenu", () => {
    expect(admin).toContain("add_menu_page");
    expect(admin).toContain("dashicons-store");
    expect(settings).not.toContain("add_action( 'admin_menu'");
  });

  it("keeps admin and updater available when WooCommerce is missing", () => {
    expect(main.indexOf("POS_Connector_Admin::init()")).toBeLessThan(main.indexOf("if ( ! pos_connector_woocommerce_active() )"));
    expect(main).toContain("داشبورد و عیب‌یابی افزونه در دسترس است");
  });

  it("has separate sections for dashboard, connection, sync, queue, diagnostics and updates", () => {
    for (const slug of ["pos-connector-connection", "pos-connector-synchronization", "pos-connector-queue", "pos-connector-diagnostics", "pos-connector-updates"]) {
      expect(admin).toContain(slug);
    }
  });

  it("validates manual actions before claiming success", () => {
    expect(settings).toContain("products_disabled");
    expect(settings).toContain("orders_disabled");
    expect(settings).toContain("customers_disabled");
    expect(settings).toContain("nothing_to_retry");
    expect(settings).toContain("woo_missing");
    expect(settings).toContain("server_allows_data_movement");
    expect(settings).toContain("'paused' === $movement");
  });
});

describe("WordPress plugin protocol", () => {
  it("sends telemetry and capabilities during handshake", () => {
    expect(sync).toContain("'capabilities'");
    expect(sync).toContain("'telemetry'");
    expect(sync).toContain("localQueuePending");
  });

  // Issue #942 (F12): the heartbeat carries the per-event problem list so
  // the app can show which plugin events are stuck and why — metadata only,
  // never payloads.
  it("reports stuck local-queue events per event in telemetry", () => {
    expect(queue).toContain("function recent_problems");
    expect(queue).toContain("status IN ('pending', 'failed')");
    expect(sync).toContain("'localQueueRecent'");
    expect(sync).toContain("POS_Connector_Queue::recent_problems( 10 )");
  });

  it("emits explicit full-sync completion markers and identifies tagged customer rows", () => {
    for (const topic of ["catalogue.sync_completed", "orders.sync_completed", "customers.sync_completed", "content.sync_completed"]) {
      expect(sync).toContain(topic);
    }
    expect(sync).toContain("__pos_customer_sync_id");
    expect(sync).toContain("'sync_id'  => $sync_id");
    expect(sync).toContain("'expected_count'  => 0,");
    expect(sync).toContain("++$state['expected_count'];");
    expect(sync).toContain("'count'    => $expected_count,");
    expect(sync).toContain("$sync_id . ':' . $customer->get_id()");
    expect(sync).toContain("POS_Connector_Queue::enqueue( 'customer.updated', $queue_id, $payload )");
    expect(sync).toContain("customer_export_user_ids_after");
    expect(sync).toContain("'_order_count'");
    expect(sync).toContain("customer_export_row_enqueue_failed");
    expect(sync).toContain("self::on_customer_changed( $user_id, false );");
    expect(sync).toContain("schedule_pending_customer_exports();");
    expect(sync).toContain("wp_schedule_single_event");
    expect(sync).toContain("continue_customer_export");
  });

  it("reports remote customer deletions without deleting local accounting history", () => {
    expect(sync).toContain("add_action( 'delete_user', array( __CLASS__, 'on_customer_deleted' )");
    expect(sync).toContain("'customer.deleted'");
    expect(sync).toContain("'deleted_at' => gmdate( 'c' )");
    expect(sync).toContain("'customer.deleted',");
  });

  it("exports full product taxonomy snapshots", () => {
    expect(sync).toContain("catalogue.taxonomy_terms");
    expect(sync).toContain("get_object_taxonomies( 'product'");
    expect(sync).toContain("wp_get_post_terms( $post_id, $taxonomy )");
  });

  it("requires operation ids before applying non-idempotent jobs", () => {
    expect(sync).toContain("operation_id_missing_for_non_idempotent_refund");
    expect(sync).toContain("operation_id_missing_for_non_idempotent_post_create");
    expect(sync).toContain("operation_id_missing_for_non_idempotent_media_create");
  });

  // Issue #942 (F01/F10): protocol 3 echoes the lease generation on every
  // ack so a stale worker cannot close a newer attempt, and a policy-off
  // stock/price job is acked `skipped`, never `done`.
  it("echoes the lease token on acks and distinguishes skipped from done", () => {
    expect(sync).toContain("'protocolVersion' => 3");
    expect(sync).toContain("$job['leaseToken']");
    expect(sync).toContain("$ack['leaseToken']");
    expect(sync).toContain("'skipped:apply_stock_disabled'");
    expect(sync).toContain("'skipped:apply_prices_disabled'");
    expect(sync).toContain("$ack['status'] = 'skipped'");
  });

  it("echoes the push operation id back on the attachment it created, not on any other attachment event", () => {
    // apply_media_create() stamps the meta right after the sideload...
    expect(sync).toContain("update_post_meta( $attachment_id, '_pos_operation_id', $operation_id )");
    // ...and content_payload() reads it back, only inside the attachment
    // branch, only when the meta is actually set.
    const attachmentBranch = sync.slice(sync.indexOf("public static function content_payload"), sync.indexOf("return $payload;", sync.indexOf("public static function content_payload")));
    expect(attachmentBranch).toContain("get_post_meta( $post->ID, '_pos_operation_id', true )");
    expect(attachmentBranch).toContain("$payload['operation_id']");
  });
});

describe("WordPress plugin updater", () => {
  it("uses the platform manifest with a package checksum", () => {
    expect(main).toContain("https://updates.eshobe.app/wordpress/pos-accounting-connector/update.json");
    expect(updater).toContain("verify_package_download");
    expect(updater).toContain("checksum");
    expect(workflow).toContain("Add checksum to self-hosted update manifest");
    expect(workflow).toContain("Get-FileHash -Algorithm SHA256");
  });

  it("walks wrapper folders and nested zips before WordPress validates the package", () => {
    expect(updater).toContain("find_plugin_root");
    expect(updater).toContain("maybe_unpack_inner_zip");
    expect(updater).toMatch(/find_plugin_root\([\s\S]*wordpress-plugin\/pos-accounting-connector/);
  });
});

describe("plugin export sweeps page by keyset cursor, not OFFSET", () => {
  // One export's source, so a pin describes that sweep — the orders sweep
  // legitimately keeps an offset walk as its fallback, which a whole-file
  // assertion could not tell apart from the primary path regressing.
  const bodyOf = (name: string, next: string) => {
    const start = sync.indexOf(`function ${name}`);
    const end = sync.indexOf(`function ${next}`, start);
    expect(start, name).toBeGreaterThan(-1);
    expect(end, next).toBeGreaterThan(start);
    return sync.slice(start, end);
  };

  it("no sweep pages by numbered page any more", () => {
    expect(sync).not.toContain("'paged'");
    expect(sync).not.toContain("'page'   =>");
  });

  it("products, customers and content resume from the last ID seen", () => {
    const products = bodyOf("export_products", "export_orders");
    const customers = bodyOf("export_customers", "export_content");
    const content = bodyOf("export_content", "run_resync_customers");

    for (const [label, body] of [["products", products], ["content", content]] as const) {
      expect(body, label).toContain("$export_id_cursor");
      expect(body, label).toContain("'orderby'");
      expect(body, label).toContain("'ID'");
      expect(body, label).not.toContain("'offset'");
    }
    // Customers sweep by user id through a bounded, keyset-paginated query
    // instead of a `pre_user_query` cursor (#1094/#1040 replaced that walk), so
    // the assertion follows the mechanism that is actually there: the batch is
    // read after the last id seen and the query is never an OFFSET walk.
    expect(customers).toContain("customer_export_user_ids_after");
    expect(customers).toContain("$state['cursor']");
    expect(customers).not.toContain("'offset'");
    expect(products).toContain("add_filter( 'posts_where'");
    expect(content).toContain("add_filter( 'posts_where'");
  });

  it("the cursor filter is always detached again after its one query", () => {
    const adds = sync.split("add_filter( 'posts_where'").length - 1;
    const removes = sync.split("remove_filter( 'posts_where'").length - 1;
    expect(adds).toBeGreaterThan(0);
    expect(removes).toBe(adds);
    const userAdds = sync.split("add_action( 'pre_user_query'").length - 1;
    const userRemoves = sync.split("remove_action( 'pre_user_query'").length - 1;
    expect(userRemoves).toBe(userAdds);
  });

  it("orders keyset on (date_modified, id) with the offset walk kept only as fallback", () => {
    const orders = bodyOf("export_orders", "export_customers");
    expect(orders).toContain("'orderby'       => 'date_modified'");
    expect(orders).toContain("$boundary_seen");
    expect(orders).toContain("$cursor_failed");
    // The fallback exists exactly once, behind the cursor-health check.
    expect(orders.split("'offset'")).toHaveLength(2);
    expect(orders.indexOf("$cursor_failed")).toBeLessThan(orders.indexOf("'offset'"));
  });

  it("the product sweep streams instead of collecting the whole catalogue first", () => {
    const products = bodyOf("export_products", "export_orders");
    expect(products).not.toContain("$parents[]");
    expect(products).not.toContain("$variations[]");
    expect(products).toContain("$deferred_variation_ids");
  });
});
