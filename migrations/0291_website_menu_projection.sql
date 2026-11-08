-- ESH-145 / biza-miz#1303: project the Accounting menu onto existing CMS
-- products. This extends the Phase 38 connection/map/outbox; it does not create
-- another connection store or product collection.
--
-- Existing single-site rows are backfilled onto their current connection.
-- New writes always name a connection. NULL is retained only for historical
-- rows whose connection was already removed; those rows are never broadcast
-- to a newly connected site.

ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS description text;

-- A business may now mirror its menu to more than one existing CMS connection.
-- The site id is scoped by its control-plane origin as well as the business.
ALTER TABLE eshobe_cms_connections
    DROP CONSTRAINT IF EXISTS eshobe_cms_connections_business_id_key;
ALTER TABLE eshobe_cms_connections
    ADD CONSTRAINT uq_eshobe_cms_connection_site UNIQUE (business_id, base_url, site_id),
    ADD CONSTRAINT uq_eshobe_cms_connection_tenant UNIQUE (id, business_id);

ALTER TABLE website_product_map
    ADD COLUMN IF NOT EXISTS connection_id uuid,
    ADD COLUMN IF NOT EXISTS last_pushed_content_hash text,
    ADD COLUMN IF NOT EXISTS last_pushed_published boolean,
    ADD COLUMN IF NOT EXISTS last_pushed_available boolean;

UPDATE website_product_map m
   SET connection_id = c.id
  FROM eshobe_cms_connections c
 WHERE m.business_id = c.business_id AND m.connection_id IS NULL;

ALTER TABLE website_product_map
    ADD CONSTRAINT fk_website_product_map_connection_tenant
        FOREIGN KEY (connection_id, business_id)
        REFERENCES eshobe_cms_connections (id, business_id) ON DELETE CASCADE;
ALTER TABLE website_product_map
    DROP CONSTRAINT IF EXISTS website_product_map_business_id_local_kind_local_id_key;
ALTER TABLE website_product_map
    ADD CONSTRAINT uq_website_product_map_connection_product
        UNIQUE NULLS NOT DISTINCT (business_id, connection_id, local_kind, local_id);
CREATE INDEX IF NOT EXISTS idx_website_product_map_connection
    ON website_product_map (business_id, connection_id);

ALTER TABLE website_outbox
    ADD COLUMN IF NOT EXISTS connection_id uuid,
    ADD COLUMN IF NOT EXISTS desired_at timestamptz NOT NULL DEFAULT now();

UPDATE website_outbox o
   SET connection_id = c.id
  FROM eshobe_cms_connections c
 WHERE o.business_id = c.business_id AND o.connection_id IS NULL;

ALTER TABLE website_outbox
    ADD CONSTRAINT fk_website_outbox_connection_tenant
        FOREIGN KEY (connection_id, business_id)
        REFERENCES eshobe_cms_connections (id, business_id) ON DELETE CASCADE;
ALTER TABLE website_outbox
    DROP CONSTRAINT IF EXISTS website_outbox_business_id_kind_local_kind_local_id_key;
ALTER TABLE website_outbox
    ADD CONSTRAINT uq_website_outbox_connection_event
        UNIQUE NULLS NOT DISTINCT (business_id, connection_id, kind, local_kind, local_id);
CREATE INDEX IF NOT EXISTS idx_website_outbox_connection_due
    ON website_outbox (business_id, connection_id, next_attempt_at)
    WHERE status IN ('pending', 'failed');

-- Auxiliary remote identities only: the product identity remains in
-- website_product_map. Media hashes prevent unchanged bytes being uploaded on
-- every retry; embedded modifier row ids are retained across product patches.
CREATE TABLE website_menu_object_map (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id   uuid NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('taxonomy', 'category', 'modifier_group', 'modifier', 'media')),
    source_key      text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 300),
    remote_id       text NOT NULL CHECK (char_length(remote_id) BETWEEN 1 AND 200),
    content_hash    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_website_menu_object_map_connection_tenant
        FOREIGN KEY (connection_id, business_id)
        REFERENCES eshobe_cms_connections (id, business_id) ON DELETE CASCADE,
    CONSTRAINT uq_website_menu_object_map_source UNIQUE (business_id, connection_id, kind, source_key)
);
CREATE INDEX idx_website_menu_object_map_connection
    ON website_menu_object_map (business_id, connection_id, kind);
ALTER TABLE website_menu_object_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_menu_object_map FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON website_menu_object_map FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- Wake the existing outbox when an Accounting-owned value changes. The trigger
-- stores routing only; every remote value is still read at send time. Failed
-- and dead rows keep their retry schedule (a dead row needs the owner's retry).
CREATE FUNCTION app_queue_website_menu_change() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $$
DECLARE
    v_new jsonb;
    v_old jsonb;
    v_location uuid;
    v_business uuid;
    v_items uuid[];
    v_kind text;
BEGIN
    -- One trigger function serves several row shapes. JSONB extraction avoids
    -- PL/pgSQL binding a field (e.g. (v_new->>'quantity')::numeric) that does not exist on the
    -- table firing this invocation.
    v_new := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
    v_old := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
    IF TG_TABLE_NAME = 'menu_items' THEN
        v_location := COALESCE((v_new->>'location_id')::uuid, (v_old->>'location_id')::uuid);
        v_items := ARRAY[COALESCE((v_new->>'id')::uuid, (v_old->>'id')::uuid)];
        v_kind := 'product.upsert';
        IF TG_OP = 'UPDATE'
           AND (v_new->>'price')::numeric IS DISTINCT FROM (v_old->>'price')::numeric
           AND (v_new->>'category_id')::uuid IS NOT DISTINCT FROM (v_old->>'category_id')::uuid
           AND (v_new->>'name')::text IS NOT DISTINCT FROM (v_old->>'name')::text
           AND (v_new->>'description')::text IS NOT DISTINCT FROM (v_old->>'description')::text
           AND (v_new->>'sku')::text IS NOT DISTINCT FROM (v_old->>'sku')::text
           AND (v_new->>'image_url')::text IS NOT DISTINCT FROM (v_old->>'image_url')::text
           AND (v_new->>'image_media_id')::uuid IS NOT DISTINCT FROM (v_old->>'image_media_id')::uuid
           AND (v_new->>'is_active')::boolean IS NOT DISTINCT FROM (v_old->>'is_active')::boolean
           AND (v_new->>'sort_order')::integer IS NOT DISTINCT FROM (v_old->>'sort_order')::integer THEN
            v_kind := 'price.set';
        END IF;
    ELSIF TG_TABLE_NAME = 'menu_categories' THEN
        v_location := COALESCE((v_new->>'location_id')::uuid, (v_old->>'location_id')::uuid);
        SELECT array_agg(id) INTO v_items FROM public.menu_items
         WHERE category_id = COALESCE((v_new->>'id')::uuid, (v_old->>'id')::uuid);
        v_kind := 'product.upsert';
    ELSIF TG_TABLE_NAME = 'modifier_groups' THEN
        v_location := COALESCE((v_new->>'location_id')::uuid, (v_old->>'location_id')::uuid);
        SELECT array_agg(menu_item_id) INTO v_items FROM public.menu_item_modifier_groups
         WHERE modifier_group_id = COALESCE((v_new->>'id')::uuid, (v_old->>'id')::uuid);
        v_kind := 'product.upsert';
    ELSIF TG_TABLE_NAME = 'modifiers' THEN
        v_location := COALESCE((v_new->>'location_id')::uuid, (v_old->>'location_id')::uuid);
        SELECT array_agg(l.menu_item_id) INTO v_items
          FROM public.menu_item_modifier_groups l
         WHERE l.modifier_group_id = COALESCE((v_new->>'group_id')::uuid, (v_old->>'group_id')::uuid);
        v_kind := 'product.upsert';
    ELSIF TG_TABLE_NAME = 'menu_item_modifier_groups' THEN
        SELECT location_id INTO v_location FROM public.menu_items
         WHERE id = COALESCE((v_new->>'menu_item_id')::uuid, (v_old->>'menu_item_id')::uuid);
        v_items := ARRAY[COALESCE((v_new->>'menu_item_id')::uuid, (v_old->>'menu_item_id')::uuid)];
        v_kind := 'product.upsert';
    ELSIF TG_TABLE_NAME = 'stock_movements' THEN
        v_location := COALESCE((v_new->>'location_id')::uuid, (v_old->>'location_id')::uuid);
        SELECT array_agg(menu_item_id) INTO v_items FROM public.menu_item_ingredients
         WHERE inventory_item_id = COALESCE((v_new->>'inventory_item_id')::uuid, (v_old->>'inventory_item_id')::uuid);
        v_kind := 'stock.set';
    ELSIF TG_TABLE_NAME = 'item_stock' THEN
        SELECT location_id INTO v_location FROM public.items
         WHERE id = COALESCE((v_new->>'item_id')::uuid, (v_old->>'item_id')::uuid);
        v_items := ARRAY[COALESCE((v_new->>'item_id')::uuid, (v_old->>'item_id')::uuid)];
        v_kind := 'product.upsert';
    ELSE
        RETURN NULL;
    END IF;

    IF v_items IS NULL OR v_location IS NULL THEN RETURN NULL; END IF;
    SELECT business_id INTO v_business FROM public.locations WHERE id = v_location;
    IF v_business IS NULL THEN RETURN NULL; END IF;

    -- The first kind is collected separately for retail stock/price changes.
    IF TG_TABLE_NAME = 'item_stock' AND TG_OP = 'UPDATE' THEN
        IF (v_new->>'quantity')::numeric IS DISTINCT FROM (v_old->>'quantity')::numeric THEN v_kind := 'stock.set';
        ELSIF (v_new->>'unit_price')::numeric IS DISTINCT FROM (v_old->>'unit_price')::numeric THEN v_kind := 'price.set';
        ELSE RETURN NULL; END IF;
    END IF;

    INSERT INTO public.website_outbox
        (business_id, connection_id, kind, local_kind, local_id, payload)
    SELECT v_business, c.id,
           v_kind,
           m.local_kind, m.local_id,
           jsonb_build_object('localKind', m.local_kind, 'localId', m.local_id)
      FROM public.website_product_map m
      JOIN public.eshobe_cms_connections c
        ON c.id = m.connection_id AND c.business_id = m.business_id
     WHERE m.business_id = v_business AND m.local_id = ANY(v_items)
       AND (v_kind = 'product.upsert' OR m.remote_id IS NOT NULL)
       AND c.status = 'active'
       AND COALESCE(c.sync_location_id, (
           SELECT l.id FROM public.locations l
            WHERE l.business_id = v_business AND l.is_active
            ORDER BY l.created_at, l.id LIMIT 1
       )) = v_location
       AND (CASE WHEN m.local_kind = 'menu_item' THEN v_kind <> 'stock.set' OR c.push_stock
                 ELSE v_kind <> 'stock.set' OR c.push_stock END)
       AND (CASE WHEN m.local_kind = 'menu_item' THEN v_kind <> 'price.set' OR c.push_prices
                 ELSE v_kind <> 'price.set' OR c.push_prices END)
    ON CONFLICT (business_id, connection_id, kind, local_kind, local_id)
    DO UPDATE SET
        status = CASE WHEN website_outbox.status = 'sent' THEN 'pending' ELSE website_outbox.status END,
        attempts = CASE WHEN website_outbox.status = 'sent' THEN 0 ELSE website_outbox.attempts END,
        next_attempt_at = CASE WHEN website_outbox.status = 'sent' THEN now() ELSE website_outbox.next_attempt_at END,
        error = CASE WHEN website_outbox.status = 'sent' THEN NULL ELSE website_outbox.error END,
        desired_at = now(),
        updated_at = CASE WHEN website_outbox.status = 'sent' THEN now() ELSE website_outbox.updated_at END;

    -- A retail row can owe price and stock independently in the same UPDATE.
    IF TG_TABLE_NAME = 'item_stock' AND TG_OP = 'UPDATE'
       AND (v_new->>'quantity')::numeric IS DISTINCT FROM (v_old->>'quantity')::numeric
       AND (v_new->>'unit_price')::numeric IS DISTINCT FROM (v_old->>'unit_price')::numeric THEN
        INSERT INTO public.website_outbox
            (business_id, connection_id, kind, local_kind, local_id, payload)
        SELECT v_business, c.id, 'price.set', 'item', m.local_id,
               jsonb_build_object('localKind', 'item', 'localId', m.local_id)
          FROM public.website_product_map m
          JOIN public.eshobe_cms_connections c ON c.id = m.connection_id
         WHERE m.business_id = v_business AND m.local_kind = 'item' AND m.local_id = ANY(v_items)
           AND m.remote_id IS NOT NULL
           AND c.business_id = v_business AND c.status = 'active' AND c.push_prices
        ON CONFLICT (business_id, connection_id, kind, local_kind, local_id)
        DO UPDATE SET
            status = CASE WHEN website_outbox.status = 'sent' THEN 'pending' ELSE website_outbox.status END,
            attempts = CASE WHEN website_outbox.status = 'sent' THEN 0 ELSE website_outbox.attempts END,
            next_attempt_at = CASE WHEN website_outbox.status = 'sent' THEN now() ELSE website_outbox.next_attempt_at END,
            error = CASE WHEN website_outbox.status = 'sent' THEN NULL ELSE website_outbox.error END,
            desired_at = now(),
        updated_at = CASE WHEN website_outbox.status = 'sent' THEN now() ELSE website_outbox.updated_at END;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_website_menu_items AFTER INSERT OR UPDATE OR DELETE ON menu_items
    FOR EACH ROW EXECUTE FUNCTION app_queue_website_menu_change();
CREATE TRIGGER trg_website_menu_categories AFTER INSERT OR UPDATE OR DELETE ON menu_categories
    FOR EACH ROW EXECUTE FUNCTION app_queue_website_menu_change();
CREATE TRIGGER trg_website_modifier_groups AFTER INSERT OR UPDATE OR DELETE ON modifier_groups
    FOR EACH ROW EXECUTE FUNCTION app_queue_website_menu_change();
CREATE TRIGGER trg_website_modifiers AFTER INSERT OR UPDATE OR DELETE ON modifiers
    FOR EACH ROW EXECUTE FUNCTION app_queue_website_menu_change();
CREATE TRIGGER trg_website_item_modifier_groups AFTER INSERT OR UPDATE OR DELETE ON menu_item_modifier_groups
    FOR EACH ROW EXECUTE FUNCTION app_queue_website_menu_change();
CREATE TRIGGER trg_website_recipe_stock AFTER INSERT OR UPDATE OR DELETE ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION app_queue_website_menu_change();
CREATE TRIGGER trg_website_retail_stock AFTER INSERT OR UPDATE OR DELETE ON item_stock
    FOR EACH ROW EXECUTE FUNCTION app_queue_website_menu_change();
