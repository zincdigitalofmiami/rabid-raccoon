import { config } from "dotenv"
config({ path: ".env.local" })
config({ path: ".env" })
import { defineConfig, env } from "prisma/config"

const forceLocal = process.env.PRISMA_LOCAL === "1"
const forceDirect = process.env.PRISMA_DIRECT === "1"
const useLocal = forceLocal || (!forceDirect && Boolean(process.env.LOCAL_DATABASE_URL))
const url = useLocal ? env("LOCAL_DATABASE_URL") : env("DIRECT_URL")

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
})
