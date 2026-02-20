"""
train-final.py — MES 1h/4h Directional Classifier (Production)

No phases. No modes. One configuration, no compromises.

  Input:  datasets/autogluon/mes_lean_1h.csv
  Output: models/core_forecaster/{1h,4h}/fold_N/   (AutoGluon artifacts)
          datasets/autogluon/core_oof_1h.csv        (OOF predictions)
          models/reports/feature_importance.md       (TradingView setup guide)
          models/logs/training_final_YYYYMMDD.log

  Config: classify (binary up/down), best_quality_v150, 5 folds, 2400s/fold
          GBM + CAT + XGB + XT, 3-fold bagging, 1 stack level
          Walk-forward expanding window with purge + embargo

  Run:    cd /Users/zincdigital/Projects/rabid-raccoon
          source .venv-autogluon/bin/activate
          python scripts/train-final.py

  Time:   ~6-8 hours on Apple Silicon (5 folds × 2 horizons × 2400s)
"""

import sys, warnings, shutil
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score, accuracy_score

warnings.filterwarnings("ignore", category=FutureWarning)

# ─── Paths ────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent
DATASET = ROOT / "datasets" / "autogluon" / "mes_lean_1h.csv"
MODEL_DIR = ROOT / "models" / "core_forecaster"
OOF_OUTPUT = ROOT / "datasets" / "autogluon" / "core_oof_1h.csv"
REPORT_DIR = ROOT / "models" / "reports"
LOG_DIR = ROOT / "models" / "logs"

# ─── Training Config (production, no compromises) ────────────────────────────

HORIZONS = {
    "1h": {"target": "target_dir_1h", "purge": 1,  "embargo": 2},
    "4h": {"target": "target_dir_4h", "purge": 4,  "embargo": 8},
}

N_FOLDS = 5
TIME_LIMIT = 2400          # 40 min per fold
PRESETS = "best_quality_v150"
NUM_BAG_FOLDS = 3
NUM_STACK_LEVELS = 1
EVAL_METRIC = "roc_auc"
MIN_COVERAGE = 0.50        # drop features with <50% non-null

# Identity + target columns — NEVER used as features
DROP_COLS = {
    "item_id", "timestamp", "target",
    "target_ret_1h", "target_ret_4h",
    "target_dir_1h", "target_dir_4h",
    "target_ret_norm_1h", "target_ret_norm_4h",
}

# Models excluded:
#   KNN:      curse of dimensionality on 130+ features
#   FASTAI:   unreliable on CPU-only Apple Silicon
#   RF:       redundant with ExtraTrees
#   NN_TORCH: overfits on weak financial signal
EXCLUDED = ["KNN", "FASTAI", "RF", "NN_TORCH"]

# ─── Feature → TradingView Indicator Mapping ─────────────────────────────────
# After training, feature importance gets mapped through this table to produce
# the "here's what to put on your charts" output.

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
    # Cross-Asset — what to put on watchlist
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
    "yield_curve_slope":   {"indicator": "10Y-2Y Spread", "setting": "Yield curve: TradingView symbol TVC:US10Y-TVC:US02Y", "chart": "WATCHLIST"},
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
    """
    Takes feature importance dicts and produces the TradingView setup guide.
    Maps model features → indicator recommendations with exact settings.
    """
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

        # Separate into categories
        tv_indicators = []   # things you put on TradingView
        watchlist = []        # cross-asset symbols to watch
        dashboard_only = []   # FRED/macro — dashboard, not TV
        calendar = []         # event flags
        unmapped = []         # features not in mapping table

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

        # ── TradingView Chart Indicators ──
        if tv_indicators:
            lines.append("### 📊 PUT ON YOUR TRADINGVIEW CHARTS")
            lines.append("")
            lines.append("| Rank | Indicator | Settings | Chart | Importance |")
            lines.append("|------|-----------|----------|-------|------------|")
            for i, r in enumerate(sorted(tv_indicators, key=lambda x: -x["score"]), 1):
                lines.append(f"| {i} | **{r['indicator']}** | {r['setting']} | {r['chart']} | {r['score']:.4f} |")
            lines.append("")

        # ── Watchlist / Side Panels ──
        if watchlist:
            lines.append("### 👀 WATCHLIST — Side Panels & Correlation Monitors")
            lines.append("")
            lines.append("| Rank | Symbol/Indicator | Why It Matters | Importance |")
            lines.append("|------|-----------------|----------------|------------|")
            for i, r in enumerate(sorted(watchlist, key=lambda x: -x["score"]), 1):
                lines.append(f"| {i} | **{r['indicator']}** | {r['setting']} | {r['score']:.4f} |")
            lines.append("")

        # ── Calendar / Events ──
        if calendar:
            lines.append("### 📅 EVENT AWARENESS")
            lines.append("")
            for r in sorted(calendar, key=lambda x: -x["score"]):
                lines.append(f"- **{r['indicator']}**: {r['setting']} (importance: {r['score']:.4f})")
            lines.append("")

        # ── Dashboard-only (FRED/macro) ──
        if dashboard_only:
            lines.append("### 📈 DASHBOARD INDICATORS (not TradingView)")
            lines.append("")
            for r in sorted(dashboard_only, key=lambda x: -x["score"]):
                lines.append(f"- **{r['indicator']}**: {r['setting']} (importance: {r['score']:.4f})")
            lines.append("")

        # ── Unmapped features ──
        if unmapped:
            lines.append("### ⚙️ OTHER IMPORTANT FEATURES (no direct TV indicator)")
            lines.append("")
            for feat, score in sorted(unmapped, key=lambda x: -x[1])[:15]:
                lines.append(f"- `{feat}`: importance {score:.4f}")
            lines.append("")

    # ── Summary: recommended TV layout ──
    lines.append("---")
    lines.append("## RECOMMENDED TRADINGVIEW LAYOUT")
    lines.append("")
    lines.append("Based on feature importance rankings above:")
    lines.append("")
    lines.append("### Main Chart (MES)")
    lines.append("- **15m**: Entry timing — Squeeze Momentum + MACD + Volume")
    lines.append("- **1h**: Directional bias — EMA(8)/EMA(24) + WVF + ADX if ranked")
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
    lines.append("")
    lines.append("*Exact indicator settings and parameters should be validated")
    lines.append("against the dataset builder source code for precise values.*")

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(lines))
    print(f"\n  TradingView Setup Guide: {report_path}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
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
        print("  source .venv-autogluon/bin/activate")
        print("  pip install 'autogluon.tabular>=1.5'")
        sys.exit(1)

    # ── Clean old folds ──
    for h in HORIZONS:
        for i in range(N_FOLDS):
            fold_dir = MODEL_DIR / h / f"fold_{i}"
            if fold_dir.exists():
                shutil.rmtree(fold_dir)
                print(f"  [clean] Removed {fold_dir.relative_to(ROOT)}")
    print()

    # ── Load dataset ──
    if not DATASET.exists():
        print(f"ERROR: {DATASET} not found. Run: npx tsx scripts/build-lean-dataset.ts")
        sys.exit(1)

    print(f"Loading: {DATASET.name}")
    df = pd.read_csv(DATASET)
    df = df.sort_values("timestamp").reset_index(drop=True)
    print(f"  Rows: {len(df):,}  Columns: {len(df.columns)}")

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

    print(f"\n  Features: {len(feature_cols)}")
    print(f"  Horizons: {list(HORIZONS.keys())}")
    print(f"  Folds: {N_FOLDS}  |  Time/fold: {TIME_LIMIT}s  |  Presets: {PRESETS}")
    print(f"  Bagging: {NUM_BAG_FOLDS}  |  Stack: {NUM_STACK_LEVELS}  |  Metric: {EVAL_METRIC}")
    print(f"  Excluded: {EXCLUDED}")
    est_hrs = TIME_LIMIT * N_FOLDS * len(HORIZONS) / 3600
    print(f"  Est. total: {est_hrs:.1f} hours")
    print()

    # ── OOF storage ──
    oof_df = df[["timestamp"]].copy()
    results = {}
    importance_by_horizon = {}

    # ══════════════════════════════════════════════════════════════════════════
    #  TRAINING LOOP — per horizon, per fold
    # ══════════════════════════════════════════════════════════════════════════

    for h_name, h_cfg in HORIZONS.items():
        target_col = h_cfg["target"]
        purge = h_cfg["purge"]
        embargo = h_cfg["embargo"]

        print(f"\n{'='*60}")
        print(f"HORIZON: {h_name}  target={target_col}  purge={purge}  embargo={embargo}")
        print(f"{'='*60}")

        # FIX: per-horizon dropna (not global across all targets)
        h_df = df.dropna(subset=[target_col]).reset_index(drop=True)
        print(f"  Rows with valid {target_col}: {len(h_df):,}")

        splits = walk_forward_splits(len(h_df), N_FOLDS, purge, embargo)
        print(f"  Walk-forward folds: {len(splits)}")

        oof_preds = pd.Series(np.nan, index=h_df.index, dtype=float)
        fold_importances = []

        for fold_i, (train_idx, val_idx) in enumerate(splits):
            print(f"\n  ── Fold {fold_i + 1}/{len(splits)} ──")
            print(f"  Train: {len(train_idx):,}  |  Val: {len(val_idx):,}")

            train_data = h_df.iloc[train_idx][feature_cols + [target_col]].dropna(subset=[target_col])
            val_data = h_df.iloc[val_idx][feature_cols + [target_col]].dropna(subset=[target_col])

            if len(train_data) < 100 or len(val_data) < 10:
                print(f"    SKIP: insufficient data")
                continue

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
                train_data=train_data,
                time_limit=TIME_LIMIT,
                presets=PRESETS,
                num_gpus=0,
                excluded_model_types=EXCLUDED,
                num_bag_folds=NUM_BAG_FOLDS,
                num_stack_levels=NUM_STACK_LEVELS,
                dynamic_stacking=False,
                ag_args_fit={
                    "num_early_stopping_rounds": 30,
                    "ag.max_memory_usage_ratio": 1.5,
                },
                ag_args_ensemble={
                    "fold_fitting_strategy": "sequential_local",
                },
            )

            # Leaderboard
            lb = predictor.leaderboard(val_data, silent=True)
            print(f"\n    Leaderboard (top 5):")
            print(lb.head(5).to_string())

            # Predictions — extract P(class=1) carefully
            preds_proba = predictor.predict_proba(val_data[feature_cols])
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
                base = val_data[target_col].mean()
                pred_mean = preds_np.mean()
                print(f"    base_rate={base:.4f}, pred_mean={pred_mean:.4f}")
                if abs(pred_mean - (1 - base)) < abs(pred_mean - base):
                    print(f"    ⚠️ POSSIBLE PROBABILITY INVERSION!")

            oof_preds.loc[val_data.index] = preds_np

            # Fold metrics
            actuals = val_data[target_col].values
            fold_auc = roc_auc_score(actuals, preds_np)
            fold_acc = accuracy_score(actuals, (preds_np >= 0.5).astype(int))
            fold_ic, _ = spearmanr(actuals, preds_np)
            print(f"\n    AUC: {fold_auc:.4f}  Acc: {fold_acc:.4f}  IC: {fold_ic:.4f}")

            # Feature importance (permutation-based)
            try:
                imp = predictor.feature_importance(val_data, silent=True)
                fold_importances.append(imp)
                top10 = imp.head(10)
                print(f"    Top 10 features:")
                for feat, row in top10.iterrows():
                    tv = FEATURE_TV_MAP.get(feat, {}).get("indicator", "")
                    tag = f" → {tv}" if tv else ""
                    print(f"      {feat:<35} {row['importance']:.4f}{tag}")
            except Exception as e:
                print(f"    Feature importance failed: {e}")

        # ── Aggregate OOF for this horizon ────────────────────────────────────

        mask = oof_preds.notna()
        oof_actual = h_df.loc[mask, target_col].values
        oof_pred = oof_preds[mask].values

        if len(oof_actual) == 0:
            print(f"\n  WARNING: No OOF predictions for {h_name}")
            continue

        auc = roc_auc_score(oof_actual, oof_pred)
        acc = accuracy_score(oof_actual, (oof_pred >= 0.5).astype(int))
        ic, ic_p = spearmanr(oof_actual, oof_pred)

        # High-confidence accuracy (p > 0.55 or p < 0.45)
        hc_mask = (oof_pred >= 0.55) | (oof_pred <= 0.45)
        hc_acc = accuracy_score(
            oof_actual[hc_mask], (oof_pred[hc_mask] >= 0.5).astype(int)
        ) if hc_mask.sum() > 0 else 0
        hc_n = int(hc_mask.sum())
        hc_pct = hc_n / len(oof_actual) * 100

        results[h_name] = {
            "AUC": auc, "Acc": acc, "HC_Acc": hc_acc, "HC_n": hc_n,
            "HC_pct": hc_pct, "IC": ic, "IC_pval": ic_p, "n": len(oof_actual),
        }

        print(f"\n  ═══ OOF RESULTS: {h_name} ═══")
        print(f"    AUC:       {auc:.4f}  {'◀ SIGNAL' if auc > 0.52 else '◀ below threshold'}")
        print(f"    Accuracy:  {acc:.4f}  ({acc*100:.1f}%)")
        print(f"    HC Acc:    {hc_acc:.4f}  ({hc_acc*100:.1f}% on {hc_n:,} rows = {hc_pct:.0f}% of data)")
        print(f"    IC:        {ic:.4f}  (p={ic_p:.2e})")
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

        # Store OOF — merge back to original df via timestamp join
        oof_col = f"oof_{h_name}"
        actual_col = f"actual_{h_name}"
        h_oof = pd.DataFrame({
            "timestamp": h_df.loc[mask, "timestamp"].values,
            oof_col: oof_pred,
            actual_col: oof_actual,
        })
        oof_df = oof_df.drop(columns=[oof_col, actual_col], errors="ignore")
        oof_df = oof_df.merge(h_oof, on="timestamp", how="left")

    # ══════════════════════════════════════════════════════════════════════════
    #  SAVE & REPORT
    # ══════════════════════════════════════════════════════════════════════════

    # Save OOF predictions
    OOF_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    oof_df.to_csv(OOF_OUTPUT, index=False)
    print(f"\nOOF saved: {OOF_OUTPUT}")

    # Generate TradingView setup guide
    if importance_by_horizon:
        report_path = REPORT_DIR / "feature_importance.md"
        generate_tv_report(importance_by_horizon, report_path)

    # ── Final Summary ─────────────────────────────────────────────────────────

    print(f"\n{'='*70}")
    print(f"  FINAL SUMMARY — MES 1h/4h Directional Classifier (Production)")
    print(f"{'='*70}")
    print(f"  Dataset:  {DATASET.name} ({len(df):,} rows × {len(df.columns)} cols)")
    print(f"  Features: {len(feature_cols)}")
    print(f"  Config:   {PRESETS} | {N_FOLDS} folds | {TIME_LIMIT}s/fold")
    print(f"  Models:   GBM + CAT + XGB + XT → WeightedEnsemble")
    print(f"  Bagging:  {NUM_BAG_FOLDS}-fold | Stack: {NUM_STACK_LEVELS} level")
    print()

    if results:
        print(f"  {'Horizon':<8} {'AUC':>7} {'Acc':>7} {'HC_Acc':>7} {'HC_n':>7} {'HC%':>5} {'IC':>7} {'n':>8}")
        print(f"  {'-'*60}")
        for h, r in results.items():
            sig = " ◀ SIGNAL" if r["AUC"] > 0.52 else ""
            print(f"  {h:<8} {r['AUC']:>7.4f} {r['Acc']:>7.4f} {r['HC_Acc']:>7.4f} "
                  f"{r['HC_n']:>7,} {r['HC_pct']:>4.0f}% {r['IC']:>7.4f} {r['n']:>8,}{sig}")

    print()
    print(f"  Outputs:")
    print(f"    Models:   {MODEL_DIR}")
    print(f"    OOF:      {OOF_OUTPUT}")
    print(f"    Report:   {REPORT_DIR / 'feature_importance.md'}")
    print(f"    Log:      {log_path}")

    # ── Interpretation Guide ──
    print()
    print(f"  ┌─────────────────────────────────────────────────────┐")
    print(f"  │  INTERPRETING RESULTS                               │")
    print(f"  │                                                     │")
    print(f"  │  AUC > 0.52:  Meaningful signal for financial data  │")
    print(f"  │  AUC > 0.55:  Strong — publishable in research     │")
    print(f"  │  AUC > 0.58:  Exceptional — double-check leakage   │")
    print(f"  │                                                     │")
    print(f"  │  HC_Acc:  Accuracy on high-confidence predictions   │")
    print(f"  │           (p > 0.55 or p < 0.45 only)              │")
    print(f"  │           THIS is your trading signal filter.       │")
    print(f"  │           Only take trades when model is confident. │")
    print(f"  │                                                     │")
    print(f"  │  IC:  Spearman rank correlation with actual returns │")
    print(f"  │       > 0.03 is meaningful for hourly financial     │")
    print(f"  │                                                     │")
    print(f"  │  Next: Open models/reports/feature_importance.md    │")
    print(f"  │        for your TradingView setup recommendations.  │")
    print(f"  └─────────────────────────────────────────────────────┘")

    log_file.close()
    sys.stdout = sys.__stdout__
    sys.stderr = sys.__stderr__


if __name__ == "__main__":
    main()
