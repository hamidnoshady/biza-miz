import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync("wordpress-plugin/pos-accounting-connector/pos-accounting-connector.php", "utf8");
const admin = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-admin.php", "utf8");
const settings = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-settings.php", "utf8");
const sync = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php", "utf8");
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

  it("emits explicit full-sync completion markers", () => {
    for (const topic of ["catalogue.sync_completed", "orders.sync_completed", "customers.sync_completed", "content.sync_completed"]) {
      expect(sync).toContain(topic);
    }
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
