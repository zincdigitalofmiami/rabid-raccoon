#!/usr/bin/env python3
"""Submit Databento batch jobs for options statistics + ohlcv-1d."""
import databento as db
import os
import sys
import json

API_KEY = os.environ.get("DATABENTO_API_KEY")
if not API_KEY:
    print("ERROR: DATABENTO_API_KEY not set. Run: source .env.local")
    sys.exit(1)

c = db.Historical(API_KEY)

SYMBOLS = [
    "ES.OPT", "NQ.OPT", "OG.OPT", "SO.OPT", "LO.OPT",
    "OKE.OPT", "ON.OPT", "OH.OPT", "OB.OPT", "HXE.OPT",
    "OZN.OPT", "OZB.OPT", "OZF.OPT", "EUU.OPT", "JPU.OPT",
]

START = "2020-01-01"
END = "2026-02-25"

# Submit statistics batch job
print("Submitting STATISTICS batch job...")
stats_job = c.batch.submit_job(
    dataset="GLBX.MDP3",
    symbols=SYMBOLS,
    schema="statistics",
    start=START,
    end=END,
    stype_in="parent",
    encoding="dbn",
    compression="zstd",
    split_duration="month",
    delivery="download",
)
print(f"  STATISTICS job: {stats_job['id']}")
print(f"  state: {stats_job['state']}")
print(f"  cost: ${stats_job.get('cost_usd', '?')}")
print()

# Submit ohlcv-1d batch job
print("Submitting OHLCV-1D batch job...")
ohlcv_job = c.batch.submit_job(
    dataset="GLBX.MDP3",
    symbols=SYMBOLS,
    schema="ohlcv-1d",
    start=START,
    end=END,
    stype_in="parent",
    encoding="dbn",
    compression="zstd",
    split_duration="month",
    delivery="download",
)
print(f"  OHLCV-1D job: {ohlcv_job['id']}")
print(f"  state: {ohlcv_job['state']}")
print(f"  cost: ${ohlcv_job.get('cost_usd', '?')}")
print()

print("Both jobs submitted. Use scripts/check-options-jobs.py to monitor.")
print("Jobs will be processed server-side by Databento.")
