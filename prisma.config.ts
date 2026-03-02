import { config } from "dotenv"
config({ path: ".env.local" })
config({ path: ".env" })
import { defineConfig } from "prisma/config"

const forceLocal = process.env.PRISMA_LOCAL === "1"
const forceDirect = process.env.PRISMA_DIRECT === "1"
const useLocal = forceLocal || (!forceDirect && Boolean(process.env.LOCAL_DATABASE_URL))

// Resolve URL without throwing when env vars are absent (e.g. during `prisma generate`
// on Vercel where only DATABASE_URL is set, not DIRECT_URL).
// Priority: LOCAL_DATABASE_URL → DIRECT_URL → DATABASE_URL (Accelerate fallback)
const resolvedUrl = useLocal
  ? process.env.LOCAL_DATABASE_URL
  : (process.env.DIRECT_URL ?? process.env.DATABASE_URL)

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(resolvedUrl !== undefined ? { datasource: { url: resolvedUrl } } : {}),
})
