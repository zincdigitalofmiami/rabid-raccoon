"""
train-final.py — MES Directional Classifier (Production v2.1)

CHANGES FROM v2 (AUC=0.506 → targeting 0.52+):
  1. Horizons: 1h, 4h, 1d (24 bars), 1w (120 bars) — dropped 2h
  2. Label-overlap purge/embargo (Lopez de Prado): purge = overlap + lookback
  3. Hierarchical correlation dedup: IC-priority cluster representative
  4. Nested calibration: isotonic vs Platt selected on held-out OOF
  5. ECE with quantile bins for robust calibration diagnostics
  6. Feature stability tracking across folds
  7. Full reproducibility manifest (dataset hash, fold splits, all seeds)
  8. Auto-generated validation report (models/reports/v2_validation.md)
  9. Dataset quality gates (preflight) — abort on missing feature groups

  Input:  datasets/autogluon/mes_lean_fred_indexes_2020plus.csv
  Output: models/core_forecaster/{1h,4h,1d,1w}/fold_N/   (AutoGluon artifacts)
          datasets/autogluon/core_oof_1h.csv               (OOF predictions)
          models/reports/feature_importance.md              (TradingView setup guide)
          models/reports/v2_validation.md                   (validation report)
          models/logs/training_final_YYYYMMDD.log

  Run:    cd "/Volumes/Satechi Hub/rabid-raccoon"
          source .venv-autogluon/bin/activate
          python scripts/train-final.py
          python scripts/train-final.py --preflight-only
          python scripts/train-final.py --dataset datasets/autogluon/mes_lean_fred_indexes_2020plus.csv --preflight-only

  Time:   ~20 hours on Apple Silicon (5 folds x 4 horizons x 3600s)
"""

import sys, os, warnings, shutil, json, hashlib, random, pickle
import argparse
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime
from collections import defaultdict
from scipy.stats import spearmanr
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import squareform
from sklearn.metrics import roc_auc_score, accuracy_score, brier_score_loss
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression

warnings.filterwarnings("ignore", category=FutureWarning)

# ─── Paths ────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent
DATASET_DEFAULT = ROOT / "datasets" / "autogluon" / "mes_lean_fred_indexes_2020plus.csv"
MODEL_DIR = ROOT / "models" / "core_forecaster"
OOF_OUTPUT = ROOT / "datasets" / "autogluon" / "core_oof_1h.csv"
REPORT_DIR = ROOT / "models" / "reports"
LOG_DIR = ROOT / "models" / "logs"

# ─── Training Config (production v2.1) ────────────────────────────────────────

# Horizons: bars are 1h. purge/embargo computed dynamically by compute_purge_embargo().
HORIZONS = {
    "1h": {"target": "target_dir_1h",  "horizon_bars": 1},
    "4h": {"target": "target_dir_4h",  "horizon_bars": 4},
    "1d": {"target": "target_dir_1d",  "horizon_bars": 24},
    "1w": {"target": "target_dir_1w",  "horizon_bars": 120},
}

SEED = 42
N_FOLDS = 5
TIME_LIMIT = 3600              # 60 min per fold
PRESETS = "best_quality_v150"
NUM_BAG_FOLDS = 5              # 5-fold bagging for stability
NUM_STACK_LEVELS = 1
EVAL_METRIC = "roc_auc"
MIN_COVERAGE = 0.50            # drop features with <50% non-null
MAX_FEATURES = 50              # IC screening: keep top N per fold
CORR_THRESHOLD = 0.90          # hierarchical cluster dedup threshold
FEATURE_MAX_LOOKBACK = 24      # longest rolling window in feature engineering (24h)


def parse_args():
    parser = argparse.ArgumentParser(description="MES Directional Classifier (Production v2.1)")
    parser.add_argument(
        "--dataset",
        default=str(DATASET_DEFAULT),
        help="CSV dataset path (default: datasets/autogluon/mes_lean_fred_indexes_2020plus.csv)",
    )
    parser.add_argument(
        "--horizons",
        default=None,
        help="Comma-separated horizons to train (subset of: 1h,4h,1d,1w). Default: all.",
    )
    parser.add_argument(
        "--time-limit",
        type=int,
        default=None,
        help="Override time limit in seconds per fold (default: 3600).",
    )
    parser.add_argument(
        "--n-folds",
        type=int,
        default=None,
        help="Override number of walk-forward folds (default: 5).",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Delete existing fold directories before training.",
    )
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="Run dataset/env checks and exit before any model training.",
    )
    return parser.parse_args()

# Identity + target columns — NEVER used as features
DROP_COLS = {
    "item_id", "timestamp", "target",
    "target_ret_1h", "target_ret_4h", "target_ret_1d", "target_ret_1w",
    "target_dir_1h", "target_dir_4h", "target_dir_1d", "target_dir_1w",
    "target_ret_norm_1h", "target_ret_norm_4h", "target_ret_norm_1d", "target_ret_norm_1w",
    # Legacy columns from older datasets
    "target_ret_2h", "target_dir_2h", "target_ret_norm_2h",
}

# Models excluded:
#   KNN:      curse of dimensionality
#   FASTAI:   unreliable on CPU-only Apple Silicon
#   RF:       redundant with ExtraTrees
#   NN_TORCH: overfits on weak financial signal
EXCLUDED = ["KNN", "FASTAI", "RF", "NN_TORCH"]

# ─── Dataset Quality Gates ────────────────────────────────────────────────────

REQUIRED_GROUPS = {
    "volatility_regime": ["fred_vix", "vix_percentile_20d", "mes_range"],
    "macro_liquidity": ["yield_curve_slope", "fed_liquidity"],
    "cross_asset": ["nq_ret_1h", "zn_ret_1h", "cl_ret_1h"],
    "event_context": ["is_high_impact_day", "hours_to_next_high_impact"],
}
MIN_GROUP_COVERAGE = 0.70

# ─── Feature → TradingView Indicator Mapping ─────────────────────────────────

FEATURE_TV_MAP = {
    # Squeeze Momentum
    "sqz_mom":             {"indicator": "Squeeze Momentum (LazyBear)", "setting": "BB Length 20, KC Length 20, Mult 1.5/2.0", "chart": "15m, 1h"},
    "sqz_mom_rising":      {"indicator": "Squeeze Momentum", "setting": "Histogram slope direction", "chart": "15m, 1h"},
    "sqz_mom_positive":    {"indicator": "Squeeze Momentum", "setting": "Histogram above/below zero", "chart": "15m, 1h"},
    "sqz_state":           {"indicator": "Squeeze Momentum", "setting": "Squeeze on/off dots", "chart": "15m, 1h"},
    "sqz_bars_in_squeeze": {"indicator": "Squeeze Momentum", "setting": "Duration of squeeze state", "chart": "15m, 1h"},
    # MACD
    "macd_line":           {"indicator": "MACD", "setting": "Check dataset builder for fast/slow/signal params", "chart": "15m, 1h"},
    "macd_signal":         {"indicator": "MACD", "setting": "Signal line value", "chart": "15m, 1h"},
    "macd_hist":           {"indicator": "MACD", "setting": "Histogram value", "chart": "15m, 1h"},
    "macd_hist_color":     {"indicator": "MACD", "setting": "Histogram color (rising/falling)", "chart": "15m, 1h"},
    "macd_above_signal":   {"indicator": "MACD", "setting": "MACD line above signal line", "chart": "15m, 1h"},
    "macd_hist_rising":    {"indicator": "MACD", "setting": "Histogram increasing", "chart": "15m, 1h"},
    # Williams Vix Fix
    "wvf_value":           {"indicator": "Williams Vix Fix", "setting": "WVF value (volatility bottom detector)", "chart": "1h"},
    "wvf_signal":          {"indicator": "Williams Vix Fix", "setting": "Signal line cross", "chart": "1h"},
    "wvf_percentile":      {"indicator": "Williams Vix Fix", "setting": "Percentile rank of WVF", "chart": "1h"},
    # MES Technical - Moving Averages
    "mes_dist_ma8":        {"indicator": "EMA 8", "setting": "Price distance from EMA(8)", "chart": "1h"},
    "mes_dist_ma24":       {"indicator": "EMA 24", "setting": "Price distance from EMA(24)", "chart": "1h"},
    "mes_dist_ma120":      {"indicator": "SMA 120", "setting": "Price distance from SMA(120) — 5-day MA", "chart": "1h"},
    # MES Technical - Volatility / Momentum
    "mes_edss":            {"indicator": "Custom: Exponential Deviation Scaled Score", "setting": "Z-score momentum oscillator", "chart": "1h"},
    "mes_range":           {"indicator": "ATR proxy", "setting": "(High-Low)/Close — bar range", "chart": "1h"},
    "mes_body_ratio":      {"indicator": "Candle analysis", "setting": "Body/range ratio — conviction", "chart": "15m, 1h"},
    "mes_ret_1h":          {"indicator": "N/A (raw return)", "setting": "1h return — momentum", "chart": "1h"},
    "mes_ret_4h":          {"indicator": "N/A (raw return)", "setting": "4h return — trend", "chart": "4h"},
    "mes_ret_24h":         {"indicator": "N/A (raw return)", "setting": "24h return — daily bias", "chart": "Daily"},
    "mes_vol_ratio":       {"indicator": "Volume", "setting": "Current vol / 20-bar avg", "chart": "1h"},
    # Volume Analysis
    "vol_accel":           {"indicator": "Volume Rate of Change", "setting": "Volume acceleration", "chart": "1h"},
    "vol_regime":          {"indicator": "Volume regime", "setting": "High/normal/low classification", "chart": "1h"},
    "vol_of_vol":          {"indicator": "Vol of Vol", "setting": "Volatility clustering measure", "chart": "1h"},
    # Cross-Asset
    "nq_ret_1h":           {"indicator": "NQ futures", "setting": "Side panel: NQ 1h chart", "chart": "WATCHLIST"},
    "nq_ret_4h":           {"indicator": "NQ futures", "setting": "NQ 4h momentum", "chart": "WATCHLIST"},
    "nq_minus_mes":        {"indicator": "NQ-MES spread", "setting": "Tech leadership/lag", "chart": "WATCHLIST"},
    "concordance_1h":      {"indicator": "Index Alignment", "setting": "How many indices agree on direction", "chart": "WATCHLIST"},
    "equity_bond_diverge": {"indicator": "ES-ZN divergence", "setting": "Risk-on/off signal", "chart": "WATCHLIST"},
    "zn_ret_1h":           {"indicator": "ZN (10Y Note)", "setting": "Side panel: ZN 1h chart", "chart": "WATCHLIST"},
    "cl_ret_1h":           {"indicator": "CL (Crude Oil)", "setting": "Side panel: CL 1h chart", "chart": "WATCHLIST"},
    "mes_zn_corr_21d":     {"indicator": "MES-ZN correlation", "setting": "Rolling 21d correlation regime", "chart": "WATCHLIST"},
    "mes_nq_corr_21d":     {"indicator": "MES-NQ correlation", "setting": "Rolling 21d correlation regime", "chart": "WATCHLIST"},
    # FRED / Macro Regime
    "yield_curve_slope":   {"indicator": "10Y-2Y Spread", "setting": "Yield curve: TVC:US10Y-TVC:US02Y", "chart": "WATCHLIST"},
    "credit_spread_diff":  {"indicator": "HY-IG OAS", "setting": "Credit stress: widen = risk-off", "chart": "DASHBOARD"},
    "fred_vix":            {"indicator": "VIX", "setting": "TradingView symbol TVC:VIX", "chart": "WATCHLIST"},
    "vix_percentile_20d":  {"indicator": "VIX percentile", "setting": "Where VIX sits in 20d range", "chart": "DASHBOARD"},
    "vix_1d_change":       {"indicator": "VIX momentum", "setting": "1-day VIX change", "chart": "DASHBOARD"},
    "fed_midpoint":        {"indicator": "Fed Funds Rate", "setting": "Target midpoint", "chart": "DASHBOARD"},
    "fed_liquidity":       {"indicator": "Fed Balance Sheet", "setting": "WALCL - RRP net liquidity", "chart": "DASHBOARD"},
    # Event / Calendar
    "is_fomc_day":         {"indicator": "FOMC Day flag", "setting": "Reduce size or sit out", "chart": "CALENDAR"},
    "is_high_impact_day":  {"indicator": "High Impact Event", "setting": "Expect vol expansion", "chart": "CALENDAR"},
    "is_cpi_day":          {"indicator": "CPI Day flag", "setting": "Watch 8:30 AM ET", "chart": "CALENDAR"},
    "is_nfp_day":          {"indicator": "NFP Day flag", "setting": "Watch 8:30 AM ET", "chart": "CALENDAR"},
    "hours_to_next_high_impact": {"indicator": "Event countdown", "setting": "Hours until next high-impact release", "chart": "CALENDAR"},
    "econ_surprise_index": {"indicator": "Surprise Index", "setting": "Net economic surprise direction", "chart": "DASHBOARD"},
    # Time
    "hour_utc":            {"indicator": "Time of day", "setting": "Session timing", "chart": "N/A"},
    "day_of_week":         {"indicator": "Day of week", "setting": "Mon=0 .. Fri=4", "chart": "N/A"},
    "is_us_session":       {"indicator": "US Session", "setting": "9:30-4:00 ET", "chart": "N/A"},
}


# ─── Reproducibility ─────────────────────────────────────────────────────────

def set_all_seeds(seed):
    """Comprehensive seed control for reproducibility."""
    np.random.seed(seed)
    random.seed(seed)
    os.environ['PYTHONHASHSEED'] = str(seed)


def dataset_hash(df):
    """SHA-256 of CSV bytes for data lineage tracking."""
    return hashlib.sha256(df.to_csv(index=False).encode()).hexdigest()[:16]


# ─── Purge/Embargo from Label Overlap ─────────────────────────────────────────

def compute_purge_embargo(horizon_bars, feature_max_lookback=24):
    """Purge = label overlap + feature lookback. Embargo = 2x purge.

    Label overlap: row t predicts close(t+h), row t-1 predicts close(t-1+h).
    Labels share (h-1) bars of future price data.

    Feature lookback: longest rolling window (24h = 24 bars).
    Features at row t contain info about close(t-24)..close(t).
    """
    label_overlap = max(1, horizon_bars - 1)
    purge = label_overlap + feature_max_lookback
    embargo = purge * 2
    return purge, embargo


# ─── ECE with Quantile Bins ──────────────────────────────────────────────────

def expected_calibration_error(y_true, y_prob, n_bins=10):
    """ECE with equal-frequency (quantile) bins for robust tail estimation."""
    bin_edges = np.quantile(y_prob, np.linspace(0, 1, n_bins + 1))
    bin_edges[-1] += 1e-8
    ece = 0.0
    reliability = []
    for i in range(n_bins):
        mask = (y_prob >= bin_edges[i]) & (y_prob < bin_edges[i + 1])
        if mask.sum() == 0:
            continue
        bin_acc = y_true[mask].mean()
        bin_conf = y_prob[mask].mean()
        weight = mask.sum() / len(y_true)
        ece += weight * abs(bin_acc - bin_conf)
        reliability.append({
            "bin_lower": float(bin_edges[i]),
            "bin_upper": float(bin_edges[i + 1]),
            "actual_freq": float(bin_acc),
            "predicted_mean": float(bin_conf),
            "count": int(mask.sum()),
        })
    return ece, reliability


# ─── Feature Selection by Information Coefficient ────────────────────────────

def rank_features_by_ic(train_df, feature_cols, target_col, top_n=50):
    """Rank features by absolute Spearman IC on TRAINING data only.
    Returns top_n feature names sorted by |IC|."""
    ics = []
    for col in feature_cols:
        vals = train_df[col].dropna()
        if len(vals) < 100:
            ics.append((col, 0.0))
            continue
        shared_idx = vals.index.intersection(train_df[target_col].dropna().index)
        if len(shared_idx) < 100:
            ics.append((col, 0.0))
            continue
        try:
            ic, _ = spearmanr(train_df.loc[shared_idx, col], train_df.loc[shared_idx, target_col])
            ics.append((col, abs(ic) if np.isfinite(ic) else 0.0))
        except Exception:
            ics.append((col, 0.0))

    ics.sort(key=lambda x: -x[1])
    selected = [col for col, ic_val in ics[:top_n]]

    print(f"    Feature IC screening (top {top_n} of {len(feature_cols)}):")
    for i, (col, ic_val) in enumerate(ics[:10]):
        print(f"      {i + 1:>2}. {col:<35} IC={ic_val:.4f}")
    if len(ics) > 10:
        cutoff_ic = ics[min(top_n - 1, len(ics) - 1)][1]
        print(f"      ... cutoff IC at rank {top_n}: {cutoff_ic:.4f}")

    return selected


# ─── Hierarchical Correlation Dedup ──────────────────────────────────────────

def cluster_dedup_features(df, feature_cols, target_col, threshold=0.90):
    """Hierarchical clustering: group correlated features, keep best per cluster."""
    numeric = [c for c in feature_cols if df[c].dtype in (np.float64, np.float32, np.int64, float, int)]
    if len(numeric) < 2:
        return feature_cols

    # Compute IC for each feature (used to pick cluster representative)
    ics = {}
    for col in numeric:
        valid = df[[col, target_col]].dropna()
        if len(valid) < 100:
            ics[col] = 0.0
            continue
        ic, _ = spearmanr(valid[col], valid[target_col])
        ics[col] = abs(ic) if np.isfinite(ic) else 0.0

    # Distance matrix from correlation
    corr = df[numeric].corr(method='spearman').abs().values
    np.fill_diagonal(corr, 1.0)
    dist = 1 - corr
    dist = np.clip(dist, 0, 2)
    condensed = squareform(dist, checks=False)

    # Hierarchical clustering (average linkage)
    Z = linkage(condensed, method='average')
    clusters = fcluster(Z, t=(1 - threshold), criterion='distance')

    # Pick representative per cluster: highest IC, then lowest missingness
    selected = set()
    for cid in set(clusters):
        members = [numeric[i] for i in range(len(numeric)) if clusters[i] == cid]
        best = max(members, key=lambda c: (ics.get(c, 0), -df[c].isna().sum()))
        selected.add(best)

    dropped = [c for c in numeric if c not in selected]
    kept = [c for c in feature_cols if c in selected or c not in numeric]

    print(f"    Cluster dedup: {len(set(clusters))} clusters from {len(numeric)} features")
    print(f"    Dropped {len(dropped)} redundant features, kept {len(kept)}")
    return kept


# ─── Walk-Forward Splitter ────────────────────────────────────────────────────

def walk_forward_splits(n, n_folds, purge, embargo):
    """Expanding-window walk-forward CV with purge + embargo gap."""
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


# ─── Log Tee ──────────────────────────────────────────────────────────────────

class _Tee:
    """Multiplex writes to several streams (stdout + log file)."""

    def __init__(self, *streams):
        self.streams = streams
    def write(self, data):
        for s in self.streams:
            s.write(data); s.flush()
    def flush(self):
        for s in self.streams:
            s.flush()
    def isatty(self):
        return False


# ─── TradingView Setup Report Generator ──────────────────────────────────────

def generate_tv_report(importance_by_horizon, report_path):
    """Maps model features → TradingView indicator recommendations."""
    lines = [
        "# Rabid Raccoon — TradingView Setup Guide",
        f"## Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "Based on AutoGluon feature importance from production training.",
        "Features ranked by predictive signal strength (permutation importance).",
        "Higher importance = model relies on this more for accuracy.",
        "",
    ]

    for horizon, imp_df in importance_by_horizon.items():
        lines.append(f"---")
        lines.append(f"## {horizon.upper()} Horizon — Top Features")
        lines.append("")

        tv_indicators = []
        watchlist = []
        dashboard_only = []
        calendar = []
        unmapped = []

        for feat, score in zip(imp_df.index, imp_df["importance"]):
            if score <= 0:
                continue
            entry = FEATURE_TV_MAP.get(feat)
            if entry is None:
                unmapped.append((feat, score))
                continue
            row = {"feature": feat, "score": score, **entry}
            chart = entry.get("chart", "")
            if "WATCHLIST" in chart:
                watchlist.append(row)
            elif "DASHBOARD" in chart:
                dashboard_only.append(row)
            elif "CALENDAR" in chart:
                calendar.append(row)
            elif chart != "N/A":
                tv_indicators.append(row)

        if tv_indicators:
            lines.append("### PUT ON YOUR TRADINGVIEW CHARTS")
            lines.append("")
            lines.append("| Rank | Indicator | Settings | Chart | Importance |")
            lines.append("|------|-----------|----------|-------|------------|")
            for i, r in enumerate(sorted(tv_indicators, key=lambda x: -x["score"]), 1):
                lines.append(f"| {i} | **{r['indicator']}** | {r['setting']} | {r['chart']} | {r['score']:.4f} |")
            lines.append("")

        if watchlist:
            lines.append("### WATCHLIST — Side Panels & Correlation Monitors")
            lines.append("")
            lines.append("| Rank | Symbol/Indicator | Why It Matters | Importance |")
            lines.append("|------|-----------------|----------------|------------|")
            for i, r in enumerate(sorted(watchlist, key=lambda x: -x["score"]), 1):
                lines.append(f"| {i} | **{r['indicator']}** | {r['setting']} | {r['score']:.4f} |")
            lines.append("")

        if calendar:
            lines.append("### EVENT AWARENESS")
            lines.append("")
            for r in sorted(calendar, key=lambda x: -x["score"]):
                lines.append(f"- **{r['indicator']}**: {r['setting']} (importance: {r['score']:.4f})")
            lines.append("")

        if dashboard_only:
            lines.append("### DASHBOARD INDICATORS (not TradingView)")
            lines.append("")
            for r in sorted(dashboard_only, key=lambda x: -x["score"]):
                lines.append(f"- **{r['indicator']}**: {r['setting']} (importance: {r['score']:.4f})")
            lines.append("")

        if unmapped:
            lines.append("### OTHER IMPORTANT FEATURES (no direct TV indicator)")
            lines.append("")
            for feat, score in sorted(unmapped, key=lambda x: -x[1])[:15]:
                lines.append(f"- `{feat}`: importance {score:.4f}")
            lines.append("")

    lines.append("---")
    lines.append("## RECOMMENDED TRADINGVIEW LAYOUT")
    lines.append("")
    lines.append("### Main Chart (MES)")
    lines.append("- **15m**: Entry timing — Squeeze Momentum + MACD + Volume")
    lines.append("- **1h**: Directional bias — EMA(8)/EMA(24) + WVF")
    lines.append("- **4h**: Trend context — SMA(120) proxy + MACD")
    lines.append("")
    lines.append("### Side Panels (ranked by model importance)")
    lines.append("- NQ 1h (tech leadership)")
    lines.append("- ZN 1h (bond direction / risk sentiment)")
    lines.append("- VIX (regime / fear)")
    lines.append("- CL 1h (commodity / inflation proxy)")
    lines.append("")
    lines.append("### Dashboard Overlay")
    lines.append("- Yield curve slope (10Y-2Y)")
    lines.append("- Credit spreads (HY-IG)")
    lines.append("- Economic surprise index")
    lines.append("- Event calendar countdown")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines))
    print(f"\n  TradingView Setup Guide: {report_path}")


# ─── Validation Report Generator ─────────────────────────────────────────────

def generate_validation_report(report_path, results, fold_metrics_by_horizon,
                                calibration_info, feature_stability_by_horizon,
                                ds_hash, n_rows, n_cols, n_folds, time_limit, presets):
    """Auto-generate models/reports/v2_validation.md with full diagnostics."""
    lines = [
        "# MES Directional Classifier — v2.1 Validation Report",
        f"## Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "## Data Lineage",
        f"- Dataset hash: `{ds_hash}`",
        f"- Rows: {n_rows:,} | Columns: {n_cols}",
        f"- Seed: {SEED}",
        f"- Folds: {n_folds} | Time/fold: {time_limit}s | Presets: {presets}",
        "",
    ]

    for h_name, fold_list in fold_metrics_by_horizon.items():
        if not fold_list:
            continue
        lines.append(f"---")
        lines.append(f"## {h_name.upper()} Horizon")
        lines.append("")

        # Fold-by-fold table
        lines.append("### Fold-by-Fold Metrics")
        lines.append("")
        lines.append("| Fold | AUC | Brier | ECE | IC | Val Size |")
        lines.append("|------|-----|-------|-----|----|----------|")
        aucs, briers, eces, ic_vals = [], [], [], []
        for fm in fold_list:
            lines.append(f"| {fm['fold']} | {fm['auc']:.4f} | {fm['brier']:.4f} | "
                         f"{fm['ece']:.4f} | {fm['ic']:.4f} | {fm['n_val']:,} |")
            aucs.append(fm['auc'])
            briers.append(fm['brier'])
            eces.append(fm['ece'])
            ic_vals.append(fm['ic'])

        lines.append(f"| **Mean** | **{np.mean(aucs):.4f}** | **{np.mean(briers):.4f}** | "
                     f"**{np.mean(eces):.4f}** | **{np.mean(ic_vals):.4f}** | |")
        lines.append(f"| **Std** | {np.std(aucs):.4f} | {np.std(briers):.4f} | "
                     f"{np.std(eces):.4f} | {np.std(ic_vals):.4f} | |")
        lines.append("")

        # Calibration info
        if h_name in calibration_info:
            cal = calibration_info[h_name]
            lines.append("### Calibration")
            lines.append(f"- Method selected: **{cal['method']}**")
            lines.append(f"- Isotonic ECE (eval split): {cal['iso_ece']:.4f}")
            lines.append(f"- Platt ECE (eval split): {cal['platt_ece']:.4f}")
            lines.append(f"- Final ECE (all OOF): {cal['final_ece']:.4f}")
            lines.append("")

        # Feature stability
        if h_name in feature_stability_by_horizon:
            stability = feature_stability_by_horizon[h_name]
            n_all = sum(1 for s in stability.values() if s >= 1.0)
            n_unstable = sum(1 for s in stability.values() if s < 0.4)
            lines.append("### Feature Stability")
            lines.append(f"- Features in all folds: {n_all}")
            lines.append(f"- Unstable (<40% of folds): {n_unstable}")
            lines.append("")
            # Top stable features
            sorted_feats = sorted(stability.items(), key=lambda x: -x[1])[:15]
            lines.append("| Feature | Fold Frequency |")
            lines.append("|---------|---------------|")
            for feat, freq in sorted_feats:
                lines.append(f"| {feat} | {freq:.0%} |")
            lines.append("")

    # Cross-horizon comparison
    if results:
        lines.append("---")
        lines.append("## Cross-Horizon Comparison")
        lines.append("")
        lines.append(f"| Horizon | AUC | Acc | HC Acc | VHC Acc | Brier | n |")
        lines.append(f"|---------|-----|-----|--------|---------|-------|---|")
        for h, r in results.items():
            lines.append(f"| {h} | {r['AUC']:.4f} | {r['Acc']:.4f} | "
                         f"{r['HC_Acc']:.4f} | {r['VHC_Acc']:.4f} | {r['Brier']:.4f} | {r['n']:,} |")
        lines.append("")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines))
    print(f"\n  Validation Report: {report_path}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    set_all_seeds(SEED)
    active_horizons = dict(HORIZONS)
    if args.horizons:
        requested = [h.strip() for h in args.horizons.split(",") if h.strip()]
        invalid = [h for h in requested if h not in HORIZONS]
        if invalid:
            print(f"ERROR: Invalid horizons: {', '.join(invalid)}")
            print(f"Valid horizons: {', '.join(HORIZONS.keys())}")
            sys.exit(1)
        if not requested:
            print("ERROR: --horizons provided but empty after parsing.")
            sys.exit(1)
        active_horizons = {h: HORIZONS[h] for h in requested}

    n_folds = args.n_folds if args.n_folds is not None else N_FOLDS
    time_limit = args.time_limit if args.time_limit is not None else TIME_LIMIT
    if n_folds < 1:
        print("ERROR: --n-folds must be >= 1")
        sys.exit(1)
    if time_limit < 1:
        print("ERROR: --time-limit must be >= 1")
        sys.exit(1)

    dataset_path = Path(args.dataset).expanduser()
    if not dataset_path.is_absolute():
        dataset_path = (ROOT / dataset_path).resolve()

    # ── Logging ──
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = LOG_DIR / f"training_final_{ts}.log"
    log_file = open(log_path, "w", buffering=1)
    sys.stdout = _Tee(sys.__stdout__, log_file)
    sys.stderr = _Tee(sys.__stderr__, log_file)
    print(f"Log: {log_path}\n")

    try:
        from autogluon.tabular import TabularPredictor
    except ImportError:
        print("ERROR: AutoGluon not installed.")
        print("  source .venv-autogluon/bin/activate  # or .venv-finance if installed there")
        print("  pip install 'autogluon.tabular>=1.5'")
        sys.exit(1)

    # ── Load dataset ──
    if not dataset_path.exists():
        print(f"ERROR: {dataset_path} not found. Run: npx tsx scripts/build-lean-dataset.ts")
        sys.exit(1)

    print(f"Loading: {dataset_path.name}")
    df = pd.read_csv(dataset_path)
    df = df.sort_values("timestamp").reset_index(drop=True)
    ds_hash_val = dataset_hash(df)
    print(f"  Rows: {len(df):,}  Columns: {len(df.columns)}")
    print(f"  Dataset hash: {ds_hash_val}")

    # ── Dataset quality gates (preflight) ──
    print(f"\n  Preflight quality gates:")
    for group, cols in REQUIRED_GROUPS.items():
        present = [c for c in cols if c in df.columns]
        if not present:
            print(f"  ABORT: Feature group '{group}' has no columns in dataset")
            print(f"         Expected: {cols}")
            sys.exit(1)
        avg_cov = np.mean([df[c].notna().mean() for c in present])
        status = "PASS" if avg_cov >= MIN_GROUP_COVERAGE else "FAIL"
        print(f"    {status}: {group:<25} {len(present)}/{len(cols)} cols, coverage={avg_cov:.1%}")
        if avg_cov < MIN_GROUP_COVERAGE:
            print(f"  ABORT: Feature group '{group}' coverage {avg_cov:.1%} < {MIN_GROUP_COVERAGE:.0%}")
            sys.exit(1)
    print()

    # ── Create 1d and 1w targets if missing ──
    for h_name, h_cfg in active_horizons.items():
        target_col = h_cfg["target"]
        horizon_bars = h_cfg["horizon_bars"]
        dir_col = f"target_dir_{h_name}"
        ret_col = f"target_ret_{h_name}"

        if dir_col not in df.columns and "target" in df.columns:
            print(f"  Creating {h_name} target (close.shift(-{horizon_bars}) vs close)...")
            future = df["target"].shift(-horizon_bars)
            df[dir_col] = (future > df["target"]).astype(float)
            df.loc[future.isna(), dir_col] = np.nan
            print(f"    {dir_col}: {df[dir_col].notna().sum():,} valid rows")

        if ret_col not in df.columns and "target" in df.columns:
            future = df["target"].shift(-horizon_bars)
            df[ret_col] = (future - df["target"]) / df["target"]
            df.loc[future.isna(), ret_col] = np.nan

    # Feature columns = everything except identity + targets
    feature_cols = [c for c in df.columns if c not in DROP_COLS]

    # Safety: no target leakage
    leaked = [c for c in feature_cols if c.startswith("target_")]
    assert not leaked, f"TARGET LEAK: {leaked}"

    # ── Drop sparse features (<50% non-null) ──
    sparse = [(c, df[c].notna().mean()) for c in feature_cols if df[c].notna().mean() < MIN_COVERAGE]
    if sparse:
        print(f"\n  Dropping {len(sparse)} sparse features (<{MIN_COVERAGE:.0%} non-null):")
        for col, cov in sparse:
            print(f"    {col:<40} {cov:.1%}")
        feature_cols = [c for c in feature_cols if c not in {s[0] for s in sparse}]

    # ── Replace inf, winsorize outliers ──
    numeric = df[feature_cols].select_dtypes(include=[np.number]).columns.tolist()
    n_inf = sum((~np.isfinite(df[c].fillna(0))).sum() for c in numeric)
    if n_inf > 0:
        print(f"  Replacing {n_inf} inf values with NaN")
        df[numeric] = df[numeric].replace([np.inf, -np.inf], np.nan)

    winsorized = 0
    for col in numeric:
        if col in feature_cols:
            p01, p99 = df[col].quantile(0.01), df[col].quantile(0.99)
            if p01 == p99:
                continue
            clipped = df[col].clip(lower=p01, upper=p99)
            if (df[col] != clipped).sum() > 0:
                df[col] = clipped
                winsorized += 1
    print(f"  Winsorized {winsorized} features to [1st, 99th] percentile")

    # ── Global hierarchical correlation dedup ──
    # Use first available target for IC computation during dedup
    dedup_target = None
    for h_cfg in active_horizons.values():
        if h_cfg["target"] in df.columns:
            dedup_target = h_cfg["target"]
            break
    if dedup_target:
        feature_cols = cluster_dedup_features(df, feature_cols, dedup_target, CORR_THRESHOLD)
    else:
        print("  WARNING: No target column found for dedup, skipping")

    print(f"\n  Features after cleanup: {len(feature_cols)}")
    print(f"  Horizons: {list(active_horizons.keys())}")
    print(f"  Folds: {n_folds}  |  Time/fold: {time_limit}s  |  Presets: {PRESETS}")
    print(f"  Bagging: {NUM_BAG_FOLDS}  |  Stack: {NUM_STACK_LEVELS}  |  Metric: {EVAL_METRIC}")
    print(f"  IC screening: top {MAX_FEATURES} features per fold")
    print(f"  Correlation dedup: hierarchical clustering, |r| > {CORR_THRESHOLD}")
    print(f"  Purge/embargo: label-overlap + {FEATURE_MAX_LOOKBACK}h lookback")
    print(f"  Excluded models: {EXCLUDED}")
    est_hrs = time_limit * n_folds * len(active_horizons) / 3600
    print(f"  Est. total: {est_hrs:.1f} hours")
    print()

    if args.preflight_only:
        print("  Preflight-only mode: checks passed, no training started.")
        log_file.close()
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        return

    if args.clean:
        for h in active_horizons:
            for i in range(n_folds):
                fold_dir = MODEL_DIR / h / f"fold_{i}"
                if fold_dir.exists():
                    shutil.rmtree(fold_dir)
                    print(f"  [clean] Removed {fold_dir.relative_to(ROOT)}")
        print()

    # ── OOF storage ──
    oof_df = df[["timestamp"]].copy()
    results = {}
    importance_by_horizon = {}
    calibrators = {}
    fold_metrics_by_horizon = {}
    calibration_info = {}
    feature_stability_by_horizon = {}

    # ══════════════════════════════════════════════════════════════════════════
    #  TRAINING LOOP — per horizon, per fold
    # ══════════════════════════════════════════════════════════════════════════

    for h_name, h_cfg in active_horizons.items():
        target_col = h_cfg["target"]
        horizon_bars = h_cfg["horizon_bars"]
        purge, embargo = compute_purge_embargo(horizon_bars, FEATURE_MAX_LOOKBACK)

        print(f"\n{'=' * 70}")
        print(f"HORIZON: {h_name}  target={target_col}  horizon={horizon_bars} bars")
        print(f"  purge={purge}  embargo={embargo}  (label_overlap={max(1, horizon_bars - 1)} + lookback={FEATURE_MAX_LOOKBACK})")
        print(f"{'=' * 70}")

        if target_col not in df.columns:
            print(f"  SKIP: target column {target_col} not in dataset")
            continue

        # Per-horizon dropna
        h_df = df.dropna(subset=[target_col]).reset_index(drop=True)
        print(f"  Rows with valid {target_col}: {len(h_df):,}")

        # Class balance check
        base_rate = h_df[target_col].mean()
        print(f"  Class balance: {base_rate:.4f} (up), {1 - base_rate:.4f} (down)")
        if abs(base_rate - 0.5) > 0.05:
            print(f"  WARNING: imbalanced classes — consider sample_weight")

        splits = walk_forward_splits(len(h_df), n_folds, purge, embargo)
        print(f"  Walk-forward folds: {len(splits)}")

        for fi, (tr_idx, va_idx) in enumerate(splits):
            gap = va_idx[0] - tr_idx[-1] - 1 if tr_idx and va_idx else 0
            print(f"    Fold {fi}: train={len(tr_idx):,}  val={len(va_idx):,}  gap={gap}")

        oof_preds = pd.Series(np.nan, index=h_df.index, dtype=float)
        fold_importances = []
        fold_metrics = []
        fold_assignments = []  # track which fold each OOF row belongs to
        feature_selection_counts = defaultdict(int)

        for fold_i, (train_idx, val_idx) in enumerate(splits):
            print(f"\n  ── Fold {fold_i + 1}/{len(splits)} ──")
            print(f"  Train: {len(train_idx):,}  |  Val: {len(val_idx):,}")

            train_data = h_df.iloc[train_idx][feature_cols + [target_col]].dropna(subset=[target_col])
            val_data = h_df.iloc[val_idx][feature_cols + [target_col]].dropna(subset=[target_col])

            if len(train_data) < 100 or len(val_data) < 10:
                print(f"    SKIP: insufficient data")
                continue

            # ── Per-fold IC screening ──
            fold_features = rank_features_by_ic(
                train_data, feature_cols, target_col, top_n=MAX_FEATURES
            )
            print(f"    Using {len(fold_features)} features for this fold")

            # Track feature stability
            for f in fold_features:
                feature_selection_counts[f] += 1

            # Subset data to selected features
            train_subset = train_data[fold_features + [target_col]]
            val_subset = val_data[fold_features + [target_col]]

            fold_dir = MODEL_DIR / h_name / f"fold_{fold_i}"
            fold_dir.mkdir(parents=True, exist_ok=True)

            predictor = TabularPredictor(
                label=target_col,
                path=str(fold_dir),
                problem_type="binary",
                eval_metric=EVAL_METRIC,
                verbosity=2,
            )

            predictor.fit(
                train_data=train_subset,
                time_limit=time_limit,
                presets=PRESETS,
                num_gpus=0,
                excluded_model_types=EXCLUDED,
                num_bag_folds=NUM_BAG_FOLDS,
                num_stack_levels=NUM_STACK_LEVELS,
                dynamic_stacking=False,
                ag_args_fit={
                    "num_early_stopping_rounds": 50,
                    "ag.max_memory_usage_ratio": 1.5,
                },
                ag_args_ensemble={
                    "fold_fitting_strategy": "sequential_local",
                },
            )

            # Leaderboard
            lb = predictor.leaderboard(val_subset, silent=True)
            print(f"\n    Leaderboard (top 5):")
            print(lb.head(5).to_string())

            # Predictions — extract P(class=1)
            preds_proba = predictor.predict_proba(val_subset[fold_features])
            pos_label = 1
            if pos_label in preds_proba.columns:
                preds_np = preds_proba[pos_label].to_numpy()
            elif str(pos_label) in preds_proba.columns:
                preds_np = preds_proba[str(pos_label)].to_numpy()
            else:
                pos_idx = list(predictor.class_labels).index(pos_label)
                preds_np = preds_proba.iloc[:, pos_idx].to_numpy()
                print(f"    WARNING: used positional index {pos_idx}")

            # Guardrails
            assert 0 <= preds_np.min() and preds_np.max() <= 1, \
                f"Probs out of [0,1]: {preds_np.min():.4f}-{preds_np.max():.4f}"

            if fold_i == 0:
                base = val_subset[target_col].mean()
                pred_mean = preds_np.mean()
                print(f"    base_rate={base:.4f}, pred_mean={pred_mean:.4f}")
                if abs(pred_mean - (1 - base)) < abs(pred_mean - base):
                    print(f"    WARNING: POSSIBLE PROBABILITY INVERSION!")

            oof_preds.loc[val_data.index] = preds_np
            # Track fold assignment for each OOF row
            for idx in val_data.index:
                fold_assignments.append((idx, fold_i))

            # Fold metrics
            actuals = val_subset[target_col].values
            fold_auc = roc_auc_score(actuals, preds_np)
            fold_acc = accuracy_score(actuals, (preds_np >= 0.5).astype(int))
            fold_ic, _ = spearmanr(actuals, preds_np)
            fold_brier = brier_score_loss(actuals, preds_np)
            fold_ece, _ = expected_calibration_error(actuals, preds_np)
            print(f"\n    AUC: {fold_auc:.4f}  Acc: {fold_acc:.4f}  IC: {fold_ic:.4f}  Brier: {fold_brier:.4f}  ECE: {fold_ece:.4f}")

            fold_metrics.append({
                "fold": fold_i,
                "auc": float(fold_auc),
                "acc": float(fold_acc),
                "ic": float(fold_ic),
                "brier": float(fold_brier),
                "ece": float(fold_ece),
                "n_val": len(val_data),
            })

            # Feature importance (permutation-based)
            try:
                imp = predictor.feature_importance(val_subset, silent=True)
                fold_importances.append(imp)
                top10 = imp.head(10)
                print(f"    Top 10 features:")
                for feat, row in top10.iterrows():
                    tv = FEATURE_TV_MAP.get(feat, {}).get("indicator", "")
                    tag = f" -> {tv}" if tv else ""
                    print(f"      {feat:<35} {row['importance']:.4f}{tag}")
            except Exception as e:
                print(f"    Feature importance failed: {e}")

            # Save fold metadata
            fold_meta = {
                "horizon": h_name,
                "fold": fold_i,
                "n_train": len(train_data),
                "n_val": len(val_data),
                "n_features": len(fold_features),
                "features": fold_features,
                "auc": float(fold_auc),
                "acc": float(fold_acc),
                "ic": float(fold_ic),
                "brier": float(fold_brier),
                "ece": float(fold_ece),
                "purge": purge,
                "embargo": embargo,
            }
            (fold_dir / "fold_meta.json").write_text(json.dumps(fold_meta, indent=2))

        # ── Feature stability report ──
        n_actual_folds = len(splits)
        if n_actual_folds > 0:
            stability = {f: cnt / n_actual_folds for f, cnt in feature_selection_counts.items()}
            n_all_folds = sum(1 for s in stability.values() if s >= 1.0)
            n_unstable = sum(1 for s in stability.values() if s < 0.4)
            print(f"\n  Feature stability: {n_all_folds} in all folds, {n_unstable} unstable (<40%)")
            feature_stability_by_horizon[h_name] = stability

        fold_metrics_by_horizon[h_name] = fold_metrics

        # ── Aggregate OOF for this horizon ────────────────────────────────────

        mask = oof_preds.notna()
        oof_actual = h_df.loc[mask, target_col].values
        oof_pred = oof_preds[mask].values

        if len(oof_actual) == 0:
            print(f"\n  WARNING: No OOF predictions for {h_name}")
            continue

        # ── Nested calibration: isotonic vs Platt ──
        print(f"\n  Calibrating probabilities (nested selection)...")

        # Build fold assignment array aligned with OOF mask
        fold_map = dict(fold_assignments)
        oof_indices = h_df.index[mask]
        oof_fold_ids = np.array([fold_map.get(idx, 0) for idx in oof_indices])

        # Split by fold parity: odd folds for fitting, even folds for evaluation
        odd_mask = (oof_fold_ids % 2 == 1)
        even_mask = ~odd_mask

        if odd_mask.sum() > 50 and even_mask.sum() > 50:
            # Fit both candidates on odd folds
            iso_fit = IsotonicRegression(y_min=0.01, y_max=0.99, out_of_bounds='clip')
            iso_fit.fit(oof_pred[odd_mask], oof_actual[odd_mask])

            platt_fit = LogisticRegression(C=1e10, solver='lbfgs', max_iter=1000)
            platt_fit.fit(oof_pred[odd_mask].reshape(-1, 1), oof_actual[odd_mask])

            # Evaluate on even folds (blind)
            iso_preds_eval = iso_fit.predict(oof_pred[even_mask])
            platt_preds_eval = platt_fit.predict_proba(oof_pred[even_mask].reshape(-1, 1))[:, 1]

            iso_ece, _ = expected_calibration_error(oof_actual[even_mask], iso_preds_eval)
            platt_ece, _ = expected_calibration_error(oof_actual[even_mask], platt_preds_eval)

            cal_method = "isotonic" if iso_ece <= platt_ece else "platt"
            print(f"    Isotonic ECE (eval): {iso_ece:.4f}")
            print(f"    Platt ECE (eval):    {platt_ece:.4f}")
            print(f"    Selected: {cal_method}")
        else:
            cal_method = "isotonic"
            iso_ece = platt_ece = float('nan')
            print(f"    Insufficient data for nested selection, defaulting to isotonic")

        # Refit winner on ALL OOF for production
        if cal_method == "isotonic":
            final_cal = IsotonicRegression(y_min=0.01, y_max=0.99, out_of_bounds='clip')
            final_cal.fit(oof_pred, oof_actual)
            oof_calibrated = final_cal.predict(oof_pred)
        else:
            final_cal = LogisticRegression(C=1e10, solver='lbfgs', max_iter=1000)
            final_cal.fit(oof_pred.reshape(-1, 1), oof_actual)
            oof_calibrated = final_cal.predict_proba(oof_pred.reshape(-1, 1))[:, 1]

        calibrators[h_name] = {"calibrator": final_cal, "method": cal_method}
        final_ece, final_reliability = expected_calibration_error(oof_actual, oof_calibrated)

        calibration_info[h_name] = {
            "method": cal_method,
            "iso_ece": float(iso_ece),
            "platt_ece": float(platt_ece),
            "final_ece": float(final_ece),
            "reliability": final_reliability,
        }

        # Pre-calibration metrics
        auc_raw = roc_auc_score(oof_actual, oof_pred)
        brier_raw = brier_score_loss(oof_actual, oof_pred)

        # Post-calibration metrics
        auc = roc_auc_score(oof_actual, oof_calibrated)
        acc = accuracy_score(oof_actual, (oof_calibrated >= 0.5).astype(int))
        ic, ic_p = spearmanr(oof_actual, oof_calibrated)
        brier = brier_score_loss(oof_actual, oof_calibrated)

        # High-confidence accuracy (p > 0.55 or p < 0.45)
        hc_mask = (oof_calibrated >= 0.55) | (oof_calibrated <= 0.45)
        hc_acc = accuracy_score(
            oof_actual[hc_mask], (oof_calibrated[hc_mask] >= 0.5).astype(int)
        ) if hc_mask.sum() > 0 else 0
        hc_n = int(hc_mask.sum())
        hc_pct = hc_n / len(oof_actual) * 100

        # Very-high-confidence accuracy (p > 0.58 or p < 0.42)
        vhc_mask = (oof_calibrated >= 0.58) | (oof_calibrated <= 0.42)
        vhc_acc = accuracy_score(
            oof_actual[vhc_mask], (oof_calibrated[vhc_mask] >= 0.5).astype(int)
        ) if vhc_mask.sum() > 0 else 0
        vhc_n = int(vhc_mask.sum())
        vhc_pct = vhc_n / len(oof_actual) * 100

        results[h_name] = {
            "AUC": auc, "AUC_raw": auc_raw, "Acc": acc,
            "HC_Acc": hc_acc, "HC_n": hc_n, "HC_pct": hc_pct,
            "VHC_Acc": vhc_acc, "VHC_n": vhc_n, "VHC_pct": vhc_pct,
            "IC": ic, "IC_pval": ic_p,
            "Brier": brier, "Brier_raw": brier_raw,
            "ECE": final_ece, "cal_method": cal_method,
            "n": len(oof_actual),
        }

        print(f"\n  ═══ OOF RESULTS: {h_name} ═══")
        print(f"    AUC:       {auc:.4f}  (raw: {auc_raw:.4f})  {'◀ SIGNAL' if auc > 0.52 else '◀ below threshold'}")
        print(f"    Accuracy:  {acc:.4f}  ({acc * 100:.1f}%)")
        print(f"    HC Acc:    {hc_acc:.4f}  ({hc_acc * 100:.1f}% on {hc_n:,} rows = {hc_pct:.0f}% of data)")
        print(f"    VHC Acc:   {vhc_acc:.4f}  ({vhc_acc * 100:.1f}% on {vhc_n:,} rows = {vhc_pct:.0f}% of data)")
        print(f"    IC:        {ic:.4f}  (p={ic_p:.2e})")
        print(f"    Brier:     {brier:.4f}  (raw: {brier_raw:.4f})")
        print(f"    ECE:       {final_ece:.4f}  (method: {cal_method})")
        print(f"    n:         {len(oof_actual):,}")

        # Average feature importance across folds
        if fold_importances:
            avg_imp = fold_importances[0].copy()
            for fi in fold_importances[1:]:
                avg_imp["importance"] = avg_imp["importance"].add(
                    fi["importance"].reindex(avg_imp.index, fill_value=0)
                )
            avg_imp["importance"] /= len(fold_importances)
            avg_imp = avg_imp.sort_values("importance", ascending=False)
            importance_by_horizon[h_name] = avg_imp

        # Store OOF (calibrated) — merge back to original df via timestamp join
        oof_col = f"oof_{h_name}"
        oof_raw_col = f"oof_raw_{h_name}"
        actual_col = f"actual_{h_name}"
        h_oof = pd.DataFrame({
            "timestamp": h_df.loc[mask, "timestamp"].values,
            oof_col: oof_calibrated,
            oof_raw_col: oof_pred,
            actual_col: oof_actual,
        })
        oof_df = oof_df.drop(columns=[oof_col, oof_raw_col, actual_col], errors="ignore")
        oof_df = oof_df.merge(h_oof, on="timestamp", how="left")

        # Save fold splits for reproducibility
        fold_splits_path = MODEL_DIR / h_name / "fold_splits.json"
        fold_splits_path.parent.mkdir(parents=True, exist_ok=True)
        fold_splits_path.write_text(json.dumps({
            "dataset_hash": ds_hash_val,
            "seed": SEED,
            "n_rows": len(h_df),
            "n_folds": len(splits),
            "horizon_bars": horizon_bars,
            "purge": purge,
            "embargo": embargo,
            "splits": [{"train_start": tr[0], "train_end": tr[-1],
                        "val_start": va[0], "val_end": va[-1]} for tr, va in splits],
            "feature_cols_global": feature_cols,
        }, indent=2))

    # ══════════════════════════════════════════════════════════════════════════
    #  SAVE & REPORT
    # ══════════════════════════════════════════════════════════════════════════

    # Save OOF predictions
    OOF_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    oof_df.to_csv(OOF_OUTPUT, index=False)
    print(f"\nOOF saved: {OOF_OUTPUT}")

    # Save calibrators
    for h_name, cal_info in calibrators.items():
        cal_path = MODEL_DIR / h_name / "calibrator.pkl"
        cal_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cal_path, "wb") as f:
            pickle.dump(cal_info, f)
        print(f"  Calibrator saved: {cal_path} (method: {cal_info['method']})")

    # Generate TradingView setup guide
    if importance_by_horizon:
        report_path = REPORT_DIR / "feature_importance.md"
        generate_tv_report(importance_by_horizon, report_path)

    # Generate validation report
    generate_validation_report(
        REPORT_DIR / "v2_validation.md",
        results, fold_metrics_by_horizon,
        calibration_info, feature_stability_by_horizon,
        ds_hash_val, len(df), len(df.columns), n_folds, time_limit, PRESETS,
    )

    # ── Final Summary ─────────────────────────────────────────────────────────

    print(f"\n{'=' * 70}")
    print(f"  FINAL SUMMARY — MES Directional Classifier (Production v2.1)")
    print(f"{'=' * 70}")
    print(f"  Dataset:     {dataset_path.name} ({len(df):,} rows x {len(df.columns)} cols)")
    print(f"  DS Hash:     {ds_hash_val}")
    print(f"  Features:    {len(feature_cols)} available, top {MAX_FEATURES} used per fold (IC screened)")
    print(f"  Corr dedup:  hierarchical clustering, |r| > {CORR_THRESHOLD}")
    print(f"  Config:      {PRESETS} | {n_folds} folds | {time_limit}s/fold")
    print(f"  Models:      GBM + CAT + XGB + XT -> WeightedEnsemble")
    print(f"  Bagging:     {NUM_BAG_FOLDS}-fold | Stack: {NUM_STACK_LEVELS} level")
    print(f"  Calibration: Nested selection (isotonic vs Platt) on OOF")
    print()

    if results:
        print(f"  {'Horizon':<8} {'AUC':>7} {'AUC_r':>7} {'Acc':>7} {'HC_Acc':>7} {'VHC_Acc':>8} {'IC':>7} {'Brier':>7} {'ECE':>7} {'Cal':>8} {'n':>8}")
        print(f"  {'-' * 85}")
        for h, r in results.items():
            sig = " ◀ SIGNAL" if r["AUC"] > 0.52 else ""
            print(f"  {h:<8} {r['AUC']:>7.4f} {r['AUC_raw']:>7.4f} {r['Acc']:>7.4f} "
                  f"{r['HC_Acc']:>7.4f} {r['VHC_Acc']:>8.4f} {r['IC']:>7.4f} {r['Brier']:>7.4f} "
                  f"{r['ECE']:>7.4f} {r['cal_method']:>8} {r['n']:>8,}{sig}")

        print()
        print(f"  HC  = High-Confidence (p > 0.55 or p < 0.45)")
        print(f"  VHC = Very-High-Confidence (p > 0.58 or p < 0.42) <- TRADING FILTER")
        print()
        for h, r in results.items():
            h_cfg = active_horizons.get(h, HORIZONS[h])
            purge, embargo = compute_purge_embargo(h_cfg["horizon_bars"], FEATURE_MAX_LOOKBACK)
            print(f"  {h}  HC: {r['HC_n']:,} rows ({r['HC_pct']:.0f}%)  "
                  f"VHC: {r['VHC_n']:,} rows ({r['VHC_pct']:.0f}%)  "
                  f"purge={purge} embargo={embargo}")

    print()
    print(f"  Outputs:")
    print(f"    Models:      {MODEL_DIR}")
    print(f"    OOF:         {OOF_OUTPUT}")
    print(f"    TV Report:   {REPORT_DIR / 'feature_importance.md'}")
    print(f"    Validation:  {REPORT_DIR / 'v2_validation.md'}")
    print(f"    Calibrators: {MODEL_DIR}/{{horizon}}/calibrator.pkl")
    print(f"    Fold Splits: {MODEL_DIR}/{{horizon}}/fold_splits.json")
    print(f"    Log:         {log_path}")

    print()
    print(f"  ┌──────────────────────────────────────────────────────────┐")
    print(f"  │  INTERPRETING RESULTS (v2.1)                            │")
    print(f"  │                                                         │")
    print(f"  │  AUC > 0.52:  Meaningful signal for financial data      │")
    print(f"  │  AUC > 0.55:  Strong — publishable in research         │")
    print(f"  │  AUC > 0.58:  Exceptional — double-check leakage       │")
    print(f"  │                                                         │")
    print(f"  │  VHC_Acc: Accuracy on VERY high-confidence predictions  │")
    print(f"  │           (calibrated p > 0.58 or p < 0.42 only)       │")
    print(f"  │           THIS is your trading signal filter.           │")
    print(f"  │                                                         │")
    print(f"  │  Brier: Lower = better. 0.25 = random, <0.24 = signal  │")
    print(f"  │  ECE:   Lower = better. <0.02 = well-calibrated        │")
    print(f"  │  IC:    > 0.03 is meaningful for hourly financial       │")
    print(f"  │                                                         │")
    print(f"  │  v2.1 improvements:                                     │")
    print(f"  │    - Label-overlap purge/embargo (Lopez de Prado)       │")
    print(f"  │    - Hierarchical cluster dedup (IC-priority)           │")
    print(f"  │    - Nested calibration (isotonic vs Platt)             │")
    print(f"  │    - ECE quantile bins + feature stability tracking     │")
    print(f"  │    - 4 horizons: 1h, 4h, 1d, 1w                        │")
    print(f"  │    - Dataset quality gates (preflight)                  │")
    print(f"  │    - Full reproducibility manifest                      │")
    print(f"  │                                                         │")
    print(f"  │  Next: Open models/reports/v2_validation.md             │")
    print(f"  │        for full fold-by-fold diagnostics.               │")
    print(f"  └──────────────────────────────────────────────────────────┘")

    log_file.close()
    sys.stdout = sys.__stdout__
    sys.stderr = sys.__stderr__


if __name__ == "__main__":
    main()
