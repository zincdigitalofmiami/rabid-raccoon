import { config } from "dotenv"
config({ path: ".env.local" })
config({ path: ".env" })
import { defineConfig } from "prisma/config"

const useLocal = process.env.PRISMA_LOCAL === "1"
const url: string | undefined = useLocal
  ? (process.env.LOCAL_DATABASE_URL ?? process.env.DIRECT_URL ?? process.env.DATABASE_URL)
  : (process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? process.env.LOCAL_DATABASE_URL)

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: { url },
})
