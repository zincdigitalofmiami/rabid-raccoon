import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaUrl?: string;
};

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
  // 3. DATABASE_URL as fallback (postgres:// or prisma+postgres://)
  //    → Legacy path. If DATABASE_URL is an Accelerate URL and USE_ACCELERATE
  //      is not set, we still use it but log a warning.

  const forceAccelerate = process.env.USE_ACCELERATE === "1";
  const directUrl = process.env.DIRECT_URL || process.env.LOCAL_DATABASE_URL;

  // Determine which URL to use
  let databaseUrl: string;
  let mode: "direct" | "accelerate";

  if (forceAccelerate && process.env.DATABASE_URL) {
    // Explicit opt-in to Accelerate (for edge caching with cacheStrategy)
    databaseUrl = process.env.DATABASE_URL;
    mode = "accelerate";
  } else if (directUrl) {
    // Default: direct Postgres — zero Accelerate cost
    databaseUrl = directUrl;
    mode = "direct";
  } else if (process.env.DATABASE_URL) {
    // Fallback to DATABASE_URL whatever it is
    databaseUrl = process.env.DATABASE_URL;
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
      "No database URL configured. Set DIRECT_URL, LOCAL_DATABASE_URL, or DATABASE_URL.",
    );
  }

  // Return cached client if URL hasn't changed
  if (globalForPrisma.prisma && globalForPrisma.prismaUrl === databaseUrl) {
    return globalForPrisma.prisma;
  }

  // Build the client
  const isDirectPostgres = /^postgres(ql)?:\/\//i.test(databaseUrl);
  const adapter = isDirectPostgres
    ? new PrismaPg({ connectionString: databaseUrl })
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

  // Cache in dev to avoid hot-reload connection storms
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
    globalForPrisma.prismaUrl = databaseUrl;
  }

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
