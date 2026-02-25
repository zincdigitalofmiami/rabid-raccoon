#!/usr/bin/env python3
"""
Check status of Databento batch jobs and download completed ones.

Usage:
  source .env.local
  .venv-finance/bin/python scripts/check-options-jobs.py          # check status
  .venv-finance/bin/python scripts/check-options-jobs.py --download  # download completed
"""
import databento as db
import os
import sys
import json
import time
from pathlib import Path

API_KEY = os.environ.get("DATABENTO_API_KEY")
if not API_KEY:
    print("ERROR: DATABENTO_API_KEY not set. Run: source .env.local")
    sys.exit(1)

DO_DOWNLOAD = "--download" in sys.argv

OUTPUT_BASE = Path("datasets")
STATS_DIR = OUTPUT_BASE / "options-statistics-raw"
OHLCV_DIR = OUTPUT_BASE / "options-ohlcv-raw"

c = db.Historical(API_KEY)

jobs = c.batch.list_jobs()
print(f"Total batch jobs: {len(jobs)}\n")

for j in jobs:
    jid = j["id"]
    state = j["state"]
    schema = j["schema"]
    progress = j.get("progress", "?")
    records = j.get("record_count", "?")
    cost = j.get("cost_usd", "?")
    pkg_size = j.get("package_size")
    size_gb = f"{pkg_size / 1e9:.1f} GB" if pkg_size else "?"

    print(f"  {jid}")
    print(f"    schema={schema}  state={state}  progress={progress}%")
    print(f"    records={records}  size={size_gb}  cost=${cost}")

    if state == "done" and DO_DOWNLOAD:
        if schema == "statistics":
            out_dir = STATS_DIR
        elif schema == "ohlcv-1d":
            out_dir = OHLCV_DIR
        elif schema == "definition":
            print("    (skipping definition download — already on disk)")
            continue
        else:
            out_dir = OUTPUT_BASE / f"options-{schema}-raw"

        out_dir.mkdir(parents=True, exist_ok=True)
        print(f"    DOWNLOADING to {out_dir}/ ...")

        try:
            files = c.batch.download(jid, output_dir=str(out_dir))
            print(f"    Downloaded {len(files)} files")
            for f in files[:5]:
                print(f"      {f}")
            if len(files) > 5:
                print(f"      ... and {len(files) - 5} more")
        except Exception as e:
            print(f"    DOWNLOAD FAILED: {e}")

    print()

if not DO_DOWNLOAD:
    print("Run with --download to download completed jobs.")
