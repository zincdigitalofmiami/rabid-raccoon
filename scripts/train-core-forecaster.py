"""
train-core-forecaster.py

MES Core Return Forecaster — AutoGluon 1.5 TabularPredictor
Optimized for 1h/4h day-trading horizons with walk-forward validation.

Dataset: mes_lean_1h.csv (~144 columns, ~36K rows from 2020+)
  - 22 MES technicals (EDSS, MAs, returns, vol)
  - 48 cross-asset technicals (8 symbols x 6 features)
  - 19 FRED macro, 10 derived regime features
  - 6 event/calendar, 7 release signals, 4 news sentiment
  - 9 BHG quality feedback, 5 time features, 6 cross-asset composites

Models: GBM (LightGBM), CAT (CatBoost), XGB (XGBoost), XT (ExtraTrees)
  - Stacked ensemble via auto_stack (weighted blend of all 4)
  - KNN, FASTAI, RF, NN_TORCH excluded

Walk-forward scheme:
  - 5 expanding-window folds
  - Purge gap = target horizon bars (prevents label leakage)
  - Embargo = 2x purge (prevents autocorrelation bleed)
  - Produces OOF predictions for every training row

Outputs:
  - models/core_forecaster/{horizon}/fold_N/  (AutoGluon artifacts per fold)
  - datasets/autogluon/core_oof_1h.csv        (OOF predictions + actuals)
  - models/reports/core_forecaster/...         (metrics, charts, tear sheets)

Usage:
  python scripts/train-core-forecaster.py
  python scripts/train-core-forecaster.py --time-limit=1200 --skip-reports
  python scripts/train-core-forecaster.py --horizons=1h --presets=medium_quality

Training time estimate (default settings):
  2400s x 5 folds x 2 horizons = ~6.7 hours on Apple Silicon
"""

import sys
import warnings
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

warnings.filterwarnings("ignore", category=FutureWarning)

# ─── Configuration ────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = PROJECT_ROOT / "models" / "core_forecaster"

# Parse CLI args
import argparse
parser = argparse.ArgumentParser(description="MES Core Return Forecaster")
parser.add_argument("--horizons", default=None, help="Comma-separated horizons to train (e.g. 1h,4h)")
parser.add_argument("--presets", default="best_quality", help="AutoGluon presets")
parser.add_argument("--time-limit", type=int, default=2400, help="Seconds per fold (default: 2400 = 40 min)")
parser.add_argument("--report-root", default="models/reports", help="Directory for reports")
parser.add_argument("--skip-reports", action="store_true", help="Skip report generation")
parser.add_argument("--min-coverage", type=float, default=0.05, help="Min non-null fraction to keep a feature (default: 0.05 = 5%%)")
args = parser.parse_args()

# ─── Dataset: mes_lean_1h.csv (the ONLY dataset) ─────────────────────────────

DATASET_PATH = PROJECT_ROOT / "datasets" / "autogluon" / "mes_lean_1h.csv"
OOF_OUTPUT = PROJECT_ROOT / "datasets" / "autogluon" / "core_oof_1h.csv"

# Day-trading horizons only: 1h (scalp signal) and 4h (runner signal)
HORIZONS = {
    "1h": {"target": "target_ret_1h", "purge_bars": 1,  "embargo_bars": 2},
    "4h": {"target": "target_ret_4h", "purge_bars": 4,  "embargo_bars": 8},
}

# Identity + all forward target columns — NEVER used as features
DROP_COLS = {
    "item_id", "timestamp", "target",
    "target_ret_1h", "target_ret_4h", "target_ret_8h",
    "target_ret_24h", "target_ret_1w",
}

# Filter horizons if specified via CLI
if args.horizons:
    requested = set(args.horizons.split(","))
    HORIZONS = {k: v for k, v in HORIZONS.items() if k in requested}
    if not HORIZONS:
        print(f"ERROR: No valid horizons in '{args.horizons}'. Available: 1h, 4h")
        sys.exit(1)

N_FOLDS = 5
TIME_LIMIT_PER_FOLD = args.time_limit
PRESETS = args.presets
REPORT_ROOT = Path(args.report_root)
if not REPORT_ROOT.is_absolute():
    REPORT_ROOT = PROJECT_ROOT / REPORT_ROOT

# Models excluded from training:
# KNN:      curse of dimensionality on 130+ feature space
# FASTAI:   unreliable on CPU-only Apple Silicon, wastes time budget
# RF:       redundant with ExtraTrees, slower training
# NN_TORCH: tends to overfit on weak financial signal with tabular data
EXCLUDED_MODELS = ["KNN", "FASTAI", "RF", "NN_TORCH"]


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


# ─── Main Training Loop ──────────────────────────────────────────────────────

def main():
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

    # ─── Load & validate dataset ──────────────────────────────────────────────

    if not DATASET_PATH.exists():
        print(f"ERROR: Dataset not found at {DATASET_PATH}")
        print("Run: npx tsx scripts/build-lean-dataset.ts")
        sys.exit(1)

    print(f"Loading dataset: {DATASET_PATH}")
    df = pd.read_csv(DATASET_PATH)
    print(f"  Rows: {len(df):,}  Columns: {len(df.columns)}")

    # Sort by timestamp (critical for walk-forward integrity)
    df = df.sort_values("timestamp").reset_index(drop=True)

    # Drop rows with NaN targets
    target_cols = [h["target"] for h in HORIZONS.values()]
    initial_len = len(df)
    df = df.dropna(subset=target_cols)
    dropped = initial_len - len(df)
    if dropped > 0:
        print(f"  Dropped {dropped} rows with NaN targets -> {len(df):,} remaining")

    # Feature columns = everything except identity + targets
    feature_cols = [c for c in df.columns if c not in DROP_COLS]

    # ─── Auto-drop near-empty features ────────────────────────────────────────
    # Features with <MIN_COVERAGE non-null values are noise for tree models.
    # BHG features (0.2% coverage) and net_sentiment (0.1%) get dropped here.

    min_coverage = args.min_coverage
    sparse_cols = []
    for col in feature_cols:
        coverage = df[col].notna().mean()
        if coverage < min_coverage:
            sparse_cols.append((col, coverage))

    if sparse_cols:
        print(f"\n  Dropping {len(sparse_cols)} sparse features (<{min_coverage:.0%} non-null):")
        for col, cov in sparse_cols:
            print(f"    {col:<32} {cov:.1%}")
        feature_cols = [c for c in feature_cols if c not in {s[0] for s in sparse_cols}]

    print(f"\n  Features: {len(feature_cols)}")
    print(f"  Horizons: {list(HORIZONS.keys())}")
    print(f"  Presets: {PRESETS}  |  Time/fold: {TIME_LIMIT_PER_FOLD}s  |  Folds: {N_FOLDS}")
    print(f"  Excluded models: {EXCLUDED_MODELS}")

    total_time_est = TIME_LIMIT_PER_FOLD * N_FOLDS * len(HORIZONS)
    print(f"  Est. total training time: {total_time_est / 3600:.1f} hours")
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
                problem_type="regression",
                eval_metric="mean_absolute_error",
                verbosity=2,
            )

            # ─── THE OPTIMIZED FIT CALL ───────────────────────────────────
            #
            # Models kept: GBM, CAT, XGB, XT → stacked ensemble
            # Models killed: KNN, FASTAI, RF, NN_TORCH
            #
            # Key tuning:
            #   num_bag_folds=3      (sufficient with 36K rows; saves ~40% vs 5)
            #   num_stack_levels=1   (single stack — more = overfitting risk)
            #   early_stopping=30    (tight for weak financial signal)
            #   num_gpus=0           (CPU-only for Apple Silicon reliability)
            #   sequential_local     (memory-safe on unified memory)
            #
            predictor.fit(
                train_data=train_data,
                time_limit=TIME_LIMIT_PER_FOLD,
                presets=PRESETS,
                num_gpus=0,
                excluded_model_types=EXCLUDED_MODELS,
                num_bag_folds=3,
                num_stack_levels=1,
                ag_args_ensemble={
                    "fold_fitting_strategy": "sequential_local",
                },
                ag_args_fit={
                    "num_early_stopping_rounds": 30,
                },
            )

            # Fold leaderboard
            leaderboard = predictor.leaderboard(val_data, silent=True)
            print(f"\n    Leaderboard (top 10):")
            print(leaderboard.head(10).to_string())

            # OOF predictions for this fold
            preds = predictor.predict(val_data[feature_cols])
            preds_np = preds.to_numpy() if hasattr(preds, "to_numpy") else np.asarray(preds)
            oof_preds.loc[val_data.index] = preds_np

            # Fold-level metrics
            actuals = val_data[target_col].values
            fold_mae = mean_absolute_error(actuals, preds_np)
            fold_rmse = np.sqrt(mean_squared_error(actuals, preds_np))
            print(f"\n    Fold MAE: {fold_mae:.6f}  RMSE: {fold_rmse:.6f}")

            # Feature importance from best single model (not ensemble)
            try:
                importance = predictor.feature_importance(val_data, silent=True)
                top5 = importance.head(5)
                print(f"    Top 5 features: {list(top5.index)}")
            except Exception:
                pass  # Some folds may not support importance

        # ─── Aggregate OOF metrics for this horizon ───────────────────────────

        oof_mask = oof_preds.notna()
        oof_actual = df.loc[oof_mask, target_col].values
        oof_pred = oof_preds[oof_mask].values

        if len(oof_actual) > 0:
            mae = mean_absolute_error(oof_actual, oof_pred)
            rmse = np.sqrt(mean_squared_error(oof_actual, oof_pred))
            r2 = r2_score(oof_actual, oof_pred)

            results[horizon_name] = {
                "MAE": mae, "RMSE": rmse, "R2": r2,
                "n_oof": len(oof_actual),
            }

            print(f"\n  === OOF Results: {horizon_name} ===")
            print(f"    MAE:  {mae:.6f}")
            print(f"    RMSE: {rmse:.6f}")
            print(f"    R2:   {r2:.4f}")
            print(f"    n:    {len(oof_actual):,}")

            # Generate report artifacts if enabled
            if generate_regression_report is not None:
                report_dir = REPORT_ROOT / "core_forecaster" / "1h" / horizon_name
                try:
                    report_summary = generate_regression_report(
                        model_name=f"core_forecaster_1h_{horizon_name}",
                        timestamps=df.loc[oof_mask, "timestamp"],
                        actual=oof_actual,
                        predicted=oof_pred,
                        out_dir=report_dir,
                        metadata={
                            "horizon": horizon_name,
                            "target_col": target_col,
                            "folds": len(splits),
                            "purge_bars": purge,
                            "embargo_bars": embargo,
                            "presets": PRESETS,
                            "time_limit_per_fold": TIME_LIMIT_PER_FOLD,
                            "feature_count": len(feature_cols),
                            "excluded_models": EXCLUDED_MODELS,
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
    print("SUMMARY: MES Core Return Forecaster")
    print(f"{'='*60}")
    print(f"Dataset:  mes_lean_1h.csv ({len(df):,} rows x {len(df.columns)} cols)")
    print(f"Features: {len(feature_cols)}")
    print(f"Models:   GBM + CAT + XGB + XT -> WeightedEnsemble")
    print(f"Presets:  {PRESETS}  |  Time/fold: {TIME_LIMIT_PER_FOLD}s")
    print()
    print(f"{'Horizon':<10} {'MAE':>10} {'RMSE':>10} {'R2':>8} {'n':>8}")
    print(f"{'-'*48}")
    for h, r in results.items():
        print(f"{h:<10} {r['MAE']:>10.6f} {r['RMSE']:>10.6f} {r['R2']:>8.4f} {r['n_oof']:>8,}")

    if results:
        print(f"\nNext: Use models/core_forecaster/{{horizon}}/fold_N/ for inference")
        print(f"      OOF file: {OOF_OUTPUT}")


if __name__ == "__main__":
    main()
