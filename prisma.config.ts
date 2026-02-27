import { config } from "dotenv"
config({ path: ".env.local" })
config({ path: ".env" })
import { defineConfig, env } from "prisma/config"

const useLocal = process.env.PRISMA_LOCAL === "1"
const url = useLocal ? env("LOCAL_DATABASE_URL") : env("DIRECT_URL")

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
})
