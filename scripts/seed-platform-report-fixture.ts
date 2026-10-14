/** Local-only, nonempty smoke fixture for the platform reports workspace. */
import "dotenv/config";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname))
    throw new Error("This fixture may only run against a local development database");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.rls_bypass', 'on', true)");
    const existing = await db.query("SELECT id FROM businesses WHERE slug='report-visual-810'");
    if (existing.rowCount) {
      console.log(`PLATFORM_REPORT_BUSINESS_ID=${existing.rows[0].id}`);
      await db.query("COMMIT"); return;
    }
    const business = (await db.query("INSERT INTO businesses (name,slug,industry) VALUES ('فروشگاه نمونهٔ گزارش‌ها','report-visual-810','accessories') RETURNING id")).rows[0].id;
    const location = (await db.query("INSERT INTO locations (business_id,name) VALUES ($1,'شعبهٔ مرکزی') RETURNING id", [business])).rows[0].id;
    await db.query(`INSERT INTO settings (business_id,key,value) VALUES
      ($1,'business.prefs','{"currencyDisplay":"toman"}'), ($1,'deployment.profile','{"profile":"cloud"}')`, [business]);
    await db.query("INSERT INTO parties (business_id,name,role) SELECT $1,'مشتری نمونه ' || g,'customer' FROM generate_series(1,3) g", [business]);
    await db.query(`INSERT INTO orders (location_id,order_number,type,status,total,subtotal,opened_at,closed_at)
      SELECT $1,g,'takeaway','completed',1500000,1500000,now()-interval '2 hours',now()-interval '1 hour' FROM generate_series(1,12) g`, [location]);
    const accounts = (await db.query(`INSERT INTO accounts (business_id,code,name,type) VALUES
      ($1,'1100','صندوق','asset'), ($1,'4100','فروش','revenue') RETURNING id,code`, [business])).rows;
    const entry = (await db.query("INSERT INTO journal_entries (business_id,location_id,entry_date,memo) VALUES ($1,$2,CURRENT_DATE,'فروش نمونه') RETURNING id", [business, location])).rows[0].id;
    await db.query("INSERT INTO journal_lines (entry_id,account_id,debit,credit) VALUES ($1,$2,18000000,0),($1,$3,0,18000000)", [entry, accounts.find((a) => a.code === "1100").id, accounts.find((a) => a.code === "4100").id]);
    await db.query(`WITH stocked AS (
      INSERT INTO items (location_id,name) SELECT $1,'کالای نمونه ' || g FROM generate_series(1,65) g RETURNING id
    ) INSERT INTO item_stock (item_id,quantity,unit_cost,reorder_point) SELECT id,2,500000,5 FROM stocked`, [location]);
    await db.query("INSERT INTO promotions (business_id,name,kind,value) VALUES ($1,'تخفیف نمونه','percent',10)", [business]);
    const connection = (await db.query(`INSERT INTO integration_connections
      (business_id,location_id,name,base_url,consumer_key_ciphertext,consumer_secret_ciphertext,webhook_secret_ciphertext,
       link_mode,link_token_hash,link_token_ciphertext,sync_orders,sync_products,sync_customers,push_stock,push_prices)
      VALUES ($1,$2,'فروشگاه نمونه','https://report-fixture.invalid','unused-fixture','unused-fixture','unused-fixture',
       'plugin','unused-fixture','unused-fixture',false,false,false,false,false) RETURNING id`, [business, location])).rows[0].id;
    await db.query(`INSERT INTO integration_mappings (business_id,connection_id,entity_type,remote_id,local_id)
      SELECT $1,$2,'order',g::text,gen_random_uuid() FROM generate_series(1,12) g`, [business, connection]);
    await db.query(`INSERT INTO integration_woo_terms (business_id,connection_id,taxonomy,remote_id,name)
      SELECT $1,$2,'product_cat',g::text,'دستهٔ نمونه ' || g FROM generate_series(1,4) g`, [business, connection]);
    await db.query(`INSERT INTO integration_webhook_events (business_id,connection_id,event_topic,remote_id,delivery_id,payload)
      SELECT $1,$2,'order.created',g::text,g::text,'{}' FROM generate_series(1,2) g`, [business, connection]);
    const device = (await db.query("INSERT INTO site_devices (business_id,location_id,display_name,status) VALUES ($1,$2,'صندوق شعبهٔ مرکزی','active') RETURNING id", [business, location])).rows[0].id;
    await db.query(`INSERT INTO site_device_runtime_status (site_device_id,business_id,location_id,app_version,reported_at)
      VALUES ($1,$2,$3,'0.0.809',now())`, [device, business, location]);
    await db.query(`INSERT INTO platform_releases
      (version,build_commit,build_id,channel,status,rollout_state,rollout_percentage,released_at,
       installer_url,installer_sha256,installer_size,manifest_signature,expected_publisher)
      VALUES ('0.0.810','fixture','fixture','stable','published','full',100,now(),
       'https://report-fixture.invalid/installer',$1,1,$2,'Fixture') ON CONFLICT (channel,version) DO NOTHING`, ["a".repeat(64), "A".repeat(96)]);
    await db.query("COMMIT");
    console.log(`PLATFORM_REPORT_BUSINESS_ID=${business}`);
  } catch (error) {
    await db.query("ROLLBACK"); throw error;
  } finally { await db.end(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
