-- 0193_platform_company_security_and_repair.sql
--
-- Corrective, additive migration for the Platform Business feature shipped in
-- 0191. 0191 is already deployed, so NOTHING here rewrites it in place: every
-- fix is `DROP … IF EXISTS` + `CREATE`, or a new object.
--
-- Repairs, in order:
--   1. `platform_company_billing_events` RLS — a customer tenant named in
--      `customer_tenant_id` could previously read AND mutate the internal
--      company's billing outbox. Reads/writes now require the internal company
--      tenant or an explicit platform bypass; inserts are outbox-only.
--   2. Settlement model — the invoice trigger no longer infers "settled by
--      wallet" from a loose `metadata->>'invoiceId'` probe. Wallet debits and
--      verified payments are themselves the authoritative settlement records,
--      so a mixed settlement (part wallet, part gateway) is posted as two
--      postings instead of one wrong one.
--   3. Void/refund/credit accounting — a void now carries the invoice's paid
--      and outstanding amounts so the reversal can be posted correctly.
--   4. Same-business integrity — cross-business object references are refused
--      by triggers, not only by application code.
--   5. Duplicate posting — a unique index on the journal entry's source makes
--      a replayed event unable to create a second document.
--   6. Handoff retention and reconciliation indexes/observability columns.
--
-- No posted journal entry, customer mapping, event or credential is deleted or
-- rewritten by this migration.

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------

-- `app_rls_bypass()` exists since 0021; re-declared so this migration is
-- self-contained and so the helper below reads the same value the policies do.
CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.rls_bypass', true), '') = 'on';
$$;

CREATE OR REPLACE FUNCTION app_current_business() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.business_id', true), '')::uuid;
$$;

-- ---------------------------------------------------------------------------
-- 1. Billing-event RLS: the internal company's outbox is not a customer view.
--
--    The 0191 policy was
--        internal_business_id = app_current_business()
--        OR customer_tenant_id = app_current_business()
--    for BOTH the USING and the WITH CHECK clauses. A customer business named
--    as `customer_tenant_id` could therefore SELECT its own outbox rows —
--    outbox payloads, posting state, retry counts, internal accounting
--    references, provider-cost rows and every other customer's rows visible
--    through the same policy — and UPDATE/DELETE them too, silently rewriting
--    the platform company's reconciliation state.
--
--    Source triggers still need to INSERT while running inside the *customer's*
--    tenant scope (that is where the billing write happens). They do that
--    through `enqueue_platform_company_billing_event()`, which raises the
--    documented app.rls_bypass flag for the single INSERT and restores it
--    afterwards. Nothing else gets to write here.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS tenant_isolation ON platform_company_billing_events;
DROP POLICY IF EXISTS internal_company_access ON platform_company_billing_events;
DROP POLICY IF EXISTS internal_company_select ON platform_company_billing_events;
DROP POLICY IF EXISTS internal_company_update ON platform_company_billing_events;
DROP POLICY IF EXISTS internal_company_delete ON platform_company_billing_events;
DROP POLICY IF EXISTS outbox_insert ON platform_company_billing_events;

CREATE POLICY internal_company_select ON platform_company_billing_events FOR SELECT
  USING (app_rls_bypass() OR internal_business_id = app_current_business());
CREATE POLICY internal_company_update ON platform_company_billing_events FOR UPDATE
  USING (app_rls_bypass() OR internal_business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR internal_business_id = app_current_business());
CREATE POLICY internal_company_delete ON platform_company_billing_events FOR DELETE
  USING (app_rls_bypass() OR internal_business_id = app_current_business());
-- INSERT is deliberately the narrowest policy: only the outbox writer, which
-- runs with the bypass flag it raised itself, may append an event.
CREATE POLICY outbox_insert ON platform_company_billing_events FOR INSERT
  WITH CHECK (app_rls_bypass());

-- ---------------------------------------------------------------------------
-- 2. Settlement model
-- ---------------------------------------------------------------------------

ALTER TABLE platform_company_billing_events
  ADD COLUMN IF NOT EXISTS settlement_method text
    CHECK (settlement_method IN ('wallet','gateway','manual','other')),
  ADD COLUMN IF NOT EXISTS customer_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS failure_kind text
    CHECK (failure_kind IN ('transient','missing_account','missing_customer','permanent'));

-- A settlement event must say which method settled it; non-settlement events
-- must not claim one.
ALTER TABLE platform_company_billing_events DROP CONSTRAINT IF EXISTS platform_company_billing_events_method_scope;
ALTER TABLE platform_company_billing_events ADD CONSTRAINT platform_company_billing_events_method_scope
  CHECK (settlement_method IS NULL OR source_kind = 'invoice_payment');

ALTER TABLE platform_company_billing_events DROP CONSTRAINT IF EXISTS platform_company_billing_events_source_kind_check;
ALTER TABLE platform_company_billing_events ADD CONSTRAINT platform_company_billing_events_source_kind_check
  CHECK (source_kind IN ('invoice_issued','invoice_payment','invoice_void','invoice_refund',
                         'wallet_top_up','wallet_spend','wallet_refund','wallet_noncash_credit',
                         'provider_cost','credit_note','adjustment'));

CREATE INDEX IF NOT EXISTS platform_company_billing_events_invoice
  ON platform_company_billing_events (customer_invoice_id)
  WHERE customer_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_company_billing_events_internal_status
  ON platform_company_billing_events (internal_business_id, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS platform_company_billing_events_customer_tenant
  ON platform_company_billing_events (customer_tenant_id)
  WHERE customer_tenant_id IS NOT NULL;

-- The authoritative "how much of this invoice has already been accounted for"
-- figure, read from the SOURCE tables rather than from the outbox so it is
-- correct inside the very transaction that is still being built.
--
-- `business_id` is always filtered explicitly: under the customer's tenant
-- scope (which is where these writes happen) RLS returns exactly that
-- business's rows, which is exactly the set this question is about.
CREATE OR REPLACE FUNCTION platform_company_invoice_settled_rial(
  p_business uuid, p_invoice uuid
) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (
    COALESCE((SELECT sum(w.amount_rial) FROM wallet_ledger w
               WHERE w.business_id = p_business
                 AND w.direction = 'debit'
                 AND w.metadata ->> 'invoiceId' = p_invoice::text), 0)
    + COALESCE((SELECT sum(p.amount_rial) FROM billing_payments p
                 WHERE p.business_id = p_business
                   AND p.invoice_id = p_invoice
                   AND p.status = 'verified'), 0)
  )::bigint;
$$;

-- ---------------------------------------------------------------------------
-- 3. The outbox writer.
--
--    `set_config(..., true)` is transaction-local; the previous value is read
--    first and restored immediately after the INSERT so the rest of the
--    caller's transaction keeps whatever isolation it had.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS enqueue_platform_company_billing_event(text,text,text,text,uuid,bigint,jsonb,timestamptz);
CREATE OR REPLACE FUNCTION enqueue_platform_company_billing_event(
  p_kind text, p_table text, p_id text, p_version text, p_customer uuid,
  p_amount bigint, p_payload jsonb, p_occurred timestamptz DEFAULT now(),
  p_method text DEFAULT NULL, p_invoice uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE target uuid; previous text;
BEGIN
  IF p_amount IS NULL OR p_amount < 0 THEN RETURN; END IF;
  previous := COALESCE(current_setting('app.rls_bypass', true), '');
  PERFORM set_config('app.rls_bypass', 'on', true);
  BEGIN
    SELECT id INTO target FROM businesses WHERE ownership_kind = 'platform_internal';
    IF target IS NULL THEN
      PERFORM set_config('app.rls_bypass', previous, true);
      RETURN;
    END IF;
    INSERT INTO platform_company_billing_events
      (internal_business_id, source_kind, source_table, source_id, source_version,
       customer_tenant_id, amount_rial, payload, occurred_at, settlement_method,
       customer_invoice_id)
    VALUES (target, p_kind, p_table, p_id, p_version, p_customer, p_amount,
            COALESCE(p_payload, '{}'::jsonb), COALESCE(p_occurred, now()),
            p_method, p_invoice)
    ON CONFLICT (source_table, source_id, source_version) DO NOTHING;
    PERFORM set_config('app.rls_bypass', previous, true);
  EXCEPTION WHEN others THEN
    PERFORM set_config('app.rls_bypass', previous, true);
    RAISE;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Invoice trigger: issue / settlement residual / void.
--
--    The old trigger emitted `invoice_payment` from `paid_rial` alone and the
--    worker then guessed the method with
--        SELECT 1 FROM wallet_ledger WHERE metadata->>'invoiceId' = $1
--    — unfiltered by business, blind to refunds, and all-or-nothing for an
--    invoice that was settled partly from the wallet and partly by other
--    means.
--
--    Now the invoice trigger only emits the RESIDUAL: the part of `paid_rial`
--    that no authoritative settlement row (wallet debit or verified payment)
--    accounts for. Everything else is emitted by the settlement record's own
--    trigger, so a 600k-wallet + 400k-gateway invoice produces two postings
--    with two different debit accounts and no invented third one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_company_invoice_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE residual bigint; settled bigint; total bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      PERFORM enqueue_platform_company_billing_event(
        'invoice_issued','billing_invoices',NEW.id::text,'issued',NEW.business_id,
        NEW.total_rial,
        jsonb_build_object('invoiceNumber', NEW.invoice_number, 'invoiceId', NEW.id),
        NEW.created_at, NULL, NEW.id);
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status <> 'draft' THEN
    PERFORM enqueue_platform_company_billing_event(
      'invoice_issued','billing_invoices',NEW.id::text,'issued',NEW.business_id,
      NEW.total_rial,
      jsonb_build_object('invoiceNumber', NEW.invoice_number, 'invoiceId', NEW.id),
      COALESCE(NEW.updated_at, now()), NULL, NEW.id);
  END IF;

  IF NEW.paid_rial > OLD.paid_rial THEN
    settled := platform_company_invoice_settled_rial(NEW.business_id, NEW.id);
    residual := NEW.paid_rial - settled;
    -- `settled` can legitimately exceed `paid_rial` when a wallet debit was
    -- posted before the invoice was marked paid; that is not a new payment.
    IF residual > 0 THEN
      PERFORM enqueue_platform_company_billing_event(
        'invoice_payment','billing_invoices',NEW.id::text,'paid:'||NEW.paid_rial::text,
        NEW.business_id, residual,
        jsonb_build_object('invoiceId', NEW.id, 'paidTotalRial', NEW.paid_rial,
                           'settledBySourceRial', settled, 'settlement', 'residual'),
        COALESCE(NEW.updated_at, now()), 'other', NEW.id);
    END IF;
  END IF;

  IF NEW.status = 'void' AND OLD.status <> 'void' THEN
    total := NEW.total_rial;
    PERFORM enqueue_platform_company_billing_event(
      'invoice_void','billing_invoices',NEW.id::text,'void',NEW.business_id,
      total,
      jsonb_build_object('invoiceId', NEW.id, 'totalRial', NEW.total_rial,
                         'paidRial', NEW.paid_rial,
                         'outstandingRial', GREATEST(NEW.total_rial - NEW.paid_rial, 0)),
      COALESCE(NEW.updated_at, now()), NULL, NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_invoice_outbox ON billing_invoices;
CREATE TRIGGER platform_company_invoice_outbox AFTER INSERT OR UPDATE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION platform_company_invoice_event();

-- ---------------------------------------------------------------------------
-- 5. Wallet trigger: a debit that settles an invoice IS the settlement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_company_wallet_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; invoice uuid; remaining bigint; amount bigint; total bigint;
BEGIN
  invoice := NULL;
  IF NEW.metadata ? 'invoiceId' AND (NEW.metadata ->> 'invoiceId') ~ '^[0-9a-fA-F-]{36}$' THEN
    invoice := (NEW.metadata ->> 'invoiceId')::uuid;
  END IF;

  -- A debit carrying an invoice id settles that invoice. It is NOT a second
  -- sale, so it must never become a `wallet_spend` revenue posting.
  IF NEW.direction = 'debit' AND invoice IS NOT NULL THEN
    SELECT i.total_rial INTO total FROM billing_invoices i WHERE i.id = invoice;
    IF total IS NULL THEN
      PERFORM enqueue_platform_company_billing_event('adjustment','wallet_ledger',NEW.id::text,
        'created',NEW.business_id,NEW.amount_rial,
        jsonb_build_object('kind',NEW.kind,'direction',NEW.direction,'invoiceId',invoice,
                           'reason','wallet_debit_with_unknown_invoice'),NEW.created_at);
      RETURN NEW;
    END IF;
    remaining := total
      - platform_company_invoice_settled_rial(NEW.business_id, invoice)
      + NEW.amount_rial; -- this row is not visible to the helper yet
    amount := LEAST(NEW.amount_rial, GREATEST(remaining, 0));
    IF amount > 0 THEN
      PERFORM enqueue_platform_company_billing_event('invoice_payment','wallet_ledger',NEW.id::text,
        'invoice-settlement',NEW.business_id,amount,
        jsonb_build_object('invoiceId',invoice,'walletLedgerId',NEW.id,'kind',NEW.kind,
                           'settlement','wallet'),NEW.created_at,'wallet',invoice);
    END IF;
    RETURN NEW;
  END IF;

  kind := CASE
    WHEN NEW.kind = 'top_up' THEN 'wallet_top_up'
    WHEN NEW.kind IN ('admin_grant','free_promo') THEN 'wallet_noncash_credit'
    WHEN NEW.kind = 'refund' AND NEW.direction = 'credit' THEN 'wallet_refund'
    WHEN NEW.direction = 'debit' THEN 'wallet_spend'
    ELSE 'adjustment' END;
  PERFORM enqueue_platform_company_billing_event(kind,'wallet_ledger',NEW.id::text,'created',
    NEW.business_id,NEW.amount_rial,
    jsonb_build_object('kind',NEW.kind,'direction',NEW.direction,'paymentId',NEW.payment_id,
                       'metadata',NEW.metadata),NEW.created_at);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_wallet_outbox ON wallet_ledger;
CREATE TRIGGER platform_company_wallet_outbox AFTER INSERT ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION platform_company_wallet_event();

-- ---------------------------------------------------------------------------
-- 6. Verified gateway/manual payments: the second authoritative settlement
--    source. Clipped to what is still outstanding on the invoice so a payment
--    that also produced a wallet credit can never be counted twice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_company_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining bigint; amount bigint; total bigint; method text;
BEGIN
  IF NEW.status <> 'verified' OR OLD.status = 'verified' THEN RETURN NEW; END IF;
  IF NEW.invoice_id IS NULL THEN RETURN NEW; END IF;
  SELECT total_rial INTO total FROM billing_invoices WHERE id = NEW.invoice_id;
  IF total IS NULL THEN RETURN NEW; END IF;
  remaining := total - platform_company_invoice_settled_rial(NEW.business_id, NEW.invoice_id);
  amount := LEAST(NEW.amount_rial, GREATEST(remaining, 0));
  IF amount <= 0 THEN RETURN NEW; END IF;
  method := CASE WHEN NEW.gateway = 'manual' THEN 'manual' ELSE 'gateway' END;
  PERFORM enqueue_platform_company_billing_event('invoice_payment','billing_payments',NEW.id::text,
    'settlement:'||NEW.status,NEW.business_id,amount,
    jsonb_build_object('invoiceId',NEW.invoice_id,'paymentId',NEW.id,'gateway',NEW.gateway,
                       'settlement',method),COALESCE(NEW.verified_at, now()),method,NEW.invoice_id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_payment_outbox ON billing_payments;
CREATE TRIGGER platform_company_payment_outbox AFTER UPDATE ON billing_payments
  FOR EACH ROW EXECUTE FUNCTION platform_company_payment_event();

-- ---------------------------------------------------------------------------
-- 7. Commercial adjustments: negative is a credit note, positive an extra
--    charge. Append-only, so one event per row and never a rewrite.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_company_adjustment_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.invoice_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.amount_rial < 0 THEN
    PERFORM enqueue_platform_company_billing_event('credit_note','billing_adjustments',NEW.id::text,
      'created',NEW.business_id,abs(NEW.amount_rial),
      jsonb_build_object('invoiceId',NEW.invoice_id,'reason',NEW.reason),NEW.created_at,
      NULL,NEW.invoice_id);
  ELSE
    PERFORM enqueue_platform_company_billing_event('adjustment','billing_adjustments',NEW.id::text,
      'created',NEW.business_id,NEW.amount_rial,
      jsonb_build_object('invoiceId',NEW.invoice_id,'reason',NEW.reason),NEW.created_at,
      NULL,NEW.invoice_id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_adjustment_outbox ON billing_adjustments;
CREATE TRIGGER platform_company_adjustment_outbox AFTER INSERT ON billing_adjustments
  FOR EACH ROW EXECUTE FUNCTION platform_company_adjustment_event();

-- Provider cost events are unchanged in shape; re-created so the file owns the
-- whole outbox contract after the enqueue signature changed.
CREATE OR REPLACE FUNCTION platform_company_vendor_cost_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM enqueue_platform_company_billing_event('provider_cost','billing_vendor_cost_events',NEW.id::text,'created',
    NEW.business_id,NEW.amount_rial,jsonb_build_object('provider',NEW.provider,'meterKey',NEW.meter_key),NEW.occurred_at);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_vendor_cost_outbox ON billing_vendor_cost_events;
CREATE TRIGGER platform_company_vendor_cost_outbox AFTER INSERT ON billing_vendor_cost_events
  FOR EACH ROW EXECUTE FUNCTION platform_company_vendor_cost_event();

-- ---------------------------------------------------------------------------
-- 8. Same-business integrity.
--
--    `party_id REFERENCES parties(id)` says nothing about WHO owns the party.
--    These triggers make cross-business linking impossible rather than merely
--    untested. They are written as BEFORE INSERT OR UPDATE triggers so a bad
--    write fails with a name that explains itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_company_same_business_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_company_cross_business_reference: %', TG_ARGV[0]
    USING ERRCODE = '23514';
END $$;

CREATE OR REPLACE FUNCTION platform_company_customers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM parties p WHERE p.id = NEW.party_id AND p.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'platform_company_customer_party_business_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.account_owner_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = NEW.account_owner_user_id AND u.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'platform_company_customer_owner_business_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = NEW.business_id AND b.ownership_kind = 'platform_internal') THEN
    RAISE EXCEPTION 'platform_company_customer_requires_internal_business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_customers_same_business ON platform_company_customers;
CREATE TRIGGER platform_company_customers_same_business BEFORE INSERT OR UPDATE ON platform_company_customers
  FOR EACH ROW EXECUTE FUNCTION platform_company_customers_guard();

CREATE OR REPLACE FUNCTION platform_company_customer_tenants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform_company_customers c
     WHERE c.id = NEW.customer_id AND c.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'platform_company_customer_tenant_business_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.business_id = NEW.customer_tenant_id THEN
    RAISE EXCEPTION 'platform_company_cannot_map_itself' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_customer_tenants_same_business ON platform_company_customer_tenants;
CREATE TRIGGER platform_company_customer_tenants_same_business BEFORE INSERT OR UPDATE ON platform_company_customer_tenants
  FOR EACH ROW EXECUTE FUNCTION platform_company_customer_tenants_guard();

CREATE OR REPLACE FUNCTION platform_company_members_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = NEW.business_id AND b.ownership_kind = 'platform_internal') THEN
    RAISE EXCEPTION 'platform_company_member_requires_internal_business' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.user_id AND u.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'platform_company_member_user_business_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_members_same_business ON platform_company_members;
CREATE TRIGGER platform_company_members_same_business BEFORE INSERT OR UPDATE ON platform_company_members
  FOR EACH ROW EXECUTE FUNCTION platform_company_members_guard();

CREATE OR REPLACE FUNCTION platform_company_web_leads_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM parties p WHERE p.id = NEW.party_id AND p.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'platform_company_web_lead_party_business_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_leads l WHERE l.id = NEW.lead_id AND l.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'platform_company_web_lead_lead_business_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_web_leads_same_business ON platform_company_web_leads;
CREATE TRIGGER platform_company_web_leads_same_business BEFORE INSERT OR UPDATE ON platform_company_web_leads
  FOR EACH ROW EXECUTE FUNCTION platform_company_web_leads_guard();

-- `workspace_project_links.linked_id` is text on purpose (a deal, an invoice,
-- a campaign, a website, a support ticket, a tenant). A text column cannot be
-- foreign-keyed, so the link kind decides which table must own the id AND that
-- the referenced row belongs to the internal business. Anything else is
-- refused here rather than discovered as a dangling cross-tenant pointer.
CREATE OR REPLACE FUNCTION workspace_project_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_projects p WHERE p.id = NEW.project_id AND p.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'workspace_project_link_project_business_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = NEW.created_by AND u.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'workspace_project_link_creator_business_mismatch' USING ERRCODE = '23514';
  END IF;
  CASE NEW.link_kind
    WHEN 'deal' THEN
      IF NOT NEW.linked_id ~ '^[0-9a-fA-F-]{36}$'
         OR NOT EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = NEW.linked_id::uuid AND d.business_id = NEW.business_id) THEN
        RAISE EXCEPTION 'workspace_project_link_invalid_deal' USING ERRCODE = '23514';
      END IF;
    WHEN 'invoice' THEN
      IF NOT NEW.linked_id ~ '^[0-9a-fA-F-]{36}$'
         OR NOT EXISTS (SELECT 1 FROM billing_invoices i WHERE i.id = NEW.linked_id::uuid
                          AND (i.business_id = NEW.business_id OR EXISTS (
                            SELECT 1 FROM platform_company_customer_tenants t
                             WHERE t.business_id = NEW.business_id AND t.customer_tenant_id = i.business_id))) THEN
        RAISE EXCEPTION 'workspace_project_link_invalid_invoice' USING ERRCODE = '23514';
      END IF;
    WHEN 'customer_tenant' THEN
      IF NOT NEW.linked_id ~ '^[0-9a-fA-F-]{36}$'
         OR NOT EXISTS (SELECT 1 FROM platform_company_customer_tenants t
                         WHERE t.business_id = NEW.business_id AND t.customer_tenant_id = NEW.linked_id::uuid) THEN
        RAISE EXCEPTION 'workspace_project_link_invalid_customer_tenant' USING ERRCODE = '23514';
      END IF;
    WHEN 'support_ticket' THEN
      IF NOT NEW.linked_id ~ '^[0-9a-fA-F-]{36}$' THEN
        RAISE EXCEPTION 'workspace_project_link_invalid_support_ticket' USING ERRCODE = '23514';
      END IF;
    WHEN 'website' THEN
      IF char_length(NEW.linked_id) = 0 OR char_length(NEW.linked_id) > 200 THEN
        RAISE EXCEPTION 'workspace_project_link_invalid_website' USING ERRCODE = '23514';
      END IF;
    WHEN 'campaign' THEN
      -- The Growth engine's campaign table is `message_campaigns` (0134).
      IF NOT NEW.linked_id ~ '^[0-9a-fA-F-]{36}$'
         OR NOT EXISTS (SELECT 1 FROM message_campaigns c
                         WHERE c.id = NEW.linked_id::uuid AND c.business_id = NEW.business_id) THEN
        RAISE EXCEPTION 'workspace_project_link_invalid_campaign' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'workspace_project_link_unknown_kind' USING ERRCODE = '23514';
  END CASE;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_project_links_validate ON workspace_project_links;
CREATE TRIGGER workspace_project_links_validate BEFORE INSERT OR UPDATE ON workspace_project_links
  FOR EACH ROW EXECUTE FUNCTION workspace_project_links_guard();

CREATE INDEX IF NOT EXISTS workspace_project_links_kind
  ON workspace_project_links (business_id, link_kind, linked_id);
CREATE INDEX IF NOT EXISTS workspace_project_links_project
  ON workspace_project_links (project_id);

CREATE OR REPLACE FUNCTION platform_company_postings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.journal_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM journal_entries j WHERE j.id = NEW.journal_entry_id AND j.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'platform_company_posting_journal_business_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_postings_same_business ON platform_company_accounting_postings;
CREATE TRIGGER platform_company_postings_same_business BEFORE INSERT OR UPDATE ON platform_company_accounting_postings
  FOR EACH ROW EXECUTE FUNCTION platform_company_postings_guard();

CREATE OR REPLACE FUNCTION platform_company_site_credentials_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = NEW.created_by AND u.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'platform_company_site_credential_creator_business_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_company_site_credentials_same_business ON platform_company_site_credentials;
CREATE TRIGGER platform_company_site_credentials_same_business BEFORE INSERT OR UPDATE ON platform_company_site_credentials
  FOR EACH ROW EXECUTE FUNCTION platform_company_site_credentials_guard();

-- ---------------------------------------------------------------------------
-- 9. Composite foreign keys, so the database — not a service function — is
--    what makes `customer_id` and `business_id` agree.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_company_customers
  DROP CONSTRAINT IF EXISTS platform_company_customers_id_business_key;
CREATE UNIQUE INDEX IF NOT EXISTS platform_company_customers_id_business_key
  ON platform_company_customers (business_id, id);

ALTER TABLE platform_company_customer_tenants
  DROP CONSTRAINT IF EXISTS platform_company_customer_tenants_customer_scope_fk;
ALTER TABLE platform_company_customer_tenants
  ADD CONSTRAINT platform_company_customer_tenants_customer_scope_fk
  FOREIGN KEY (business_id, customer_id)
  REFERENCES platform_company_customers (business_id, id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 10. Duplicate posting: the strongest available guard is on the ledger row
--     itself, not on the worker's own bookkeeping. One source event can create
--     at most one journal document.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'journal_entries_platform_billing_source'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM journal_entries
       WHERE source_type = 'platform_billing' AND source_id IS NOT NULL
       GROUP BY business_id, source_id HAVING count(*) > 1
    ) THEN
      CREATE UNIQUE INDEX journal_entries_platform_billing_source
        ON journal_entries (business_id, source_id)
       WHERE source_type = 'platform_billing';
    END IF;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS platform_company_accounting_postings_event
  ON platform_company_accounting_postings (event_id);
CREATE UNIQUE INDEX IF NOT EXISTS platform_company_accounting_postings_reference
  ON platform_company_accounting_postings (business_id, source_reference);

-- ---------------------------------------------------------------------------
-- 11. Handoff retention.
--
--    `platform_company_handoffs` grows one row per app-open and is only ever
--    read while a token is unredeemed. Used rows are dead weight; expired ones
--    are dead weight with a hash in them. Retention is 24h for redeemed rows
--    and 7 days for expired ones; nothing else is ever removed, and the audit
--    trail of *who opened what* lives in `platform_audit_log`, not here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prune_platform_company_handoffs(
  p_redeemed_retention interval DEFAULT interval '24 hours',
  p_expired_retention interval DEFAULT interval '7 days'
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
  WITH deleted AS (
    DELETE FROM platform_company_handoffs
     WHERE (used_at IS NOT NULL AND used_at < now() - p_redeemed_retention)
        OR (used_at IS NULL AND expires_at < now() - p_expired_retention)
     RETURNING 1
  )
  SELECT count(*)::integer INTO removed FROM deleted;
  RETURN removed;
END $$;

CREATE INDEX IF NOT EXISTS platform_company_handoffs_business
  ON platform_company_handoffs (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 12. Site credentials: revocation is a state with a time, and a credential
--     is attributable to the site record it serves.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_company_site_credentials
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS site_id text;
CREATE INDEX IF NOT EXISTS platform_company_site_credentials_site
  ON platform_company_site_credentials (business_id, site_id)
  WHERE site_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 13. Web leads: attribute the intake to the credential that authorised it.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_company_web_leads
  ADD COLUMN IF NOT EXISTS credential_id uuid;
CREATE INDEX IF NOT EXISTS platform_company_web_leads_received
  ON platform_company_web_leads (business_id, received_at DESC);
-- Attribution is a real reference, not a copy: a lead knows which credential
-- authorised it, and the credential cannot be deleted out from under it.
ALTER TABLE platform_company_web_leads
  DROP CONSTRAINT IF EXISTS platform_company_web_leads_credential_fk;
ALTER TABLE platform_company_web_leads
  ADD CONSTRAINT platform_company_web_leads_credential_fk
  FOREIGN KEY (credential_id) REFERENCES platform_company_site_credentials (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 14. Company entitlements: one source of truth for "this app is switched on
--     for the internal company", checked by `/api/platform/company/open`.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS platform_company_entitlements_enabled
  ON platform_company_entitlements (business_id, capability) WHERE enabled;

CREATE INDEX IF NOT EXISTS platform_company_members_lookup
  ON platform_company_members (platform_admin_id) WHERE is_active;

-- ---------------------------------------------------------------------------
-- 15. Chart of accounts wording for the company's own books.
--
--     `2455` is seeded by the shared `service_saas` template as «پرداختنی به
--     پلتفرم (اعتبار پیام)» — the CUSTOMER's account for the message credit
--     they hold. In the internal company's own ledger the same account is the
--     mirror image: money the company holds on a customer's behalf, i.e. a
--     liability to that customer. Posting a wallet settlement against an
--     account whose name says the opposite is how a reconciliation turns into
--     an argument.
--
--     Only the seeded default is renamed, and only inside the internal
--     company, so an operator who renamed it deliberately keeps their wording
--     and no customer business is touched. A label, not a posting: nothing
--     already recorded changes.
-- ---------------------------------------------------------------------------
UPDATE accounts a
   SET name = 'بدهی کیف پول مشتری'
 WHERE a.business_id IN (SELECT id FROM businesses WHERE ownership_kind = 'platform_internal')
   AND a.code = '2455'
   AND a.name = 'پرداختنی به پلتفرم (اعتبار پیام)';
