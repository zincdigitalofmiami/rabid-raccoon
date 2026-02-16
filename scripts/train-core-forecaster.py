"""
train-core-forecaster.py

Core Return Forecaster — trains AutoGluon 1.5 TabularPredictor regressors for
multiple horizons with walk-forward OOF and purge gaps.

Supports two dataset modes:
  --dataset=1h   (default) → mes_1h_complete.csv, horizons: 1h/4h/24h/1w
  --dataset=15m             → mes_15m_complete.csv, horizons: 15m/1h/4h

Supports horizon filtering:
  --horizons=15m,1h         → only train specified horizons

Walk-forward scheme:
  - 5 expanding-window folds
  - Purge gap = target horizon bars
  - Embargo = 2x purge gap
  - Produces OOF predictions for every training row

AutoGluon best_quality preset:
  - Zeroshot portfolio: ~100 pre-tuned configs (GBM, CAT, XGB, RF, XT, NN_TORCH, FASTAI)
  - auto_stack=True with dynamic_stacking
  - 8 internal bag folds, 1 bag set
  - Text column (headlines_7d) → n-gram + special feature extraction
  - eval_metric=MAE (robust to fat-tailed return distributions)

Outputs:
  - models/core_forecaster/{horizon}/   (AutoGluon model artifacts)
  - datasets/autogluon/core_oof_{dataset}.csv (OOF predictions + MAE per row)
  - models/reports/core_forecaster/{dataset}/{horizon}/ (metrics/charts/tear sheets)
  - Console: OOF MAE, RMSE, R^2 per horizon

Setup:
  pip install "autogluon>=1.5" pandas scikit-learn
  pip install -r requirements-finance.txt
  python scripts/train-core-forecaster.py --dataset=1h
  python scripts/train-core-forecaster.py --dataset=1h --horizons=1h --presets=medium_quality --time-limit=120

Note: AutoGluon >=1.5 TabularPredictor auto-detects text columns (headlines_7d)
and uses n-gram + special feature extraction. No custom NLP needed.
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
parser = argparse.ArgumentParser()
parser.add_argument("--dataset", default="1h", choices=["1h", "15m"])
parser.add_argument("--horizons", default=None, help="Comma-separated horizons to train (e.g. 15m,1h)")
parser.add_argument("--presets", default="best_quality", help="AutoGluon presets (best_quality, medium_quality, etc.)")
parser.add_argument("--time-limit", type=int, default=3600, help="Seconds per fold (3600 = 1 hour)")
parser.add_argument(
    "--report-root",
    default="models/reports",
    help="Directory for model reports (relative to project root unless absolute).",
)
parser.add_argument(
    "--skip-reports",
    action="store_true",
    help="Skip report artifact generation.",
)
args = parser.parse_args()

DATASET_CONFIGS = {
    "1h": {
        "path": PROJECT_ROOT / "datasets" / "autogluon" / "mes_1h_complete.csv",
        "oof_output": PROJECT_ROOT / "datasets" / "autogluon" / "core_oof_1h.csv",
        "horizons": {
            "1h":  {"target": "target_ret_1h",  "purge_bars": 1,   "embargo_bars": 2},
            "4h":  {"target": "target_ret_4h",  "purge_bars": 4,   "embargo_bars": 8},
            "24h": {"target": "target_ret_24h", "purge_bars": 24,  "embargo_bars": 48},
            "1w":  {"target": "target_ret_1w",  "purge_bars": 168, "embargo_bars": 336},
        },
        "drop_cols": {"item_id", "timestamp", "target",
                      "target_ret_1h", "target_ret_4h", "target_ret_8h", "target_ret_24h", "target_ret_1w"},
    },
    "15m": {
        "path": PROJECT_ROOT / "datasets" / "autogluon" / "mes_15m_complete.csv",
        "oof_output": PROJECT_ROOT / "datasets" / "autogluon" / "core_oof_15m.csv",
        "horizons": {
            "15m": {"target": "target_ret_15m", "purge_bars": 1,  "embargo_bars": 2},
            "1h":  {"target": "target_ret_1h",  "purge_bars": 4,  "embargo_bars": 8},
            "4h":  {"target": "target_ret_4h",  "purge_bars": 16, "embargo_bars": 32},
        },
        "drop_cols": {"item_id", "timestamp", "target",
                      "target_ret_15m", "target_ret_1h", "target_ret_4h"},
    },
}

cfg = DATASET_CONFIGS[args.dataset]
DATASET_PATH = cfg["path"]
OOF_OUTPUT = cfg["oof_output"]
HORIZONS = cfg["horizons"]
DROP_COLS = cfg["drop_cols"]

# Filter horizons if specified
if args.horizons:
    requested = set(args.horizons.split(","))
    HORIZONS = {k: v for k, v in HORIZONS.items() if k in requested}
    if not HORIZONS:
        print(f"ERROR: No valid horizons in '{args.horizons}'. Available: {list(cfg['horizons'].keys())}")
        sys.exit(1)

N_FOLDS = 5
TIME_LIMIT_PER_FOLD = args.time_limit
PRESETS = args.presets
REPORT_ROOT = Path(args.report_root)
if not REPORT_ROOT.is_absolute():
    REPORT_ROOT = PROJECT_ROOT / REPORT_ROOT


# ─── Walk-Forward Splitter ────────────────────────────────────────────────────

def walk_forward_splits(n: int, n_folds: int, purge: int, embargo: int):
    """
    Expanding-window walk-forward cross-validation.

    Each fold:
      train = [0, split_point)
      gap   = [split_point, split_point + purge + embargo)   # purged
      val   = [split_point + purge + embargo, next_split)
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
        from autogluon.tabular import TabularPredictor, FeatureMetadata
    except ImportError:
        print("ERROR: AutoGluon not installed.")
        print("Install with: pip install 'autogluon>=1.5' pandas scikit-learn")
        sys.exit(1)

    generate_regression_report = None
    if not args.skip_reports:
        try:
            from model_report_utils import generate_regression_report as _generate_regression_report
            generate_regression_report = _generate_regression_report
        except Exception as exc:
            print("ERROR: Report dependencies are unavailable.")
            print("Install with: pip install -r requirements-finance.txt")
            print(f"Details: {exc}")
            sys.exit(1)

    print(f"Loading dataset from {DATASET_PATH}")
    df = pd.read_csv(DATASET_PATH)
    print(f"  Rows: {len(df):,}  Columns: {len(df.columns)}")
    print(f"  Presets: {PRESETS}  Time limit/fold: {TIME_LIMIT_PER_FOLD}s")
    print(f"  Reports: {'disabled' if args.skip_reports else REPORT_ROOT}")

    # Sort by timestamp (critical for walk-forward)
    df = df.sort_values("timestamp").reset_index(drop=True)

    # Drop rows with NaN targets
    initial_len = len(df)
    df = df.dropna(subset=[h["target"] for h in HORIZONS.values()])
    print(f"  After dropping NaN targets: {len(df):,} rows ({initial_len - len(df)} dropped)")

    # Feature columns
    feature_cols = [c for c in df.columns if c not in DROP_COLS]
    print(f"  Feature columns: {len(feature_cols)}")

    # Build FeatureMetadata to force text column detection
    text_cols = [c for c in feature_cols if c in ("headlines_7d", "headlines_24h")]
    feature_metadata = None
    if text_cols:
        # Create metadata from a sample to detect types, then force text columns
        sample = df[feature_cols].head(5)
        feature_metadata = FeatureMetadata.from_df(sample)
        feature_metadata = feature_metadata.add_special_types(
            {col: ["text"] for col in text_cols}
        )
        print(f"  Text columns: {text_cols} (forced via FeatureMetadata)")

    # Initialize OOF dataframe
    oof_df = df[["timestamp"]].copy()

    results = {}

    for horizon_name, config in HORIZONS.items():
        target_col = config["target"]
        purge = config["purge_bars"]
        embargo = config["embargo_bars"]

        print(f"\n{'='*60}")
        print(f"HORIZON: {horizon_name}  (target={target_col}, purge={purge}, embargo={embargo})")
        print(f"{'='*60}")

        # Walk-forward splits
        splits = walk_forward_splits(len(df), N_FOLDS, purge, embargo)
        print(f"  Folds: {len(splits)}")

        oof_preds = pd.Series(np.nan, index=df.index, dtype=float)

        for fold_i, (train_idx, val_idx) in enumerate(splits):
            print(f"\n  Fold {fold_i + 1}/{len(splits)}: train={len(train_idx):,}  val={len(val_idx):,}")

            train_data = df.iloc[train_idx][feature_cols + [target_col]]
            val_data = df.iloc[val_idx][feature_cols + [target_col]]

            # Drop rows where target is NaN (shouldn't happen after earlier dropna, but safety)
            train_data = train_data.dropna(subset=[target_col])
            val_data = val_data.dropna(subset=[target_col])

            if len(train_data) < 100 or len(val_data) < 10:
                print(f"    Skipping (insufficient data)")
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

            fit_kwargs = dict(
                train_data=train_data,
                time_limit=TIME_LIMIT_PER_FOLD,
                presets=PRESETS,
                num_gpus=0,                       # CPU-only for Apple Silicon reliability
                excluded_model_types=["KNN"],     # curse of dimensionality on 80+ features
                ag_args_ensemble={
                    "fold_fitting_strategy": "sequential_local",  # memory-safe on unified memory
                },
            )
            if feature_metadata is not None:
                fit_kwargs["feature_metadata"] = feature_metadata

            predictor.fit(**fit_kwargs)

            # Print leaderboard for this fold
            leaderboard = predictor.leaderboard(val_data, silent=True)
            print(f"\n    ── Fold {fold_i + 1} Leaderboard (top 10) ──")
            print(leaderboard.head(10).to_string())

            preds = predictor.predict(val_data[feature_cols])
            preds_np = preds.to_numpy() if hasattr(preds, "to_numpy") else np.asarray(preds)
            oof_preds.loc[val_data.index] = preds_np

            # Fold metrics
            actuals = val_data[target_col].values
            fold_mae = mean_absolute_error(actuals, preds_np)
            fold_rmse = np.sqrt(mean_squared_error(actuals, preds_np))
            print(f"\n    Fold MAE: {fold_mae:.6f}  RMSE: {fold_rmse:.6f}")

        # Overall OOF metrics
        oof_mask = oof_preds.notna()
        oof_actual = df.loc[oof_mask, target_col].values
        oof_pred = oof_preds[oof_mask].values

        if len(oof_actual) > 0:
            mae = mean_absolute_error(oof_actual, oof_pred)
            rmse = np.sqrt(mean_squared_error(oof_actual, oof_pred))
            r2 = r2_score(oof_actual, oof_pred)

            results[horizon_name] = {"MAE": mae, "RMSE": rmse, "R2": r2, "n_oof": len(oof_actual)}

            print(f"\n  OOF Results ({horizon_name}):")
            print(f"    MAE:  {mae:.6f}")
            print(f"    RMSE: {rmse:.6f}")
            print(f"    R^2:  {r2:.4f}")
            print(f"    n:    {len(oof_actual):,}")

            if generate_regression_report is not None:
                report_dir = REPORT_ROOT / "core_forecaster" / args.dataset / horizon_name
                report_summary = generate_regression_report(
                    model_name=f"core_forecaster_{args.dataset}_{horizon_name}",
                    timestamps=df.loc[oof_mask, "timestamp"],
                    actual=oof_actual,
                    predicted=oof_pred,
                    out_dir=report_dir,
                    metadata={
                        "dataset": args.dataset,
                        "horizon": horizon_name,
                        "target_col": target_col,
                        "folds": len(splits),
                        "purge_bars": purge,
                        "embargo_bars": embargo,
                        "presets": PRESETS,
                        "time_limit_per_fold": TIME_LIMIT_PER_FOLD,
                        "feature_count": len(feature_cols),
                    },
                )
                results[horizon_name]["report_summary"] = str(report_dir / "summary.json")
                pyfolio = report_summary.get("pyfolio", {})
                pyfolio_state = "enabled" if pyfolio.get("enabled") else "skipped"
                print(f"    Report: {report_dir} (pyfolio: {pyfolio_state})")
        else:
            print(f"  WARNING: No OOF predictions for {horizon_name}")

        # Store OOF predictions
        oof_df[f"oof_{horizon_name}"] = oof_preds
        oof_df[f"actual_{horizon_name}"] = df[target_col]

    # ─── Save OOF output ──────────────────────────────────────────────────────

    OOF_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    oof_df.to_csv(OOF_OUTPUT, index=False)
    print(f"\nOOF predictions saved to {OOF_OUTPUT}")

    # ─── Summary ──────────────────────────────────────────────────────────────

    print(f"\n{'='*60}")
    print("SUMMARY: Core Return Forecaster OOF Results")
    print(f"{'='*60}")
    print(f"{'Horizon':<10} {'MAE':>10} {'RMSE':>10} {'R^2':>8} {'n':>8}")
    print(f"{'-'*46}")
    for h, r in results.items():
        print(f"{h:<10} {r['MAE']:>10.6f} {r['RMSE']:>10.6f} {r['R2']:>8.4f} {r['n_oof']:>8,}")


if __name__ == "__main__":
    main()
