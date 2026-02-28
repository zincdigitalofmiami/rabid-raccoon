import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDirectPgUrl, resolvePrismaRuntimeUrl } from '../src/lib/db-url'

const ENV_KEYS = ['NODE_ENV', 'PRISMA_LOCAL', 'PRISMA_DIRECT', 'LOCAL_DATABASE_URL', 'DIRECT_URL', 'DATABASE_URL'] as const

type EnvPatch = Partial<Record<(typeof ENV_KEYS)[number], string>>

function withEnv(patch: EnvPatch, fn: () => void): void {
  const env = process.env as Record<string, string | undefined>
  const previous = new Map<string, string | undefined>()
  for (const key of ENV_KEYS) previous.set(key, env[key])

  for (const key of ENV_KEYS) delete env[key]
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) env[key] = value
  }

  try {
    fn()
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key)
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
}

const LOCAL_URL = 'postgresql://postgres:password@localhost:5432/rabid_raccoon'
const DIRECT_URL = 'postgresql://user:password@db.prisma.io:5432/postgres'
const DATABASE_URL = 'prisma+postgres://accelerate.prisma-data.net/?api_key=test'

test('non-production runtime defaults to LOCAL_DATABASE_URL', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      LOCAL_DATABASE_URL: LOCAL_URL,
      DIRECT_URL,
      DATABASE_URL,
    },
    () => {
      const target = resolvePrismaRuntimeUrl()
      assert.equal(target.source, 'LOCAL_DATABASE_URL')
      assert.equal(target.url, LOCAL_URL)
    }
  )
})

test('non-production direct pg defaults to LOCAL_DATABASE_URL', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      LOCAL_DATABASE_URL: LOCAL_URL,
      DIRECT_URL,
    },
    () => {
      const target = resolveDirectPgUrl()
      assert.equal(target.source, 'LOCAL_DATABASE_URL')
      assert.equal(target.url, LOCAL_URL)
    }
  )
})

test('PRISMA_DIRECT forces DIRECT_URL for runtime and direct pg', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      PRISMA_DIRECT: '1',
      LOCAL_DATABASE_URL: LOCAL_URL,
      DIRECT_URL,
      DATABASE_URL,
    },
    () => {
      const runtime = resolvePrismaRuntimeUrl()
      const direct = resolveDirectPgUrl()
      assert.equal(runtime.source, 'DIRECT_URL')
      assert.equal(direct.source, 'DIRECT_URL')
      assert.equal(runtime.url, DIRECT_URL)
      assert.equal(direct.url, DIRECT_URL)
    }
  )
})

test('PRISMA_LOCAL forces LOCAL_DATABASE_URL for runtime and direct pg', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      PRISMA_LOCAL: '1',
      LOCAL_DATABASE_URL: LOCAL_URL,
      DIRECT_URL,
      DATABASE_URL,
    },
    () => {
      const runtime = resolvePrismaRuntimeUrl()
      const direct = resolveDirectPgUrl()
      assert.equal(runtime.source, 'LOCAL_DATABASE_URL')
      assert.equal(direct.source, 'LOCAL_DATABASE_URL')
    }
  )
})

test('production runtime uses DATABASE_URL and direct pg uses DIRECT_URL', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      LOCAL_DATABASE_URL: LOCAL_URL,
      DIRECT_URL,
      DATABASE_URL,
    },
    () => {
      const runtime = resolvePrismaRuntimeUrl()
      const direct = resolveDirectPgUrl()
      assert.equal(runtime.source, 'DATABASE_URL')
      assert.equal(runtime.url, DATABASE_URL)
      assert.equal(direct.source, 'DIRECT_URL')
      assert.equal(direct.url, DIRECT_URL)
    }
  )
})

test('conflicting force flags throw explicit errors', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      PRISMA_LOCAL: '1',
      PRISMA_DIRECT: '1',
      LOCAL_DATABASE_URL: LOCAL_URL,
      DIRECT_URL,
    },
    () => {
      assert.throws(() => resolvePrismaRuntimeUrl(), /cannot both be 1/)
      assert.throws(() => resolveDirectPgUrl(), /cannot both be 1/)
    }
  )
})

test('missing LOCAL_DATABASE_URL in non-production fails closed', () => {
  withEnv(
    {
      NODE_ENV: 'development',
      DIRECT_URL,
      DATABASE_URL,
    },
    () => {
      assert.throws(() => resolvePrismaRuntimeUrl(), /LOCAL_DATABASE_URL is required by default/)
      assert.throws(() => resolveDirectPgUrl(), /LOCAL_DATABASE_URL is required by default/)
    }
  )
})

test('missing required production urls fail closed', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      DIRECT_URL,
    },
    () => {
      assert.throws(() => resolvePrismaRuntimeUrl(), /DATABASE_URL is required/)
    }
  )

  withEnv(
    {
      NODE_ENV: 'production',
      DATABASE_URL,
    },
    () => {
      assert.throws(() => resolveDirectPgUrl(), /DIRECT_URL is required/)
    }
  )
})
