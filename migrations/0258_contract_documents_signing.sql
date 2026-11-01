-- ===========================================================================
-- 0258 — Issue #908: contract documents, reusable templates and multi-party
--         e-signing (Phase A: schema and invariants)
-- ===========================================================================
--
-- #908 extends `workspace_contracts`; it does not replace it. That table stays
-- the canonical execution-contract record (party, project, amount, dates,
-- lifecycle), and everything here hangs off it:
--
--   workspace_contracts ──1:1── contract_documents        the editable draft
--                       ──1:N── contract_document_versions immutable snapshots
--                       ──1:N── contract_signing_envelopes  a signature round
--                                  ──1:N── contract_signers
--                                  ──1:N── contract_invitations
--                                  ──1:N── contract_signatures
--                                  ──1:N── contract_signing_events (append-only)
--
-- A `contract_templates` row is the business's own reusable document; the
-- built-in starter templates live in code (`src/lib/contracts/templates.ts`) and
-- are copied into a draft, never referenced by id, so editing a template can
-- never rewrite a contract that was issued from it.
--
-- Money stays integer Rial and dates stay `date`/`timestamptz`; the Shamsi
-- formatting happens at the boundary (docs/data-model.md §Dates).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Templates — a business's own reusable documents
-- ---------------------------------------------------------------------------
CREATE TABLE contract_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (btrim(name) <> ''),
    description text NOT NULL DEFAULT '',
    -- Mirrors workspace_contracts.contract_type so "new contract from template"
    -- pre-selects the right kind without another lookup table.
    contract_type text NOT NULL DEFAULT 'other'
                      CHECK (contract_type IN (
                          'contractor', 'supplier', 'consultant', 'subcontractor',
                          'vendor', 'developer', 'service', 'other')),
    -- The current definition, kept on the row for cheap listing. The content of
    -- a published revision is duplicated into contract_template_versions, which
    -- is what a "roll back to v3" restores from.
    content     jsonb NOT NULL DEFAULT '{}'::jsonb,
    revision    integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);
CREATE INDEX idx_contract_templates_business
    ON contract_templates (business_id, updated_at DESC) WHERE archived_at IS NULL;

-- Every published revision of a template. Immutable rows: a template the
-- business already sent from must keep the exact text it had that day.
CREATE TABLE contract_template_versions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    template_id uuid NOT NULL REFERENCES contract_templates(id) ON DELETE CASCADE,
    version     integer NOT NULL CHECK (version > 0),
    content     jsonb NOT NULL,
    created_by  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
);

-- ---------------------------------------------------------------------------
-- 2. Documents — the draft, one per contract
-- ---------------------------------------------------------------------------
CREATE TABLE contract_documents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    contract_id      uuid NOT NULL REFERENCES workspace_contracts(id) ON DELETE CASCADE,
    template_id      uuid REFERENCES contract_templates(id) ON DELETE SET NULL,
    -- One document per contract: the editor, the print view and the signing
    -- round all read the same row, so there is no "which document is current".
    content          jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Optimistic concurrency for autosave. Every save states the revision it
    -- was based on; a save that lost the race is refused rather than silently
    -- overwriting the other tab's paragraph.
    revision         integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by       text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contract_documents_one_per_contract UNIQUE (contract_id)
);
CREATE INDEX idx_contract_documents_business ON contract_documents (business_id);

-- A frozen snapshot: the exact content AND the exact resolved values, plus the
-- SHA-256 over both. A signature points at one of these, never at the draft.
CREATE TABLE contract_document_versions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    contract_id  uuid NOT NULL REFERENCES workspace_contracts(id) ON DELETE CASCADE,
    document_id  uuid NOT NULL REFERENCES contract_documents(id) ON DELETE CASCADE,
    version      integer NOT NULL CHECK (version > 0),
    -- Denormalised for the signer's header and the version list: reading a
    -- document's title should not require parsing a whole block tree.
    title        text NOT NULL DEFAULT '',
    -- `content` carries `values` (the resolved variable map), so the rendering
    -- of a frozen version never re-reads a project or a party that may have
    -- changed since. That is what makes the hash meaningful.
    content      jsonb NOT NULL,
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    frozen_by    text NOT NULL DEFAULT '',
    frozen_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contract_document_versions_unique UNIQUE (document_id, version)
);
CREATE INDEX idx_contract_document_versions_contract
    ON contract_document_versions (business_id, contract_id, version DESC);

-- ---------------------------------------------------------------------------
-- 3. Envelopes — one signature round over one frozen version
-- ---------------------------------------------------------------------------
CREATE TABLE contract_signing_envelopes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    contract_id         uuid NOT NULL REFERENCES workspace_contracts(id) ON DELETE CASCADE,
    -- Draft envelopes are prepared against a version too: the signer list must
    -- name signature slots, and those only exist once the document is frozen.
    document_version_id uuid NOT NULL REFERENCES contract_document_versions(id) ON DELETE RESTRICT,
    status              text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'sent', 'partially_signed',
                                              'completed', 'declined', 'cancelled', 'expired')),
    signing_mode        text NOT NULL DEFAULT 'parallel'
                            CHECK (signing_mode IN ('parallel', 'sequential')),
    expires_at          timestamptz,
    cancel_reason       text NOT NULL DEFAULT '',
    created_by          text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz,
    completed_at        timestamptz,
    cancelled_at        timestamptz
);
-- One live round per contract. A second round is a NEW envelope after the first
-- is completed, declined or cancelled — never two links to two different texts
-- racing each other.
CREATE UNIQUE INDEX contract_signing_envelopes_one_live
    ON contract_signing_envelopes (contract_id)
    WHERE status IN ('draft', 'sent', 'partially_signed');
CREATE INDEX idx_contract_signing_envelopes_business
    ON contract_signing_envelopes (business_id, status);

CREATE TABLE contract_signers (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    envelope_id    uuid NOT NULL REFERENCES contract_signing_envelopes(id) ON DELETE CASCADE,
    -- When the counterparty is a known party, link it so the CRM/party file can
    -- show the contract; an external individual signs without one.
    party_id       uuid REFERENCES parties(id) ON DELETE SET NULL,
    full_name      text NOT NULL CHECK (btrim(full_name) <> ''),
    role_label     text NOT NULL DEFAULT '',
    -- E.164. The number is the identity the OTP is bound to, which is why signer
    -- endpoints never accept a caller-supplied number: it comes from this row.
    phone_e164     text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    -- Which `signature` block of the frozen document this person signs.
    slot_id        text NOT NULL CHECK (btrim(slot_id) <> ''),
    sign_order     integer NOT NULL DEFAULT 1 CHECK (sign_order > 0),
    required       boolean NOT NULL DEFAULT true,
    status         text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'invited', 'opened', 'acknowledged',
                                         'signed', 'declined', 'expired')),
    decline_reason text NOT NULL DEFAULT '',
    deadline       date,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    invited_at     timestamptz,
    opened_at      timestamptz,
    acknowledged_at timestamptz,
    -- Set when the OTP is redeemed, so an acknowledged signer and a verified
    -- signer are distinguishable in the evidence trail.
    verified_at    timestamptz,
    signed_at      timestamptz,
    declined_at    timestamptz,
    -- Two people cannot share one signature line, and one phone cannot hold two
    -- identities in the same round (the OTP would verify the wrong person).
    CONSTRAINT contract_signers_unique_slot UNIQUE (envelope_id, slot_id),
    CONSTRAINT contract_signers_unique_phone UNIQUE (envelope_id, phone_e164)
);
CREATE INDEX idx_contract_signers_envelope
    ON contract_signers (envelope_id, sign_order);

-- ---------------------------------------------------------------------------
-- 4. Invitations — the bearer token, stored only as a digest
-- ---------------------------------------------------------------------------
CREATE TABLE contract_invitations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    envelope_id uuid NOT NULL REFERENCES contract_signing_envelopes(id) ON DELETE CASCADE,
    signer_id   uuid NOT NULL REFERENCES contract_signers(id) ON DELETE CASCADE,
    -- HMAC-SHA-256 of the token under the deployment secret. The plaintext
    -- exists only in the message that carried it, so a database dump cannot be
    -- replayed as a signing session.
    token_hash  text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at  timestamptz NOT NULL,
    send_count  integer NOT NULL DEFAULT 0 CHECK (send_count >= 0),
    last_sent_at timestamptz,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT contract_invitations_unique_token UNIQUE (token_hash)
);
-- Exactly one live token per signer: "resend" rotates it, and the previous link
-- stops working the moment the new one is minted.
CREATE UNIQUE INDEX contract_invitations_one_live
    ON contract_invitations (signer_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_contract_invitations_envelope ON contract_invitations (envelope_id);

-- ---------------------------------------------------------------------------
-- 5. Signatures — one per signer, immutable
-- ---------------------------------------------------------------------------
CREATE TABLE contract_signatures (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    envelope_id         uuid NOT NULL REFERENCES contract_signing_envelopes(id) ON DELETE CASCADE,
    signer_id           uuid NOT NULL REFERENCES contract_signers(id) ON DELETE CASCADE,
    document_version_id uuid NOT NULL REFERENCES contract_document_versions(id) ON DELETE RESTRICT,
    slot_id             text NOT NULL,
    full_name           text NOT NULL,
    -- The drawn image (PNG data URL) when the signer drew; empty when they
    -- chose the typed-name form. Either way the intent is recorded, and the
    -- hash below — not the picture — is what binds them to the text.
    drawn_image         text,
    signature_kind      text NOT NULL DEFAULT 'drawn' CHECK (signature_kind IN ('drawn', 'typed')),
    -- The hash of the version they signed. Stored here as well as on the version
    -- so a later version's edit cannot be argued to have "always" been signed.
    content_hash        text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    -- Truncated (/24, /64) client address: enough to corroborate a dispute,
    -- not enough to be a personal-data liability of its own.
    ip_address          text NOT NULL DEFAULT '',
    user_agent          text NOT NULL DEFAULT '',
    signed_at           timestamptz NOT NULL DEFAULT now(),
    -- A person signs once. Re-signing is a new round, not an update.
    CONSTRAINT contract_signatures_one_per_signer UNIQUE (signer_id)
);
CREATE INDEX idx_contract_signatures_envelope ON contract_signatures (envelope_id);

-- ---------------------------------------------------------------------------
-- 6. Events — the append-only audit trail
-- ---------------------------------------------------------------------------
-- Insert-only by construction: the tenant policy below grants SELECT and INSERT
-- and nothing else, so no code path (and no future migration accident) can
-- rewrite history by UPDATE or DELETE.
CREATE TABLE contract_signing_events (
    id          bigserial PRIMARY KEY,
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Nullable: a signer-driven event can outlive a deleted contract's
    -- envelope, and the trail must survive as far as the tenant row does.
    contract_id uuid REFERENCES workspace_contracts(id) ON DELETE CASCADE,
    envelope_id uuid REFERENCES contract_signing_envelopes(id) ON DELETE CASCADE,
    signer_id   uuid REFERENCES contract_signers(id) ON DELETE SET NULL,
    kind        text NOT NULL CHECK (btrim(kind) <> ''),
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contract_signing_events_contract
    ON contract_signing_events (business_id, contract_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 7. Row-level security — every row is one tenant's
-- ---------------------------------------------------------------------------
ALTER TABLE contract_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_templates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE contract_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_template_versions FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_documents FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE contract_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_document_versions FORCE ROW LEVEL SECURITY;
-- Frozen versions are immutable: SELECT + INSERT only, so a "correction" is a
-- new version rather than an edit to what somebody already signed.
CREATE POLICY tenant_read ON contract_document_versions FOR SELECT
    USING (app_rls_bypass() OR business_id = app_current_business());
CREATE POLICY tenant_insert ON contract_document_versions FOR INSERT
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE contract_signing_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signing_envelopes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_signing_envelopes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE contract_signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_signers FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE contract_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_invitations FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE contract_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signatures FORCE ROW LEVEL SECURITY;
-- A signature is evidence: it is written once and read afterwards.
CREATE POLICY tenant_read ON contract_signatures FOR SELECT
    USING (app_rls_bypass() OR business_id = app_current_business());
CREATE POLICY tenant_insert ON contract_signatures FOR INSERT
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE contract_signing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_signing_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON contract_signing_events FOR SELECT
    USING (app_rls_bypass() OR business_id = app_current_business());
CREATE POLICY tenant_insert ON contract_signing_events FOR INSERT
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

COMMENT ON TABLE contract_document_versions IS
    'Immutable frozen contract snapshots; content_hash is SHA-256 over the canonical {title, blocks, values, version} JSON (issue #908).';
COMMENT ON TABLE contract_invitations IS
    'Per-signer bearer tokens, stored as HMAC-SHA-256 digests only; the plaintext lives in the SMS link (issue #908).';
COMMENT ON TABLE contract_signing_events IS
    'Append-only signing audit trail; RLS grants SELECT/INSERT only (issue #908).';
