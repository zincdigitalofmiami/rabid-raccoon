import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";
import {
  normalizeEnvValue,
  normalizeServerEnv,
  resolveDirectDatabaseUrl,
} from "./server-env";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaUrl?: string;
};

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(normalizeEnvValue(value) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPrismaClient(): PrismaClient {
  // Connection priority (first match wins):
  //
  // 1. USE_ACCELERATE=1 + DATABASE_URL (prisma+postgres://)
  //    → Accelerate proxy. Only enable when you actually use cacheStrategy
  //      in queries. Otherwise it's just an expensive passthrough.
  //
  // 2. DIRECT_URL or LOCAL_DATABASE_URL (postgres://)
  //    → Direct Postgres via @prisma/adapter-pg. Default for all environments.
  //      Zero per-op cost. Works on Vercel, local dev, scripts, Inngest.
  //
  // 3. DATABASE_URL as fallback only when it's direct postgres://
  //    → If DATABASE_URL is an Accelerate URL, require explicit USE_ACCELERATE=1.

  normalizeServerEnv();

  const forceAccelerate = normalizeEnvValue(process.env.USE_ACCELERATE) === "1";
  const directUrl = resolveDirectDatabaseUrl();
  const accelerateDatabaseUrl = normalizeEnvValue(process.env.DATABASE_URL);

  // Determine which URL to use
  let databaseUrl: string;
  let mode: "direct" | "accelerate";

  if (forceAccelerate && accelerateDatabaseUrl) {
    // Explicit opt-in to Accelerate (for edge caching with cacheStrategy)
    databaseUrl = accelerateDatabaseUrl;
    mode = "accelerate";
  } else if (directUrl) {
    // Default: direct Postgres — zero Accelerate cost
    databaseUrl = directUrl;
    mode = "direct";
  } else if (accelerateDatabaseUrl) {
    const isAccelerateUrl = /^prisma(\+postgres)?:\/\//i.test(accelerateDatabaseUrl);
    if (isAccelerateUrl) {
      throw new Error(
        "[prisma] DIRECT_URL or LOCAL_DATABASE_URL is required for direct runtime access. " +
          "DATABASE_URL points to Accelerate; set USE_ACCELERATE=1 only when explicitly opting in.",
      );
    }
    // Fallback to DATABASE_URL only when it's a direct postgres URL.
    databaseUrl = accelerateDatabaseUrl;
    mode = "direct";
  } else {
    throw new Error(
      "No database URL configured. Set DIRECT_URL, LOCAL_DATABASE_URL, or DATABASE_URL.",
    );
  }

  // Return cached client if URL hasn't changed
  if (globalForPrisma.prisma && globalForPrisma.prismaUrl === databaseUrl) {
    return globalForPrisma.prisma;
  }

  // Build the client
  const isDirectPostgres = /^postgres(ql)?:\/\//i.test(databaseUrl);
  const pgPoolMax = positiveIntFromEnv(process.env.PRISMA_POOL_MAX, 2);
  const pgConnectionTimeoutMs = positiveIntFromEnv(
    process.env.PRISMA_POOL_CONNECTION_TIMEOUT_MS,
    5_000,
  );
  const pgIdleTimeoutMs = positiveIntFromEnv(
    process.env.PRISMA_POOL_IDLE_TIMEOUT_MS,
    5_000,
  );
  const adapter = isDirectPostgres
    ? new PrismaPg({
        connectionString: databaseUrl,
        max: pgPoolMax,
        connectionTimeoutMillis: pgConnectionTimeoutMs,
        idleTimeoutMillis: pgIdleTimeoutMs,
      })
    : undefined;

  const baseClient = new PrismaClient({
    ...(adapter ? { adapter } : {}),
    ...(mode === "accelerate" ? { accelerateUrl: databaseUrl } : {}),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  const client =
    mode === "accelerate"
      ? (baseClient.$extends(withAccelerate()) as unknown as PrismaClient)
      : baseClient;

  // Cache in all environments. In production serverless runtimes this avoids
  // creating many Prisma clients per invocation and exhausting DB connections.
  globalForPrisma.prisma = client;
  globalForPrisma.prismaUrl = databaseUrl;

  return client;
}

const prismaProxy = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrismaClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export const prisma: PrismaClient = prismaProxy;
