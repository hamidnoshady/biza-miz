/**
 * The local install's half of desktop pairing: replay a PairingSnapshot into
 * an empty database.
 *
 * Bypassed (`platform`) throughout for the same reason `provisionBusiness` is:
 * it creates the tenant that scoping would otherwise require to already
 * exist. One transaction, so a partial pairing is impossible — either the
 * whole business lands or the database stays empty and the owner can retry
 * with a fresh code.
 *
 * Every id is inserted verbatim from the snapshot. That is the point: the
 * laptop and the server share a business_id, location_id and user ids, which
 * is what makes Phase 11's sync_events replay in both directions afterwards.
 *
 * DB-touching, so per repo convention no direct unit test — see
 * integration/pairing.integration.test.ts.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, withoutTenantScope } from "./db";
import type { PairingSnapshot } from "./pairing-snapshot";
import { SETTING_KEYS } from "./settings";

/** Electron supplies this durable identity; the deterministic fallback keeps non-Electron development resumable. */
export function localInstallationId(): string {
  const desktopId = process.env.DESKTOP_INSTANCE_ID?.trim();
  if (desktopId && desktopId.length >= 8 && desktopId.length <= 200)
    return desktopId;
  return `server:${createHash("sha256")
    .update(process.env.HOSTNAME || "local-development")
    .digest("hex")}`;
}

export interface AppliedSnapshot {
  businessId: string;
  businessSlug: string;
  businessSubdomain: string;
  locationId: string;
  ownerUserId: string;
  ownerName: string;
  ownerPlatformUserId: string | null;
}

export async function applyPairingSnapshot(
  snapshot: PairingSnapshot,
  remoteUrl: string,
  pairing: { pairingSessionId?: string; installationId?: string } = {},
): Promise<AppliedSnapshot> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // The snapshot *is* the central server's data: record no master-data
      // clocks for it (migration 0190), or the whole catalogue would be pushed
      // straight back. The master feed then fills in what the snapshot lacks,
      // customers included, and both sides compare equal on the rest.
      await client.query("SET LOCAL app.sync_replay = 'on'");

      await client.query(
        `INSERT INTO businesses (id, name, slug, subdomain, timezone, industry) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          snapshot.business.id,
          snapshot.business.name,
          snapshot.business.slug,
          // Older central servers send no subdomain; the slug is what the
          // column was backfilled from, so it is the right fallback.
          snapshot.business.subdomain ?? snapshot.business.slug,
          snapshot.business.timezone,
          // Likewise for industry: absent from an older snapshot means fall
          // back to the column default, which is what a paired install got
          // before the field crossed at all. Carrying it matters because the
          // laptop's dashboard, wizard and chart of accounts all key off it —
          // a paired jewellery business used to come up as a café.
          snapshot.business.industry ?? "food_service",
        ],
      );

      await client.query(
        `INSERT INTO locations (id, business_id, name, address, phone, timezone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          snapshot.location.id,
          snapshot.business.id,
          snapshot.location.name,
          snapshot.location.address,
          snapshot.location.phone,
          snapshot.location.timezone,
        ],
      );

      const additionalLocations = snapshot.locationIdentities.filter((location) => location.id !== snapshot.location.id);
      if (additionalLocations.length > 0) {
        await client.query(
          `INSERT INTO locations (id, business_id, name, timezone)
           SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::text[])
           ON CONFLICT (id) DO NOTHING`,
          [
            additionalLocations.map((location) => location.id),
            additionalLocations.map(() => snapshot.business.id),
            additionalLocations.map((location) => location.name),
            additionalLocations.map((location) => location.timezone),
          ],
        );
      }

      await client.query(
        `INSERT INTO site_devices (id, business_id, location_id, public_id, display_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          snapshot.siteDevice.id,
          snapshot.business.id,
          snapshot.location.id,
          snapshot.siteDevice.publicId,
          snapshot.siteDevice.displayName,
        ],
      );
      await client.query(
        `INSERT INTO site_sync_credentials (site_device_id, business_id, token_hash)
         VALUES ($1, $2, $3)`,
        [
          snapshot.siteDevice.id,
          snapshot.business.id,
          createHash("sha256").update(snapshot.syncToken).digest("hex"),
        ],
      );

      await insertTenantRoles(client, snapshot);
      const ownerIds = await insertUsers(client, snapshot);
      await insertAccounts(client, snapshot);
      await insertMenu(client, snapshot);
      await insertDiningTables(client, snapshot);
      await insertInventory(client, snapshot);
      await insertPaymentMethods(client, snapshot);
      await insertSettings(client, snapshot, remoteUrl, pairing);
      await insertFeatures(client, snapshot);

      await client.query("COMMIT");
      return {
        businessId: snapshot.business.id,
        businessSlug: snapshot.business.slug,
        businessSubdomain:
          snapshot.business.subdomain ?? snapshot.business.slug,
        locationId: snapshot.location.id,
        ...ownerIds,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/** Insert canonical custom-role identities before memberships reference them. */
async function insertTenantRoles(client: PoolClient, snapshot: PairingSnapshot): Promise<void> {
  for (const role of snapshot.tenantRoles) {
    await client.query(
      `INSERT INTO tenant_roles (id,business_id,name,description,permissions,default_location_scope,is_active,role_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [role.id,snapshot.business.id,role.name,role.description,JSON.stringify(role.permissions),role.defaultLocationScope,role.isActive,role.roleRevision],
    );
  }
}

/**
 * Recreate the canonical membership replica without Cloud credentials. Cloud
 * password hashes, MFA secrets and sessions never cross the pairing boundary;
 * once the site credential is active, IAM sync replicates the password and
 * second factor (src/lib/iam/login-credentials.ts) so login is global.
 * The temporary post-pairing owner session is used to establish an explicit
 * site credential before the next login.
 */
async function insertUsers(client: PoolClient, snapshot: PairingSnapshot): Promise<{
  ownerUserId: string; ownerName: string; ownerPlatformUserId: null;
}> {
  let ownerUserId = "";
  let ownerName = "";
  for (const user of snapshot.users) {
    await client.query(
      `INSERT INTO users
         (id,business_id,platform_user_id,location_id,role,custom_role_id,full_name,email,
          permissions,is_active,membership_status,location_scope,membership_revision)
       VALUES ($1,$2,NULL,$3,$4::user_role,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [user.id,snapshot.business.id,user.defaultLocationId,user.role,user.customRoleId,user.fullName,user.email,
       JSON.stringify(user.permissions ?? {}),user.isActive,user.membershipStatus,user.locationScope,user.membershipRevision],
    );
    for (const locationId of user.locationIds) {
      await client.query(`INSERT INTO user_locations (user_id,location_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id,locationId]);
    }
    // Site policy is a separate deny-only overlay. It narrows this machine to
    // its paired branch without erasing the membership's Cloud branch policy.
    await client.query(
      `INSERT INTO site_member_access (business_id,site_device_id,user_id,allowed_location_ids)
       VALUES ($1,$2,$3,$4::uuid[]) ON CONFLICT DO NOTHING`,
      [snapshot.business.id,snapshot.siteDevice.id,user.id,[snapshot.location.id]],
    );
    if (user.role === "owner" && !ownerUserId) { ownerUserId=user.id; ownerName=user.fullName; }
  }
  await client.query(`INSERT INTO iam_business_sequences(business_id,last_sequence) VALUES($1,$2)
    ON CONFLICT(business_id) DO UPDATE SET last_sequence=GREATEST(iam_business_sequences.last_sequence,EXCLUDED.last_sequence)`,
    [snapshot.business.id,snapshot.iam.lastSequence]);
  await client.query(
    `INSERT INTO iam_sync_state (business_id,site_device_id,last_sequence,last_snapshot_version,last_snapshot_hash,status,last_success_at)
     VALUES ($1,$2,$3,$3,$4,'healthy',now())
     ON CONFLICT (business_id,site_device_id) DO UPDATE SET last_sequence=EXCLUDED.last_sequence,
       last_snapshot_version=EXCLUDED.last_snapshot_version,last_snapshot_hash=EXCLUDED.last_snapshot_hash,status='healthy',last_success_at=now(),last_error=NULL`,
    [snapshot.business.id,snapshot.siteDevice.id,snapshot.iam.lastSequence,snapshot.iam.stateHash],
  );
  return { ownerUserId, ownerName, ownerPlatformUserId: null };
}

/** Parents before children, resolving parent_id from a code→id map built as we go. */
async function insertAccounts(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<void> {
  const idByCode = new Map<string, string>();
  const pending = [...snapshot.accounts];
  let guard = pending.length + 1;
  while (pending.length > 0 && guard > 0) {
    guard -= 1;
    const ready = pending.filter(
      (a) => !a.parentCode || idByCode.has(a.parentCode),
    );
    // A snapshot whose parent chain can't be resolved (a cycle, or a parent
    // that was inactive and so never travelled) would loop forever; treat the
    // remaining rows as roots rather than hanging the pairing.
    const batch = ready.length > 0 ? ready : [...pending];
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      const chunk = batch.slice(i, i + CHUNK_SIZE);
      const values: string[] = [];
      const args: unknown[] = [];
      let offset = 1;
      for (const account of chunk) {
        values.push(
          `($${offset}, $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::account_type)`,
        );
        args.push(
          account.id,
          snapshot.business.id,
          account.parentCode
            ? (idByCode.get(account.parentCode) ?? null)
            : null,
          account.code,
          account.name,
          account.type,
        );
        offset += 6;
      }
      if (values.length > 0) {
        await client.query(
          `INSERT INTO accounts (id, business_id, parent_id, code, name, type) VALUES ${values.join(", ")}`,
          args,
        );
      }
      for (const account of chunk) {
        idByCode.set(account.code, account.id);
        pending.splice(pending.indexOf(account), 1);
      }
    }
  }
}

async function insertMenu(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<void> {
  // v4: media rows first — menu_items.image_media_id points at them, and the
  // bytes stay on the central server. The local /api/media/[id]/file fetches
  // on demand and the tile falls back to its placeholder when it cannot.
  if (snapshot.menu.mediaAssets.length > 0) {
    await client.query(
      `INSERT INTO media_assets
         (id, business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::text[], $8::text[])`,
      [
        snapshot.menu.mediaAssets.map((a) => a.id),
        snapshot.menu.mediaAssets.map(() => snapshot.business.id),
        snapshot.menu.mediaAssets.map((a) => a.kind),
        snapshot.menu.mediaAssets.map((a) => a.fileName),
        snapshot.menu.mediaAssets.map((a) => a.mimeType),
        snapshot.menu.mediaAssets.map((a) => a.byteSize),
        snapshot.menu.mediaAssets.map((a) => a.storageKey),
        snapshot.menu.mediaAssets.map((a) => a.sha256),
      ],
    );
  }

  if (snapshot.menu.categories.length > 0) {
    await client.query(
      `INSERT INTO menu_categories (id, location_id, name, sort_order, is_active)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::integer[], $5::boolean[])`,
      [
        snapshot.menu.categories.map((c) => c.id),
        snapshot.menu.categories.map(() => snapshot.location.id),
        snapshot.menu.categories.map((c) => c.name),
        snapshot.menu.categories.map((c) => c.sortOrder),
        snapshot.menu.categories.map((c) => c.isActive),
      ],
    );
  }

  if (snapshot.menu.items.length > 0) {
    await client.query(
      `INSERT INTO menu_items
         (id, location_id, category_id, name, description, sku, price, image_url, image_media_id,
          is_active, sort_order)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::uuid[], $10::boolean[], $11::integer[])`,
      [
        snapshot.menu.items.map((i) => i.id),
        snapshot.menu.items.map(() => snapshot.location.id),
        snapshot.menu.items.map((i) => i.categoryId),
        snapshot.menu.items.map((i) => i.name),
        snapshot.menu.items.map((i) => i.description),
        snapshot.menu.items.map((i) => i.sku),
        snapshot.menu.items.map((i) => i.price),
        snapshot.menu.items.map((i) => i.imageUrl),
        snapshot.menu.items.map((i) => i.imageMediaId),
        snapshot.menu.items.map((i) => i.isActive),
        snapshot.menu.items.map((i) => i.sortOrder),
      ],
    );
  }

  if (snapshot.menu.modifierGroups.length > 0) {
    await client.query(
      `INSERT INTO modifier_groups (id, location_id, name, min_select, max_select, is_active, sort_order)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::integer[], $5::integer[], $6::boolean[], $7::integer[])`,
      [
        snapshot.menu.modifierGroups.map((group) => group.id),
        snapshot.menu.modifierGroups.map(() => snapshot.location.id),
        snapshot.menu.modifierGroups.map((group) => group.name),
        snapshot.menu.modifierGroups.map((group) => group.minSelect),
        snapshot.menu.modifierGroups.map((group) => group.maxSelect),
        snapshot.menu.modifierGroups.map((group) => group.isActive),
        snapshot.menu.modifierGroups.map((group) => group.sortOrder),
      ],
    );
  }

  if (snapshot.menu.modifiers.length > 0) {
    await client.query(
      `INSERT INTO modifiers (id, location_id, group_id, name, price_delta, is_active, sort_order)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::bigint[], $6::boolean[], $7::integer[])`,
      [
        snapshot.menu.modifiers.map((modifier) => modifier.id),
        snapshot.menu.modifiers.map(() => snapshot.location.id),
        snapshot.menu.modifiers.map((modifier) => modifier.groupId),
        snapshot.menu.modifiers.map((modifier) => modifier.name),
        snapshot.menu.modifiers.map((modifier) => modifier.priceDelta),
        snapshot.menu.modifiers.map((modifier) => modifier.isActive),
        snapshot.menu.modifiers.map((modifier) => modifier.sortOrder),
      ],
    );
  }

  if (snapshot.menu.itemModifierGroups.length > 0) {
    await client.query(
      `INSERT INTO menu_item_modifier_groups
         (menu_item_id, modifier_group_id, min_select_override, max_select_override, sort_order, is_active)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::integer[], $4::integer[], $5::integer[], $6::boolean[])`,
      [
        snapshot.menu.itemModifierGroups.map((link) => link.menuItemId),
        snapshot.menu.itemModifierGroups.map((link) => link.modifierGroupId),
        snapshot.menu.itemModifierGroups.map((link) => link.minSelectOverride),
        snapshot.menu.itemModifierGroups.map((link) => link.maxSelectOverride),
        snapshot.menu.itemModifierGroups.map((link) => link.sortOrder),
        snapshot.menu.itemModifierGroups.map((link) => link.isActive),
      ],
    );
  }
}

async function insertDiningTables(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<void> {
  if (snapshot.diningTables.length === 0) return;
  await client.query(
    `INSERT INTO dining_tables (id, location_id, name, zone, capacity, sort_order, is_active)
     SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::integer[], $6::integer[], $7::boolean[])`,
    [
      snapshot.diningTables.map((table) => table.id),
      snapshot.diningTables.map(() => snapshot.location.id),
      snapshot.diningTables.map((table) => table.name),
      snapshot.diningTables.map((table) => table.zone),
      snapshot.diningTables.map((table) => table.capacity),
      snapshot.diningTables.map((table) => table.sortOrder),
      snapshot.diningTables.map((table) => table.isActive),
    ],
  );
}

async function insertInventory(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<void> {
  if (snapshot.inventory.items.length > 0) {
    await client.query(
      `INSERT INTO inventory_items
         (id, location_id, name, sku, unit, reorder_level, avg_cost, purchase_unit,
          purchase_unit_factor, carrying_value_rial, is_produced, is_active)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[],
                           $6::numeric[], $7::numeric[], $8::text[], $9::numeric[], $10::bigint[],
                           $11::boolean[], $12::boolean[])`,
      [
        snapshot.inventory.items.map((item) => item.id),
        snapshot.inventory.items.map(() => snapshot.location.id),
        snapshot.inventory.items.map((item) => item.name),
        snapshot.inventory.items.map((item) => item.sku),
        snapshot.inventory.items.map((item) => item.unit),
        snapshot.inventory.items.map((item) => item.reorderLevel),
        snapshot.inventory.items.map((item) => item.averageCost),
        snapshot.inventory.items.map((item) => item.purchaseUnit),
        snapshot.inventory.items.map((item) => item.purchaseUnitFactor),
        snapshot.inventory.items.map((item) => item.carryingValueRial),
        snapshot.inventory.items.map((item) => item.isProduced),
        snapshot.inventory.items.map((item) => item.isActive),
      ],
    );
  }

  if (snapshot.inventory.menuIngredients.length > 0) {
    await client.query(
      `INSERT INTO menu_item_ingredients (menu_item_id, inventory_item_id, quantity)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::numeric[])`,
      [
        snapshot.inventory.menuIngredients.map(
          (ingredient) => ingredient.menuItemId,
        ),
        snapshot.inventory.menuIngredients.map(
          (ingredient) => ingredient.inventoryItemId,
        ),
        snapshot.inventory.menuIngredients.map(
          (ingredient) => ingredient.quantity,
        ),
      ],
    );
  }

  if (snapshot.inventory.modifierIngredients.length > 0) {
    await client.query(
      `INSERT INTO modifier_ingredients (modifier_id, inventory_item_id, quantity_delta)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::numeric[])`,
      [
        snapshot.inventory.modifierIngredients.map(
          (ingredient) => ingredient.modifierId,
        ),
        snapshot.inventory.modifierIngredients.map(
          (ingredient) => ingredient.inventoryItemId,
        ),
        snapshot.inventory.modifierIngredients.map(
          (ingredient) => ingredient.quantityDelta,
        ),
      ],
    );
  }
}

async function insertPaymentMethods(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<void> {
  if (snapshot.paymentMethods.length === 0) return;
  await client.query(
    `INSERT INTO payment_methods
       (id, business_id, code, name, settlement, sort_order, is_active, is_builtin, opens_drawer, requires_reference)
     SELECT id, $1, code, name, settlement::payment_method, sort_order, is_active, is_builtin, opens_drawer, requires_reference
       FROM UNNEST($2::uuid[], $3::text[], $4::text[], $5::text[], $6::integer[],
                   $7::boolean[], $8::boolean[], $9::boolean[], $10::boolean[])
         AS input(id, code, name, settlement, sort_order, is_active, is_builtin, opens_drawer, requires_reference)`,
    [
      snapshot.business.id,
      snapshot.paymentMethods.map((method) => method.id),
      snapshot.paymentMethods.map((method) => method.code),
      snapshot.paymentMethods.map((method) => method.name),
      snapshot.paymentMethods.map((method) => method.settlement),
      snapshot.paymentMethods.map((method) => method.sortOrder),
      snapshot.paymentMethods.map((method) => method.isActive),
      snapshot.paymentMethods.map((method) => method.isBuiltin),
      snapshot.paymentMethods.map((method) => method.opensDrawer),
      snapshot.paymentMethods.map((method) => method.requiresReference),
    ],
  );
}

/**
 * The snapshot's own settings, plus three this side owns:
 *
 *   - deployment.profile   — 'hybrid', stamped with the pairing time
 *   - server_sync.config   — the token the snapshot delivered, pointed at the
 *                            server that issued it, left disabled so the owner
 *                            turns sync on deliberately
 *   - setup.progress       — marked complete, because the configuration this
 *                            wizard would have collected is exactly what just
 *                            arrived
 */
async function insertSettings(
  client: PoolClient,
  snapshot: PairingSnapshot,
  remoteUrl: string,
  pairing: { pairingSessionId?: string; installationId?: string },
): Promise<void> {
  const pairedAt = new Date().toISOString();

  if (snapshot.settings.length > 0) {
    const keys = snapshot.settings.map((s) => s.key);
    const values = snapshot.settings.map((s) => JSON.stringify(s.value));

    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       SELECT $1, NULL, k, v::jsonb
       FROM unnest($2::text[], $3::text[]) AS t(k, v)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [snapshot.business.id, keys, values],
    );
  }

  const owned: Array<[string, unknown]> = [
    [SETTING_KEYS.deploymentProfile, { profile: "hybrid", pairedAt }],
    [
      SETTING_KEYS.serverSyncConfig,
      {
        remoteUrl,
        token: snapshot.syncToken,
        // The identity is still pending on the cloud until setup acknowledges
        // this committed local transaction.  The sync worker retries that
        // acknowledgement, then starts live sync automatically.
        enabled: true,
        pairingPending: true,
        batchSize: 100,
        siteDeviceId: snapshot.siteDevice.id,
        siteDevicePublicId: snapshot.siteDevice.publicId,
        locationId: snapshot.location.id,
        ...(pairing.pairingSessionId
          ? { pairingSessionId: pairing.pairingSessionId }
          : {}),
        ...(pairing.installationId
          ? { installationId: pairing.installationId }
          : {}),
      },
    ],
    [
      SETTING_KEYS.wizardProgress,
      { steps: { paired: pairedAt }, completedAt: pairedAt },
    ],
  ];

  if (owned.length > 0) {
    const keys = owned.map(([k]) => k);
    const values = owned.map(([_, v]) => JSON.stringify(v));

    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       SELECT $1, NULL, k, v::jsonb
       FROM unnest($2::text[], $3::text[]) AS t(k, v)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [snapshot.business.id, keys, values],
    );
  }

  // The site-scoped credential row is inserted with the site identity above.
  // It intentionally does not touch legacy server_sync_tokens, whose
  // business-primary-key shape cannot represent several locations.
}

/**
 * Pin every flag the snapshot reported, so the laptop shows exactly what the
 * online business shows. Written as overrides rather than trusting local
 * defaults, because the two sides' catalogue defaults could diverge across
 * versions.
 */
async function insertFeatures(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<void> {
  const entries = Object.entries(snapshot.features);
  if (entries.length === 0) return;

  const keys = entries.map(([k]) => k);
  const vals = entries.map(([, v]) => v);

  await client.query(
    `INSERT INTO business_features (business_id, flag_key, enabled)
     SELECT $1, input.key, input.enabled
     FROM (SELECT unnest($2::text[]) AS key, unnest($3::boolean[]) AS enabled) AS input
     WHERE EXISTS (SELECT 1 FROM feature_flags WHERE key = input.key)
     ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [snapshot.business.id, keys, vals],
  );
}

/**
 * Non-destructive re-enrollment for a desktop that still has its business
 * database but whose cloud identity was revoked or lost.  It intentionally
 * does not replay bootstrap data: local orders/outbox rows stay untouched and
 * only the machine identity + sync configuration are rebound.
 */
export async function repairPairingSnapshot(
  snapshot: PairingSnapshot,
  remoteUrl: string,
  pairing: { pairingSessionId?: string; installationId?: string } = {},
): Promise<{ businessId: string; locationId: string }> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ id: string }>(
        `SELECT b.id FROM businesses b JOIN locations l ON l.business_id=b.id
          WHERE b.id=$1 AND l.id=$2 FOR UPDATE`,
        [snapshot.business.id, snapshot.location.id],
      );
      if (!existing.rows[0]) throw new Error("repair_business_or_location_mismatch");
      await client.query(
        `INSERT INTO site_devices (id, business_id, location_id, public_id, display_name)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, status='active', revoked_at=NULL`,
        [
          snapshot.siteDevice.id,
          snapshot.business.id,
          snapshot.location.id,
          snapshot.siteDevice.publicId,
          snapshot.siteDevice.displayName,
        ],
      );
      await client.query(
        `INSERT INTO site_sync_credentials (site_device_id,business_id,token_hash,state)
         VALUES ($1,$2,$3,'active')
         ON CONFLICT (token_hash) DO UPDATE SET revoked_at=NULL, state='active', rotated_at=now()`,
        [snapshot.siteDevice.id, snapshot.business.id, createHash("sha256").update(snapshot.syncToken).digest("hex")],
      );
      await client.query(
        `INSERT INTO settings (business_id, location_id, key, value)
         VALUES ($1,NULL,$2,$3::jsonb)
         ON CONFLICT (business_id, location_id, key) DO UPDATE SET value=EXCLUDED.value`,
        [
          snapshot.business.id,
          SETTING_KEYS.serverSyncConfig,
          JSON.stringify({
            remoteUrl,
            token: snapshot.syncToken,
            enabled: true,
            pairingPending: true,
            batchSize: 100,
            siteDeviceId: snapshot.siteDevice.id,
            siteDevicePublicId: snapshot.siteDevice.publicId,
            locationId: snapshot.location.id,
            // Without these the sync tick's acknowledgePendingPairing skips and
            // the cloud device stays pending (every sync call answers 401).
            ...(pairing.pairingSessionId ? { pairingSessionId: pairing.pairingSessionId } : {}),
            ...(pairing.installationId ? { installationId: pairing.installationId } : {}),
          }),
        ],
      );
      await client.query("COMMIT");
      return { businessId: snapshot.business.id, locationId: snapshot.location.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}
