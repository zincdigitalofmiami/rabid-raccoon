"""
train-directional-v2.py — MES 1h/4h Directional Bias Model

Clean rebuild. Fixes three problems from v1:
  1. Feature bloat (135 → ~60 curated features with proven marginal signal)
  2. Memory death (2.2 GB available → explicit CatBoost/LightGBM/XGB only, no prep variants)
  3. No signal (AUC 0.50) → feature selection, proper walk-forward, honest reporting

Architecture:
  - TabularPredictor binary classification (up/down)
  - Walk-forward expanding window with purge + embargo
  - Two horizons: 1h (intraday timing), 4h (session bias)
  - High-confidence threshold reporting (p>0.55)
  - Feature importance tracking across folds

Usage:
  cd /Users/zincdigital/Projects/rabid-raccoon
  source .venv-autogluon/bin/activate
  python scripts/train-directional-v2.py                   # Phase 1: quick validation (~1h)
  python scripts/train-directional-v2.py --phase=2         # Phase 2: production (~4h)
  python scripts/train-directional-v2.py --horizons=4h     # Single horizon
"""

import sys, warnings, shutil, argparse
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime
from scipy.stats import spearmanr

warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", category=UserWarning)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ─── CLI ──────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="MES Directional Bias Model v2")
parser.add_argument("--phase", type=int, default=1, choices=[1, 2])
parser.add_argument("--horizons", default=None, help="Comma-separated: 1h,4h")
parser.add_argument("--clean", action="store_true", help="Delete old model dirs first")
args = parser.parse_args()

# ─── Constants ────────────────────────────────────────────────────────────────

DATASET_PATH = PROJECT_ROOT / "datasets" / "autogluon" / "mes_lean_1h.csv"
MODEL_DIR = PROJECT_ROOT / "models" / "directional_v2"
OOF_OUTPUT = PROJECT_ROOT / "datasets" / "autogluon" / "directional_v2_oof.csv"

HORIZONS = {
    "1h": {"target": "target_dir_1h", "purge": 1, "embargo": 2},
    "4h": {"target": "target_dir_4h", "purge": 4, "embargo": 8},
}

if args.horizons:
    req = set(args.horizons.split(","))
    HORIZONS = {k: v for k, v in HORIZONS.items() if k in req}

PHASE_CFG = {
    1: {"presets": "medium_quality", "time_limit": 300, "n_folds": 3},
    2: {"presets": "high_quality",   "time_limit": 900, "n_folds": 5},
}
cfg = PHASE_CFG[args.phase]

# Identity + target columns — NEVER used as features
TARGET_COLS = {
    "item_id", "timestamp", "target",
    "target_ret_1h", "target_ret_4h",
    "target_dir_1h", "target_dir_4h",
    "target_ret_norm_1h", "target_ret_norm_4h",
}

# ─── Curated Feature Set ─────────────────────────────────────────────────────
# Selected by univariate IC analysis on 36K rows (Feb 20 2026 audit).
# Criteria: |IC| > 0.008 OR p < 0.10 on EITHER target_dir_1h or target_dir_4h.
# Grouped by signal category for interpretability.

CURATED_FEATURES = [
    # ── MES Technical (price action + momentum) ──────────────────────────────
    "mes_ret_1h",           # short-term momentum
    "mes_ret_4h",           # medium-term momentum (IC=-0.012 for 1h)
    "mes_ret_8h",           # trend context
    "mes_ret_24h",          # daily momentum (IC=-0.014 for 4h)
    "mes_range",            # volatility proxy (IC=+0.019/+0.013 both targets)
    "mes_body_ratio",       # candle quality (IC=-0.011)
    "mes_dist_ma8",         # short MA distance
    "mes_dist_ma24",        # medium MA distance
    "mes_dist_hi24",        # distance from 24h high (IC=-0.016/-0.014)
    "mes_dist_lo24",        # distance from 24h low
    "mes_dist_hi120",       # distance from 5d high
    "mes_std8",             # short-term realized vol
    "mes_std24",            # medium-term realized vol
    "mes_vol_ratio",        # volume vs average (IC=+0.013/+0.012)

    # ── Squeeze + Williams VFix (volatility regime) ──────────────────────────
    "sqz_mom",              # squeeze momentum (IC=-0.012)
    "sqz_mom_positive",     # momentum direction
    "sqz_state",            # in/out of squeeze
    "wvf_value",            # Williams VFix (IC=+0.017/+0.014)
    "wvf_percentile",       # VFix relative to history (IC=+0.013)

    # ── MACD ─────────────────────────────────────────────────────────────────
    "macd_line",            # MACD value
    "macd_signal",          # signal line
    "macd_hist",            # histogram
    "macd_hist_color",      # histogram color state

    # ── Volume acceleration ──────────────────────────────────────────────────
    "vol_accel",            # volume acceleration
    "vol_regime",           # volume regime classification
    "vol_of_vol",           # volatility of volatility

    # ── Macro Regime (rates, credit, liquidity) ──────────────────────────────
    "yield_curve_slope",    # 10Y-2Y spread (IC=+0.009/+0.018 for 4h)
    "credit_spread_diff",   # HY-IG spread
    "real_rate_10y",        # real rate (IC=-0.013/-0.023 for 4h, STRONG)
    "fed_liquidity",        # WALCL-RRP (IC=+0.011/+0.012)
    "fed_midpoint",         # fed funds midpoint

    # ── Macro Momentum (rate of change in macro) ─────────────────────────────
    "fred_vix",             # raw VIX level
    "vix_1d_change",        # VIX momentum
    "y10y_1d_change",       # 10Y yield momentum
    "y30y_1d_change",       # 30Y yield momentum (IC for 4h)
    "dgs10_velocity_5d",    # 10Y 5-day velocity (IC=-0.020 for 4h, STRONG)
    "ig_oas_1d_change",     # IG spread momentum
    "hy_oas_1d_change",     # HY spread momentum (IC=-0.010)
    "tips10y_1d_change",    # TIPS momentum
    "dollar_momentum_5d",   # USD momentum
    "wti_momentum_5d",      # crude momentum (IC=+0.012)
    "fed_assets_change_1w", # Fed balance sheet change
    "rrp_change_1d",        # reverse repo change
    "claims_change_1w",     # jobless claims momentum

    # ── Event Calendar ───────────────────────────────────────────────────────
    "is_fomc_day",
    "is_high_impact_day",
    "is_cpi_day",
    "is_nfp_day",
    "hours_to_next_high_impact",

    # ── Economic Surprise Z-scores ───────────────────────────────────────────
    "cpi_release_z",        # CPI surprise (IC=+0.013 for 4h)
    "econ_surprise_index",  # composite surprise

    # ── Cross-Asset: Bonds (STRONGEST cross-asset signal) ────────────────────
    "zn_ret_1h",            # ZN short momentum
    "zn_ret_4h",            # ZN medium momentum (IC=+0.011 for 4h)
    "zn_ret_24h",           # ZN daily momentum (IC=+0.026 for 4h, VERY STRONG)
    "zn_edss",              # ZN regime
    "zn_dist_ma24",         # ZN distance from MA (IC=+0.028 for 4h, STRONGEST)
    "zn_vol_ratio",         # ZN volume

    # ── Cross-Asset: Equity (NQ lead/lag) ────────────────────────────────────
    "nq_ret_1h",
    "nq_ret_24h",
    "nq_edss",
    "nq_vol_ratio",         # NQ volume (IC=+0.016/+0.015)
    "nq_minus_mes",         # NQ-MES divergence (IC=+0.015 for 4h)

    # ── Cross-Asset: Crude + NatGas ──────────────────────────────────────────
    "cl_ret_1h",
    "cl_vol_ratio",         # CL volume (IC=+0.013/+0.012)
    "ng_edss",              # NG regime (IC=+0.012/+0.017)
    "ng_vol_ratio",         # NG volume (IC=+0.018/+0.014, TOP for 1h)

    # ── Cross-Asset: FX ──────────────────────────────────────────────────────
    "e6_ret_1h",            # EUR/USD
    "j6_ret_1h",            # JPY

    # ── Cross-Asset Composites ───────────────────────────────────────────────
    "mes_zn_corr_21d",      # MES-ZN rolling correlation (IC=-0.015 for 4h)
    "mes_nq_corr_21d",      # MES-NQ rolling correlation
    "concordance_1h",       # cross-asset directional agreement
    "equity_bond_diverge",  # equity-bond divergence signal

    # ── Time Features ────────────────────────────────────────────────────────
    "hour_utc",             # hour of day (weak alone but interaction effects)
    "day_of_week",          # day of week
    "is_us_session",        # US session flag (IC=+0.015/+0.014)
]

# ─── Walk-Forward Splitter ────────────────────────────────────────────────────

def walk_forward_splits(n, n_folds, purge, embargo):
    """Expanding-window walk-forward CV with purge gap + embargo."""
    fold_size = n // (n_folds + 1)
    splits = []
    for fold in range(n_folds):
        split = fold_size * (fold + 1)
        val_start = split + purge + embargo
        val_end = fold_size * (fold + 2) if fold < n_folds - 1 else n
        if val_start >= val_end or val_start >= n:
            continue
        splits.append((list(range(0, split)), list(range(val_start, val_end))))
    return splits


# ─── Log Tee ─────────────────────────────────────────────────────────────────

class _Tee:
    def __init__(self, *streams):
        self.streams = streams
    def write(self, data):
        for s in self.streams:
            s.write(data); s.flush()
    def flush(self):
        for s in self.streams: s.flush()
    def isatty(self):
        return False

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Setup logging
    log_dir = PROJECT_ROOT / "models" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = log_dir / f"directional_v2_{ts}.log"
    log_file = open(log_path, "w", buffering=1)
    sys.stdout = _Tee(sys.__stdout__, log_file)
    sys.stderr = _Tee(sys.__stderr__, log_file)

    print(f"═══════════════════════════════════════════════════")
    print(f"  MES Directional Bias Model v2")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"  Log: {log_path.name}")
    print(f"═══════════════════════════════════════════════════")

    try:
        from autogluon.tabular import TabularPredictor
    except ImportError:
        print("ERROR: pip install 'autogluon>=1.5'")
        sys.exit(1)

    # ─── Load Data ────────────────────────────────────────────────────────────
    if not DATASET_PATH.exists():
        print(f"ERROR: {DATASET_PATH} not found. Run: npx tsx scripts/build-lean-dataset.ts")
        sys.exit(1)

    df = pd.read_csv(DATASET_PATH)
    df = df.sort_values("timestamp").reset_index(drop=True)
    print(f"\nDataset: {DATASET_PATH.name}")
    print(f"  Rows: {len(df):,}  |  Columns: {len(df.columns)}")
    print(f"  Range: {df['timestamp'].iloc[0][:10]} → {df['timestamp'].iloc[-1][:10]}")

    # ─── Feature Selection ────────────────────────────────────────────────────
    # Use only curated features that exist in the dataset
    available = [f for f in CURATED_FEATURES if f in df.columns]
    missing = [f for f in CURATED_FEATURES if f not in df.columns]
    if missing:
        print(f"\n  Missing features (skipped): {missing}")

    feature_cols = available
    print(f"\n  Curated features: {len(feature_cols)} (from {len(CURATED_FEATURES)} specified)")

    # Safety: no target leakage
    leaked = [c for c in feature_cols if c in TARGET_COLS or c.startswith("target_")]
    assert not leaked, f"TARGET LEAK: {leaked}"

    # ─── Data Cleaning ────────────────────────────────────────────────────────
    # Replace inf with NaN
    numeric = df[feature_cols].select_dtypes(include=[np.number]).columns.tolist()
    n_inf = (~np.isfinite(df[numeric].fillna(0))).sum().sum()
    if n_inf > 0:
        df[numeric] = df[numeric].replace([np.inf, -np.inf], np.nan)
        print(f"  Replaced {n_inf} inf values with NaN")

    # Winsorize to [1st, 99th] percentile
    win_count = 0
    for col in numeric:
        if col in feature_cols:
            p01, p99 = df[col].quantile(0.01), df[col].quantile(0.99)
            if p01 == p99: continue
            clipped = df[col].clip(lower=p01, upper=p99)
            if (df[col] != clipped).sum() > 0:
                df[col] = clipped
                win_count += 1
    print(f"  Winsorized {win_count} features to [1st, 99th] pctl")

    # Drop target NaN rows
    target_cols = [h["target"] for h in HORIZONS.values()]
    pre = len(df)
    df = df.dropna(subset=target_cols)
    if len(df) < pre:
        print(f"  Dropped {pre - len(df)} rows with NaN targets → {len(df):,} remaining")

    # ─── Feature Coverage Report ──────────────────────────────────────────────
    sparse = [(c, df[c].isna().mean()) for c in feature_cols if df[c].isna().mean() > 0.3]
    if sparse:
        print(f"\n  Sparse features (>30% null):")
        for c, pct in sorted(sparse, key=lambda x: -x[1]):
            print(f"    {c:<35} {pct:.1%} null")

    # ─── Config Summary ───────────────────────────────────────────────────────
    n_folds = cfg["n_folds"]
    time_limit = cfg["time_limit"]
    presets = cfg["presets"]

    print(f"\n  Phase: {args.phase}  |  Presets: {presets}  |  Time/fold: {time_limit}s")
    print(f"  Folds: {n_folds}  |  Horizons: {list(HORIZONS.keys())}")
    est_hrs = time_limit * n_folds * len(HORIZONS) / 3600
    print(f"  Est. training time: {est_hrs:.1f} hours")
    print(f"  Models: CatBoost + LightGBM + XGBoost + ExtraTrees (memory-safe)")

    if args.clean:
        for h in HORIZONS:
            for i in range(n_folds):
                d = MODEL_DIR / h / f"fold_{i}"
                if d.exists():
                    shutil.rmtree(d)
                    print(f"  [clean] Removed {d.relative_to(PROJECT_ROOT)}")

    # ─── Train Each Horizon ───────────────────────────────────────────────────

    oof_df = df[["timestamp"]].copy()
    results = {}
    all_importances = {}

    for h_name, h_cfg in HORIZONS.items():
        target_col = h_cfg["target"]
        purge = h_cfg["purge"]
        embargo = h_cfg["embargo"]

        print(f"\n{'='*60}")
        print(f"  HORIZON: {h_name}  |  target: {target_col}")
        print(f"  purge: {purge}  |  embargo: {embargo}")
        print(f"{'='*60}")

        splits = walk_forward_splits(len(df), n_folds, purge, embargo)
        print(f"  Walk-forward folds: {len(splits)}")

        oof_preds = pd.Series(np.nan, index=df.index, dtype=float)
        fold_importances = []

        for fold_i, (train_idx, val_idx) in enumerate(splits):
            print(f"\n  ── Fold {fold_i+1}/{len(splits)} ──")
            print(f"  Train: {len(train_idx):,}  |  Val: {len(val_idx):,}")

            train_data = df.iloc[train_idx][feature_cols + [target_col]].dropna(subset=[target_col])
            val_data = df.iloc[val_idx][feature_cols + [target_col]].dropna(subset=[target_col])

            if len(train_data) < 100 or len(val_data) < 10:
                print(f"    SKIP: insufficient data")
                continue

            fold_dir = MODEL_DIR / h_name / f"fold_{fold_i}"
            fold_dir.mkdir(parents=True, exist_ok=True)

            predictor = TabularPredictor(
                label=target_col,
                path=str(fold_dir),
                problem_type="binary",
                eval_metric="roc_auc",
                verbosity=1,
            )

            # Memory-safe fit: explicit model list, no prep variants,
            # no bagging/stacking in Phase 1, light bagging in Phase 2
            hyperparameters = {
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
                ],
                "XT": [{}],
            }

            fit_kwargs = dict(
                train_data=train_data,
                hyperparameters=hyperparameters,
                time_limit=time_limit,
                num_gpus=0,
                dynamic_stacking=False,
                ag_args_fit={
                    "num_early_stopping_rounds": 30,
                    "ag.max_memory_usage_ratio": 1.2,  # allow slight overcommit
                },
            )
            # Phase 2: add light bagging
            if args.phase == 2:
                fit_kwargs["num_bag_folds"] = 3
                fit_kwargs["num_stack_levels"] = 0
                fit_kwargs["ag_args_ensemble"] = {
                    "fold_fitting_strategy": "sequential_local"
                }

            predictor.fit(**fit_kwargs)

            # Leaderboard
            lb = predictor.leaderboard(val_data, silent=True)
            print(f"\n    Leaderboard:")
            print(lb[["model", "score_val"]].head(8).to_string(index=False))

            # OOF predictions — P(up)
            proba = predictor.predict_proba(val_data[feature_cols])
            cls = predictor.class_labels
            if 1 in proba.columns:
                preds_np = proba[1].to_numpy()
            elif "1" in proba.columns:
                preds_np = proba["1"].to_numpy()
            else:
                pos_idx = list(cls).index(1)
                preds_np = proba.iloc[:, pos_idx].to_numpy()

            oof_preds.loc[val_data.index] = preds_np

            # Fold metrics
            from sklearn.metrics import roc_auc_score, accuracy_score
            actuals = val_data[target_col].values
            auc = roc_auc_score(actuals, preds_np)
            acc = accuracy_score(actuals, (preds_np >= 0.5).astype(int))
            ic, _ = spearmanr(actuals, preds_np)
            print(f"\n    AUC: {auc:.4f}  |  Acc: {acc:.3f}  |  IC: {ic:.4f}")

            # Feature importance
            try:
                imp = predictor.feature_importance(val_data, silent=True)
                fold_importances.append(imp)
                top5 = list(imp.head(5).index)
                print(f"    Top 5: {top5}")
            except Exception:
                pass

        # ─── Aggregate OOF for this horizon ───────────────────────────────────
        mask = oof_preds.notna()
        oof_act = df.loc[mask, target_col].values
        oof_pred = oof_preds[mask].values

        if len(oof_act) == 0:
            print(f"\n  WARNING: No OOF predictions for {h_name}")
            continue

        from sklearn.metrics import roc_auc_score, accuracy_score
        auc = roc_auc_score(oof_act, oof_pred)
        acc = accuracy_score(oof_act, (oof_pred >= 0.5).astype(int))
        ic, ic_p = spearmanr(oof_act, oof_pred)

        # High-confidence subset
        hc_mask = (oof_pred >= 0.55) | (oof_pred <= 0.45)
        hc_n = hc_mask.sum()
        hc_acc = accuracy_score(
            oof_act[hc_mask], (oof_pred[hc_mask] >= 0.5).astype(int)
        ) if hc_n > 0 else 0

        # Very-high-confidence subset (p>0.58)
        vhc_mask = (oof_pred >= 0.58) | (oof_pred <= 0.42)
        vhc_n = vhc_mask.sum()
        vhc_acc = accuracy_score(
            oof_act[vhc_mask], (oof_pred[vhc_mask] >= 0.5).astype(int)
        ) if vhc_n > 0 else 0

        results[h_name] = {
            "AUC": auc, "Acc": acc, "HC_Acc": hc_acc, "HC_n": hc_n,
            "VHC_Acc": vhc_acc, "VHC_n": vhc_n,
            "IC": ic, "IC_p": ic_p, "n": len(oof_act),
        }

        signal = "✓ SIGNAL" if auc > 0.52 else "⚠ MARGINAL" if auc > 0.51 else "✗ NO SIGNAL"
        print(f"\n  ╔══ OOF RESULTS: {h_name} ══════════════════════╗")
        print(f"  ║  AUC:       {auc:.4f}  {signal:<20}  ║")
        print(f"  ║  Accuracy:  {acc:.4f}  ({acc*100:.1f}%)              ║")
        print(f"  ║  HC Acc:    {hc_acc:.4f}  ({hc_acc*100:.1f}% on {hc_n:,} rows, p>.55) ║")
        print(f"  ║  VHC Acc:   {vhc_acc:.4f}  ({vhc_acc*100:.1f}% on {vhc_n:,} rows, p>.58) ║")
        print(f"  ║  IC:        {ic:.4f}  (p={ic_p:.2e})          ║")
        print(f"  ║  n:         {len(oof_act):,}                        ║")
        print(f"  ╚══════════════════════════════════════════════╝")

        # Aggregate feature importance across folds
        if fold_importances:
            avg_imp = pd.concat(fold_importances, axis=1).mean(axis=1).sort_values(ascending=False)
            all_importances[h_name] = avg_imp
            print(f"\n  Feature Importance (avg across folds):")
            for feat, val in avg_imp.head(15).items():
                bar = "█" * max(1, int(val / avg_imp.iloc[0] * 20))
                print(f"    {feat:<35} {val:.4f} {bar}")
