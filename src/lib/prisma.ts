import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
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
  // 1. DIRECT_URL or LOCAL_DATABASE_URL (postgres://)
  //    → Direct Postgres via @prisma/adapter-pg. Default for all environments.
  //      Zero per-op cost. Works on Vercel, local dev, scripts, Inngest.
  //
  // 2. DATABASE_URL fallback only when it's direct postgres://
  //
  // Accelerate URLs (prisma+postgres:// / prisma://) are not supported in this
  // runtime contract.

  normalizeServerEnv();

  const directUrl = resolveDirectDatabaseUrl();
  const runtimeDatabaseUrl = normalizeEnvValue(process.env.DATABASE_URL);
  const isAccelerateUrl =
    runtimeDatabaseUrl != null && /^prisma(\+postgres)?:\/\//i.test(runtimeDatabaseUrl);

  let databaseUrl: string;

  if (directUrl) {
    // Default: direct Postgres — zero Accelerate cost
    databaseUrl = directUrl;
  } else if (runtimeDatabaseUrl) {
    if (isAccelerateUrl) {
      throw new Error(
        "[prisma] Accelerate URLs are disabled for this runtime contract. " +
          "Set DIRECT_URL or LOCAL_DATABASE_URL (preferred), or use a direct postgres DATABASE_URL.",
      );
    }
    // Fallback to DATABASE_URL only when it's direct postgres URL.
    databaseUrl = runtimeDatabaseUrl;
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
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  const client = baseClient;

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
