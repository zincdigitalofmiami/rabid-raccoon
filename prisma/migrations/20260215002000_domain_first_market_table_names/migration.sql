-- Rename futures/MES tables to domain-first names.
ALTER TABLE "futures_ex_mes_1d" RENAME TO "mkt_futures_1d";
ALTER TABLE "futures_ex_mes_1h" RENAME TO "mkt_futures_1h";
ALTER TABLE "mes_prices_1h" RENAME TO "mkt_futures_mes_1h";
ALTER TABLE "mes_prices_15m" RENAME TO "mkt_futures_mes_15m";

-- Rename unique/index names to match new table naming.
ALTER INDEX IF EXISTS "futures_ex_mes_1d_symbol_date_key" RENAME TO "mkt_futures_1d_symbol_date_key";
ALTER INDEX IF EXISTS "futures_ex_mes_1d_date_idx" RENAME TO "mkt_futures_1d_date_idx";
ALTER INDEX IF EXISTS "futures_ex_mes_1h_symbol_time_key" RENAME TO "mkt_futures_1h_symbol_time_key";
ALTER INDEX IF EXISTS "futures_ex_mes_1h_time_idx" RENAME TO "mkt_futures_1h_time_idx";
ALTER INDEX IF EXISTS "mes_prices_1h_event_time_key" RENAME TO "mkt_futures_mes_1h_event_time_key";
ALTER INDEX IF EXISTS "mes_prices_15m_event_time_key" RENAME TO "mkt_futures_mes_15m_event_time_key";

-- Rename constraints for readability/consistency.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'futures_ex_mes_1d_pkey') THEN
    ALTER TABLE "mkt_futures_1d" RENAME CONSTRAINT "futures_ex_mes_1d_pkey" TO "mkt_futures_1d_pkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'futures_ex_mes_1d_symbolCode_fkey') THEN
    ALTER TABLE "mkt_futures_1d" RENAME CONSTRAINT "futures_ex_mes_1d_symbolCode_fkey" TO "mkt_futures_1d_symbolCode_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'futures_ex_mes_1d_symbol_not_mes_chk') THEN
    ALTER TABLE "mkt_futures_1d" RENAME CONSTRAINT "futures_ex_mes_1d_symbol_not_mes_chk" TO "mkt_futures_1d_symbol_not_mes_chk";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'futures_ex_mes_1h_pkey') THEN
    ALTER TABLE "mkt_futures_1h" RENAME CONSTRAINT "futures_ex_mes_1h_pkey" TO "mkt_futures_1h_pkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'futures_ex_mes_1h_symbolCode_fkey') THEN
    ALTER TABLE "mkt_futures_1h" RENAME CONSTRAINT "futures_ex_mes_1h_symbolCode_fkey" TO "mkt_futures_1h_symbolCode_fkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'futures_ex_mes_1h_symbol_not_mes_chk') THEN
    ALTER TABLE "mkt_futures_1h" RENAME CONSTRAINT "futures_ex_mes_1h_symbol_not_mes_chk" TO "mkt_futures_1h_symbol_not_mes_chk";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mes_prices_1h_pkey') THEN
    ALTER TABLE "mkt_futures_mes_1h" RENAME CONSTRAINT "mes_prices_1h_pkey" TO "mkt_futures_mes_1h_pkey";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mes_prices_15m_pkey') THEN
    ALTER TABLE "mkt_futures_mes_15m" RENAME CONSTRAINT "mes_prices_15m_pkey" TO "mkt_futures_mes_15m_pkey";
  END IF;
END $$;
