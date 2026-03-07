import assert from "node:assert/strict";
import test from "node:test";
import {
  getInngestConfigWarnings,
  isVercelProduction,
  resolveInngestKeys,
  resolveLocalServeHost,
  resolveServeHost,
  scrubInngestCloudEnvForLocalDev,
} from "../src/inngest/config";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

test("isVercelProduction only passes for Vercel production tuple", () => {
  assert.equal(
    isVercelProduction(env({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" })),
    true
  );
  assert.equal(
    isVercelProduction(env({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "development" })),
    false
  );
  assert.equal(
    isVercelProduction(
      env({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", LOCAL_DEV: "1" })
    ),
    false
  );
  assert.equal(
    isVercelProduction(env({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" })),
    false
  );
  assert.equal(
    isVercelProduction(env({ VERCEL: "0", VERCEL_ENV: "production", NODE_ENV: "production" })),
    false
  );
});

test("resolveServeHost ignores configured host outside Vercel production", () => {
  const value = resolveServeHost(
    env({
      VERCEL: "0",
      VERCEL_ENV: "development",
      INNGEST_SERVE_HOST: "https://rabid-raccoon.vercel.app",
      VERCEL_URL: "leaked-preview.vercel.app",
    })
  );
  assert.equal(value, undefined);
});

test("resolveLocalServeHost defaults to host.docker.internal in local dev", () => {
  const value = resolveLocalServeHost(
    env({
      LOCAL_DEV: "1",
      INNGEST_BASE_URL: "http://localhost:8288",
    })
  );
  assert.equal(value, "http://host.docker.internal:3001");
});

test("resolveLocalServeHost accepts validated local override", () => {
  const value = resolveLocalServeHost(
    env({
      LOCAL_DEV: "1",
      INNGEST_LOCAL_SERVE_HOST: "http://127.0.0.1:3001/api/inngest?x=1",
    })
  );
  assert.equal(value, "http://127.0.0.1:3001");
});

test("resolveServeHost returns normalized origin for valid production host", () => {
  const value = resolveServeHost(
    env({
      VERCEL: "1",
      VERCEL_ENV: "production",
      NODE_ENV: "production",
      INNGEST_SERVE_HOST: "https://rabid-raccoon.vercel.app/api/inngest?foo=bar",
    })
  );
  assert.equal(value, "https://rabid-raccoon.vercel.app");
});

test("resolveServeHost rejects insecure and internal production hosts", () => {
  assert.equal(
    resolveServeHost(
      env({
        VERCEL: "1",
        VERCEL_ENV: "production",
        NODE_ENV: "production",
        INNGEST_SERVE_HOST: "http://rabid-raccoon.vercel.app",
      })
    ),
    undefined
  );

  assert.equal(
    resolveServeHost(
      env({
        VERCEL: "1",
        VERCEL_ENV: "production",
        NODE_ENV: "production",
        INNGEST_SERVE_HOST: "https://localhost:3001",
      })
    ),
    undefined
  );
});

test("resolveInngestKeys prefers canonical env names but supports RR fallback names", () => {
  const fallback = resolveInngestKeys(
    env({
      RRInngest_INNGEST_EVENT_KEY: "rr-event",
      RRInngest_INNGEST_SIGNING_KEY: "rr-sign",
    })
  );
  assert.equal(fallback.eventKey, "rr-event");
  assert.equal(fallback.signingKey, "rr-sign");

  const canonical = resolveInngestKeys(
    env({
      INNGEST_EVENT_KEY: "canonical-event",
      INNGEST_SIGNING_KEY: "canonical-sign",
      RRInngest_INNGEST_EVENT_KEY: "rr-event",
      RRInngest_INNGEST_SIGNING_KEY: "rr-sign",
    })
  );
  assert.equal(canonical.eventKey, "canonical-event");
  assert.equal(canonical.signingKey, "canonical-sign");
});

test("getInngestConfigWarnings reports dangerous non-prod serve host and missing keys", () => {
  const warnings = getInngestConfigWarnings(
    env({
      VERCEL: "0",
      VERCEL_ENV: "development",
      INNGEST_SERVE_HOST: "https://rabid-raccoon.vercel.app",
    })
  );

  assert.equal(
    warnings.some((w) => w.includes("INNGEST_SERVE_HOST is set outside Vercel production")),
    true
  );
  assert.equal(warnings.some((w) => w.includes("No Inngest event key found")), true);
  assert.equal(warnings.some((w) => w.includes("No Inngest signing key found")), true);
});

test("scrubInngestCloudEnvForLocalDev removes leaked cloud env in local contexts", () => {
  const localEnv = env({
    VERCEL: "1",
    VERCEL_ENV: "production",
    NODE_ENV: "development",
    VERCEL_URL: "rabid-raccoon.vercel.app",
    INNGEST_SERVE_HOST: "https://rabid-raccoon.vercel.app",
  });

  const scrubbed = scrubInngestCloudEnvForLocalDev(localEnv);
  assert.deepEqual(scrubbed.sort(), ["INNGEST_SERVE_HOST", "VERCEL", "VERCEL_ENV", "VERCEL_URL"]);
  assert.equal(localEnv.VERCEL, undefined);
  assert.equal(localEnv.VERCEL_ENV, undefined);
  assert.equal(localEnv.VERCEL_URL, undefined);
  assert.equal(localEnv.INNGEST_SERVE_HOST, undefined);
});

test("scrubInngestCloudEnvForLocalDev preserves env in true Vercel production", () => {
  const prodEnv = env({
    VERCEL: "1",
    VERCEL_ENV: "production",
    NODE_ENV: "production",
    INNGEST_SERVE_HOST: "https://rabid-raccoon.vercel.app",
  });

  const scrubbed = scrubInngestCloudEnvForLocalDev(prodEnv);
  assert.deepEqual(scrubbed, []);
  assert.equal(prodEnv.VERCEL, "1");
  assert.equal(prodEnv.VERCEL_ENV, "production");
  assert.equal(prodEnv.INNGEST_SERVE_HOST, "https://rabid-raccoon.vercel.app");
});
