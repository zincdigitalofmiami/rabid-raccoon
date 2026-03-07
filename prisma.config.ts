import { config } from "dotenv"
config({ path: ".env.local" })
config({ path: ".env" })
import { defineConfig } from "prisma/config"

const url: string | undefined =
  process.env.DIRECT_URL ?? process.env.DATABASE_URL

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
})
