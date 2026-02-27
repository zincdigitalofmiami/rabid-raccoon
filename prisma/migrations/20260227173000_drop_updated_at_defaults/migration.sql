-- Align DB defaults with Prisma @updatedAt semantics (no DB default required).
ALTER TABLE "scored_trades" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "symbol_roles" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "symbol_role_members" ALTER COLUMN "updated_at" DROP DEFAULT;
