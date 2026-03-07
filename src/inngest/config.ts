type Env = NodeJS.ProcessEnv;
const DEFAULT_LOCAL_SERVE_HOST = "http://host.docker.internal:3001";

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isUnsafeProdHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "host.docker.internal" ||
    host.startsWith("127.") ||
    host.endsWith(".local")
  );
}

export function isVercelProduction(env: Env = process.env): boolean {
  return (
    env.VERCEL === "1" &&
    env.VERCEL_ENV === "production" &&
    env.NODE_ENV === "production" &&
    env.LOCAL_DEV !== "1"
  );
}

function shouldForceLocalServeHost(env: Env = process.env): boolean {
  if (isVercelProduction(env)) return false;
  if (env.LOCAL_DEV === "1") return true;
  const base = firstNonEmpty(env.INNGEST_BASE_URL);
  return Boolean(base && /^https?:\/\/localhost(?::\d+)?$/i.test(base));
}

function normalizeOrigin(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function resolveLocalServeHost(env: Env = process.env): string | undefined {
  if (!shouldForceLocalServeHost(env)) return undefined;
  const raw = firstNonEmpty(env.INNGEST_LOCAL_SERVE_HOST, DEFAULT_LOCAL_SERVE_HOST);
  return raw ? normalizeOrigin(raw) : undefined;
}

export function scrubInngestCloudEnvForLocalDev(env: Env = process.env): string[] {
  if (isVercelProduction(env)) return [];

  const keys = ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "INNGEST_SERVE_HOST"] as const;
  const scrubbed: string[] = [];

  for (const key of keys) {
    if (env[key]) {
      delete env[key];
      scrubbed.push(key);
    }
  }

  return scrubbed;
}

export function resolveInngestKeys(env: Env = process.env): {
  eventKey?: string;
  signingKey?: string;
} {
  const eventKey = firstNonEmpty(env.INNGEST_EVENT_KEY, env.RRInngest_INNGEST_EVENT_KEY);
  const signingKey = firstNonEmpty(env.INNGEST_SIGNING_KEY, env.RRInngest_INNGEST_SIGNING_KEY);
  return { eventKey, signingKey };
}

// In local/dev we intentionally omit serveHost to avoid advertising cloud URLs.
export function resolveServeHost(env: Env = process.env): string | undefined {
  const localHost = resolveLocalServeHost(env);
  if (localHost) return localHost;
  if (!isVercelProduction(env)) return undefined;

  const rawHost = firstNonEmpty(env.INNGEST_SERVE_HOST);
  if (!rawHost) return undefined;

  try {
    const parsed = new URL(rawHost);
    if (parsed.protocol !== "https:") return undefined;
    if (isUnsafeProdHost(parsed.hostname)) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

export function getInngestConfigWarnings(env: Env = process.env): string[] {
  const warnings: string[] = [];
  const isProd = isVercelProduction(env);
  const localHost = resolveLocalServeHost(env);
  const configuredServeHost = firstNonEmpty(env.INNGEST_SERVE_HOST);
  const resolvedServeHost = resolveServeHost(env);
  const { eventKey, signingKey } = resolveInngestKeys(env);

  if (!isProd && localHost) {
    warnings.push(`Using local Inngest serveHost override: ${localHost}`);
  }

  if (!isProd && configuredServeHost) {
    warnings.push(
      "INNGEST_SERVE_HOST is set outside Vercel production and will be ignored to prevent local/cloud sync drift."
    );
  }

  if (isProd && configuredServeHost && !resolvedServeHost) {
    warnings.push(
      "INNGEST_SERVE_HOST is invalid for production (must be an https origin and not localhost/internal). serveHost omitted."
    );
  }

  if (!eventKey) {
    warnings.push("No Inngest event key found (INNGEST_EVENT_KEY or RRInngest_INNGEST_EVENT_KEY).");
  }

  if (!signingKey) {
    warnings.push(
      "No Inngest signing key found (INNGEST_SIGNING_KEY or RRInngest_INNGEST_SIGNING_KEY)."
    );
  }

  return warnings;
}
