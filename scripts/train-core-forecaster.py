"""
train-core-forecaster.py

MES Core Return Forecaster — AutoGluon 1.5 TabularPredictor
Optimized for 1h/4h day-trading horizons with walk-forward validation.
15m model training is intentionally retired.

Models: GBM (LightGBM), CAT (CatBoost), XGB (XGBoost), XT (ExtraTrees),
        REALMLP, TABM, EBM (11 configs total)
  - KNN, FASTAI, RF, NN_TORCH excluded
  - dynamic_stacking=False (prevents DyStack inside outer walk-forward)

Modes:
  classify (default): Directional prediction (up/down), eval=roc_auc
  regress:            Raw return prediction, eval=MAE
  volnorm:            Vol-normalized return prediction, eval=R2

Two-phase training defaults:
  Phase 1 (validation): 3 folds, no bagging/stacking
  Phase 2 (production): 5 folds, 8-fold bagging + 1 stack level
  Use --time-limit=N to override with a per-fold time budget (seconds)

Walk-forward scheme:
  - Expanding-window folds with purge + embargo
  - Purge gap = target horizon bars (prevents label leakage)
  - Embargo = 2x purge (prevents autocorrelation bleed)
  - Produces OOF predictions for every training row

Metrics:
  classify: AUC, Accuracy, High-Confidence Accuracy (p>0.55/p<0.45), IC
  regress/volnorm: MAE, RMSE, R2, Spearman IC

Outputs:
  models/core_forecaster/{horizon}/fold_N/      AutoGluon artifacts per fold
  datasets/autogluon/core_oof_1h.csv            OOF predictions + actuals
  models/logs/training_1h_YYYYMMDD_HHMMSS.log   Full stdout log

Usage:
  python scripts/train-core-forecaster.py
  python scripts/train-core-forecaster.py --phase=2 --clean
  python scripts/train-core-forecaster.py --horizons=1h --time-limit=3600
  python scripts/train-core-forecaster.py --phase=2 --num-cpus=20
"""

import os
import sys
import json
import warnings
import shutil
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime
from scipy.stats import spearmanr
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

warnings.filterwarnings("ignore", category=FutureWarning)

# ─── Configuration ────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Parse CLI args
import argparse
parser = argparse.ArgumentParser(description="MES Core Return Forecaster")
parser.add_argument("--timeframe", default="1h", choices=["1h"],
                    help="Compatibility flag. 15m training is retired; only 1h dataset is supported.")
parser.add_argument("--horizons", default=None, help="Comma-separated horizons to train (1h,4h,1d,1w)")
parser.add_argument("--mode", default="classify", choices=["classify", "regress", "volnorm"],
                    help="classify: directional (up/down) with roc_auc. "
                         "regress: raw return with MAE. "
                         "volnorm: vol-normalized return with R2.")
parser.add_argument("--phase", type=int, default=1, choices=[1, 2],
                    help="Phase 1: validation (3 folds, no bagging). "
                         "Phase 2: production (5 folds, bagging + stacking).")
parser.add_argument("--time-limit", type=int, default=None, help="Seconds per fold (overrides --phase default)")
parser.add_argument("--n-folds", type=int, default=None, help="Override walk-forward folds")
parser.add_argument("--num-bag-folds", type=int, default=None, help="Override AutoGluon bag folds")
parser.add_argument("--num-stack-levels", type=int, default=None, help="Override AutoGluon stack levels")
parser.add_argument("--num-cpus", type=int, default=max(1, (os.cpu_count() or 2) - 1),
                    help="CPUs for model fitting (default: all cores minus one)")
parser.add_argument("--max-memory-ratio", type=float, default=3.0,
                    help="AutoGluon ag.max_memory_usage_ratio (3.0 for 24GB M4 Pro)")
parser.add_argument("--report-root", default="models/reports", help="Directory for reports")
parser.add_argument("--skip-reports", action="store_true", help="Skip report generation")
parser.add_argument("--min-coverage", type=float, default=0.50,
                    help="Min non-null fraction to keep a feature (default: 0.50 = 50%%)")
parser.add_argument("--clean", action="store_true",
                    help="Delete existing model fold directories before training (prevents stale-fold confusion)")
args = parser.parse_args()

# ─── Paths and horizon configs (1h-only policy) ───────────────────────────────

TIMEFRAME = args.timeframe  # compatibility; always "1h"

DATASET_PATH = PROJECT_ROOT / "datasets" / "autogluon" / "mes_lean_fred_indexes_2020plus.csv"
MODEL_DIR = PROJECT_ROOT / "models" / "core_forecaster"
OOF_OUTPUT = PROJECT_ROOT / "datasets" / "autogluon" / "core_oof_1h.csv"

HORIZONS_CLASSIFY = {
    "1h": {"target": "target_dir_1h", "purge_bars": 1, "embargo_bars": 2},
    "4h": {"target": "target_dir_4h", "purge_bars": 4, "embargo_bars": 8},
    "1d": {"target": "target_dir_1d", "purge_bars": 24, "embargo_bars": 48},
    "1w": {"target": "target_dir_1w", "purge_bars": 120, "embargo_bars": 240},
}
HORIZONS_REGRESS = {
    "1h": {"target": "target_ret_1h", "purge_bars": 1, "embargo_bars": 2},
    "4h": {"target": "target_ret_4h", "purge_bars": 4, "embargo_bars": 8},
    "1d": {"target": "target_ret_1d", "purge_bars": 24, "embargo_bars": 48},
    "1w": {"target": "target_ret_1w", "purge_bars": 120, "embargo_bars": 240},
}
HORIZONS_VOLNORM = {
    "1h": {"target": "target_ret_norm_1h", "purge_bars": 1, "embargo_bars": 2},
    "4h": {"target": "target_ret_norm_4h", "purge_bars": 4, "embargo_bars": 8},
    "1d": {"target": "target_ret_norm_1d", "purge_bars": 24, "embargo_bars": 48},
    "1w": {"target": "target_ret_norm_1w", "purge_bars": 120, "embargo_bars": 240},
}

# All target columns in this dataset — never used as features
DROP_COLS = {
    "item_id", "timestamp", "target",
    "target_ret_1h", "target_ret_4h", "target_ret_1d", "target_ret_1w",
    "target_dir_1h", "target_dir_4h", "target_dir_1d", "target_dir_1w",
    "target_ret_norm_1h", "target_ret_norm_4h", "target_ret_norm_1d", "target_ret_norm_1w",
}

# Select horizons based on mode
MODE = args.mode
if MODE == "classify":
    HORIZONS = dict(HORIZONS_CLASSIFY)
    PROBLEM_TYPE = "binary"
    EVAL_METRIC = "roc_auc"
elif MODE == "volnorm":
    HORIZONS = dict(HORIZONS_VOLNORM)
    PROBLEM_TYPE = "regression"
    EVAL_METRIC = "r2"
else:
    HORIZONS = dict(HORIZONS_REGRESS)
    PROBLEM_TYPE = "regression"
    EVAL_METRIC = "mean_absolute_error"

# Filter horizons if specified via CLI
if args.horizons:
    requested = set(args.horizons.split(","))
    HORIZONS = {k: v for k, v in HORIZONS.items() if k in requested}
    if not HORIZONS:
        print(f"ERROR: No valid horizons in '{args.horizons}'. Available: {list(HORIZONS_CLASSIFY.keys())}")
        sys.exit(1)

# Phase-based defaults:
#   Phase 1: fast validation — confirm no leakage, features work, beats baseline
#   Phase 2: production candidate — full ensemble with light bagging
PHASE_DEFAULTS = {
    1: {"presets": "high_quality_v150", "time_limit": None, "n_folds": 3,
        "num_bag_folds": 0, "num_stack_levels": 0, "dynamic_stacking": False},
    2: {"presets": "best_quality_v150", "time_limit": None, "n_folds": 5,
        "num_bag_folds": 8, "num_stack_levels": 1, "dynamic_stacking": False},
}
phase_cfg = PHASE_DEFAULTS[args.phase]

N_FOLDS = args.n_folds if args.n_folds is not None else phase_cfg["n_folds"]
TIME_LIMIT_PER_FOLD = args.time_limit if args.time_limit is not None else phase_cfg["time_limit"]
NUM_BAG_FOLDS = args.num_bag_folds if args.num_bag_folds is not None else phase_cfg["num_bag_folds"]
NUM_STACK_LEVELS = args.num_stack_levels if args.num_stack_levels is not None else phase_cfg["num_stack_levels"]
DYNAMIC_STACKING = phase_cfg["dynamic_stacking"]
NUM_CPUS = max(1, args.num_cpus)
MAX_MEMORY_RATIO = args.max_memory_ratio

REPORT_ROOT = Path(args.report_root)
if not REPORT_ROOT.is_absolute():
    REPORT_ROOT = PROJECT_ROOT / REPORT_ROOT

# Models excluded from training:
# KNN:      curse of dimensionality on 130+ feature space
# FASTAI:   unreliable on CPU-only Apple Silicon, wastes time budget
# RF:       redundant with ExtraTrees, slower training
# NN_TORCH: replaced by REALMLP, TABM, MITRA (better on tabular, less overfit)
EXCLUDED_MODELS = ["KNN", "FASTAI", "RF", "NN_TORCH"]

# ─── Explicit hyperparameters ────────────────────────────────────────────────
# CRITICAL: Do NOT use presets= in the fit call. The high_quality_v150 preset
# overrides this dict with its own zeroshot config that only spawns LightGBM +
# CatBoost (~50 GBM configs + 1 CAT). XGBoost and ExtraTrees never run.
# Instead, pass hyperparameters= directly to ensure all 4 model types train.
HYPERPARAMETERS = {
    "GBM": [
        {"num_boost_round": 5000, "learning_rate": 0.02,
         "num_leaves": 31, "feature_fraction": 0.7,
         "min_data_in_leaf": 20, "extra_trees": False},
        {"num_boost_round": 5000, "learning_rate": 0.01,
         "num_leaves": 63, "feature_fraction": 0.5,
         "min_data_in_leaf": 50, "extra_trees": True},
    ],
    "CAT": [
        {"iterations": 5000, "learning_rate": 0.03, "depth": 6},
        {"iterations": 5000, "learning_rate": 0.01, "depth": 8},
    ],
    "XGB": [
        {"n_estimators": 5000, "learning_rate": 0.02,
         "max_depth": 6, "colsample_bytree": 0.7},
        {"n_estimators": 5000, "learning_rate": 0.01,
         "max_depth": 8, "colsample_bytree": 0.5},
    ],
    "XT": [
        {},
        {"max_features": 0.5, "min_samples_leaf": 5},
    ],
    "REALMLP": [{}],
    "TABM": [{}],
    # MITRA: removed — estimates 68-252 GB RAM, needs GPU + >>24GB
    "EBM": [{}],
}


# ─── Walk-Forward Splitter ────────────────────────────────────────────────────

def walk_forward_splits(n: int, n_folds: int, purge: int, embargo: int):
    """
    Expanding-window walk-forward cross-validation.

    Each fold:
      train = [0, split_point)
      gap   = [split_point, split_point + purge + embargo)   # purged
      val   = [split_point + purge + embargo, next_split)

    Anti-leakage:
      purge  = bars matching target horizon (removes label overlap)
      embargo = 2x purge (removes autocorrelation bleed)
    """
    fold_size = n // (n_folds + 1)
    splits = []

    for fold in range(n_folds):
        split_point = fold_size * (fold + 1)
        val_start = split_point + purge + embargo
        val_end = fold_size * (fold + 2) if fold < n_folds - 1 else n

        if val_start >= val_end or val_start >= n:
            continue

        train_idx = list(range(0, split_point))
        val_idx = list(range(val_start, val_end))
        splits.append((train_idx, val_idx))

    return splits


# ─── Log tee: mirror stdout to a timestamped log file ─────────────────────────

class _Tee:
    """Mirror writes to stdout and a log file simultaneously."""
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for s in self.streams:
            s.write(data)
            s.flush()

    def flush(self):
        for s in self.streams:
            s.flush()

    def isatty(self):
        return False


# ─── Main Training Loop ──────────────────────────────────────────────────────

def main():
    # ─── Setup log file tee ───────────────────────────────────────────────────
    log_dir = PROJECT_ROOT / "models" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = log_dir / f"training_{TIMEFRAME}_{ts}.log"
    log_file = open(log_path, "w", buffering=1)
    sys.stdout = _Tee(sys.__stdout__, log_file)
    sys.stderr = _Tee(sys.__stderr__, log_file)
    print(f"Log: {log_path}")

    try:
        from autogluon.tabular import TabularPredictor
    except ImportError:
        print("ERROR: AutoGluon not installed.")
        print("Install: pip install 'autogluon>=1.5' pandas scikit-learn")
        sys.exit(1)

    generate_regression_report = None
    if not args.skip_reports:
        try:
            from model_report_utils import generate_regression_report as _grr
            generate_regression_report = _grr
        except Exception as exc:
            print(f"WARNING: Report dependencies unavailable ({exc})")
            print("Continuing without reports. Install: pip install -r requirements-finance.txt")
            generate_regression_report = None

    # ─── Clean stale fold directories ─────────────────────────────────────────
    if args.clean:
        for horizon_name in HORIZONS:
            for fold_i in range(N_FOLDS):
                fold_dir = MODEL_DIR / horizon_name / f"fold_{fold_i}"
                if fold_dir.exists():
                    shutil.rmtree(fold_dir)
                    print(f"  [clean] Removed {fold_dir.relative_to(PROJECT_ROOT)}")
        print()

    # ─── Load & validate dataset ──────────────────────────────────────────────

    if not DATASET_PATH.exists():
        print(f"ERROR: Dataset not found at {DATASET_PATH}")
        print("Run: npx tsx scripts/build-lean-dataset.ts --timeframe=1h")
        sys.exit(1)

    print(f"Loading dataset: {DATASET_PATH.name}  (timeframe={TIMEFRAME})")
    df = pd.read_csv(DATASET_PATH)
    print(f"  Rows: {len(df):,}  Columns: {len(df.columns)}")

    required_targets = sorted({cfg["target"] for cfg in HORIZONS.values()})
    missing_targets = [col for col in required_targets if col not in df.columns]
    if missing_targets:
        print(f"ERROR: Dataset missing target columns for requested horizons: {missing_targets}")
        print("Run: npx tsx scripts/build-lean-dataset.ts --timeframe=1h")
        sys.exit(1)

    # Sort by timestamp (critical for walk-forward integrity)
    df = df.sort_values("timestamp").reset_index(drop=True)

    # NOTE: Do NOT dropna on ALL target cols globally — each horizon drops its own
    # NaN targets inside the training loop. Global dropna loses rows that are valid
    # for one horizon but NaN for another (e.g., last 4 rows have target_dir_1h but
    # not target_dir_4h). This was the original bug.

    # Drop redundant highly-correlated features (>0.99 correlation)
    # Identified by correlation analysis:
    #   yield_proxy ≈ zn_ret_1h (r=1.000) — drop yield_proxy (keep the raw)
    #   usd_shock ≈ e6_ret_1h (r=1.000) — drop usd_shock (keep the raw)
    #   econ_surprise_index ≈ claims_release_z (r=0.995) — drop econ_surprise_index
    #   bhg_setups_count_30d ≈ bhg_setups_count_7d (r=0.994) — drop 30d
    #   news_total_volume_7d ≈ policy_news_volume_7d (r=0.966) — drop news_total
    REDUNDANT_FEATURES = {
        "yield_proxy", "usd_shock", "econ_surprise_index",
        "bhg_setups_count_30d", "news_total_volume_7d",
    }

    # Feature columns = everything except identity + targets + redundant
    feature_cols = [c for c in df.columns if c not in DROP_COLS and c not in REDUNDANT_FEATURES]
    if REDUNDANT_FEATURES & set(df.columns):
        dropped_feats = REDUNDANT_FEATURES & set(df.columns)
        print(f"\n  Dropped {len(dropped_feats)} redundant features (>0.99 corr): {sorted(dropped_feats)}")

    # CRITICAL: no target column may ever appear as a feature
    leaked = [c for c in feature_cols if c.startswith("target_")]
    assert not leaked, f"TARGET LEAK: these target columns are in feature_cols: {leaked}"

    # ─── OOF mode validation ──────────────────────────────────────────────────
    # Warn if an existing OOF file appears to be from a different mode.
    if OOF_OUTPUT.exists():
        try:
            old_oof = pd.read_csv(OOF_OUTPUT, nrows=100)
            for h in HORIZONS:
                col = f"actual_{h}"
                if col in old_oof.columns:
                    vals = old_oof[col].dropna()
                    if len(vals) > 0:
                        is_binary = vals.isin([0.0, 1.0]).all()
                        if MODE == "classify" and not is_binary:
                            print(f"  WARNING: Existing OOF actual_{h} has non-binary values (regression mode?) "
                                  f"— will be overwritten by this classify-mode run.")
                        elif MODE != "classify" and is_binary:
                            print(f"  WARNING: Existing OOF actual_{h} looks binary — "
                                  f"was it from a classify run? Current mode: {MODE}")
        except Exception:
            pass  # Can't read old OOF — no problem, will be overwritten

    # ─── Auto-drop near-empty features ────────────────────────────────────────
    # Features with <MIN_COVERAGE non-null values are noise for tree models.
    min_coverage = args.min_coverage
    sparse_cols = []
    borderline_cols = []
    for col in feature_cols:
        coverage = df[col].notna().mean()
        if coverage < min_coverage:
            sparse_cols.append((col, coverage))
        elif coverage < min_coverage + 0.20:
            borderline_cols.append((col, coverage))

    if sparse_cols:
        print(f"\n  Dropping {len(sparse_cols)} sparse features (<{min_coverage:.0%} non-null):")
        for col, cov in sparse_cols:
            print(f"    {col:<40} {cov:.1%}")
        feature_cols = [c for c in feature_cols if c not in {s[0] for s in sparse_cols}]

    if borderline_cols:
        print(f"\n  Borderline features ({min_coverage:.0%}–{min_coverage+0.20:.0%} coverage) — kept:")
        for col, cov in borderline_cols:
            print(f"    {col:<40} {cov:.1%}")

    # ─── Pre-fit sanity checks: inf, NaN, extreme magnitudes ────────────────
    numeric_cols = df[feature_cols].select_dtypes(include=[np.number]).columns.tolist()
    inf_counts = {}
    huge_counts = {}
    MAGNITUDE_THRESHOLD = 1e12
    for col in numeric_cols:
        n_inf = (~np.isfinite(df[col].fillna(0))).sum()
        if n_inf > 0:
            inf_counts[col] = int(n_inf)
        n_huge = (df[col].abs() > MAGNITUDE_THRESHOLD).sum()
        if n_huge > 0:
            huge_counts[col] = int(n_huge)

    if inf_counts:
        print(f"\n  WARNING: {len(inf_counts)} features contain inf values — replacing with NaN:")
        for col, cnt in sorted(inf_counts.items(), key=lambda x: -x[1])[:10]:
            print(f"    {col:<40} {cnt:>6} inf values")
        df[numeric_cols] = df[numeric_cols].replace([np.inf, -np.inf], np.nan)

    if huge_counts:
        print(f"\n  WARNING: {len(huge_counts)} features have values > {MAGNITUDE_THRESHOLD:.0e}:")
        for col, cnt in sorted(huge_counts.items(), key=lambda x: -x[1])[:10]:
            max_val = df[col].abs().max()
            print(f"    {col:<40} {cnt:>6} rows (max={max_val:.2e})")

    if not inf_counts and not huge_counts:
        print(f"\n  Pre-fit checks: CLEAN (no inf, no extreme magnitudes)")

    # ─── Winsorize outliers ─────────────────────────────────────────────────
    # Clip features to [1st, 99th] percentile per column to tame extreme values
    winsorized_count = 0
    for col in numeric_cols:
        if col in feature_cols:
            p01, p99 = df[col].quantile(0.01), df[col].quantile(0.99)
            if p01 == p99:
                continue  # constant column, skip
            clipped = df[col].clip(lower=p01, upper=p99)
            n_clipped = (df[col] != clipped).sum()
            if n_clipped > 0:
                df[col] = clipped
                winsorized_count += 1
    print(f"\n  Winsorized {winsorized_count} features to [1st, 99th] percentile")

    print(f"\n  Features: {len(feature_cols)}")
    print(f"  Mode: {MODE}  |  Problem: {PROBLEM_TYPE}  |  Metric: {EVAL_METRIC}")
    print(f"  Timeframe: {TIMEFRAME}  |  Horizons: {list(HORIZONS.keys())}")
    tl_label = f"{TIME_LIMIT_PER_FOLD}s" if TIME_LIMIT_PER_FOLD is not None else "unlimited"
    hp_summary = ", ".join(f"{k}({len(v)})" for k, v in HYPERPARAMETERS.items())
    print(f"  Phase: {args.phase}  |  Hyperparameters: {hp_summary}  |  Time/fold: {tl_label}  |  Folds: {N_FOLDS}")
    print(f"  Bagging: {NUM_BAG_FOLDS} folds  |  Stacking: {NUM_STACK_LEVELS} levels  |  DyStack: {DYNAMIC_STACKING}")
    print(f"  Compute: num_cpus={NUM_CPUS}")
    print(f"  Memory ratio: {MAX_MEMORY_RATIO} (ag.max_memory_usage_ratio)")
    print(f"  Clean mode: {'YES — old fold dirs deleted' if args.clean else 'NO'}")

    if TIME_LIMIT_PER_FOLD is not None:
        total_time_est = TIME_LIMIT_PER_FOLD * N_FOLDS * len(HORIZONS)
        print(f"  Est. total training time: {total_time_est / 3600:.1f} hours")
    else:
        print(f"  Est. total training time: unlimited (each model trains to completion)")
    print(f"  Reports: {'DISABLED' if args.skip_reports else REPORT_ROOT}")

    # Initialize OOF predictions dataframe
    oof_df = df[["timestamp"]].copy()
    results = {}

    # ─── Train each horizon ───────────────────────────────────────────────────

    for horizon_name, config in HORIZONS.items():
        target_col = config["target"]
        purge = config["purge_bars"]
        embargo = config["embargo_bars"]

        print(f"\n{'='*60}")
        print(f"HORIZON: {horizon_name}  target={target_col}  purge={purge}  embargo={embargo}")
        print(f"{'='*60}")

        splits = walk_forward_splits(len(df), N_FOLDS, purge, embargo)
        print(f"  Walk-forward folds: {len(splits)}")

        oof_preds = pd.Series(np.nan, index=df.index, dtype=float)

        for fold_i, (train_idx, val_idx) in enumerate(splits):
            print(f"\n  -- Fold {fold_i + 1}/{len(splits)} --")
            print(f"  Train: {len(train_idx):,} rows  |  Val: {len(val_idx):,} rows")

            train_data = df.iloc[train_idx][feature_cols + [target_col]]
            val_data = df.iloc[val_idx][feature_cols + [target_col]]

            # Safety: drop any residual NaN targets
            train_data = train_data.dropna(subset=[target_col])
            val_data = val_data.dropna(subset=[target_col])

            if len(train_data) < 100 or len(val_data) < 10:
                print(f"    SKIP: insufficient data")
                continue

            fold_dir = MODEL_DIR / horizon_name / f"fold_{fold_i}"
            fold_dir.mkdir(parents=True, exist_ok=True)

            predictor = TabularPredictor(
                label=target_col,
                path=str(fold_dir),
                problem_type=PROBLEM_TYPE,
                eval_metric=EVAL_METRIC,
                verbosity=2,
            )

            # ─── FIT CALL (phase-configured) ──────────────────────────────
            #
            # Phase 1: no bagging/stacking — raw model leaderboard, fast sanity check
            # Phase 2: light bagging (3-fold) + 1 stack level, dynamic_stacking OFF
            #
            # dynamic_stacking=False prevents AutoGluon's DyStack sub-fits inside
            # our outer walk-forward folds (avoids double-ensembling on noise).
            #
            fit_kwargs = dict(
                train_data=train_data,
                hyperparameters=HYPERPARAMETERS,
                num_cpus=NUM_CPUS,
                num_gpus=0,
                num_bag_folds=NUM_BAG_FOLDS,
                num_stack_levels=NUM_STACK_LEVELS,
                dynamic_stacking=DYNAMIC_STACKING,
                ag_args_fit={
                    "num_cpus": NUM_CPUS,
                    "num_early_stopping_rounds": 30,
                    "ag.max_memory_usage_ratio": MAX_MEMORY_RATIO,
                },
            )
            if TIME_LIMIT_PER_FOLD is not None:
                fit_kwargs["time_limit"] = TIME_LIMIT_PER_FOLD
            if NUM_BAG_FOLDS > 0:
                fit_kwargs["ag_args_ensemble"] = {
                    "fold_fitting_strategy": "parallel_local" if NUM_CPUS > 1 else "sequential_local",
                }
            predictor.fit(**fit_kwargs)

            # Fold leaderboard
            leaderboard = predictor.leaderboard(val_data, silent=True)
            print(f"\n    Leaderboard (top 10):")
            print(leaderboard.head(10).to_string())

            # OOF predictions for this fold
            if MODE == "classify":
                # Use probability of class 1 (up) for ranking and thresholding
                # CRITICAL: extract P(class=1) by explicit label, never by position
                preds_proba = predictor.predict_proba(val_data[feature_cols])
                class_labels = predictor.class_labels  # ordered list of classes
                pos_label = 1  # target encoding: 1=up, 0=down

                if fold_i == 0:
                    print(f"    [prob-check] class_labels={class_labels}")
                    print(f"    [prob-check] preds_proba.columns={list(preds_proba.columns)}")
                    print(f"    [prob-check] preds_proba.iloc[0]={preds_proba.iloc[0].to_dict()}")

                if pos_label in preds_proba.columns:
                    preds_np = preds_proba[pos_label].to_numpy()
                elif str(pos_label) in preds_proba.columns:
                    preds_np = preds_proba[str(pos_label)].to_numpy()
                else:
                    # Last resort: find pos_label index in class_labels
                    pos_idx = list(class_labels).index(pos_label)
                    preds_np = preds_proba.iloc[:, pos_idx].to_numpy()
                    print(f"    [prob-check] WARNING: used positional index {pos_idx} for class {pos_label}")

                # Guardrails: verify probabilities are valid
                assert preds_np.min() >= 0.0 and preds_np.max() <= 1.0, \
                    f"Probabilities out of [0,1]: min={preds_np.min():.4f}, max={preds_np.max():.4f}"
                base_rate = val_data[target_col].mean()
                pred_mean = preds_np.mean()
                if fold_i == 0:
                    print(f"    [prob-check] base_rate={base_rate:.4f}, pred_mean={pred_mean:.4f}")
                    if abs(pred_mean - (1 - base_rate)) < abs(pred_mean - base_rate):
                        print(f"    [prob-check] WARNING: pred_mean closer to 1-base_rate — POSSIBLE INVERSION!")

                preds_class = (preds_np >= 0.5).astype(int)
            else:
                preds = predictor.predict(val_data[feature_cols])
                preds_np = preds.to_numpy() if hasattr(preds, "to_numpy") else np.asarray(preds)
            oof_preds.loc[val_data.index] = preds_np

            # Fold-level metrics
            actuals = val_data[target_col].values
            if MODE == "classify":
                from sklearn.metrics import roc_auc_score, accuracy_score
                fold_auc = roc_auc_score(actuals, preds_np)
                fold_acc = accuracy_score(actuals, preds_class)
                fold_ic, _ = spearmanr(actuals, preds_np)
                print(f"\n    Fold AUC: {fold_auc:.4f}  Acc: {fold_acc:.4f}  IC: {fold_ic:.4f}")
            else:
                fold_mae = mean_absolute_error(actuals, preds_np)
                fold_rmse = np.sqrt(mean_squared_error(actuals, preds_np))
                fold_ic, _ = spearmanr(actuals, preds_np)
                print(f"\n    Fold MAE: {fold_mae:.6f}  RMSE: {fold_rmse:.6f}  IC: {fold_ic:.4f}")

            # Feature importance from best single model (not ensemble)
            top_features = []
            try:
                importance = predictor.feature_importance(val_data, silent=True)
                top5 = importance.head(5)
                print(f"    Top 5 features: {list(top5.index)}")
                top_features = list(top5.index)
            except Exception:
                pass  # Some folds may not support importance

            # ─── Fold metadata JSON ───────────────────────────────────────
            fold_meta = {
                "horizon": horizon_name,
                "fold": fold_i,
                "n_train": len(train_data),
                "n_val": len(val_data),
                "n_features": len(feature_cols),
                "models_trained": list(leaderboard["model"].values) if "model" in leaderboard.columns else [],
                "top_features": top_features,
            }
            if MODE == "classify":
                fold_meta["auc"] = float(fold_auc)
                fold_meta["acc"] = float(fold_acc)
                fold_meta["ic"] = float(fold_ic)
            else:
                fold_meta["mae"] = float(fold_mae)
                fold_meta["rmse"] = float(fold_rmse)
                fold_meta["ic"] = float(fold_ic)
            fold_meta_path = fold_dir / "fold_meta.json"
            with open(fold_meta_path, "w") as f:
                json.dump(fold_meta, f, indent=2)
            print(f"    Fold metadata: {fold_meta_path.relative_to(PROJECT_ROOT)}")

        # ─── Aggregate OOF metrics for this horizon ───────────────────────────

        oof_mask = oof_preds.notna()
        oof_actual = df.loc[oof_mask, target_col].values
        oof_pred = oof_preds[oof_mask].values

        if len(oof_actual) > 0:
            ic, ic_pval = spearmanr(oof_actual, oof_pred)

            if MODE == "classify":
                from sklearn.metrics import roc_auc_score, accuracy_score
                auc = roc_auc_score(oof_actual, oof_pred)
                acc = accuracy_score(oof_actual, (oof_pred >= 0.5).astype(int))
                # Trading-relevant: accuracy at high-confidence thresholds
                high_conf_mask = (oof_pred >= 0.55) | (oof_pred <= 0.45)
                hc_acc = accuracy_score(
                    oof_actual[high_conf_mask],
                    (oof_pred[high_conf_mask] >= 0.5).astype(int)
                ) if high_conf_mask.sum() > 0 else 0
                hc_n = high_conf_mask.sum()

                results[horizon_name] = {
                    "AUC": auc, "Acc": acc, "HC_Acc": hc_acc, "HC_n": hc_n,
                    "IC": ic, "IC_pval": ic_pval, "n_oof": len(oof_actual),
                }

                print(f"\n  === OOF Results: {horizon_name} ===")
                print(f"    AUC:       {auc:.4f}  {'<-- SIGNAL' if auc > 0.52 else '<-- below threshold'}")
                print(f"    Accuracy:  {acc:.4f}  ({acc*100:.1f}%)")
                print(f"    HC Acc:    {hc_acc:.4f}  ({hc_acc*100:.1f}% on {hc_n:,} high-conf rows, p>0.55 or p<0.45)")
                print(f"    IC:        {ic:.4f}  (p={ic_pval:.2e})")
                print(f"    n:         {len(oof_actual):,}")
            else:
                mae = mean_absolute_error(oof_actual, oof_pred)
                rmse = np.sqrt(mean_squared_error(oof_actual, oof_pred))
                r2 = r2_score(oof_actual, oof_pred)

                results[horizon_name] = {
                    "MAE": mae, "RMSE": rmse, "R2": r2, "IC": ic, "IC_pval": ic_pval,
                    "n_oof": len(oof_actual),
                }

                print(f"\n  === OOF Results: {horizon_name} ===")
                print(f"    MAE:  {mae:.6f}")
                print(f"    RMSE: {rmse:.6f}")
                print(f"    R2:   {r2:.4f}")
                print(f"    IC:   {ic:.4f}  (p={ic_pval:.2e})")
                print(f"    n:    {len(oof_actual):,}")

            # Generate regression report artifacts only for regression-style modes
            if generate_regression_report is not None and MODE in {"regress", "volnorm"}:
                report_dir = REPORT_ROOT / "core_forecaster" / TIMEFRAME / horizon_name
                try:
                    report_summary = generate_regression_report(
                        model_name=f"core_forecaster_{TIMEFRAME}_{horizon_name}",
                        timestamps=df.loc[oof_mask, "timestamp"],
                        actual=oof_actual,
                        predicted=oof_pred,
                        out_dir=report_dir,
                        metadata={
                            "timeframe": TIMEFRAME,
                            "horizon": horizon_name,
                            "target_col": target_col,
                            "folds": len(splits),
                            "purge_bars": purge,
                            "embargo_bars": embargo,
                            "hyperparameters": list(HYPERPARAMETERS.keys()),
                            "time_limit_per_fold": TIME_LIMIT_PER_FOLD,
                            "feature_count": len(feature_cols),
                        },
                    )
                    pyfolio_state = "enabled" if report_summary.get("pyfolio", {}).get("enabled") else "skipped"
                    print(f"    Report: {report_dir} (pyfolio: {pyfolio_state})")
                except Exception as exc:
                    print(f"    Report generation failed: {exc}")
        else:
            print(f"\n  WARNING: No OOF predictions for {horizon_name}")

        # Store in OOF output
        oof_df[f"oof_{horizon_name}"] = oof_preds
        oof_df[f"actual_{horizon_name}"] = df[target_col]

    # ─── Save OOF predictions ─────────────────────────────────────────────────

    OOF_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    oof_df.to_csv(OOF_OUTPUT, index=False)
    print(f"\nOOF predictions saved: {OOF_OUTPUT}")

    # ─── Final Summary ────────────────────────────────────────────────────────

    print(f"\n{'='*60}")
    MODE_LABELS = {
        "classify": "Direction Classifier (binary)",
        "volnorm": "Vol-Normalized Forecaster",
        "regress": "Raw Return Forecaster",
    }
    print(f"SUMMARY: MES Core {MODE_LABELS.get(MODE, MODE)}  [{TIMEFRAME}]")
    print(f"{'='*60}")
    print(f"Dataset:  {DATASET_PATH.name} ({len(df):,} rows x {len(df.columns)} cols)")
    print(f"Features: {len(feature_cols)}")
    print(f"Mode:     {MODE}  |  Metric: {EVAL_METRIC}")
    print(f"Phase:    {args.phase}  |  Hyperparams: {hp_summary}  |  Time/fold: {tl_label}")
    print(f"Models:   GBM + CAT + XGB + XT {'-> WeightedEnsemble' if NUM_STACK_LEVELS > 0 else '(no stacking)'}")
    print()
    if MODE == "classify":
        print(f"{'Horizon':<10} {'AUC':>8} {'Acc':>8} {'HC_Acc':>8} {'HC_n':>8} {'IC':>8} {'n':>8}")
        print(f"{'-'*60}")
        for h, r in results.items():
            signal = " <SIGNAL" if r["AUC"] > 0.52 else ""
            print(f"{h:<10} {r['AUC']:>8.4f} {r['Acc']:>8.4f} {r['HC_Acc']:>8.4f} {r['HC_n']:>8,} {r['IC']:>8.4f} {r['n_oof']:>8,}{signal}")
    else:
        print(f"{'Horizon':<10} {'MAE':>10} {'RMSE':>10} {'R2':>8} {'IC':>8} {'n':>8}")
        print(f"{'-'*56}")
        for h, r in results.items():
            print(f"{h:<10} {r['MAE']:>10.6f} {r['RMSE']:>10.6f} {r['R2']:>8.4f} {r['IC']:>8.4f} {r['n_oof']:>8,}")

    if results:
        print(f"\nModels: {MODEL_DIR}")
        print(f"OOF:    {OOF_OUTPUT}")
        print(f"Log:    {log_path}")

    log_file.close()
    sys.stdout = sys.__stdout__
    sys.stderr = sys.__stderr__


if __name__ == "__main__":
    main()
