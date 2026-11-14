import { isIP, createConnection } from "node:net";

function reachable(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 3000 });
    const done = (connected) => {
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function parseTarget(value) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !isIP(host) || port < 1 || port > 65535) {
    throw new Error("Use literal IP:port targets, with brackets for IPv6");
  }
  return { host, port, label: value };
}

try {
  const denied = process.argv.slice(2).map(parseTarget);
  if (!denied.length) throw new Error("Supply at least one non-Demo endpoint to verify");

  const expected = [
    { host: "db", port: 5432 },
    { host: "redis", port: 6379 },
    { host: "storage", port: 9000 },
  ];
  const results = await Promise.all([
    ...expected.map(async ({ host, port }) => ({
      label: `${host}:${port}`,
      ok: await reachable(host, port),
      expected: "reachable",
    })),
    ...denied.map(async ({ host, port, label }) => ({
      label,
      ok: !(await reachable(host, port)),
      expected: "blocked",
    })),
  ]);
  for (const { label, ok, expected } of results) {
    console.log(`${ok ? "PASS" : "FAIL"} ${label} should be ${expected}`);
  }
  if (results.some(({ ok }) => !ok)) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
