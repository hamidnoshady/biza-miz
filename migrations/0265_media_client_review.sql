-- ============================================================================
-- 0265_media_client_review.sql — issue #1128 §E: client media review, on top of
-- the Media Library the product already has.
--
-- §E asks that the shared S3-backed Media Library stay the single file store,
-- that assets be organized by tenant/client/project/campaign with metadata and
-- versions, review state, visibility/roles and an audit trail, and that
-- client-facing review or download links be short-lived, authenticated and
-- scoped — never public cross-tenant URLs.
--
-- WHAT THIS MIGRATION DOES NOT DO, and the reason matters more than the fact:
--
--   * It does not create a second file store, a second asset table, or a media
--     migration of any kind. §E forbids a parallel object store, so every byte
--     stays in `media_assets` and is served by the code that already serves it.
--   * It does not add a column to `media_assets`. That table belongs to every
--     trade in the product — a restaurant's menu photos, a dealership's vehicle
--     shots, an expense receipt, a purchase invoice — so an agency's review
--     state on it would be a burden on twelve industries for one trade's
--     workflow. Review state lives on a *round* instead, which is also what
--     makes it a history: the same creative sent to two clients, or re-sent
--     after revisions, is two rounds over one asset.
--   * It does not touch `media_assets.ai_status`. That column already carries
--     'pending_review' and it is tempting to reuse the word, but it records
--     whether an operator confirmed the AI's *proposed labels* — an internal
--     housekeeping state with no client in it. One column must not answer two
--     unrelated questions.
--   * It posts no journal entry and moves no money. §E is an approval workflow.
--
-- FOUR TABLES, in the order a review actually happens:
--
--   1. `media_review_rounds`      — a batch of assets sent to one client for a
--                                   decision, scoped to a project, a client and
--                                   a campaign. The state machine's subject.
--   2. `media_review_round_items` — which assets are in the round, each with its
--                                   own decision and note.
--   3. `media_review_links`       — the short-lived scoped token a client who is
--                                   not a member of the tenant uses to reach it.
--   4. `media_review_events`      — the audit trail: append-only, and it records
--                                   the external client as an actor with no user
--                                   row, because that is exactly who they are.
--
-- WHY THE LINK IS A ROW AND NOT A PRESIGNED URL. `presignS3Get` already exists
-- and would be the easy answer, but a presigned URL cannot be revoked before it
-- expires and leaves no record of who fetched what. §E requires both, and §B
-- requires the links be revocable. So the token resolves to a round inside this
-- application, and the bytes are streamed by the same code path the tenant's own
-- library uses — which already refuses a storage key that does not belong to the
-- business it was asked for. Revocation is then immediate and every access is an
-- event. The plaintext token is never stored: only its sha-256, the rule
-- migration 0022 set for invitations and `api-auth.ts` set for API keys.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The round
-- ---------------------------------------------------------------------------

CREATE TABLE media_review_rounds (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,

    -- The three dimensions §E asks the library to be organized by, beyond the
    -- tenant itself. All optional: an agency reviewing a logo before there is a
    -- campaign, or a one-person studio with no CRM party for the client yet,
    -- must still be able to ask for approval. `project_id` mirrors the column
    -- migration 0161 already put on `media_assets`, so a round and the assets
    -- in it can disagree and the disagreement is visible rather than silent.
    project_id      uuid REFERENCES ai_projects(id) ON DELETE SET NULL,
    client_party_id uuid REFERENCES parties(id) ON DELETE SET NULL,
    campaign_id     uuid REFERENCES growth_campaigns(id) ON DELETE SET NULL,

    title           text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
    note            text CHECK (note IS NULL OR char_length(note) <= 2000),

    -- The chain itself lives in src/lib/media-review.ts, so a service and a
    -- screen cannot each invent one. What the database holds is the invariant
    -- behind it: nothing is decided before it was sent, and a decision is
    -- stamped. `approved` is terminal — a client who changes their mind does
    -- not un-approve, the agency sends a new round, so both facts survive.
    state           text NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft', 'sent', 'approved',
                                         'changes_requested', 'rejected', 'withdrawn')),

    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    created_by_name text NOT NULL DEFAULT '',

    sent_at         timestamptz,
    decided_at      timestamptz,
    -- The client's own name, as they wrote it. An external approver has no row
    -- in `users` and must not be given one: granting a client a user account to
    -- record a decision would be a second identity system, which §B forbids.
    decided_by_name text CHECK (decided_by_name IS NULL OR char_length(btrim(decided_by_name)) <= 200),
    decision_note   text CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    -- Nothing decided before it was sent, and a decision is always stamped.
    CHECK (state = 'draft' OR sent_at IS NOT NULL),
    CHECK (decided_at IS NULL OR state <> 'draft'),
    CHECK (state NOT IN ('approved', 'changes_requested', 'rejected') OR decided_at IS NOT NULL),
    -- A withdrawal is the agency's act and happens after sending, never before.
    CHECK (state <> 'withdrawn' OR sent_at IS NOT NULL),

    -- So the two child tables can key on the pair and the database, not the
    -- service, is what keeps a round's items and links inside its own tenant.
    UNIQUE (business_id, id)
);

CREATE INDEX idx_media_review_rounds_business
    ON media_review_rounds (business_id, state, created_at DESC);
CREATE INDEX idx_media_review_rounds_project
    ON media_review_rounds (business_id, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_media_review_rounds_client
    ON media_review_rounds (business_id, client_party_id) WHERE client_party_id IS NOT NULL;
CREATE INDEX idx_media_review_rounds_campaign
    ON media_review_rounds (business_id, campaign_id) WHERE campaign_id IS NOT NULL;
-- What a client-facing screen needs: the rounds still waiting on somebody.
CREATE INDEX idx_media_review_rounds_awaiting
    ON media_review_rounds (business_id, sent_at) WHERE state = 'sent';

ALTER TABLE media_review_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_review_rounds FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON media_review_rounds FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 2. The assets in a round
-- ---------------------------------------------------------------------------

CREATE TABLE media_review_round_items (
    -- No plain foreign key on round_id. The composite key at the foot of this
    -- table is what ties an item to its round, and it ties the item to a round
    -- *of the same tenant* in the same breath. That is the pattern migration
    -- 0262 set for `growth_campaign_versions`, and one constraint that proves
    -- two things is better than two constraints that each prove one — the pair
    -- cannot be satisfied by a round that exists but belongs to somebody else.
    round_id    uuid NOT NULL,
    asset_id    uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    -- Denormalized from the round so RLS can check this table without a join —
    -- the pattern `media_collection_items` documented in migration 0174. Unlike
    -- that table, the pair is also a real foreign key below, so the column
    -- cannot drift from the round it came from.
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,

    -- §E's format list, over the library's existing vocabulary rather than a
    -- widened `media_assets.kind`: that column is `image | video | document` and
    -- every upload path in the product branches on it, so nine agency formats
    -- belong here and in `category`, not there.
    format        text CHECK (format IS NULL OR format IN (
                      'copy', 'static_creative', 'logo', 'video', 'print_ready',
                      'ad_variant', 'brief', 'contract', 'report')),
    -- The client-facing version. Successive rounds over one asset are its
    -- version history, so this labels a version rather than storing one —
    -- storing a second copy of what the rounds already say would be a second,
    -- staler answer to the same question.
    version_label text CHECK (version_label IS NULL OR char_length(version_label) <= 80),

    position    integer NOT NULL DEFAULT 0 CHECK (position >= 0),

    state       text NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'approved', 'changes_requested', 'rejected')),
    note        text CHECK (note IS NULL OR char_length(note) <= 2000),
    decided_at  timestamptz,

    added_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    added_at    timestamptz NOT NULL DEFAULT now(),

    -- A decision is stamped; an undecided item has no stamp.
    CHECK (state = 'pending' OR decided_at IS NOT NULL),
    CHECK (decided_at IS NULL OR state <> 'pending'),

    PRIMARY KEY (round_id, asset_id),
    FOREIGN KEY (business_id, round_id)
        REFERENCES media_review_rounds (business_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_media_review_items_asset ON media_review_round_items (asset_id);
CREATE INDEX idx_media_review_items_business
    ON media_review_round_items (business_id, state);

ALTER TABLE media_review_round_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_review_round_items FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON media_review_round_items FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 3. The scoped link
-- ---------------------------------------------------------------------------

CREATE TABLE media_review_links (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    -- Composite key at the foot of the table proves the round and the tenant
    -- together, so no plain foreign key here (migration 0262's pattern).
    round_id     uuid NOT NULL,

    -- Only the sha-256 of the token, never the token: the plaintext is shown
    -- once at minting and is unrecoverable afterwards, the rule migration 0022
    -- set for invitations. 64 lower-case hex characters is that hash's shape,
    -- and pinning it here means a plaintext token cannot be stored by mistake —
    -- the failure §E's "never public cross-tenant URLs" exists to prevent.
    token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    -- The non-secret identifier, so a dashboard can say which link is which
    -- without holding anything that authenticates.
    token_prefix text NOT NULL CHECK (char_length(token_prefix) BETWEEN 1 AND 40),

    -- Review means look and decide. Download is a separate deliberate grant: a
    -- print-ready file is often the deliverable the agency is still owed money
    -- for, so approving it is not the same as being handed it.
    purpose      text NOT NULL DEFAULT 'review' CHECK (purpose IN ('review', 'download')),

    -- Clamped to src/lib/media-review.ts's window and checked again here, so a
    -- caller that bypasses the service still cannot mint a permanent link.
    ttl_days     integer NOT NULL CHECK (ttl_days BETWEEN 1 AND 30),
    expires_at   timestamptz NOT NULL,
    -- Revocation is a state and not only a timestamp: a withdrawn round's link
    -- must stop working at once, which expiry alone cannot do.
    revoked_at   timestamptz,

    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    -- Access is recorded, because a link that leaves no trace cannot be audited
    -- and cannot be investigated after a client says they never received it.
    last_used_at timestamptz,
    use_count    integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),

    created_at   timestamptz NOT NULL DEFAULT now(),

    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
    CHECK (last_used_at IS NULL OR last_used_at >= created_at),
    CHECK (use_count = 0 OR last_used_at IS NOT NULL),

    FOREIGN KEY (business_id, round_id)
        REFERENCES media_review_rounds (business_id, id) ON DELETE CASCADE
);

-- One live link per round per purpose. Re-issuing replaces rather than
-- accumulating tokens that all still work — the reason migration 0022 put a
-- partial unique index on pending invitations. Revoked rows are history and are
-- deliberately outside the index, so they stay readable for the audit trail.
CREATE UNIQUE INDEX idx_media_review_links_live
    ON media_review_links (round_id, purpose) WHERE revoked_at IS NULL;
-- The lookup a client request makes: by hash, then the tenant falls out of the
-- row. Never the other way round — a request must not get to name its tenant.
CREATE INDEX idx_media_review_links_hash ON media_review_links (token_hash);
CREATE INDEX idx_media_review_links_business
    ON media_review_links (business_id, created_at DESC);

ALTER TABLE media_review_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_review_links FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON media_review_links FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- 4. The audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE media_review_events (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- Composite key at the foot of this table, as for items and links. A plain
    -- foreign key would prove only that the round *exists*, not that it is this
    -- tenant's round — and an audit row filed under one business about another
    -- business's round is readable by the tenant it was filed under. A narrow
    -- leak, but §E's whole subject is that nothing about one tenant reaches
    -- another, and the audit trail is the last place to leave one.
    round_id      uuid NOT NULL,
    -- These two stay plain references, and that is a decision rather than an
    -- oversight. Neither can be a composite foreign key: `media_assets` has no
    -- UNIQUE (business_id, id) to point at, and §E is no reason to add one to a
    -- table every trade in the product reads; and a composite key on `link_id`
    -- would make ON DELETE SET NULL try to null `business_id` as well, which is
    -- NOT NULL. What either could leak is the existence of a UUID — the token
    -- itself is stored only as a hash, and no bytes are ever resolved through
    -- this table. The reference capable of leaking a *subject* is `round_id`,
    -- which is exactly why that one is composite.
    asset_id      uuid REFERENCES media_assets(id) ON DELETE SET NULL,
    link_id       uuid REFERENCES media_review_links(id) ON DELETE SET NULL,

    -- NULL for the external client, who has no user row and must not be given
    -- one. `actor_label` is what a screen shows, and `actor_kind` is what code
    -- branches on, so neither has to be inferred from the other.
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_kind    text NOT NULL CHECK (actor_kind IN ('member', 'client', 'system')),
    actor_label   text NOT NULL CHECK (char_length(btrim(actor_label)) BETWEEN 1 AND 200),

    action        text NOT NULL CHECK (char_length(btrim(action)) BETWEEN 1 AND 80),
    from_state    text,
    to_state      text,
    note          text CHECK (note IS NULL OR char_length(note) <= 2000),

    created_at    timestamptz NOT NULL DEFAULT now(),

    -- One direction only, and the direction is the point. A user id implies a
    -- member; but `ON DELETE SET NULL` above means a member's event outlives
    -- their user row, and the trail has to survive that instead of failing it.
    -- The equality these two columns seem to invite — a 'member' event always
    -- has a user — would turn deleting a user into being unable to delete them,
    -- or into deleting the record of what they did. `actor_label` is NOT NULL
    -- precisely so the name outlives the id.
    CHECK (actor_user_id IS NULL OR actor_kind = 'member'),

    -- Proves the round and the tenant together, so an audit row cannot be filed
    -- under one business about another business's round.
    FOREIGN KEY (business_id, round_id)
        REFERENCES media_review_rounds (business_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_media_review_events_round
    ON media_review_events (business_id, round_id, created_at DESC);
CREATE INDEX idx_media_review_events_asset
    ON media_review_events (asset_id) WHERE asset_id IS NOT NULL;

ALTER TABLE media_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_review_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON media_review_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

-- ---------------------------------------------------------------------------
-- Guards. Each is a fact §E states in prose, held in the database instead, so a
-- service bug or a hand-written query cannot quietly violate it.
-- ---------------------------------------------------------------------------

-- A round may only point at a project, a client and a campaign of its own
-- tenant. Without this, a round could be filed against another business's
-- campaign and a client link would then expose that campaign's name.
CREATE OR REPLACE FUNCTION media_assert_review_round_references_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
BEGIN
    IF NEW.project_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM ai_projects WHERE id = NEW.project_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'media_review_rounds: project does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'media_review_rounds: project belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.client_party_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM parties WHERE id = NEW.client_party_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'media_review_rounds: client does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'media_review_rounds: client belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.campaign_id IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM growth_campaigns WHERE id = NEW.campaign_id;
        IF owner_business IS NULL THEN
            RAISE EXCEPTION 'media_review_rounds: campaign does not exist'
                USING ERRCODE = '23514';
        END IF;
        IF owner_business <> NEW.business_id THEN
            RAISE EXCEPTION 'media_review_rounds: campaign belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.created_by IS NOT NULL THEN
        SELECT business_id INTO owner_business FROM users WHERE id = NEW.created_by;
        IF owner_business IS DISTINCT FROM NEW.business_id THEN
            RAISE EXCEPTION 'media_review_rounds: creator belongs to another business'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_review_rounds_references
    BEFORE INSERT OR UPDATE OF project_id, client_party_id, campaign_id, created_by
    ON media_review_rounds
    FOR EACH ROW EXECUTE FUNCTION media_assert_review_round_references_owned();

-- An item's asset must belong to the same tenant and must not be in the bin.
--
-- This is the guard §E's "never public cross-tenant URLs" actually rests on. A
-- client link resolves to a round, and the round resolves to its items; if an
-- item could name another tenant's asset, the link would stream that tenant's
-- bytes to somebody outside it. The streaming code refuses a foreign storage key
-- too, so this is the second of two doors — but the second door is here because
-- the first one is in application code and this one is not.
CREATE OR REPLACE FUNCTION media_assert_review_item_asset_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    owner_business uuid;
    binned         timestamptz;
BEGIN
    SELECT business_id, deleted_at INTO owner_business, binned
      FROM media_assets WHERE id = NEW.asset_id;
    IF owner_business IS NULL THEN
        RAISE EXCEPTION 'media_review_round_items: asset does not exist'
            USING ERRCODE = '23514';
    END IF;
    IF owner_business <> NEW.business_id THEN
        RAISE EXCEPTION 'media_review_round_items: asset belongs to another business'
            USING ERRCODE = '23514';
    END IF;
    -- A deleted asset is not reviewable. The library soft-deletes (migration
    -- 0174), so the row still exists and the reference would otherwise succeed.
    IF binned IS NOT NULL THEN
        RAISE EXCEPTION 'media_review_round_items: asset is deleted'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_review_items_asset
    BEFORE INSERT OR UPDATE OF asset_id, business_id
    ON media_review_round_items
    FOR EACH ROW EXECUTE FUNCTION media_assert_review_item_asset_owned();

-- A link must be born unexpired, and once revoked it is history.
--
-- Freezing a revoked row is what makes revocation trustworthy: if `revoked_at`
-- could be cleared or `expires_at` pushed out, "revoked" would mean "revoked
-- until somebody changes their mind", and a client cut off for cause could be
-- let back in by an UPDATE nobody recorded.
CREATE OR REPLACE FUNCTION media_review_link_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.expires_at <= now() THEN
            RAISE EXCEPTION 'media_review_links: link is already expired'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.revoked_at IS NOT NULL THEN
            RAISE EXCEPTION 'media_review_links: a link is minted live, then revoked'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    -- A link is minted, used and revoked. Nothing about its authority ever
    -- moves, live or revoked: only the revocation stamp — set once, never
    -- cleared, never moved — and the access counters may change.
    --
    -- Freezing a *live* link, not merely a revoked one, is the part that is easy
    -- to omit and expensive to omit. Each field earns its place:
    --
    --   expires_at, ttl_days  a link whose expiry can be pushed out is not
    --                         short-lived, it is permanent with extra steps, and
    --                         §E asks for short-lived.
    --   purpose               widening review to download hands over bytes the
    --                         agency may still be owed for. That is a privilege
    --                         escalation wearing the costume of a preference.
    --   round_id, business_id moving a token hands a working authenticator to a
    --                         different subject.
    --   token_hash            a token is replaced by a new row, never rotated in
    --                         place, so the old one stays in the trail as
    --                         revoked rather than silently becoming somebody
    --                         else's credential.
    --
    -- Re-issuing is the supported answer to all five: revoke, mint a new row,
    -- and both facts are on the record.
    IF NEW.id <> OLD.id
       OR NEW.token_hash <> OLD.token_hash
       OR NEW.token_prefix <> OLD.token_prefix
       OR NEW.purpose <> OLD.purpose
       OR NEW.expires_at <> OLD.expires_at
       OR NEW.ttl_days <> OLD.ttl_days
       OR NEW.round_id <> OLD.round_id
       OR NEW.business_id <> OLD.business_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at <> OLD.created_at
       OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
        RAISE EXCEPTION 'media_review_links: a link is minted, used and revoked'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_review_links_guard
    BEFORE INSERT OR UPDATE ON media_review_links
    FOR EACH ROW EXECUTE FUNCTION media_review_link_guard();

-- The audit trail is append-only. An audit log that can be edited is a
-- suggestion, and §E asks for a trail — so both statements are refused here
-- rather than being left to the service to remember.
CREATE OR REPLACE FUNCTION media_review_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- On the way in, a 'member' event must name its member. The UPDATE branch
    -- below has to tolerate a member event whose user id the foreign key nulled,
    -- so the CHECK constraint deliberately cannot ask for this — but the insert
    -- can. Without it a service bug could record "a member did this" with
    -- nobody attached, and an audit entry that cannot be attributed is worse
    -- than no entry, because it reads as though it could be.
    IF TG_OP = 'INSERT' THEN
        IF NEW.actor_kind = 'member' AND NEW.actor_user_id IS NULL THEN
            RAISE EXCEPTION 'media_review_events: a member event names its member'
                USING ERRCODE = '23514';
        END IF;
        -- This RETURN NEW is load-bearing in a way that is easy to miss. A
        -- BEFORE INSERT row trigger that returns NULL does not raise an error:
        -- PostgreSQL silently skips the row. Falling through to the DELETE path
        -- below — where OLD is NULL, so no round is found and the function
        -- returns OLD — would therefore discard every event ever written, with
        -- nothing failing anywhere and an audit trail that is simply, quietly
        -- empty. Each branch returns its own row.
        RETURN NEW;
    END IF;

    -- Rewriting history is refused, including on a draft: an edited event is
    -- indistinguishable from one that was recorded correctly.
    --
    -- One edit is permitted, and it is not ours to make or refuse: the foreign
    -- key's own ON DELETE SET NULL, firing when a member's user row goes. A
    -- blanket refusal here would mean the audit trail holds that member hostage
    -- — the agency could never delete a departed colleague's account once they
    -- had appeared in a review. Permitting edits generally would mean it is not
    -- a trail. So exactly that column may move, only to NULL, and only with
    -- every other field byte-identical.
    --
    -- This is the moment `actor_label` being NOT NULL pays for: the name
    -- outlives the id, so the row still says who did it after the account is
    -- gone, which is also why the CHECK below runs one direction only.
    IF TG_OP = 'UPDATE' THEN
        IF NEW.actor_user_id IS NULL
           AND OLD.actor_user_id IS NOT NULL
           AND NEW.id = OLD.id
           AND NEW.business_id = OLD.business_id
           AND NEW.round_id = OLD.round_id
           AND NEW.asset_id IS NOT DISTINCT FROM OLD.asset_id
           AND NEW.link_id IS NOT DISTINCT FROM OLD.link_id
           AND NEW.actor_kind = OLD.actor_kind
           AND NEW.actor_label = OLD.actor_label
           AND NEW.action = OLD.action
           AND NEW.from_state IS NOT DISTINCT FROM OLD.from_state
           AND NEW.to_state IS NOT DISTINCT FROM OLD.to_state
           AND NEW.note IS NOT DISTINCT FROM OLD.note
           AND NEW.created_at = OLD.created_at THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'media_review_events: the audit trail is append-only'
            USING ERRCODE = '23514';
    END IF;

    -- A delete is refused while the round still exists, whatever its state. The
    -- one deletion that gets through is the cascade from deleting the round
    -- itself: PostgreSQL fires a foreign-key cascade after the parent row is
    -- gone, so "the round is no longer there" is exactly how a cascade is told
    -- apart from somebody erasing a line of history — the same distinction
    -- migration 0262's version guard relies on.
    --
    -- It is tempting to also permit deleting a *draft* round's events directly,
    -- on the grounds that a draft holds no client-facing fact. The cascade does
    -- not need that permission: the round guard already limits round deletion to
    -- drafts, so an agency cleaning up a round it created by mistake takes the
    -- events with the round. Granting line-by-line erasure on top would open a
    -- hole precisely where the guarantee is meant to be strongest, for no gain.
    PERFORM 1 FROM media_review_rounds WHERE id = OLD.round_id;
    IF FOUND THEN
        RAISE EXCEPTION 'media_review_events: the audit trail is append-only'
            USING ERRCODE = '23514';
    END IF;

    RETURN OLD;
END;
$$;

CREATE TRIGGER trg_media_review_events_immutable
    BEFORE INSERT OR UPDATE OR DELETE ON media_review_events
    FOR EACH ROW EXECUTE FUNCTION media_review_event_immutable();

-- A round's contents freeze when it goes to the client, and a settled round is
-- history.
--
-- Two different freezes, because two different things are protected. A *sent*
-- round must not change underneath the client reading it — approving a batch and
-- then finding a different batch approved is the failure. A *settled* round must
-- not change at all, because the decision is the record of what the client
-- agreed to, and §E's audit trail is only worth having if the thing it audited
-- cannot be rearranged afterwards.
CREATE OR REPLACE FUNCTION media_review_round_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        -- Only an unsent round may be deleted. A round a client has seen is
        -- history whether or not they decided on it.
        IF OLD.state <> 'draft' THEN
            RAISE EXCEPTION 'media_review_rounds: only a draft round may be deleted'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    -- A settled round is immutable: the decision and its stamp are the record.
    IF OLD.state IN ('approved', 'rejected') THEN
        IF NEW.state <> OLD.state
           OR NEW.title IS DISTINCT FROM OLD.title
           OR NEW.note IS DISTINCT FROM OLD.note
           OR NEW.decision_note IS DISTINCT FROM OLD.decision_note
           OR NEW.decided_by_name IS DISTINCT FROM OLD.decided_by_name
           OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
           OR NEW.project_id IS DISTINCT FROM OLD.project_id
           OR NEW.client_party_id IS DISTINCT FROM OLD.client_party_id
           OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
            RAISE EXCEPTION 'media_review_rounds: a decided round is history'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- A round that is with the client, or was and came back, keeps its title and
    -- its scope: those are what the client was shown.
    IF OLD.state IN ('sent', 'withdrawn') THEN
        IF NEW.title IS DISTINCT FROM OLD.title
           OR NEW.project_id IS DISTINCT FROM OLD.project_id
           OR NEW.client_party_id IS DISTINCT FROM OLD.client_party_id
           OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id THEN
            RAISE EXCEPTION 'media_review_rounds: a sent round keeps the scope the client was shown'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- Stamps are set once. Re-sending a round that came back for changes is a
    -- new attempt, but the first sending is a fact and stays a fact.
    IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS NULL THEN
        RAISE EXCEPTION 'media_review_rounds: a sending is not unsent'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_review_rounds_guard
    BEFORE UPDATE OR DELETE ON media_review_rounds
    FOR EACH ROW EXECUTE FUNCTION media_review_round_guard();

-- An item follows its round: nothing is added to a round the client is reading,
-- and nothing is decided on a round that was never sent.
--
-- The second half is the one that matters. A decision recorded against a draft
-- round would let an agency approve its own work before the client ever saw it,
-- and the row would read exactly like a client approval.
CREATE OR REPLACE FUNCTION media_review_item_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    round_state text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT state INTO round_state FROM media_review_rounds WHERE id = OLD.round_id;
        -- No round means this delete is the cascade from deleting the round
        -- itself, which the round guard already limits to drafts.
        IF NOT FOUND THEN
            RETURN OLD;
        END IF;
        -- Taking an asset back out of a round the client is reading changes what
        -- they were shown, by the same route as editing the round's scope. The
        -- three states that still accept assets are exactly the three
        -- `isReviewRoundOpenForItems` names in src/lib/media-review.ts, so the
        -- database and the vocabulary cannot drift apart.
        IF round_state NOT IN ('draft', 'changes_requested', 'rejected') THEN
            RAISE EXCEPTION 'media_review_round_items: a sent round keeps the assets it was sent with'
                USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    SELECT state INTO round_state FROM media_review_rounds WHERE id = NEW.round_id;
    IF round_state IS NULL THEN
        RAISE EXCEPTION 'media_review_round_items: round does not exist'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- Assembling a round is what a draft is for, and what a round sent back
        -- for changes is for; a settled or withdrawn round takes nothing new.
        IF round_state NOT IN ('draft', 'changes_requested', 'rejected') THEN
            RAISE EXCEPTION 'media_review_round_items: this round is closed to new assets'
                USING ERRCODE = '23514';
        END IF;
        IF NEW.state <> 'pending' THEN
            RAISE EXCEPTION 'media_review_round_items: an asset joins a round undecided'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    -- Only a round the client is actually holding may be decided on.
    IF round_state <> 'sent' AND NEW.state <> OLD.state THEN
        RAISE EXCEPTION 'media_review_round_items: only a sent round may be decided'
            USING ERRCODE = '23514';
    END IF;

    -- Once an item is decided it stays decided; changing a client's answer is
    -- the audit trail's whole reason to exist, so it is refused rather than
    -- logged.
    IF OLD.state <> 'pending' AND NEW.state <> OLD.state THEN
        RAISE EXCEPTION 'media_review_round_items: a decision is not revised in place'
            USING ERRCODE = '23514';
    END IF;

    -- The asset an item points at is the asset that was reviewed.
    IF NEW.asset_id <> OLD.asset_id THEN
        RAISE EXCEPTION 'media_review_round_items: an item is replaced, never repointed'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_review_items_guard
    BEFORE INSERT OR UPDATE OR DELETE ON media_review_round_items
    FOR EACH ROW EXECUTE FUNCTION media_review_item_guard();
