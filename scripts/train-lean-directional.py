"""
train-lean-directional.py — MES Directional Model (Lean)

Stripped to ~40 features selected by IC analysis. No fluff.
Binary classify: 1h and 4h direction.
Walk-forward with purge+embargo. Memory-safe for 8GB Apple Silicon.

Usage:
  python scripts/train-lean-directional.py              # Phase 1 fast (~45 min)
  python scripts/train-lean-directional.py --phase=2    # Phase 2 production (~4h)
"""

import sys, warnings, shutil, argparse
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score, accuracy_score

warnings.filterwarnings("ignore", category=FutureWarning)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ── CLI ───────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--phase", type=int, default=1, choices=[1, 2])
parser.add_argument("--horizons", default="1h,4h")
parser.add_argument("--time-limit", type=int, default=None)
parser.add_argument("--clean", action="store_true")
args = parser.parse_args()

# ── CURATED FEATURE SET (40 features, ranked by IC analysis) ──────────────────
# Selected 2026-02-20 from Spearman IC analysis vs target_dir_1h/4h on 36K rows.
# One feature per concept. No redundancy.

LEAN_FEATURES = [
    # ── MES Price Action (8) ──
    "mes_ret_1h",           # recent momentum
    "mes_ret_4h",           # medium momentum
    "mes_ret_24h",          # daily momentum
    "mes_range",            # candle range (IC 0.016)
    "mes_body_ratio",       # candle quality
    "mes_dist_hi24",        # distance from 24h high (IC 0.015)
    "mes_dist_lo24",        # distance from 24h low
    "mes_vol_ratio",        # volume regime (IC 0.013)

    # ── MES Indicators (6) ──
    "sqz_mom",              # squeeze momentum value (IC 0.010)
    "sqz_mom_positive",     # squeeze direction (IC 0.011)
    "sqz_state",            # in/out of squeeze (IC 0.008)
    "wvf_value",            # Williams VIX Fix (IC 0.015)
    "wvf_percentile",       # VIX fix percentile (IC 0.013)
    "macd_hist",            # MACD histogram

    # ── Cross-Asset Returns & Vol (10) ──
    "nq_vol_ratio",         # NQ volume regime (IC 0.015)
    "nq_ret_24h",           # NQ daily return (IC 0.008)
    "nq_minus_mes",         # NQ-MES spread (IC 0.012)
    "zn_dist_ma24",         # Bond distance from MA (IC 0.018)
    "zn_ret_24h",           # Bond daily return (IC 0.017)
    "zn_ret_4h",            # Bond 4h return (IC 0.008)
    "cl_vol_ratio",         # Crude oil volume (IC 0.013)
    "ng_vol_ratio",         # NatGas volume (IC 0.016)
    "ng_edss",              # NatGas EDSS (IC 0.015)
    "e6_ret_1h",            # Euro 1h return (IC 0.006)

    # ── Correlations & Composites (4) ──
    "mes_zn_corr_21d",      # Equity-bond correlation (IC 0.012)
    "equity_bond_diverge",  # Divergence flag (IC 0.009)
    "concordance_1h",       # Index alignment (IC 0.007)
    "yield_proxy",          # Yield direction proxy

    # ── Macro Regime (7) ──
    "real_rate_10y",        # #1 feature overall (IC 0.018)
    "yield_curve_slope",    # Yield curve (IC 0.014)
    "dgs10_velocity_5d",    # 10Y yield velocity (IC 0.014)
    "fed_liquidity",        # Fed balance sheet (IC 0.011)
    "ig_oas_1d_change",     # IG credit change (IC 0.010)
    "hy_oas_1d_change",     # HY credit change (IC 0.009)
    "vix_percentile_20d",   # VIX regime (regime filter)

    # ── Time (3) ──
    "hour_utc",
    "day_of_week",
    "is_us_session",

    # ── Event Flags (2) ──
    "is_high_impact_day",
    "hours_to_next_high_impact",
]

# ── Config ────────────────────────────────────────────────────────────────────

DATASET_PATH = PROJECT_ROOT / "datasets" / "autogluon" / "mes_lean_1h.csv"
MODEL_DIR = PROJECT_ROOT / "models" / "lean_directional"
OOF_OUTPUT = PROJECT_ROOT / "datasets" / "autogluon" / "lean_oof_1h.csv"

HORIZONS = {
    "1h": {"target": "target_dir_1h", "purge": 1,  "embargo": 2},
    "4h": {"target": "target_dir_4h", "purge": 4,  "embargo": 8},
}

# Filter horizons
requested = set(args.horizons.split(","))
HORIZONS = {k: v for k, v in HORIZONS.items() if k in requested}

PHASE = {
    1: {"presets": "high_quality_v150", "time_limit": 600,  "folds": 3},
    2: {"presets": "best_quality_v150", "time_limit": 1800, "folds": 5},
}[args.phase]

TIME_LIMIT = args.time_limit or PHASE["time_limit"]
N_FOLDS = PHASE["folds"]

# ── Walk-Forward Splitter ─────────────────────────────────────────────────────

def walk_forward_splits(n, n_folds, purge, embargo):
    fold_size = n // (n_folds + 1)
    splits = []
    for fold in range(n_folds):
        split = fold_size * (fold + 1)
        val_start = split + purge + embargo
        val_end = fold_size * (fold + 2) if fold < n_folds - 1 else n
        if val_start < val_end and val_start < n:
            splits.append((list(range(0, split)), list(range(val_start, val_end))))
    return splits


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    from autogluon.tabular import TabularPredictor

    # Log setup
    log_dir = PROJECT_ROOT / "models" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = log_dir / f"lean_{ts}.log"

    log_file = open(log_path, "w", buffering=1)
    class Tee:
        def __init__(self, *s): self.streams = s
        def write(self, d):
            for s in self.streams: s.write(d); s.flush()
        def flush(self):
            for s in self.streams: s.flush()
        def isatty(self): return False
    sys.stdout = Tee(sys.__stdout__, log_file)
    sys.stderr = Tee(sys.__stderr__, log_file)
    print(f"Log: {log_path}")

    # Load data
    print(f"\nLoading {DATASET_PATH.name}...")
    df = pd.read_csv(DATASET_PATH)
    df = df.sort_values("timestamp").reset_index(drop=True)
    print(f"  Raw: {len(df):,} rows x {len(df.columns)} cols")

    # Validate features exist
    available = [f for f in LEAN_FEATURES if f in df.columns]
    missing = [f for f in LEAN_FEATURES if f not in df.columns]
    if missing:
        print(f"  WARNING: {len(missing)} features missing: {missing}")
    print(f"  Using {len(available)} of {len(LEAN_FEATURES)} lean features")

