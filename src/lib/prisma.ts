import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaUrl?: string;
};

function normalizeDatabaseUrl(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/(?:\\n|\n)+$/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

function positiveIntFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPrismaClient(): PrismaClient {
  // Connection priority (first match wins):
  //
  // 1. USE_ACCELERATE=1 + DATABASE_URL (prisma+postgres://)
  //    → Accelerate proxy. Only enable when you actually use cacheStrategy
  //      in queries. Otherwise it's just an expensive passthrough.
  //
  // 2. DIRECT_URL (postgres://)
  //    → Direct Postgres via @prisma/adapter-pg. Default for all environments.
  //      Zero per-operation cost. Works on Vercel, Inngest, and local scripts.
  //
  // 3. DATABASE_URL as fallback (postgres:// or prisma+postgres://)
  //    → Legacy path. If DATABASE_URL is an Accelerate URL and USE_ACCELERATE
  //      is not set, we still use it but log a warning.

  const forceAccelerate = process.env.USE_ACCELERATE === "1";
  const directUrl = normalizeDatabaseUrl(process.env.DIRECT_URL);
  const accelerateDatabaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);

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
    // Fallback to DATABASE_URL whatever it is
    databaseUrl = accelerateDatabaseUrl;
    const isAccelerateUrl = /^prisma(\+postgres)?:\/\//i.test(databaseUrl);
    mode = isAccelerateUrl ? "accelerate" : "direct";
    if (isAccelerateUrl) {
      console.warn(
        "[prisma] WARNING: Using Accelerate proxy without USE_ACCELERATE=1. " +
          "Set DIRECT_URL to avoid per-operation Accelerate charges, or set " +
          "USE_ACCELERATE=1 to silence this warning.",
      );
    }
  } else {
    throw new Error(
      "No database URL configured. Set DIRECT_URL (or DATABASE_URL for Accelerate).",
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
