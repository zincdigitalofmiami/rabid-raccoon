import { config } from "dotenv"
config({ path: ".env.production.local" })
config({ path: ".env.local" })
config({ path: ".env" })
import { defineConfig, env } from "prisma/config"
import { normalizeServerEnv, resolveDatabaseTarget } from "./src/lib/server-env"

normalizeServerEnv()
const prismaTarget = resolveDatabaseTarget()
const url = prismaTarget === "local" ? env("LOCAL_DATABASE_URL") : env("DIRECT_URL")

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
})
