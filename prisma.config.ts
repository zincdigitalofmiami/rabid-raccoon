import path from "node:path";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

const root = path.resolve(__dirname);
config({ path: path.join(root, ".env.local"), override: true });
config({ path: path.join(root, ".env") });

export default defineConfig({
  schema: path.join(root, "prisma/schema.prisma"),
  migrations: {
    path: path.join(root, "prisma/migrations"),
  },
  datasource: {
    url: process.env["DATABASE_URL"]!,
  },
});
