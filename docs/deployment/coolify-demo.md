# Private Demo deployment in Coolify

Use a separate Coolify project and preferably a separate server. Deploy `deploy/demo/compose.yaml` as a Docker Compose resource from a release containing the Demo startup and scheduler changes. Use the same tested Biza Miz image digest you intend to promote to production. The Demo resource has independent deploy, migration, and stop controls. [Coolify Compose documentation](https://coolify.io/docs/services/configuration/docker-compose)

| Service | Access |
| --- | --- |
| `web` | Uses the restricted `demo_app` PostgreSQL role. |
| `migrate` | Runs migrations and provisions `demo_app`. Its PostgreSQL owner credentials are scoped to the Demo cluster. |
| `db`, `redis`, `storage` | Own separate Demo volumes and credentials. The object-store admin stays in the storage service. |

The private stack publishes no ports. Keep Coolify's predefined network disabled and leave Domains empty for this bring-up. After the public demo app and its safety policy are ready, route TLS ingress through a dedicated proxy that can reach the Demo web service. Keep the web and data services on the private network and rerun the network checks after introducing the proxy. Use Docker Engine with support for the isolated bridge gateway mode and a Compose version supporting inline configs. [Docker network modes](https://docs.docker.com/engine/network/port-publishing/#gateway-modes)

## Configure the resource

| Coolify variable | Value |
| --- | --- |
| `DEMO_APP_IMAGE` | The tested Biza Miz GHCR image at `@sha256:<digest>`. |
| `DEMO_POSTGRES_IMAGE` | A PostgreSQL 16 official image pinned by digest. The data volume uses its standard PGDATA path. |
| `DEMO_REDIS_IMAGE` | A Redis official image pinned by digest. |
| `DEMO_STORAGE_IMAGE` | An approved MinIO-compatible server image pinned by digest. The manifest expects its standard MinIO entrypoint and port 9000. |
| `DEMO_DATABASE_ID` | A new lowercase UUID. Keep it stable for the life of this database volume. |
| `DEMO_MIGRATOR_PASSWORD`, `DEMO_APP_DB_PASSWORD`, `DEMO_REDIS_PASSWORD`, `DEMO_STORAGE_ADMIN_PASSWORD` | Generate an independent 64-character lowercase hexadecimal value for each, for example with separate `openssl rand -hex 32` invocations. Hexadecimal values are safe in the Compose database URLs and Redis config. |
| `DEMO_JWT_SECRET`, `DEMO_MASTER_KEY`, `DEMO_SESSION_SECRET`, `DEMO_HEALTH_VERSION_TOKEN` | Generate an independent 64-character lowercase hexadecimal value for each. Store them as runtime secrets. |

The first PostgreSQL initialization writes the database marker. Later boots verify it. A changed UUID or an existing unmarked volume must fail the migration check. If either happens, inspect the volume assignment and restore the correct UUID for that known Demo volume. Create a fresh Demo volume for a new deployment. The web service starts only after the migration job succeeds and verifies the marker and restricted database role before opening its HTTP listener.

Before deploying, check the rendered images without printing interpolated secrets. On the deployment host, load the Demo-only variables and run:

```sh
docker compose -f deploy/demo/compose.yaml config --images
```

Verify every reference ends in `@sha256:` followed by 64 hexadecimal characters and that the app digest matches the tested release. Coolify's rendered service configuration should have no port mappings and each container should have only the private Demo network.

## Verify the private deployment

1. Confirm `migrate` exited successfully and `web` and `redis` are healthy. Check the web image's build version using its health token. Confirm the web database role is `demo_app`.
2. From a trusted operator network, identify known-listening canaries or actual endpoint IPs for production PostgreSQL, Redis, object storage, private APIs and the host or metadata network. Verify they answer there. From the Demo **web container**, run the following, replacing both example targets and supplying all relevant IP/port pairs. Use the Coolify container terminal or `docker compose exec -T web`.

   ```sh
   node scripts/verify-demo-network.mjs 192.0.2.10:5432 192.0.2.20:443
   ```

   The command must reach the three Demo services and fail to connect to every supplied target. Repeat from each Demo worker once installed. Test every routable address, including IPv6 when enabled.
3. From an authorized operator environment, test that Demo credentials cannot authenticate to production PostgreSQL, Redis or S3. Use fresh Demo credentials and a non-mutating request. Verify the Demo database is synthetic and the storage account has access only to the dedicated Demo bucket. Configure application storage with that bucket-scoped credential after it is provisioned. The storage admin is for provisioning.
4. On a disposable private deployment, change `DEMO_DATABASE_ID` while retaining its database volume. Confirm migrations fail and the app never becomes healthy. Restore the original UUID and repeat the health and network checks.

## Operate and promote

- Start with one web replica. Reserve at least 6 GiB for the listed services and leave headroom for the host, proxy and future worker. Watch memory, container restarts, disk capacity and session volume. Use a separate monitoring destination for Demo. Apply TLS and ingress abuse limits before exposing the demo hostname.
- For an emergency stop, remove or disable Demo ingress first, then stop the Demo resource and any Demo worker. Check that the public route no longer responds and keep its volumes for diagnosis. Retain the Demo-only operational and recovery credentials separately.
- Record each release digest and its schema compatibility. Roll back to the previous tested digest if its schema expectations are compatible. For incompatible migrations, recover in a fresh isolated Demo environment with synthetic data and rotate active Demo session credentials before restoring ingress.
- The private bring-up disables the regular application schedulers and AI gateway. Deploy the Demo cleanup worker after [GitHub #1342](https://github.com/hamidnoshady/biza-miz/issues/1342), and configure a Demo-only AI gateway and quota when outbound policy is in place. Require the application DemoPolicy from [GitHub #1341](https://github.com/hamidnoshady/biza-miz/issues/1341) and repeat network, credential and public demo smoke checks before opening DNS and TLS ingress.
