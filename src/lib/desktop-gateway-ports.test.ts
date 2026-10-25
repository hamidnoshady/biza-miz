import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { loadOrCreateConfig } = require("../../electron/backend-manager.js");

function xor(value: Buffer): Buffer {
  return Buffer.from(value.map((byte, index) => byte ^ (0x5a ^ (index % 17))));
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => xor(Buffer.from(value, "utf8")),
  decryptString: (value: Buffer) => xor(value).toString("utf8"),
};

it("reselects and persists an adjacent port pair if either saved port is occupied", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gateway-ports-"));
  const blocker = net.createServer();
  try {
    const first = await loadOrCreateConfig(dir, { safeStorage });
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(first.config.gatewayPort + 1, "0.0.0.0", resolve);
    });
    const second = await loadOrCreateConfig(dir, { safeStorage });
    expect(second.config.gatewayPort).not.toBe(first.config.gatewayPort);
    expect(second.config.gatewayPort).not.toBe(first.config.gatewayPort + 1);
    expect((await loadOrCreateConfig(dir, { safeStorage })).config.gatewayPort).toBe(second.config.gatewayPort);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
