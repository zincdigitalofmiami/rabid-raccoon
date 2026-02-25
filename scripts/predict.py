"""
predict.py — MES Directional Forecast from Trained AutoGluon Models (v2.1)

Loads the latest trained folds, reads the most recent feature row(s)
from the lean dataset, and outputs JSON predictions.

v2.1 changes:
  - Nested calibration: loads isotonic OR Platt from calibrator.pkl dict
  - 4 horizons: 1h, 4h, 1d, 1w (dropped 2h)
  - Fold-specific feature lists from fold_meta.json

Usage:
  source .venv-autogluon/bin/activate
  python scripts/predict.py                          # predict latest row
  python scripts/predict.py --rows=24                # predict last 24 rows
  python scripts/predict.py --dataset=path/to.csv    # custom dataset
  python scripts/predict.py --output=predictions.json # write to file

Output JSON format:
  {
    "predictions": [
      {
        "timestamp": "2026-02-16T10:00:00.000Z",
        "price": 6878.75,
        "prob_up_1h": 0.543,
        "prob_up_4h": 0.561,
        "prob_up_1d": 0.528,
        "prob_up_1w": 0.515,
        "direction_1h": "BULLISH",
        "direction_4h": "BULLISH",
        "direction_1d": "BULLISH",
        "direction_1w": "BULLISH",
        "calibrated": true,
        "cal_method": "isotonic"
      }
    ],
    "meta": {
      "model_dir": "models/core_forecaster",
      "dataset": "datasets/autogluon/mes_lean_1h.csv",
      "folds_loaded": {"1h": 5, "4h": 5, "1d": 5, "1w": 5},
      "calibrated": {"1h": true, "4h": true, "1d": true, "1w": true},
      "generated_at": "2026-02-24T18:30:00Z"
    }
  }
"""

import sys
import json
import argparse
import warnings
import pickle
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime, timezone

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models" / "core_forecaster"
DEFAULT_DATASET = ROOT / "datasets" / "autogluon" / "mes_lean_1h.csv"

# Identity + target columns — never used as features
DROP_COLS = {
    "item_id", "timestamp", "target",
    "target_ret_1h", "target_ret_4h", "target_ret_1d", "target_ret_1w",
    "target_dir_1h", "target_dir_4h", "target_dir_1d", "target_dir_1w",
    "target_ret_norm_1h", "target_ret_norm_4h", "target_ret_norm_1d", "target_ret_norm_1w",
    # Legacy columns
    "target_ret_2h", "target_dir_2h", "target_ret_norm_2h",
}

HORIZONS = ["1h", "4h", "1d", "1w"]
MIN_COVERAGE = 0.50


def load_folds(horizon: str) -> list:
    """Load all available AutoGluon folds for a horizon."""
    from autogluon.tabular import TabularPredictor

    horizon_dir = MODEL_DIR / horizon
    if not horizon_dir.exists():
        return []

    folds = []
    for fold_dir in sorted(horizon_dir.glob("fold_*")):
        if not (fold_dir / "predictor.pkl").exists():
            continue
        try:
            predictor = TabularPredictor.load(str(fold_dir), verbosity=0)
            folds.append((predictor, fold_dir))
        except Exception as e:
            print(f"  Warning: failed to load {fold_dir.name}: {e}", file=sys.stderr)
    return folds


def load_calibrator(horizon: str):
    """Load calibrator if available. v2.1 stores {"calibrator": obj, "method": str}."""
    cal_path = MODEL_DIR / horizon / "calibrator.pkl"
    if cal_path.exists():
        with open(cal_path, "rb") as f:
            cal_data = pickle.load(f)
        # v2.1 format: dict with "calibrator" and "method"
        if isinstance(cal_data, dict) and "calibrator" in cal_data:
            return cal_data
        # v2 format: raw IsotonicRegression object
        return {"calibrator": cal_data, "method": "isotonic"}
    return None


def load_fold_features(fold_dir: Path) -> list | None:
    """Load the feature list used for this fold from fold_meta.json."""
    meta_path = fold_dir / "fold_meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
            return meta.get("features")
        except Exception:
            pass
    return None


def extract_prob_up(predictor, data: pd.DataFrame) -> np.ndarray:
    """Extract P(class=1) = P(up) from predictor, handling column name quirks."""
    preds_proba = predictor.predict_proba(data)
    pos_label = 1

    if pos_label in preds_proba.columns:
        return preds_proba[pos_label].to_numpy()
    elif str(pos_label) in preds_proba.columns:
        return preds_proba[str(pos_label)].to_numpy()
    else:
        pos_idx = list(predictor.class_labels).index(pos_label)
        return preds_proba.iloc[:, pos_idx].to_numpy()


def predict(dataset_path: Path, n_rows: int = 1) -> dict:
    """Run inference on the last n_rows of the dataset."""

    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")

    df = pd.read_csv(dataset_path)
    df = df.sort_values("timestamp").reset_index(drop=True)

    # Feature columns (same logic as training)
    feature_cols = [c for c in df.columns if c not in DROP_COLS]

    # Drop sparse features
    sparse = [c for c in feature_cols if df[c].notna().mean() < MIN_COVERAGE]
    feature_cols = [c for c in feature_cols if c not in set(sparse)]

    # Get the last n_rows
    tail_df = df.tail(n_rows).copy()
    timestamps = tail_df["timestamp"].tolist()
    prices = tail_df["target"].tolist() if "target" in tail_df.columns else [None] * n_rows

    # Prepare feature data (replace inf with NaN)
    numeric = tail_df[feature_cols].select_dtypes(include=[np.number]).columns.tolist()
    tail_df[numeric] = tail_df[numeric].replace([np.inf, -np.inf], np.nan)

    # Load models and predict per horizon
    folds_loaded = {}
    calibrated_flags = {}
    horizon_predictions = {}

    cal_methods = {}
    for horizon in HORIZONS:
        folds = load_folds(horizon)
        folds_loaded[horizon] = len(folds)
        cal_info = load_calibrator(horizon)
        calibrated_flags[horizon] = cal_info is not None
        cal_methods[horizon] = cal_info["method"] if cal_info else None

        if not folds:
            print(f"  No folds found for {horizon}", file=sys.stderr)
            horizon_predictions[horizon] = {
                "probs": [None] * n_rows,
                "agreement": [None] * n_rows,
            }
            continue

        # Predict with each fold, average probabilities
        fold_probs = []
        for predictor, fold_dir in folds:
            # Use fold-specific feature list if available
            fold_features = load_fold_features(fold_dir)
            if fold_features:
                # Only use features that exist in the dataset
                available = [f for f in fold_features if f in tail_df.columns]
                fold_data = tail_df[available]
            else:
                fold_data = tail_df[feature_cols]

            try:
                probs = extract_prob_up(predictor, fold_data)
                fold_probs.append(probs)
            except Exception as e:
                print(f"  Warning: fold prediction failed: {e}", file=sys.stderr)

        if not fold_probs:
            horizon_predictions[horizon] = {
                "probs": [None] * n_rows,
                "agreement": [None] * n_rows,
            }
            continue

        # Ensemble: average across folds
        all_probs = np.array(fold_probs)
        mean_probs = np.nanmean(all_probs, axis=0)

        # Apply calibration if available
        if cal_info is not None:
            cal_obj = cal_info["calibrator"]
            method = cal_info["method"]
            if method == "platt":
                mean_probs = cal_obj.predict_proba(mean_probs.reshape(-1, 1))[:, 1]
            else:
                mean_probs = cal_obj.predict(mean_probs)
            mean_probs = np.clip(mean_probs, 0.01, 0.99)

        # Model agreement: fraction of folds that agree on direction
        directions = (all_probs >= 0.5).astype(int)
        majority = np.round(np.nanmean(directions, axis=0))
        agreement = np.array([
            np.mean(directions[:, i] == majority[i])
            for i in range(all_probs.shape[1])
        ])

        horizon_predictions[horizon] = {
            "probs": mean_probs.tolist(),
            "agreement": agreement.tolist(),
        }

    # Assemble output
    predictions = []
    for i in range(len(timestamps)):
        row = {
            "timestamp": timestamps[i],
            "price": round(prices[i], 2) if prices[i] is not None and pd.notna(prices[i]) else None,
        }

        for horizon in HORIZONS:
            prob = horizon_predictions[horizon]["probs"][i]
            agree = horizon_predictions[horizon]["agreement"][i]

            if prob is not None:
                direction = "BULLISH" if prob >= 0.5 else "BEARISH"
                raw_conf = abs(prob - 0.5) * 2
                confidence = round(50 + raw_conf * 45, 1)
            else:
                direction = None
                confidence = None

            row[f"prob_up_{horizon}"] = round(prob, 4) if prob is not None else None
            row[f"direction_{horizon}"] = direction
            row[f"confidence_{horizon}"] = confidence
            row[f"model_agreement_{horizon}"] = round(agree, 2) if agree is not None else None

        row["calibrated"] = any(calibrated_flags.get(h, False) for h in HORIZONS)
        row["cal_methods"] = {h: cal_methods.get(h) for h in HORIZONS if cal_methods.get(h)}
        predictions.append(row)

    return {
        "predictions": predictions,
        "meta": {
            "model_dir": str(MODEL_DIR.relative_to(ROOT)),
            "dataset": str(dataset_path.relative_to(ROOT)),
            "folds_loaded": folds_loaded,
            "calibrated": calibrated_flags,
            "n_features": len(feature_cols),
            "dataset_rows": len(df),
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    }


def main():
    parser = argparse.ArgumentParser(description="MES directional forecast inference (v2)")
    parser.add_argument("--rows", type=int, default=1, help="Number of recent rows to predict")
    parser.add_argument("--dataset", type=str, default=str(DEFAULT_DATASET), help="Path to dataset CSV")
    parser.add_argument("--output", type=str, default=None, help="Output JSON file (default: stdout)")
    args = parser.parse_args()

    result = predict(Path(args.dataset), n_rows=args.rows)

    output_json = json.dumps(result, indent=2)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output_json)
        print(f"Written to {out_path}", file=sys.stderr)
    else:
        print(output_json)


if __name__ == "__main__":
    main()
