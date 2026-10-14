-- Keep run-scoped rollback from deleting pre-existing seed-chart rows that were
-- only linked to a Holoo remote identity. The run still owns the mapping row;
-- this flag says whether it created the local domain row as well.
ALTER TABLE integration_mappings
    ADD COLUMN local_created_by_import_run boolean NOT NULL DEFAULT false;

-- Opening inventory item identities let run-scoped rollback distinguish newly
-- created inventory masters from items that the import only linked to.
ALTER TABLE integration_mappings
    DROP CONSTRAINT IF EXISTS integration_mappings_entity_type_check;
ALTER TABLE integration_mappings
    ADD CONSTRAINT integration_mappings_entity_type_check
        CHECK (entity_type IN (
            'product', 'customer', 'order', 'refund', 'category',
            'holoo_goods', 'holoo_customer', 'holoo_account', 'holoo_invoice',
            'holoo_purchase', 'holoo_receipt', 'holoo_stock', 'holoo_inventory_item',
            'holoo_journal', 'holoo_document'
        ));

-- Historical Holoo runs created these domain rows. Account mappings are
-- intentionally left false: older releases did not distinguish imported
-- accounts from links to pre-existing seed accounts, so deletion cannot be
-- proven safe.
UPDATE integration_mappings
   SET local_created_by_import_run = true
 WHERE import_run_id IS NOT NULL
   AND entity_type IN (
       'holoo_goods', 'holoo_customer', 'holoo_invoice', 'holoo_purchase',
       'holoo_receipt', 'holoo_stock', 'holoo_journal'
   );
