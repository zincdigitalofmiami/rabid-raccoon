# Inngest Function Standards

## Every Inngest function MUST:

1. Create an IngestionRun record at start (status: RUNNING)
2. Update IngestionRun on completion (status: COMPLETED, rowsInserted count)
3. Update IngestionRun on failure (status: FAILED, error message)
4. Have try/catch wrapping all step.run() calls
5. Query the symbol registry instead of hardcoding symbol arrays
6. Log the FRED series IDs being fetched (for debugging staleness)

## Cron Schedule Reference

- 15m data: every 15 minutes during market hours
- 1h data: every hour during market hours
- Daily market: 0 4 \* \* 1-5 (4 AM UTC weekdays)
- Daily FRED: 0 9-10 \* \* \* (9-10 AM UTC, after FRED publishes)
- News signals: every 6 hours
- BHG setups: needs to be created (currently missing)

## Known FRED Lag Times

- Daily rates/yields: 1 business day lag
- FX rates: 1-3 business day lag
- Weekly (ICSA/CCSA): published Thursday, 1-week lag
- Monthly (CPI, UNRATE, PAYEMS): ~2 weeks after month end
- Quarterly (GDP): ~1 month after quarter end
- EPU/EMV monthly indices: 1-3 month publication lag
- Discontinued: KOREAEPUINDXM (Dec 2020), FREEPUFEARINDX (Oct 2019)
