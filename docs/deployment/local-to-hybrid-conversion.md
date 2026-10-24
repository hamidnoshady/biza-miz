# Local → Hybrid conversion runbook

This conversion does **not** toggle a feature flag and never resets the Local database. It is an operator-assisted two-phase process because automatically merging two independently-used financial databases is unsafe.

## Preconditions

1. Take and verify a Local backup.
2. Migrate both installations to the same schema version.
3. The Cloud target must not already contain the Local `business_id`. The tool intentionally refuses merges.
4. Use an administrative Cloud database URL capable of the existing tenant-restore operation. Keep both database URLs outside shell history where possible.

## Phase 1: bootstrap, sync disabled

On the Local installation, set `DATABASE_URL` to its database and run:

```bash
npm run deployment:convert-hybrid -- \
  --business-id <uuid> \
  --central-database-url <cloud-admin-database-url> \
  --remote-url https://pos.example.com \
  --yes
```

The tool:

- checks that every migration version matches;
- refuses if the Cloud already has the business;
- excludes printer, backup, certificate/database filesystem state, relay queue, and old sync/deployment settings;
- exports the existing production tenant without deleting or rewriting Local rows;
- performs a full transactional Cloud dry run before applying anything;
- restores the exact stable business/location/entity IDs;
- never copies a DEK wrapped under the Local installation key; plaintext export columns are restored and, when Local encryption was active, activation remains blocked until `npm run db:encrypt-fields` has minted/backfilled a Cloud-owned key;
- provisions a revocable site credential;
- writes Local sync configuration with `enabled: false`;
- leaves the Local profile unchanged.

Any constraint collision aborts rather than merging.

## Operator verification

Confirm the Cloud business, opening balances, inventory valuation, user count, order count, and media metadata. Keep the Local application in normal Local operation during review; continuous sync remains disabled.

## Phase 2: deliberate activation

Run the same command with `--activate`:

```bash
npm run deployment:convert-hybrid -- \
  --business-id <uuid> \
  --central-database-url <cloud-admin-database-url> \
  --remote-url https://pos.example.com \
  --activate --yes
```

Activation rechecks schema versions and verifies the Cloud site credential, location, and business identity. Only then does one Local transaction enable sync and write `deployment.profile=hybrid`. Local remains authoritative for operational writes.

The tool never supports an automatic Cloud/Local merge. If the Cloud target already contains independently-created data, reconcile it explicitly with domain-specific import/reversal tools before attempting conversion.
