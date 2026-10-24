/** Browser against real app/DB/S3 fixture. Remote WordPress completions are
 * deliberately simulated in the mirror; native WP behavior is a separate
 * PHPUnit gate, not something this fixture claims to prove.
 */
import assert from "node:assert/strict";
export async function runWpMediaE2E({ page, db, baseUrl, uploadPath, businessSlug }) {
  page.on("pageerror", (error) => console.error("[e2e-wp-media] browser error:", error.message));
  page.setDefaultTimeout(60000); // cold local webpack route compilation
  const { rows: businesses } = await db.query("SELECT id FROM businesses WHERE slug = $1", [businessSlug]);
  const businessId = businesses[0].id;
  const previousFeature = await db.query("SELECT enabled FROM business_features WHERE business_id = $1 AND flag_key = 'integrations'", [businessId]);
  await db.query("INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'integrations', true) ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = true", [businessId]);
  const { rows: sites } = await db.query(`INSERT INTO integration_connections (business_id, name, provider, base_url, consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext, link_mode, plugin_capabilities, link_token_hash, link_token_ciphertext) VALUES ($1, 'WP browser fixture', 'woocommerce', 'https://fixture.example.org', 'fixture', 'fixture', 'fixture', 'plugin', $2::jsonb, gen_random_uuid()::text, 'fixture') RETURNING id`, [businessId, JSON.stringify({ jobTypes: ["media_create", "media_update", "content_export"], mediaTrash: true })]);
  const connectionId = sites[0].id;
  const remoteId = "941000";
  const payload = { id: remoteId, type: "attachment", revision: "10", alt_text: "Fixture alt", filename: "fixture.png", usage: { featured: 1, galleries: 0, embedded: 0, total: 1 }, title: { raw: "Remote fixture" }, source_url: "https://fixture.example.org/fixture.png", mime_type: "image/png" };
  const metadata = () => db.query(`SELECT payload FROM integration_outbox_events WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'media_update' ORDER BY created_at DESC`, [businessId, connectionId]);
  async function settle(action, status, revision) {
    const commands = await metadata();
    assert.equal(commands.rows[0].payload.action, action);
    await db.query(`UPDATE integration_outbox_events SET status = 'sent' WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'media_update'`, [businessId, connectionId]);
    await db.query(`UPDATE integration_wp_content SET status = $3, payload = jsonb_set(payload, '{revision}', to_jsonb($4::text)), updated_at = now() WHERE business_id = $1 AND connection_id = $2 AND remote_id = $5`, [businessId, connectionId, status, revision, remoteId]);
  }
  try {
    await db.query(`INSERT INTO integration_wp_content (business_id, connection_id, wp_type, remote_id, title, status, mime_type, media_url, payload) VALUES ($1, $2, 'attachment', $3, 'Remote fixture', 'inherit', 'image/png', $4, $5::jsonb)`, [businessId, connectionId, remoteId, payload.source_url, JSON.stringify(payload)]);
    await page.goto(`${baseUrl}/websites/wp/media?store=${connectionId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "انتخاب یا بارگذاری در کتابخانهٔ اصلی", exact: true }).click();
    let picker = page.getByRole("dialog");
    await picker.locator('input[type="file"]').setInputFiles(uploadPath);
    await picker.getByText(/تصویر بارگذاری و به انتخاب اضافه شد/).waitFor();
    await picker.getByRole("button", { name: /تأیید انتخاب/ }).click();
    await page.getByRole("button", { name: "ارسال انتخاب‌ها به WP browser fixture", exact: true }).click();
    await page.getByText("در صف تأیید وردپرس", { exact: true }).waitFor();
    const { rows: jobs } = await db.query(`SELECT payload FROM integration_outbox_events WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'media_create'`, [businessId, connectionId]);
    assert.equal(jobs.length, 1);
    assert.ok(jobs[0].payload.__mediaAssetId);
    assert.equal(jobs[0].payload.url, undefined); // URL is minted only on lease.
    console.log("[e2e-wp-media] canonical picker upload and identity-only queued push passed");

    await page.getByRole("button", { name: "جزئیات و مدیریت پیوست", exact: true }).click();
    const detail = page.getByRole("dialog");
    await detail.getByText(/شاخص: 1/).waitFor();
    await detail.getByLabel("عنوان", { exact: true }).fill("Browser-edited title");
    await detail.getByRole("button", { name: "ذخیرهٔ فراداده در وردپرس", exact: true }).click();
    await detail.getByText(/در صف وردپرس قرار گرفت/).waitFor();
    assert.equal((await metadata()).rows[0].payload.fields.title, "Browser-edited title");
    const trash = detail.getByRole("button", { name: "انتقال پیوست سایت به زباله‌دان", exact: true });
    assert.equal(await trash.isDisabled(), true);
    await detail.getByLabel("تأیید می‌کنم فقط پیوست همین سایت", { exact: false }).check();
    await detail.getByLabel("با وجود احتمال خرابی", { exact: false }).check();
    await Promise.all([page.waitForResponse((r) => r.url().includes(`/media/${remoteId}`) && r.request().method() === "GET"), trash.click()]);
    assert.equal((await metadata()).rows[0].payload.acknowledge_usage, true);
    await settle("trash", "trash", "11");
    const restore = detail.getByRole("button", { name: "بازیابی پیوست سایت", exact: true });
    await restore.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'بازیابی پیوست سایت' && !b.disabled));
    await Promise.all([page.waitForResponse((r) => r.url().includes(`/media/${remoteId}`) && r.request().method() === "GET"), restore.click()]);
    await settle("restore", "inherit", "12");
    console.log("[e2e-wp-media] detail metadata command, usage warnings, confirmed remote trash/restore passed (simulated remote completion)");
    await page.screenshot({ path: process.env.E2E_WP_SCREENSHOT || ".cache/wp-media-browser.png", fullPage: true });
    console.log("[e2e-wp-media] ALL STEPS PASSED");
  } catch (error) {
    console.error("[e2e-wp-media] failed at", page.url(), (await page.locator("body").innerText()).slice(-5000));
    await page.screenshot({ path: process.env.E2E_WP_SCREENSHOT || ".cache/wp-media-browser.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    // Audit history outlives a connection (ON DELETE NO ACTION since 0233), so the fixture clears its own trail first.
    await db.query("DELETE FROM integration_audit_log WHERE business_id = $1 AND connection_id = $2", [businessId, connectionId]);
    await db.query("DELETE FROM integration_connections WHERE business_id = $1 AND id = $2", [businessId, connectionId]);
    if (previousFeature.rows.length) await db.query("UPDATE business_features SET enabled = $2 WHERE business_id = $1 AND flag_key = 'integrations'", [businessId, previousFeature.rows[0].enabled]);
    else await db.query("DELETE FROM business_features WHERE business_id = $1 AND flag_key = 'integrations'", [businessId]);
  }
}
