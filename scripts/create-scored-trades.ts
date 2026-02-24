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
        setup_hash      VARCHAR(128) NOT NULL,
        direction       "SignalDirection" NOT NULL,
        fib_ratio       DECIMAL(8,6) NOT NULL,
        go_type         VARCHAR(10),
        entry_price     DECIMAL(18,6),
        stop_loss       DECIMAL(18,6),
        tp1             DECIMAL(18,6),
        tp2             DECIMAL(18,6),
        current_price   DECIMAL(18,6) NOT NULL,
        composite_score INT NOT NULL,
        grade           VARCHAR(1) NOT NULL,
        p_tp1           DECIMAL(8,6) NOT NULL,
        p_tp2           DECIMAL(8,6) NOT NULL,
        ml_source       VARCHAR(16) NOT NULL,
        rr              DECIMAL(8,4),
        dollar_risk     DECIMAL(12,2),
        event_phase     VARCHAR(16) NOT NULL,
        confidence_adj  DECIMAL(4,2) NOT NULL,
        rationale       TEXT,
        reasoning_source VARCHAR(16) NOT NULL,
        adjusted_p_tp1  DECIMAL(8,6),
        adjusted_p_tp2  DECIMAL(8,6),
        features        JSONB NOT NULL,
        score_breakdown JSONB NOT NULL,
        flags           TEXT[] DEFAULT ARRAY[]::TEXT[],
        tp1_hit         BOOLEAN,
        tp2_hit         BOOLEAN,
        sl_hit          BOOLEAN,
        tp1_hit_time    TIMESTAMPTZ,
        tp2_hit_time    TIMESTAMPTZ,
        sl_hit_time     TIMESTAMPTZ,
        max_favorable   DECIMAL(18,6),
        max_adverse     DECIMAL(18,6),
        outcome_checked_at TIMESTAMPTZ,
        scored_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    console.log('Table created')

    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS scored_trades_hash_time_key ON scored_trades (setup_hash, scored_at)')
    await client.query('CREATE INDEX IF NOT EXISTS scored_trades_scored_at_idx ON scored_trades (scored_at)')
    await client.query('CREATE INDEX IF NOT EXISTS scored_trades_grade_time_idx ON scored_trades (grade, scored_at)')
    await client.query('CREATE INDEX IF NOT EXISTS scored_trades_tp1_outcome_idx ON scored_trades (tp1_hit)')
    await client.query('CREATE INDEX IF NOT EXISTS scored_trades_outcome_checked_idx ON scored_trades (outcome_checked_at)')
    console.log('Indexes created')

    const res = await client.query('SELECT count(*) FROM scored_trades')
    console.log('Verification — row count:', res.rows[0].count)
  } finally {
    await client.end()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
