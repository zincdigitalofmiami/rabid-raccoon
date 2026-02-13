"""
train-core-forecaster.py

Core Return Forecaster — Model 1 of 2.

Trains 4 AutoGluon regressors (1h/4h/8h/24h forward returns) with
walk-forward OOF and purge gaps. Uses the existing mes_1h_complete.csv
dataset (85 features, 11k+ rows).

Walk-forward scheme:
  - 5 expanding-window folds
  - Purge gap = target horizon (e.g. 24 bars for 24h target)
  - Embargo = 2x purge gap
  - Produces OOF predictions for every training row

Outputs:
  - models/core_forecaster/{horizon}/   (AutoGluon model artifacts)
  - datasets/autogluon/core_oof.csv     (OOF predictions + MAE per row)
  - Console: OOF MAE, RMSE, R^2 per horizon

Setup:
  pip install -r mes_hft_halsey/requirements.txt
  python scripts/train-core-forecaster.py
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
DATASET_PATH = PROJECT_ROOT / "datasets" / "autogluon" / "mes_1h_complete.csv"
MODEL_DIR = PROJECT_ROOT / "models" / "core_forecaster"
OOF_OUTPUT = PROJECT_ROOT / "datasets" / "autogluon" / "core_oof.csv"

HORIZONS = {
    "1h":  {"target": "target_ret_1h",  "purge_bars": 1,  "embargo_bars": 2},
    "4h":  {"target": "target_ret_4h",  "purge_bars": 4,  "embargo_bars": 8},
    "8h":  {"target": "target_ret_8h",  "purge_bars": 8,  "embargo_bars": 16},
    "24h": {"target": "target_ret_24h", "purge_bars": 24, "embargo_bars": 48},
}

# Columns to exclude from features
DROP_COLS = {"item_id", "timestamp", "target", "target_ret_1h", "target_ret_4h", "target_ret_8h", "target_ret_24h"}

N_FOLDS = 5
TIME_LIMIT_PER_FOLD = 300  # seconds per AutoGluon fit
PRESETS = "medium_quality"  # "best_quality" for production, "medium_quality" for speed


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
        from autogluon.tabular import TabularPredictor
    except ImportError:
        print("ERROR: AutoGluon not installed.")
        print("Install with: pip install -r mes_hft_halsey/requirements.txt")
        sys.exit(1)

    print(f"Loading dataset from {DATASET_PATH}")
    df = pd.read_csv(DATASET_PATH)
    print(f"  Rows: {len(df):,}  Columns: {len(df.columns)}")

    # Sort by timestamp (critical for walk-forward)
    df = df.sort_values("timestamp").reset_index(drop=True)

    # Drop rows with NaN targets
    initial_len = len(df)
    df = df.dropna(subset=[h["target"] for h in HORIZONS.values()])
    print(f"  After dropping NaN targets: {len(df):,} rows ({initial_len - len(df)} dropped)")

    # Feature columns
    feature_cols = [c for c in df.columns if c not in DROP_COLS]
    print(f"  Feature columns: {len(feature_cols)}")

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
                verbosity=1,
            )

            predictor.fit(
                train_data=train_data,
                time_limit=TIME_LIMIT_PER_FOLD,
                presets=PRESETS,
                excluded_model_types=["KNN"],  # slow, low value for time series
            )

            preds = predictor.predict(val_data[feature_cols])
            oof_preds.iloc[val_idx[:len(preds)]] = preds.values

            # Fold metrics
            actuals = val_data[target_col].values
            fold_mae = mean_absolute_error(actuals, preds.values)
            fold_rmse = np.sqrt(mean_squared_error(actuals, preds.values))
            print(f"    Fold MAE: {fold_mae:.6f}  RMSE: {fold_rmse:.6f}")

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
