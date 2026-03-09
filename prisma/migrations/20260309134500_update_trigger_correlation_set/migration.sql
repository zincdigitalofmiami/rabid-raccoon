-- Update the live trigger correlation basket to the approved Databento Standard + FRED set.
-- Keep the role key stable so existing runtime consumers continue to read CORRELATION_SET.

INSERT INTO "symbol_roles" ("role_key", "description", "is_active", "created_at", "updated_at")
VALUES ('CORRELATION_SET', 'Approved live trigger correlation basket', true, NOW(), NOW())
ON CONFLICT ("role_key") DO UPDATE
SET
  "description" = EXCLUDED."description",
  "is_active" = true,
  "updated_at" = NOW();

UPDATE "symbol_role_members"
SET
  "position" = "position" + 100,
  "updated_at" = NOW()
WHERE "role_key" = 'CORRELATION_SET';

INSERT INTO "symbol_role_members" ("role_key", "symbol_code", "position", "enabled", "created_at", "updated_at")
VALUES
  ('CORRELATION_SET', 'MES', 0, true, NOW(), NOW()),
  ('CORRELATION_SET', 'NQ', 1, true, NOW(), NOW()),
  ('CORRELATION_SET', 'RTY', 2, true, NOW(), NOW()),
  ('CORRELATION_SET', 'ZN', 3, true, NOW(), NOW()),
  ('CORRELATION_SET', 'CL', 4, true, NOW(), NOW()),
  ('CORRELATION_SET', '6E', 5, true, NOW(), NOW())
ON CONFLICT ("role_key", "symbol_code") DO UPDATE
SET
  "position" = EXCLUDED."position",
  "enabled" = true,
  "updated_at" = NOW();

UPDATE "symbol_role_members"
SET
  "enabled" = false,
  "updated_at" = NOW()
WHERE "role_key" = 'CORRELATION_SET'
  AND "symbol_code" NOT IN ('MES', 'NQ', 'RTY', 'ZN', 'CL', '6E')
  AND "enabled" = true;
