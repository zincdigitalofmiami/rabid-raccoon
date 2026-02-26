-- Add 15 CME option parent symbols to the symbol registry
-- and create the OPTIONS_PARENT role for Python script consumption.
-- These symbols are Databento stype_in="parent" identifiers for options data.

-- Step 1: Insert option parent symbols into the symbols table
INSERT INTO "symbols" ("code", "displayName", "shortName", "description", "tickSize", "dataSource", "dataset", "databentoSymbol", "isActive", "createdAt", "updatedAt")
VALUES
  ('ES.OPT',  'ES Options',  'ES Opts',  'E-mini S&P 500 Options (CME parent)',       0, 'DATABENTO', 'GLBX.MDP3', 'ES.OPT',  true, NOW(), NOW()),
  ('NQ.OPT',  'NQ Options',  'NQ Opts',  'E-mini Nasdaq-100 Options (CME parent)',     0, 'DATABENTO', 'GLBX.MDP3', 'NQ.OPT',  true, NOW(), NOW()),
  ('OG.OPT',  'OG Options',  'OG Opts',  'Gold Options (CME parent)',                  0, 'DATABENTO', 'GLBX.MDP3', 'OG.OPT',  true, NOW(), NOW()),
  ('SO.OPT',  'SO Options',  'SO Opts',  'Soybean Options (CME parent)',               0, 'DATABENTO', 'GLBX.MDP3', 'SO.OPT',  true, NOW(), NOW()),
  ('LO.OPT',  'LO Options',  'LO Opts',  'Crude Oil Options (CME parent)',             0, 'DATABENTO', 'GLBX.MDP3', 'LO.OPT',  true, NOW(), NOW()),
  ('OKE.OPT', 'OKE Options', 'OKE Opts', 'Eurodollar Options (CME parent)',            0, 'DATABENTO', 'GLBX.MDP3', 'OKE.OPT', true, NOW(), NOW()),
  ('ON.OPT',  'ON Options',  'ON Opts',  'Natural Gas Options (CME parent)',            0, 'DATABENTO', 'GLBX.MDP3', 'ON.OPT',  true, NOW(), NOW()),
  ('OH.OPT',  'OH Options',  'OH Opts',  'Heating Oil Options (CME parent)',            0, 'DATABENTO', 'GLBX.MDP3', 'OH.OPT',  true, NOW(), NOW()),
  ('OB.OPT',  'OB Options',  'OB Opts',  'RBOB Gasoline Options (CME parent)',         0, 'DATABENTO', 'GLBX.MDP3', 'OB.OPT',  true, NOW(), NOW()),
  ('HXE.OPT', 'HXE Options', 'HXE Opts', 'Euro FX Options (CME parent)',              0, 'DATABENTO', 'GLBX.MDP3', 'HXE.OPT', true, NOW(), NOW()),
  ('OZN.OPT', 'OZN Options', 'OZN Opts', '10-Year Treasury Note Options (CME parent)', 0, 'DATABENTO', 'GLBX.MDP3', 'OZN.OPT', true, NOW(), NOW()),
  ('OZB.OPT', 'OZB Options', 'OZB Opts', 'Treasury Bond Options (CME parent)',         0, 'DATABENTO', 'GLBX.MDP3', 'OZB.OPT', true, NOW(), NOW()),
  ('OZF.OPT', 'OZF Options', 'OZF Opts', '5-Year Treasury Note Options (CME parent)',  0, 'DATABENTO', 'GLBX.MDP3', 'OZF.OPT', true, NOW(), NOW()),
  ('EUU.OPT', 'EUU Options', 'EUU Opts', 'Euro FX (E-micro) Options (CME parent)',    0, 'DATABENTO', 'GLBX.MDP3', 'EUU.OPT', true, NOW(), NOW()),
  ('JPU.OPT', 'JPU Options', 'JPU Opts', 'Japanese Yen Options (CME parent)',          0, 'DATABENTO', 'GLBX.MDP3', 'JPU.OPT', true, NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;

-- Step 2: Create OPTIONS_PARENT role
INSERT INTO "symbol_roles" ("role_key", "description", "is_active", "created_at", "updated_at")
VALUES ('OPTIONS_PARENT', 'CME option parent symbols for Databento batch pulls and conversion', true, NOW(), NOW())
ON CONFLICT ("role_key") DO NOTHING;

-- Step 3: Assign all 15 option parents to the role (ordered alphabetically)
INSERT INTO "symbol_role_members" ("role_key", "symbol_code", "position", "enabled", "created_at", "updated_at")
VALUES
  ('OPTIONS_PARENT', 'ES.OPT',   0, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'EUU.OPT',  1, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'HXE.OPT',  2, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'JPU.OPT',  3, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'LO.OPT',   4, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'NQ.OPT',   5, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'OB.OPT',   6, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'OG.OPT',   7, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'OH.OPT',   8, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'OKE.OPT',  9, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'ON.OPT',  10, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'OZB.OPT', 11, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'OZF.OPT', 12, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'OZN.OPT', 13, true, NOW(), NOW()),
  ('OPTIONS_PARENT', 'SO.OPT',  14, true, NOW(), NOW())
ON CONFLICT ("role_key", "symbol_code") DO NOTHING;
