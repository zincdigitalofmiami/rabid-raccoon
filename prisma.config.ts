import { config } from "dotenv"
config({ path: ".env.local" })
config({ path: ".env" })
import { defineConfig, env } from "prisma/config"

const isProd = process.env.NODE_ENV === "production"
const forceLocal = process.env.PRISMA_LOCAL === "1"
const forceDirect = process.env.PRISMA_DIRECT === "1"

if (forceLocal && forceDirect) {
  throw new Error("Prisma config resolution failed: PRISMA_LOCAL and PRISMA_DIRECT cannot both be 1.")
}

let url: string
if (forceDirect) {
  url = env("DIRECT_URL")
} else if (forceLocal) {
  url = env("LOCAL_DATABASE_URL")
} else if (isProd) {
  url = env("DIRECT_URL")
} else if (process.env.LOCAL_DATABASE_URL) {
  url = env("LOCAL_DATABASE_URL")
} else {
  throw new Error(
    "Prisma config resolution failed in non-production: LOCAL_DATABASE_URL is required by default. To run Prisma CLI against direct Postgres, set PRISMA_DIRECT=1 with DIRECT_URL."
  )
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
})
