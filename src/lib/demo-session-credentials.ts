import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const DATABASE_ID = new RegExp(`^${UUID}$`);
const START_KEY = /^([0-9]{13}\.[a-f0-9]{64})\.([a-f0-9]{64})$/;
const CREDENTIAL = new RegExp(`^(${UUID})\\.([a-f0-9]{64})$`);

export interface DemoDeployment {
  databaseId: string;
  sessionSecret: Buffer;
}

export function isDemoDeployment(): boolean {
  return process.env.BIZAMIZ_DEPLOYMENT_PROFILE === "demo";
}

export function requireDemoDeployment(): DemoDeployment {
  if (!isDemoDeployment()) throw new Error("demo_deployment_required");
  const databaseId = process.env.DEMO_DATABASE_ID ?? "";
  const secret = process.env.DEMO_SESSION_SECRET ?? "";
  if (!DATABASE_ID.test(databaseId) || !/^[a-f0-9]{64}$/.test(secret)) {
    throw new Error("demo_deployment_misconfigured");
  }
  return { databaseId, sessionSecret: Buffer.from(secret, "hex") };
}

function demoMac(config: DemoDeployment, purpose: "start" | "session", key: string): string {
  return createHmac("sha256", config.sessionSecret)
    .update(`bizamiz-demo:${purpose}:${config.databaseId}:${key}`)
    .digest("hex");
}

/** Issue server-side and reuse the same key for retries of a single start. */
export function createDemoStartKey(): string {
  const config = requireDemoDeployment();
  const key = `${Date.now() + 10 * 60 * 1000}.${randomBytes(32).toString("hex")}`;
  return `${key}.${demoMac(config, "start", key)}`;
}

export function demoStartProof(startKey: string, config: DemoDeployment) {
  const match = START_KEY.exec(startKey);
  if (!match) return null;
  const [, key, signature] = match;
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(demoMac(config, "start", key), "hex"))) {
    return null;
  }
  return { secret: demoMac(config, "session", key), startBefore: new Date(Number(key.slice(0, 13))) };
}

export function demoTokenHash(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function parseDemoCredential(token: string) {
  const match = CREDENTIAL.exec(token);
  return match ? { businessId: match[1], secret: match[2] } : null;
}
