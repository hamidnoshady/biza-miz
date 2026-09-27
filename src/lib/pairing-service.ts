/**
 * The online server's half of desktop pairing: issuing codes from the
 * super-admin console, and trading a redeemed code for a snapshot of the
 * business configuration.
 *
 * DB-touching, so per repo convention it has no direct unit test — the pure
 * logic it leans on is covered by pairing-codes.test.ts and
 * pairing-snapshot.test.ts, and the transactional behaviour by
 * integration/pairing.integration.test.ts.
 */
import { createHash } from "node:crypto";
import { getPool, query, withoutTenantScope } from "./db";
import { effectiveFeatures } from "./features";
import type { Industry } from "./industries";
import {
  generatePairingCode,
  hashPairingCode,
  pairingCodeState,
  PAIRING_CODE_TTL_HOURS,
  type PairingCodeState,
} from "./pairing-codes";
import {
  PAIRING_SNAPSHOT_VERSION,
  type PairingSnapshot,
} from "./pairing-snapshot";
import { SETTING_KEYS } from "./settings";
import { generateSyncToken } from "./sync-token";
import {
  decryptSecret,
  encryptSecret,
  resolveEncryptionKey,
} from "./integrations/secrets";
import { SYNC_EVENT_REGISTRY } from "./sync-event-registry";

export interface PairingCodeSummary {
  id: string;
  businessId: string;
  locationId: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: PairingCodeState;
}

// A type alias rather than an interface: `query<T>` constrains T to
// Record<string, unknown>, which only object-literal aliases satisfy (see the
// row types in api-auth.ts and server-sync.ts for the same shape).
type CodeRow = {
  id: string;
  business_id: string;
  location_id: string;
  expires_at: Date;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

function toSummary(row: CodeRow, now: Date): PairingCodeSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    expiresAt: row.expires_at.toISOString(),
    redeemedAt: row.redeemed_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    state: pairingCodeState(
      {
        expiresAt: row.expires_at,
        redeemedAt: row.redeemed_at,
        revokedAt: row.revoked_at,
      },
      now,
    ),
  };
}

/**
 * Issue a fresh code for a business, revoking whatever live code it already
 * had. The partial unique index enforces one-live-per-business, so revoking
 * first is not a nicety — it is what makes re-issuing possible at all.
 *
 * Runs under whichever scope the caller already established: the console wraps
 * it in `withPlatformScope`, and the owner's own «اتصال دستگاه» panel wraps it
 * in the ordinary tenant scope (`withTenantScope`), where RLS's `WITH CHECK`
 * confines the insert to the caller's business without needing a bypass.
 *
 * `issuedBy` is a `platform_users.id` and is nullable in the schema, so an
 * owner issuing their own code passes `session.platformUserId` — which is null
 * for a PIN-only staff login, and null is the honest value there rather than a
 * borrowed identity. (Only Owners reach this, and Owners are password logins,
 * so in practice it is set.)
 */
export async function listPairingLocations(
  businessId: string,
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations WHERE business_id = $1 AND is_active ORDER BY name, created_at`,
    [businessId],
  );
  return rows;
}

export async function issuePairingCode(
  businessId: string,
  issuedBy: string | null,
  locationId: string,
): Promise<
  | { code: string; summary: PairingCodeSummary }
  | { error: "no_location" | "invalid_location" }
> {
  if (!locationId) return { error: "no_location" };
  const { rows: locationRows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE id = $1 AND business_id = $2 AND is_active`,
    [locationId, businessId],
  );
  if (!locationRows[0]) return { error: "invalid_location" };

  const code = generatePairingCode();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE install_pairing_codes SET revoked_at = now()
        WHERE business_id = $1 AND location_id = $2
          AND redeemed_at IS NULL AND revoked_at IS NULL`,
      [businessId, locationId],
    );
    const { rows } = await client.query<CodeRow>(
      `INSERT INTO install_pairing_codes
         (business_id, location_id, code_hash, expires_at, issued_by)
       VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)
       RETURNING id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at`,
      [
        businessId,
        locationId,
        hashPairingCode(code),
        String(PAIRING_CODE_TTL_HOURS),
        issuedBy,
      ],
    );
    await client.query("COMMIT");
    return { code, summary: toSummary(rows[0], new Date()) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listPairingCodes(
  businessId: string,
): Promise<PairingCodeSummary[]> {
  const { rows } = await query<CodeRow>(
    `SELECT id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at
       FROM install_pairing_codes
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT 20`,
    [businessId],
  );
  const now = new Date();
  return rows.map((row) => toSummary(row, now));
}

/** Revoke a still-live code. Returns false if there was nothing live to revoke. */
export async function revokePairingCode(
  businessId: string,
  codeId: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE install_pairing_codes SET revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND redeemed_at IS NULL AND revoked_at IS NULL`,
    [codeId, businessId],
  );
  return (rowCount ?? 0) > 0;
}

export type PairingSessionState =
  | "issued"
  | "redeeming"
  | "snapshot_ready"
  | "downloaded"
  | "local_commit_pending"
  | "completed"
  | "expired"
  | "abandoned"
  | "revoked";

type PairingSessionRow = {
  id: string;
  install_pairing_code_id: string;
  business_id: string;
  location_id: string;
  site_device_id: string;
  installation_id: string;
  device_name: string;
  state: PairingSessionState;
  sync_token_ciphertext: string;
  snapshot_ciphertext: string | null;
  expires_at: Date;
};

export type RedeemResult =
  | {
      ok: true;
      snapshot: PairingSnapshot;
      pairingSessionId: string;
      resumed: boolean;
    }
  | {
      ok: false;
      error:
        | "code_not_found"
        | "code_expired"
        | "code_already_redeemed"
        | "code_revoked"
        | "pairing_session_unavailable";
    };

export type AcknowledgePairingResult =
  | { ok: true; state: "completed" }
  | {
      ok: false;
      error:
        | "pairing_session_not_found"
        | "pairing_session_expired"
        | "pairing_session_mismatch"
        | "pairing_session_unavailable";
    };

function canonicalInstallationId(
  raw: string | null | undefined,
  clientIp: string | null,
  deviceName: string,
): string {
  const supplied = raw?.trim();
  if (supplied && supplied.length >= 8 && supplied.length <= 200)
    return supplied;
  // Old desktop builds did not send an instance id. Keep their one-code flow
  // working, but bind the compatibility session deterministically so retries
  // from the same caller resume instead of minting another device.
  return `legacy:${createHash("sha256")
    .update(`${clientIp ?? "unknown"}:${deviceName}`)
    .digest("hex")}`;
}

async function expireStalePairingSessionsInTransaction(
  client: import("pg").PoolClient,
): Promise<void> {
  const expired = await client.query<{ site_device_id: string }>(
    `UPDATE pairing_sessions
        SET state='expired', updated_at=now(), last_error_code='pairing_session_expired'
      WHERE state IN ('redeeming','snapshot_ready','downloaded','local_commit_pending')
        AND expires_at <= now()
      RETURNING site_device_id`,
  );
  if (expired.rowCount) {
    await client.query(
      `UPDATE site_devices
          SET status='revoked', revoked_at=COALESCE(revoked_at, now())
        WHERE id = ANY($1::uuid[]) AND status='pending'`,
      [expired.rows.map((row) => row.site_device_id)],
    );
    await client.query(
      `DELETE FROM site_sync_credentials WHERE site_device_id = ANY($1::uuid[])`,
      [expired.rows.map((row) => row.site_device_id)],
    );
  }
}

/**
 * Expire orphaned pairing sessions and revoke their pending credentials. This
 * runs from the server-sync tick as well as the redemption path, so an
 * abandoned install is cleaned up even when nobody opens the pairing UI.
 */
export async function expireStalePairingSessions(): Promise<void> {
  await withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await expireStalePairingSessionsInTransaction(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

async function saveBuiltSnapshot(
  sessionId: string,
  snapshot: PairingSnapshot,
): Promise<boolean> {
  const ciphertext = encryptSecret(
    JSON.stringify(snapshot),
    resolveEncryptionKey(process.env),
  );
  const { rowCount } = await query(
    `UPDATE pairing_sessions
        SET snapshot_ciphertext=$2, state='snapshot_ready', updated_at=now(), last_error_code=NULL
      WHERE id=$1 AND state='redeeming' AND expires_at > now()`,
    [sessionId, ciphertext],
  );
  return (rowCount ?? 0) === 1;
}

/**
 * Trade a pairing code for a resumable snapshot. A newly-created session owns
 * a pending device and credential; it becomes active only after the local
 * install acknowledges its committed transaction.
 */
export async function redeemPairingCode(
  rawCode: string,
  clientIp: string | null,
  deviceName = "Windows Business Suite",
  installationId?: string | null,
): Promise<RedeemResult> {
  return withoutTenantScope("pairing-redeem", async () => {
    const cleanDeviceName =
      deviceName.trim().slice(0, 120) || "Windows Business Suite";
    const stableInstallationId = canonicalInstallationId(
      installationId,
      clientIp,
      cleanDeviceName,
    );
    const key = resolveEncryptionKey(process.env);
    const client = await getPool().connect();
    let session: PairingSessionRow | null = null;
    let shouldBuildSnapshot = false;
    let resumed = false;
    try {
      await client.query("BEGIN");
      await expireStalePairingSessionsInTransaction(client);
      const { rows } = await client.query<CodeRow>(
        `SELECT id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at
           FROM install_pairing_codes WHERE code_hash = $1 FOR UPDATE`,
        [hashPairingCode(rawCode)],
      );
      const code = rows[0];
      if (!code) {
        await client.query("ROLLBACK");
        return { ok: false, error: "code_not_found" };
      }

      const existing = await client.query<PairingSessionRow>(
        `SELECT id,install_pairing_code_id,business_id,location_id,site_device_id,installation_id,
                device_name,state,sync_token_ciphertext,snapshot_ciphertext,expires_at
           FROM pairing_sessions WHERE install_pairing_code_id=$1 FOR UPDATE`,
        [code.id],
      );
      session = existing.rows[0] ?? null;
      if (session) {
        if (session.installation_id !== stableInstallationId) {
          await client.query("ROLLBACK");
          return { ok: false, error: "code_already_redeemed" };
        }
        if (
          session.state === "expired" ||
          session.expires_at.getTime() <= Date.now()
        ) {
          await client.query("ROLLBACK");
          return { ok: false, error: "code_expired" };
        }
        if (session.state === "completed") {
          // Recovery ends at the atomic local-commit acknowledgement. Returning
          // the snapshot/token after that would turn an old one-time code into
          // a reusable credential download.
          await client.query("ROLLBACK");
          return { ok: false, error: "code_already_redeemed" };
        }
        if (session.state === "revoked" || session.state === "abandoned") {
          await client.query("ROLLBACK");
          return { ok: false, error: "pairing_session_unavailable" };
        }
        resumed = true;
        shouldBuildSnapshot = !session.snapshot_ciphertext;
        await client.query("COMMIT");
      } else {
        const state = pairingCodeState(
          {
            expiresAt: code.expires_at,
            redeemedAt: code.redeemed_at,
            revokedAt: code.revoked_at,
          },
          new Date(),
        );
        if (state !== "valid") {
          await client.query("ROLLBACK");
          return { ok: false, error: state };
        }

        const syncToken = generateSyncToken();
        const deviceRows = await client.query<{
          id: string;
          public_id: string;
          display_name: string;
        }>(
          `INSERT INTO site_devices (business_id, location_id, display_name, status)
           VALUES ($1, $2, $3, 'pending')
           RETURNING id, public_id, display_name`,
          [code.business_id, code.location_id, cleanDeviceName],
        );
        const device = deviceRows.rows[0];
        await client.query(
          `INSERT INTO site_sync_credentials (site_device_id, business_id, token_hash)
           VALUES ($1, $2, $3)`,
          [
            device.id,
            code.business_id,
            createHash("sha256").update(syncToken).digest("hex"),
          ],
        );
        const sessionRows = await client.query<PairingSessionRow>(
          `INSERT INTO pairing_sessions
             (install_pairing_code_id,business_id,location_id,site_device_id,installation_id,device_name,
              state,sync_token_ciphertext,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,'redeeming',$7,$8)
           RETURNING id,install_pairing_code_id,business_id,location_id,site_device_id,installation_id,
                     device_name,state,sync_token_ciphertext,snapshot_ciphertext,expires_at`,
          [
            code.id,
            code.business_id,
            code.location_id,
            device.id,
            stableInstallationId,
            cleanDeviceName,
            encryptSecret(syncToken, key),
            code.expires_at,
          ],
        );
        session = sessionRows.rows[0];
        await client.query(
          `UPDATE install_pairing_codes SET redeemed_at=now(), redeemed_ip=$2 WHERE id=$1`,
          [code.id, clientIp],
        );
        await client.query("COMMIT");
        shouldBuildSnapshot = true;
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (!session) return { ok: false, error: "pairing_session_unavailable" };
    let snapshot: PairingSnapshot;
    if (shouldBuildSnapshot) {
      try {
        const syncToken = decryptSecret(session.sync_token_ciphertext, key);
        const device = await query<{
          id: string;
          public_id: string;
          display_name: string;
        }>(
          `SELECT id,public_id,display_name FROM site_devices
            WHERE id=$1 AND business_id=$2 AND status='pending'`,
          [session.site_device_id, session.business_id],
        );
        if (!device.rows[0])
          return { ok: false, error: "pairing_session_unavailable" };
        snapshot = await buildPairingSnapshot(
          session.business_id,
          session.location_id,
          {
            id: device.rows[0].id,
            publicId: device.rows[0].public_id,
            displayName: device.rows[0].display_name,
          },
          syncToken,
        );
        if (!(await saveBuiltSnapshot(session.id, snapshot)))
          return { ok: false, error: "pairing_session_unavailable" };
      } catch (error) {
        await query(
          `UPDATE pairing_sessions SET last_error_code='snapshot_build_failed',updated_at=now()
            WHERE id=$1 AND state='redeeming'`,
          [session.id],
        ).catch(() => {});
        console.error("pairing snapshot build failed", error);
        return { ok: false, error: "pairing_session_unavailable" };
      }
    } else {
      try {
        snapshot = JSON.parse(
          decryptSecret(session.snapshot_ciphertext!, key),
        ) as PairingSnapshot;
      } catch {
        return { ok: false, error: "pairing_session_unavailable" };
      }
    }

    await query(
      `UPDATE pairing_sessions
          SET state=CASE WHEN state IN ('snapshot_ready','redeeming') THEN 'downloaded' ELSE state END,
              downloaded_at=COALESCE(downloaded_at,now()),updated_at=now()
        WHERE id=$1`,
      [session.id],
    );
    return { ok: true, snapshot, pairingSessionId: session.id, resumed };
  });
}

/** Activate a pending credential only after the local pairing transaction committed. */
export async function acknowledgePairingSession(
  pairingSessionId: string,
  installationId: string,
  token: string,
): Promise<AcknowledgePairingResult> {
  return withoutTenantScope("pairing-redeem", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await expireStalePairingSessionsInTransaction(client);
      const { rows } = await client.query<
        PairingSessionRow & { token_hash: string }
      >(
        `SELECT s.id,s.install_pairing_code_id,s.business_id,s.location_id,s.site_device_id,s.installation_id,
                s.device_name,s.state,s.sync_token_ciphertext,s.snapshot_ciphertext,s.expires_at,c.token_hash
           FROM pairing_sessions s
           JOIN site_sync_credentials c ON c.site_device_id=s.site_device_id AND c.business_id=s.business_id
          WHERE s.id=$1 FOR UPDATE`,
        [pairingSessionId],
      );
      const session = rows[0];
      if (!session) {
        await client.query("ROLLBACK");
        return { ok: false, error: "pairing_session_not_found" };
      }
      if (
        session.installation_id !== installationId ||
        session.token_hash !== createHash("sha256").update(token).digest("hex")
      ) {
        await client.query("ROLLBACK");
        return { ok: false, error: "pairing_session_mismatch" };
      }
      if (session.state === "completed") {
        await client.query("COMMIT");
        return { ok: true, state: "completed" };
      }
      if (
        session.expires_at.getTime() <= Date.now() ||
        session.state === "expired"
      ) {
        await client.query("ROLLBACK");
        return { ok: false, error: "pairing_session_expired" };
      }
      if (
        !["snapshot_ready", "downloaded", "local_commit_pending"].includes(
          session.state,
        )
      ) {
        await client.query("ROLLBACK");
        return { ok: false, error: "pairing_session_unavailable" };
      }
      await client.query(
        `UPDATE pairing_sessions SET state='local_commit_pending',updated_at=now() WHERE id=$1`,
        [session.id],
      );
      await client.query(
        `UPDATE site_devices SET status='active' WHERE id=$1 AND business_id=$2 AND status='pending'`,
        [session.site_device_id, session.business_id],
      );
      await client.query(
        `UPDATE pairing_sessions SET state='completed',completed_at=now(),updated_at=now(),last_error_code=NULL WHERE id=$1`,
        [session.id],
      );
      await client.query("COMMIT");
      return { ok: true, state: "completed" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

/**
 * Read the business's configuration into a transportable snapshot.
 *
 * Deliberately excludes everything transactional (orders, ledger entries,
 * stock movements) and everything machine-specific (backup destinations,
 * rollup config, sync state). What is left is the configuration a till needs
 * to start selling.
 *
 * Must be called from inside a bypassed scope — `redeemPairingCode` provides
 * one; it is exported only so the integration test can exercise it directly.
 */
export async function buildPairingSnapshot(
  businessId: string,
  locationId: string,
  siteDevice: PairingSnapshot["siteDevice"],
  syncToken: string,
): Promise<PairingSnapshot> {
  const [
    bizRes,
    locRes,
    userRes,
    assignRes,
    accountRes,
    catRes,
    itemRes,
    mediaAssetRes,
    modifierGroupRes,
    modifierRes,
    itemModifierRes,
    diningRes,
    inventoryRes,
    menuIngredientRes,
    modifierIngredientRes,
    paymentMethodRes,
    settingRes,
    features,
  ] = await Promise.all([
    query<{
      id: string;
      name: string;
      slug: string;
      timezone: string;
      industry: Industry;
    }>(
      `SELECT id, name, slug::text AS slug, subdomain::text AS subdomain, timezone, industry
           FROM businesses WHERE id = $1`,
      [businessId],
    ),
    query<{
      id: string;
      name: string;
      address: string | null;
      phone: string | null;
      timezone: string;
    }>(
      `SELECT id, name, address, phone, timezone FROM locations WHERE id = $1`,
      [locationId],
    ),
    query<{
      id: string;
      role: string;
      full_name: string;
      email: string | null;
      permissions: Record<string, unknown>;
      pin_hash: string | null;
      password_hash: string | null;
      pu_email: string | null;
      pu_full_name: string | null;
      pu_password_hash: string | null;
    }>(
      `SELECT u.id, u.role::text AS role, u.full_name, u.email::text AS email, u.permissions,
                u.pin_hash, u.password_hash,
                pu.email::text AS pu_email, pu.full_name AS pu_full_name,
                pu.password_hash AS pu_password_hash
           FROM users u
           LEFT JOIN platform_users pu ON pu.id = u.platform_user_id
          WHERE u.business_id = $1 AND u.is_active`,
      [businessId],
    ),
    query<{ user_id: string; location_id: string }>(
      `SELECT ul.user_id, ul.location_id
           FROM user_locations ul
           JOIN users u ON u.id = ul.user_id
          WHERE u.business_id = $1`,
      [businessId],
    ),
    query<{
      id: string;
      parent_code: string | null;
      code: string;
      name: string;
      type: string;
    }>(
      `SELECT a.id, p.code AS parent_code, a.code, a.name, a.type::text AS type
           FROM accounts a
           LEFT JOIN accounts p ON p.id = a.parent_id
          WHERE a.business_id = $1 AND a.is_active
          ORDER BY a.code`,
      [businessId],
    ),
    query<{ id: string; name: string; sort_order: number; is_active: boolean }>(
      `SELECT id, name, sort_order, is_active FROM menu_categories
          WHERE location_id = $1 ORDER BY sort_order, name`,
      [locationId],
    ),
    query<{
      id: string;
      category_id: string | null;
      name: string;
      description: string | null;
      sku: string | null;
      price: string;
      image_url: string | null;
      image_media_id: string | null;
      is_active: boolean;
      sort_order: number;
    }>(
      `SELECT id, category_id, name, description, sku, price, image_url, image_media_id,
                is_active, sort_order
           FROM menu_items WHERE location_id = $1 ORDER BY sort_order, name`,
      [locationId],
    ),
    // v4: the media rows this branch's menu actually points at. Minimal
    // replication — metadata only; the bytes are fetched from this server
    // on demand, so pairing never stalls on image payloads.
    query<{
      id: string;
      kind: string;
      file_name: string;
      mime_type: string;
      byte_size: string;
      storage_key: string;
      sha256: string;
    }>(
      `SELECT DISTINCT ma.id, ma.kind, ma.file_name, ma.mime_type,
                ma.byte_size::text AS byte_size, ma.storage_key, ma.sha256
           FROM media_assets ma
           JOIN menu_items mi ON mi.image_media_id = ma.id
          WHERE mi.location_id = $1`,
      [locationId],
    ),
    query<{
      id: string;
      name: string;
      min_select: number;
      max_select: number;
      is_active: boolean;
      sort_order: number;
    }>(
      `SELECT id, name, min_select, max_select, is_active, sort_order
           FROM modifier_groups WHERE location_id = $1 ORDER BY sort_order, name, id`,
      [locationId],
    ),
    query<{
      id: string;
      group_id: string;
      name: string;
      price_delta: string;
      is_active: boolean;
      sort_order: number;
    }>(
      `SELECT id, group_id, name, price_delta, is_active, sort_order
           FROM modifiers WHERE location_id = $1 ORDER BY group_id, sort_order, name`,
      [locationId],
    ),
    query<{
      menu_item_id: string;
      modifier_group_id: string;
      min_select_override: number | null;
      max_select_override: number | null;
      sort_order: number;
      is_active: boolean;
    }>(
      `SELECT mm.menu_item_id, mm.modifier_group_id, mm.min_select_override,
                mm.max_select_override, mm.sort_order, mm.is_active
           FROM menu_item_modifier_groups mm
           JOIN menu_items mi ON mi.id = mm.menu_item_id
          WHERE mi.location_id = $1`,
      [locationId],
    ),
    query<{
      id: string;
      name: string;
      zone: string | null;
      capacity: number;
      sort_order: number;
      is_active: boolean;
    }>(
      `SELECT id, name, zone, capacity, sort_order, is_active
           FROM dining_tables WHERE location_id = $1 ORDER BY sort_order, name`,
      [locationId],
    ),
    query<{
      id: string;
      name: string;
      sku: string | null;
      unit: string;
      reorder_level: string | null;
      avg_cost: string;
      purchase_unit: string | null;
      purchase_unit_factor: string;
      carrying_value_rial: string | null;
      is_produced: boolean;
      is_active: boolean;
    }>(
      `SELECT id, name, sku, unit, reorder_level, avg_cost, purchase_unit,
                purchase_unit_factor, carrying_value_rial, is_produced, is_active
           FROM inventory_items WHERE location_id = $1 ORDER BY name, id`,
      [locationId],
    ),
    query<{
      menu_item_id: string;
      inventory_item_id: string;
      quantity: string;
    }>(
      `SELECT m.menu_item_id, m.inventory_item_id, m.quantity
           FROM menu_item_ingredients m
           JOIN menu_items mi ON mi.id = m.menu_item_id
          WHERE mi.location_id = $1`,
      [locationId],
    ),
    query<{
      modifier_id: string;
      inventory_item_id: string;
      quantity_delta: string;
    }>(
      `SELECT m.modifier_id, m.inventory_item_id, m.quantity_delta
           FROM modifier_ingredients m
           JOIN modifiers md ON md.id = m.modifier_id
          WHERE md.location_id = $1`,
      [locationId],
    ),
    query<{
      id: string;
      code: string;
      name: string;
      settlement: string;
      sort_order: number;
      is_active: boolean;
      is_builtin: boolean;
      opens_drawer: boolean;
      requires_reference: boolean;
    }>(
      `SELECT id, code, name, settlement::text AS settlement, sort_order,
                is_active, is_builtin, opens_drawer, requires_reference
           FROM payment_methods WHERE business_id = $1 ORDER BY sort_order, name`,
      [businessId],
    ),
    query<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings
          WHERE business_id = $1 AND location_id IS NULL AND key = ANY($2::text[])`,
      [businessId, SNAPSHOT_SETTING_KEYS],
    ),
    effectiveFeatures(businessId),
  ]);

  const locationsByUser = new Map<string, string[]>();
  for (const row of assignRes.rows) {
    const list = locationsByUser.get(row.user_id) ?? [];
    list.push(row.location_id);
    locationsByUser.set(row.user_id, list);
  }

  return {
    version: PAIRING_SNAPSHOT_VERSION,
    business: bizRes.rows[0],
    location: locRes.rows[0],
    siteDevice,
    users: userRes.rows.map((u) => ({
      id: u.id,
      role: u.role,
      fullName: u.full_name,
      email: u.email,
      permissions: u.permissions ?? {},
      pinHash: u.pin_hash,
      passwordHash: u.password_hash,
      platformUserEmail: u.pu_email,
      platformUserFullName: u.pu_full_name,
      platformUserPasswordHash: u.pu_password_hash,
      locationIds: locationsByUser.get(u.id) ?? [],
    })),
    accounts: accountRes.rows.map((a) => ({
      id: a.id,
      parentCode: a.parent_code,
      code: a.code,
      name: a.name,
      type: a.type,
    })),
    menu: {
      categories: catRes.rows.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sort_order,
        isActive: c.is_active,
      })),
      items: itemRes.rows.map((i) => ({
        id: i.id,
        categoryId: i.category_id,
        name: i.name,
        description: i.description,
        sku: i.sku,
        // Keep PostgreSQL bigint as text through JSON; converting to Number
        // would silently round sufficiently large Rial values.
        price: i.price,
        imageUrl: i.image_url,
        imageMediaId: i.image_media_id,
        isActive: i.is_active,
        sortOrder: i.sort_order,
      })),
      mediaAssets: mediaAssetRes.rows.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        fileName: asset.file_name,
        mimeType: asset.mime_type,
        byteSize: asset.byte_size,
        storageKey: asset.storage_key,
        sha256: asset.sha256,
      })),
      modifierGroups: modifierGroupRes.rows.map((group) => ({
        id: group.id,
        name: group.name,
        minSelect: group.min_select,
        maxSelect: group.max_select,
        isActive: group.is_active,
        sortOrder: group.sort_order,
      })),
      modifiers: modifierRes.rows.map((modifier) => ({
        id: modifier.id,
        groupId: modifier.group_id,
        name: modifier.name,
        priceDelta: modifier.price_delta,
        isActive: modifier.is_active,
        sortOrder: modifier.sort_order,
      })),
      itemModifierGroups: itemModifierRes.rows.map((link) => ({
        menuItemId: link.menu_item_id,
        modifierGroupId: link.modifier_group_id,
        minSelectOverride: link.min_select_override,
        maxSelectOverride: link.max_select_override,
        sortOrder: link.sort_order,
        isActive: link.is_active,
      })),
    },
    diningTables: diningRes.rows.map((table) => ({
      id: table.id,
      name: table.name,
      zone: table.zone,
      capacity: table.capacity,
      sortOrder: table.sort_order,
      isActive: table.is_active,
    })),
    inventory: {
      items: inventoryRes.rows.map((item) => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        reorderLevel: item.reorder_level,
        averageCost: item.avg_cost,
        purchaseUnit: item.purchase_unit,
        purchaseUnitFactor: item.purchase_unit_factor,
        carryingValueRial: item.carrying_value_rial,
        isProduced: item.is_produced,
        isActive: item.is_active,
      })),
      menuIngredients: menuIngredientRes.rows.map((ingredient) => ({
        menuItemId: ingredient.menu_item_id,
        inventoryItemId: ingredient.inventory_item_id,
        quantity: ingredient.quantity,
      })),
      modifierIngredients: modifierIngredientRes.rows.map((ingredient) => ({
        modifierId: ingredient.modifier_id,
        inventoryItemId: ingredient.inventory_item_id,
        quantityDelta: ingredient.quantity_delta,
      })),
    },
    paymentMethods: paymentMethodRes.rows.map((method) => ({
      id: method.id,
      code: method.code,
      name: method.name,
      settlement: method.settlement,
      sortOrder: method.sort_order,
      isActive: method.is_active,
      isBuiltin: method.is_builtin,
      opensDrawer: method.opens_drawer,
      requiresReference: method.requires_reference,
    })),
    settings: settingRes.rows.map((s) => ({ key: s.key, value: s.value })),
    dataClassification: PAIRING_DATA_CLASSIFICATION,
    features,
    syncToken,
  };
}

const PAIRING_DATA_CLASSIFICATION = {
  bootstrapMasterData: [
    "business identity and selected location",
    "active users, location assignments, and credential hashes",
    "chart of accounts",
    "feature entitlements and selected operational settings",
    "menu categories, items, modifier groups, modifiers, and recipes",
    "dining tables (availability state resets locally)",
    "inventory item catalogue (not stock balances or lots)",
    "named payment methods",
    "site-device identity and one-time sync credential",
  ],
  // Derived from the server's authoritative replay catalogue. Updating a
  // domain event therefore updates the pairing capability response rather than
  // leaving an attractive but stale hand-written claim behind.
  ongoingDomainEvents: SYNC_EVENT_REGISTRY.map(
    (event) => `${event.type}@${event.schemaVersion}`,
  ),
  siteLocalOperationalData: [
    "embedded PostgreSQL files and local backup destinations",
    "desktop identity, secrets, certificates, LAN gateway, logs, and firewall preference",
    "IndexedDB offline mutation queue",
    "printer and print-connector machine configuration",
  ],
  centralOnlyData: [
    "platform administrators, impersonation grants, plans, wallet billing, and global feature catalogue",
    "cloud media/update/backup distribution credentials",
    "cross-business support and platform audit data",
  ],
  notYetReplicated: [
    "historical/full orders, tenders, payments, refunds, reservations, and shifts",
    "journal entries, fiscal periods, bank reconciliation, payroll, tax filings, and accounting documents",
    "stock balances, lots, movements, counts, purchases, suppliers, production, and transfers",
    "customers, CRM activity, loyalty, campaigns, coupons, and Growth/Marketing history",
    "website content, WooCommerce mappings/outbox, WordPress, Holoo, API/MCP, and other integration state",
    "media binaries and media-library history",
    "continuous changes to bootstrap master data (users, catalogue, settings, customers and CRM) after pairing",
  ],
} satisfies PairingSnapshot["dataClassification"];

/**
 * The settings a till needs to operate, and nothing else. Backup destinations
 * and rollup/sync targets are machine-specific, and wizard progress is
 * recomputed on the local side (see applyPairingSnapshot), so none of them
 * travel.
 */
const SNAPSHOT_SETTING_KEYS = [
  SETTING_KEYS.businessPrefs,
  SETTING_KEYS.businessProfile,
  SETTING_KEYS.costing,
  SETTING_KEYS.tax,
  SETTING_KEYS.pricing,
];
