/**
 * create-scored-trades.ts — Create the scored_trades table via direct connection.
 * Run: npx tsx scripts/create-scored-trades.ts
 */
import 'dotenv/config'
import pg from 'pg'

async function main() {
  const url = process.env.DIRECT_URL
  if (!url) { console.error('No DIRECT_URL'); process.exit(1) }

  const client = new pg.Client({ connectionString: url })
  await client.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS scored_trades (
        id              BIGSERIAL PRIMARY KEY,
        "setupHash"      VARCHAR(128) NOT NULL,
        direction       "SignalDirection" NOT NULL,
        "fibRatio"       DECIMAL(8,6) NOT NULL,
        "goType"         VARCHAR(10),
        "entryPrice"     DECIMAL(18,6),
        "stopLoss"       DECIMAL(18,6),
        tp1             DECIMAL(18,6),
        tp2             DECIMAL(18,6),
        "currentPrice"   DECIMAL(18,6) NOT NULL,
        "compositeScore" INT NOT NULL,
        grade           VARCHAR(1) NOT NULL,
        "pTp1"           DECIMAL(8,6) NOT NULL,
        "pTp2"           DECIMAL(8,6) NOT NULL,
        "mlSource"       VARCHAR(16) NOT NULL,
        rr              DECIMAL(8,4),
        "dollarRisk"     DECIMAL(12,2),
        "eventPhase"     VARCHAR(16) NOT NULL,
        "confidenceAdj"  DECIMAL(4,2) NOT NULL,
        rationale       TEXT,
        "reasoningSource" VARCHAR(16) NOT NULL,
        "adjustedPTp1"  DECIMAL(8,6),
        "adjustedPTp2"  DECIMAL(8,6),
        features        JSONB NOT NULL,
        "scoreBreakdown" JSONB NOT NULL,
        flags           TEXT[] DEFAULT ARRAY[]::TEXT[],
        "tp1Hit"         BOOLEAN,
        "tp2Hit"         BOOLEAN,
        "slHit"          BOOLEAN,
        "tp1HitTime"    TIMESTAMPTZ,
        "tp2HitTime"    TIMESTAMPTZ,
        "slHitTime"     TIMESTAMPTZ,
        "maxFavorable"   DECIMAL(18,6),
        "maxAdverse"     DECIMAL(18,6),
        "outcomeCheckedAt" TIMESTAMPTZ,
        "scoredAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    console.log('Table created')

    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS scored_trades_hash_time_key ON scored_trades ("setupHash", "scoredAt")')
    await client.query('CREATE INDEX IF NOT EXISTS scored_trades_scored_at_idx ON scored_trades ("scoredAt")')
    await client.query('CREATE INDEX IF NOT EXISTS scored_trades_grade_time_idx ON scored_trades (grade, "scoredAt")')
    await client.query('CREATE INDEX IF NOT EXISTS scored_trades_tp1_outcome_idx ON scored_trades ("tp1Hit")')
    await client.query('CREATE INDEX IF NOT EXISTS scored_trades_outcome_checked_idx ON scored_trades ("outcomeCheckedAt")')
    console.log('Indexes created')

    const res = await client.query('SELECT count(*) FROM scored_trades')
    console.log('Verification — row count:', res.rows[0].count)
  } finally {
    await client.end()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
