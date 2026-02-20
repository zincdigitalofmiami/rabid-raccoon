"""
train-fib-scorer.py

Fib Setup Scorer — Model 2 of 2.

Trains 2 binary classifiers:
  y1236: P(TP1 hit before SL) — TP1 at 1.236 extension, 4h horizon
  y1618: P(TP2 hit before SL) — TP2 at 1.618 extension, 8h horizon

Composite score: 0.30 * P(TP1) + 0.70 * P(TP2)
Grade: A >= 0.65, B >= 0.50, C >= 0.35, D < 0.35

Walk-forward OOF with purge gap = horizon bars.
All mandatory feature groups (A-F) from the BHG setup dataset.

Inputs:
  datasets/autogluon/bhg_setups.csv  (built by build-bhg-dataset.ts)

Outputs:
  models/fib_scorer/y1272/           (AutoGluon model)
  models/fib_scorer/y1618/           (AutoGluon model)
  datasets/autogluon/fib_scorer_oof.csv  (OOF predictions + grades)
  models/reports/fib_scorer/{target}/    (metrics/charts/tear sheets)

Setup:
  pip install "autogluon>=1.5" pandas scikit-learn
  pip install -r requirements-finance.txt
  npx tsx scripts/build-bhg-dataset.ts   # Build dataset first
  python scripts/train-fib-scorer.py

Note: AutoGluon >=1.5 TabularPredictor auto-detects text columns (headlines_24h)
and uses transformer embeddings via MultiModal — no custom NLP needed.
"""

import sys
import warnings
import numpy as np
import pandas as pd
from pathlib import Path
import argparse
from sklearn.metrics import (
    log_loss, roc_auc_score, brier_score_loss,
    classification_report
)
from sklearn.calibration import calibration_curve

warnings.filterwarnings("ignore", category=FutureWarning)

# ─── Configuration ────────────────────────────────────────────────────────────

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATASET_PATH = PROJECT_ROOT / "datasets" / "autogluon" / "bhg_setups.csv"
MODEL_DIR = PROJECT_ROOT / "models" / "fib_scorer"
OOF_OUTPUT = PROJECT_ROOT / "datasets" / "autogluon" / "fib_scorer_oof.csv"

# Parse CLI args
parser = argparse.ArgumentParser()
parser.add_argument("--time-limit", type=int, default=300, help="Seconds per fold")
parser.add_argument("--presets", default="medium_quality", help="AutoGluon presets")
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

TARGETS = {
    "y1272": {
        "column": "tp1_before_sl_4h",
        "reward_col": "r_to_tp1",
        "purge_bars": 16,   # 4h in 15m bars
        "embargo_bars": 32,
        "weight": 0.30,
    },
    "y1618": {
        "column": "tp2_before_sl_8h",
        "reward_col": "r_to_tp2",
        "purge_bars": 32,   # 8h in 15m bars
        "embargo_bars": 64,
        "weight": 0.70,
    },
}

# Columns to exclude from features
DROP_COLS = {
    "go_time", "go_timestamp", "direction", "go_type",
    "tp1_before_sl_1h", "tp1_before_sl_4h", "tp2_before_sl_8h",
    "grade",  # This is the risk grade, not the model grade
}

# Grade thresholds on composite score
GRADE_THRESHOLDS = {"A": 0.65, "B": 0.50, "C": 0.35}

N_FOLDS = 5
TIME_LIMIT_PER_FOLD = args.time_limit
PRESETS = args.presets
REPORT_ROOT = Path(args.report_root)
if not REPORT_ROOT.is_absolute():
    REPORT_ROOT = PROJECT_ROOT / REPORT_ROOT


# ─── Walk-Forward Splitter ────────────────────────────────────────────────────

def walk_forward_splits(n: int, n_folds: int, purge: int, embargo: int):
    """Expanding-window walk-forward with purge gap."""
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


# ─── Calibration Report ──────────────────────────────────────────────────────

def print_calibration(y_true, y_prob, name: str):
    """Print a simple calibration table."""
    try:
        fraction_pos, mean_predicted = calibration_curve(y_true, y_prob, n_bins=5, strategy='quantile')
        print(f"\n  Calibration ({name}):")
        print(f"  {'Bin':>6} {'Predicted':>10} {'Actual':>10} {'Count':>8}")
        print(f"  {'-'*38}")

        # Get bin edges
        quantiles = np.quantile(y_prob, np.linspace(0, 1, 6))
        for i in range(len(fraction_pos)):
            lo = quantiles[i] if i < len(quantiles) else 0
            hi = quantiles[i+1] if i+1 < len(quantiles) else 1
            mask = (y_prob >= lo) & (y_prob < hi + 0.001)
            n = mask.sum()
            print(f"  {i+1:>6} {mean_predicted[i]:>10.3f} {fraction_pos[i]:>10.3f} {n:>8}")
    except Exception:
        print(f"  Could not compute calibration for {name}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    try:
        from autogluon.tabular import TabularPredictor
    except ImportError:
        print("ERROR: AutoGluon not installed.")
        print("Install with: pip install 'autogluon>=1.5' pandas scikit-learn")
        sys.exit(1)

    generate_classification_report = None
    if not args.skip_reports:
        try:
            from model_report_utils import generate_classification_report as _generate_classification_report
            generate_classification_report = _generate_classification_report
        except Exception as exc:
            print("ERROR: Report dependencies are unavailable.")
            print("Install with: pip install -r requirements-finance.txt")
            print(f"Details: {exc}")
            sys.exit(1)

    print(f"Loading dataset from {DATASET_PATH}")
    if not DATASET_PATH.exists():
        print(f"ERROR: Dataset not found. Run: npx tsx scripts/build-bhg-dataset.ts")
        sys.exit(1)

    df = pd.read_csv(DATASET_PATH)
    print(f"  Rows: {len(df):,}  Columns: {len(df.columns)}")
    print(f"  Presets: {PRESETS}  Time limit/fold: {TIME_LIMIT_PER_FOLD}s")
    print(f"  Reports: {'disabled' if args.skip_reports else REPORT_ROOT}")

    # Sort by go_time (critical for walk-forward)
    df = df.sort_values("go_time").reset_index(drop=True)

    # Feature columns
    feature_cols = [c for c in df.columns if c not in DROP_COLS]
    print(f"  Feature columns: {len(feature_cols)}")

    # Initialize OOF dataframe
    oof_df = df[["go_time", "go_timestamp", "direction"]].copy()

    results = {}

    for target_name, config in TARGETS.items():
        target_col = config["column"]
        purge = config["purge_bars"]
        embargo = config["embargo_bars"]

        print(f"\n{'='*60}")
        print(f"TARGET: {target_name}  (column={target_col}, weight={config['weight']})")
        print(f"{'='*60}")

        # Drop rows where label is missing
        valid_mask = df[target_col].notna()
        df_valid = df[valid_mask].reset_index(drop=True)
        print(f"  Valid rows (non-null label): {len(df_valid):,}")
        print(f"  Positive rate: {df_valid[target_col].mean():.3f}")

        if len(df_valid) < 50:
            print(f"  WARNING: Too few samples for {target_name}. Skipping.")
            continue

        # Walk-forward splits
        splits = walk_forward_splits(len(df_valid), N_FOLDS, purge, embargo)
        print(f"  Folds: {len(splits)}")

        oof_probs = pd.Series(np.nan, index=df_valid.index, dtype=float)

        for fold_i, (train_idx, val_idx) in enumerate(splits):
            print(f"\n  Fold {fold_i + 1}/{len(splits)}: train={len(train_idx):,}  val={len(val_idx):,}")

            train_data = df_valid.iloc[train_idx][feature_cols + [target_col]].copy()
            val_data = df_valid.iloc[val_idx][feature_cols + [target_col]].copy()

            # Ensure label is integer
            train_data[target_col] = train_data[target_col].astype(int)
            val_data[target_col] = val_data[target_col].astype(int)

            # Drop rows where target is NaN
            train_data = train_data.dropna(subset=[target_col])
            val_data = val_data.dropna(subset=[target_col])

            if len(train_data) < 30 or len(val_data) < 10:
                print(f"    Skipping (insufficient data)")
                continue

            # Check class balance
            pos_rate = train_data[target_col].mean()
            print(f"    Train positive rate: {pos_rate:.3f}")

            fold_dir = MODEL_DIR / target_name / f"fold_{fold_i}"
            fold_dir.mkdir(parents=True, exist_ok=True)

            predictor = TabularPredictor(
                label=target_col,
                path=str(fold_dir),
                problem_type="binary",
                eval_metric="log_loss",
                verbosity=1,
            )

            predictor.fit(
                train_data=train_data,
                time_limit=TIME_LIMIT_PER_FOLD,
                presets=PRESETS,
                excluded_model_types=["KNN"],
            )

            probs = predictor.predict_proba(val_data[feature_cols])
            # Get probability of positive class (column 1)
            if isinstance(probs, pd.DataFrame) and 1 in probs.columns:
                prob_pos = probs[1].values
            elif isinstance(probs, pd.DataFrame) and probs.shape[1] == 2:
                prob_pos = probs.iloc[:, 1].values
            else:
                prob_pos = probs.values if hasattr(probs, 'values') else np.array(probs)

            oof_probs.loc[val_data.index] = prob_pos

            # Fold metrics
            actuals = val_data[target_col].values
            fold_auc = roc_auc_score(actuals, prob_pos) if len(set(actuals)) > 1 else 0
            fold_brier = brier_score_loss(actuals, prob_pos)
            fold_logloss = log_loss(actuals, prob_pos, labels=[0, 1])
            print(f"    AUC: {fold_auc:.4f}  Brier: {fold_brier:.4f}  LogLoss: {fold_logloss:.4f}")

        # Overall OOF metrics
        oof_mask = oof_probs.notna()
        oof_actual = df_valid.loc[oof_mask, target_col].values.astype(int)
        oof_pred = oof_probs[oof_mask].values

        if len(oof_actual) > 0:
            has_two_classes = len(set(oof_actual)) > 1
            auc = roc_auc_score(oof_actual, oof_pred) if has_two_classes else float("nan")
            brier = brier_score_loss(oof_actual, oof_pred)
            logloss = log_loss(oof_actual, oof_pred, labels=[0, 1])

            results[target_name] = {
                "AUC": auc, "Brier": brier, "LogLoss": logloss,
                "n_oof": len(oof_actual), "pos_rate": oof_actual.mean()
            }

            print(f"\n  OOF Results ({target_name}):")
            auc_str = f"{auc:.4f}" if np.isfinite(auc) else "n/a (single class)"
            print(f"    AUC:      {auc_str}")
            print(f"    Brier:    {brier:.4f}")
            print(f"    LogLoss:  {logloss:.4f}")
            print(f"    n:        {len(oof_actual):,}")
            print(f"    Pos rate: {oof_actual.mean():.3f}")

            if has_two_classes:
                # Classification at 0.5 threshold
                preds_binary = (oof_pred >= 0.5).astype(int)
                print(f"\n  Classification Report (threshold=0.5):")
                print(classification_report(oof_actual, preds_binary, target_names=["SL Hit", "TP Hit"]))

                # Calibration
                print_calibration(oof_actual, oof_pred, target_name)
            else:
                print("  Classification report skipped (single-class OOF labels)")

            if generate_classification_report is not None:
                reward_col = config["reward_col"]
                reward_r = (
                    df_valid.loc[oof_mask, reward_col]
                    .fillna(1.0)
                    .clip(lower=0.01)
                    .to_numpy(dtype=float)
                )
                expected_payoff = np.where(oof_actual == 1, reward_r, -1.0)
                report_dir = REPORT_ROOT / "fib_scorer" / target_name
                report_summary = generate_classification_report(
                    model_name=f"fib_scorer_{target_name}",
                    timestamps=df_valid.loc[oof_mask, "go_timestamp"],
                    y_true=oof_actual,
                    y_prob=oof_pred,
                    expected_payoff=expected_payoff,
                    out_dir=report_dir,
                    metadata={
                        "target": target_name,
                        "target_col": target_col,
                        "reward_col": reward_col,
                        "folds": len(splits),
                        "purge_bars": purge,
                        "embargo_bars": embargo,
                        "presets": PRESETS,
                        "time_limit_per_fold": TIME_LIMIT_PER_FOLD,
                        "feature_count": len(feature_cols),
                    },
                )
                results[target_name]["report_summary"] = str(report_dir / "summary.json")
                pyfolio = report_summary.get("pyfolio", {})
                pyfolio_state = "enabled" if pyfolio.get("enabled") else "skipped"
                print(f"    Report: {report_dir} (pyfolio: {pyfolio_state})")
        else:
            print(f"  WARNING: Insufficient OOF predictions for {target_name}")

        # Map OOF predictions back to original indices
        oof_col = f"oof_{target_name}"
        oof_series = pd.Series(np.nan, index=df.index, dtype=float)
        valid_indices = df.index[valid_mask]
        oof_series.iloc[valid_indices[oof_mask.values]] = oof_probs[oof_mask].to_numpy(dtype=float)
        oof_df[oof_col] = oof_series
        oof_df[f"actual_{target_name}"] = pd.Series(np.nan, index=df.index, dtype=float)
        oof_df.loc[valid_indices, f"actual_{target_name}"] = df_valid[target_col].astype(float).values

    # ─── Composite Score + Grade ──────────────────────────────────────────

    if "oof_y1272" in oof_df.columns and "oof_y1618" in oof_df.columns:
        w1 = TARGETS["y1272"]["weight"]
        w2 = TARGETS["y1618"]["weight"]

        oof_df["composite_score"] = (
            oof_df["oof_y1272"].fillna(0) * w1 +
            oof_df["oof_y1618"].fillna(0) * w2
        )

        # Grade assignment
        def assign_grade(score):
            if pd.isna(score) or score == 0:
                return "--"
            if score >= GRADE_THRESHOLDS["A"]:
                return "A"
            if score >= GRADE_THRESHOLDS["B"]:
                return "B"
            if score >= GRADE_THRESHOLDS["C"]:
                return "C"
            return "D"

        oof_df["model_grade"] = oof_df["composite_score"].apply(assign_grade)

        # Grade distribution
        print(f"\n{'='*60}")
        print("COMPOSITE SCORE DISTRIBUTION")
        print(f"{'='*60}")
        grade_counts = oof_df["model_grade"].value_counts()
        for g in ["A", "B", "C", "D", "--"]:
            n = grade_counts.get(g, 0)
            pct = n / len(oof_df) * 100
            print(f"  Grade {g}: {n:>6} ({pct:.1f}%)")

        # Win rate by grade
        print(f"\n  Win Rate by Grade (TP1 4h):")
        for g in ["A", "B", "C", "D"]:
            mask = oof_df["model_grade"] == g
            if mask.sum() == 0:
                continue
            grade_rows = df.loc[mask, "tp1_before_sl_4h"]
            valid = grade_rows.dropna()
            if len(valid) > 0:
                wr = valid.mean()
                print(f"    {g}: {wr:.3f} ({len(valid)} setups)")

    # ─── Save OOF ────────────────────────────────────────────────────────

    OOF_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    oof_df.to_csv(OOF_OUTPUT, index=False)
    print(f"\nOOF predictions saved to {OOF_OUTPUT}")

    # ─── Summary ──────────────────────────────────────────────────────────

    print(f"\n{'='*60}")
    print("SUMMARY: Fib Setup Scorer OOF Results")
    print(f"{'='*60}")
    print(f"{'Target':<10} {'AUC':>8} {'Brier':>8} {'LogLoss':>10} {'Pos%':>8} {'n':>8}")
    print(f"{'-'*52}")
    for t, r in results.items():
        print(f"{t:<10} {r['AUC']:>8.4f} {r['Brier']:>8.4f} {r['LogLoss']:>10.4f} {r['pos_rate']:>8.3f} {r['n_oof']:>8,}")

    print("\nComposite: score = 0.30 * P(TP1) + 0.70 * P(TP2)")
    print("Grades: A >= 0.65, B >= 0.50, C >= 0.35, D < 0.35")


if __name__ == "__main__":
    main()
