/**
 * A Postgres-wire server backed by PGlite, so the database integration suite
 * can run where no real Postgres is available.
 *
 * Why this exists: `npm run test:db` needs a server it can reach over TCP with
 * `pg`, and each suite creates its own scratch database (`pos_<suite>_<uuid>`),
 * migrates it, and drops it afterwards. PGlite is a genuine Postgres compiled
 * to WASM, so it runs the real SQL — but one instance *is* one database, and
 * `@electric-sql/pglite-socket` serves its single instance to every connection
 * regardless of the database named in the startup packet. Pointing the suite
 * straight at it silently lands every connection back on `postgres`, which has
 * none of the migrations; the failures then look like connection errors rather
 * than "you are on the wrong database".
 *
 * So this listens on one port, reads the startup packet to learn which
 * database the client wants, and forwards the connection to a per-database
 * PGLiteSocketServer that it starts on demand on an ephemeral port. Each
 * database therefore gets its own real instance, and CREATE/DROP DATABASE in
 * the maintenance connection are no-ops that simply make the name resolvable.
 *
 * This is a local convenience, NOT a replacement for CI. PGlite serves one
 * connection at a time per instance (run the suite with DB_POOL_MAX=1) and so
 * cannot exercise the cross-session contention that branch-service.ts's
 * advisory locks exist for. The GitHub Actions `test` workflow, with a real
 * postgres:16 service, remains the authority.
 *
 * The two packages it needs are deliberately NOT in package.json: they carry a
 * ~27MB WASM build that nothing in the app or in CI uses, and adding them
 * would put that in every install for a fallback most contributors never
 * reach. Install them on demand instead.
 *
 * Usage:
 *   npm i --no-save @electric-sql/pglite @electric-sql/pglite-socket
 *   node scripts/pglite-wire-server.mjs &
 *   DATABASE_URL=postgres://postgres:x@127.0.0.1:5432/postgres \
 *   DB_POOL_MAX=1 npm run test:db
 *
 * DB_POOL_MAX=1 is not optional: PGlite executes one statement at a time, and
 * a larger pool just queues sockets behind a backend that cannot use them.
 */
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = Number(process.env.PGLITE_PORT || 5432);
const HOST = process.env.PGLITE_HOST || "127.0.0.1";

/** database name -> { server, port } for the backend serving it. */
const backends = new Map();
/** In-flight starts, so two simultaneous connections don't start two backends. */
const starting = new Map();

async function backendFor(name) {
  const existing = backends.get(name);
  if (existing) return existing;
  if (starting.has(name)) return starting.get(name);

  const boot = (async () => {
    const db = await PGlite.create({ extensions: { btree_gist, citext, pgcrypto } });
    // Port 0 = let the OS pick. maxConnections must be raised from the
    // default of 1: the suites hold a long-lived admin client open for
    // fixtures *and* exercise the app's own pool at the same time, so one
    // connection is refused outright and surfaces as "Connection terminated
    // unexpectedly". The backend still executes queries one at a time through
    // pglite-socket's queue; this only allows several idle sockets.
    const server = new PGLiteSocketServer({
      db,
      port: 0,
      host: "127.0.0.1",
      maxConnections: 50,
    });
    await server.start();
    const entry = { db, server, port: server.port };
    backends.set(name, entry);
    starting.delete(name);
    return entry;
  })();

  starting.set(name, boot);
  return boot;
}

/** Reads the database name out of a Postgres startup packet. */
function parseStartup(buf) {
  if (buf.length < 8) return null;
  const length = buf.readInt32BE(0);
  if (buf.length < length) return null;
  const code = buf.readInt32BE(4);
  if (code === 80877103 || code === 80877102) {
    return { special: code === 80877103 ? "ssl" : "cancel" };
  }
  const params = {};
  let i = 8;
  while (i < length) {
    const end = buf.indexOf(0, i);
    if (end < 0 || end >= length) break;
    const key = buf.toString("utf8", i, end);
    if (!key) break;
    const vEnd = buf.indexOf(0, end + 1);
    params[key] = buf.toString("utf8", end + 1, vEnd);
    i = vEnd + 1;
  }
  return { params, consumed: length };
}

const server = net.createServer((client) => {
  let buffered = Buffer.alloc(0);
  let routed = false;

  const onData = async (chunk) => {
    if (routed) return;
    buffered = Buffer.concat([buffered, chunk]);
    const startup = parseStartup(buffered);
    if (!startup) return;

    if (startup.special === "ssl") {
      // Decline TLS; the client retries in cleartext on the same socket.
      buffered = buffered.subarray(8);
      client.write(Buffer.from("N"));
      return;
    }
    if (startup.special === "cancel") {
      client.destroy();
      return;
    }

    routed = true;
    client.off("data", onData);
    client.pause();

    const name = startup.params?.database || "postgres";
    try {
      const { port } = await backendFor(name);
      // Plain TCP pipe from here on: the backend performs the handshake
      // itself, so the untouched startup packet is simply forwarded.
      const upstream = net.connect(port, "127.0.0.1", () => {
        upstream.write(buffered);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    } catch (err) {
      console.error(`pglite-wire: cannot serve "${name}":`, err?.message);
      client.destroy();
    }
  };

  client.on("data", onData);
  client.on("error", () => {});
});

server.listen(PORT, HOST, () => {
  console.log(`pglite-wire: listening on ${HOST}:${PORT}`);
});
