#!/usr/bin/env python3
"""
WARBIRD MES Trainer (AGENTS-compliant)

Purpose:
  - Train MES-only regression models for 3-4 horizons (15m, 1h, 4h, 1d)
  - For each horizon, train 3 targets: price return, MAE, MFE
  - Preserve strict time ordering via walk-forward CV + purge/embargo
  - Use AutoGluon best-quality settings with 5 bag folds
  - Emit horizon/model metrics + overall summary

Outputs:
  models/warbird/{horizon}/{target}/fold_{k}/
  models/warbird/{horizon}/{target}/oof_predictions.csv
  models/reports/warbird_training_summary.json

Notes:
  - This script uses the full dataset rows (no row subsampling).
  - Feature pruning is per AGENTS hard rules: IC ranking + cluster dedup + top-N.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pickle
import random
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform
from scipy.stats import norm, spearmanr
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score, roc_auc_score


# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent

# Horizons depend on dataset timeframe:
# 1h dataset: 1h=1, 4h=4, 1d=24 bars
# 15m dataset: 15m=1, 1h=4, 4h=16, 1d=96 bars
HORIZONS_1H: dict[str, int] = {
    "1h": 1,
    "4h": 4,
    "1d": 24,
}

HORIZONS_15M: dict[str, int] = {
    "15m": 1,
    "1h": 4,
    "4h": 16,
    "1d": 96,
}

# Default — selected by --timeframe arg
HORIZONS: dict[str, int] = HORIZONS_1H

TARGET_TYPES = ("price", "mae", "mfe")

DEFAULT_DATASET = ROOT / "datasets" / "autogluon" / "mes_lean_fred_indexes_2020plus.csv"
DEFAULT_OUTPUT_ROOT = ROOT / "models" / "warbird"
DEFAULT_SUMMARY = ROOT / "models" / "reports" / "warbird_training_summary.json"


@dataclass
class AgConfig:
    presets: str = "best_quality"
    num_bag_folds: int = 5
    num_stack_levels: int = 2
    dynamic_stacking: str = "auto"
    excluded_model_types: list[str] | None = None
    early_stopping_rounds: int = 50
    max_memory_ratio: float = 0.8
    fold_fitting_strategy: str = "sequential_local"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train WARBIRD MES regression models")
    p.add_argument("--dataset", default=str(DEFAULT_DATASET))
    p.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT))
    p.add_argument("--summary-out", default=str(DEFAULT_SUMMARY))
    p.add_argument("--n-folds", type=int, default=5)
    p.add_argument("--feature-top-n", type=int, default=30)
    p.add_argument("--feature-corr-threshold", type=float, default=0.85)
    p.add_argument("--feature-max-lookback", type=int, default=24)
    p.add_argument("--price-time-limit", type=int, default=14_400)
    p.add_argument("--risk-time-limit", type=int, default=7_200)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--num-cpus", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    p.add_argument("--mc-paths", type=int, default=10_000)
    p.add_argument("--preflight-only", action="store_true")
    p.add_argument("--skip-shap", action="store_true")
    p.add_argument("--timeframe", choices=["1h", "15m"], default="1h",
                   help="Dataset timeframe — determines horizon bars (default: 1h)")
    p.add_argument("--clean", action="store_true")
    p.add_argument(
        "--model-determined-folds",
        action="store_true",
        help=(
            "Request model-determined folds. For leakage-safe tabular time-series, "
            "script still uses walk-forward folds as robust default."
        ),
    )
    return p.parse_args()


def set_seed(seed: int) -> None:
    np.random.seed(seed)
    random.seed(seed)
    os.environ["PYTHONHASHSEED"] = str(seed)


def ds_hash(df: pd.DataFrame) -> str:
    return __import__("hashlib").sha256(df.to_csv(index=False).encode()).hexdigest()[:16]


def compute_purge_embargo(horizon_bars: int, feature_max_lookback: int) -> tuple[int, int]:
    label_overlap = max(1, horizon_bars - 1)
    purge = label_overlap + feature_max_lookback
    embargo = purge * 2
    return purge, embargo


def walk_forward_splits(n: int, n_folds: int, purge: int, embargo: int) -> list[tuple[list[int], list[int]]]:
    fold_size = n // (n_folds + 1)
    splits: list[tuple[list[int], list[int]]] = []
    for fold in range(n_folds):
        split = fold_size * (fold + 1)
        val_start = split + purge + embargo
        val_end = fold_size * (fold + 2) if fold < n_folds - 1 else n
        if val_start >= val_end or val_start >= n:
            continue
        tr = list(range(0, split))
        va = list(range(val_start, val_end))
        splits.append((tr, va))
    return splits


def derive_targets(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    close = out["target"].astype(float).to_numpy()
    n = len(close)

    for h_name, h_bars in HORIZONS.items():
        ret = np.full(n, np.nan, dtype=float)
        mae = np.full(n, np.nan, dtype=float)
        mfe = np.full(n, np.nan, dtype=float)

        limit = n - h_bars
        for i in range(limit):
            c0 = close[i]
            if not np.isfinite(c0) or c0 == 0:
                continue
            future = close[i + 1 : i + h_bars + 1]
            if future.size == 0 or not np.all(np.isfinite(future)):
                continue
            ret[i] = (close[i + h_bars] - c0) / c0
            mae[i] = (float(np.min(future)) - c0) / c0
            mfe[i] = (float(np.max(future)) - c0) / c0

        out[f"target_price_{h_name}"] = ret
        out[f"target_mae_{h_name}"] = mae
        out[f"target_mfe_{h_name}"] = mfe

    return out


def pinball_loss(y_true: np.ndarray, y_pred_q: np.ndarray, q: float) -> float:
    err = y_true - y_pred_q
    return float(np.mean(np.maximum(q * err, (q - 1.0) * err)))


def rank_features_by_ic(train_df: pd.DataFrame, feature_cols: list[str], target_col: str, top_n: int) -> list[str]:
    ranked: list[tuple[str, float]] = []
    for col in feature_cols:
        if col not in train_df.columns:
            continue
        s = train_df[[col, target_col]].dropna()
        if len(s) < 100:
            ranked.append((col, 0.0))
            continue
        try:
            ic, _ = spearmanr(s[col], s[target_col])
            ranked.append((col, abs(float(ic)) if np.isfinite(ic) else 0.0))
        except Exception:
            ranked.append((col, 0.0))
    ranked.sort(key=lambda x: -x[1])
    return [c for c, _ in ranked[:top_n]]


def cluster_dedup_features(
    df: pd.DataFrame,
    feature_cols: list[str],
    target_col: str,
    corr_threshold: float,
) -> list[str]:
    numeric = [c for c in feature_cols if pd.api.types.is_numeric_dtype(df[c])]
    if len(numeric) < 2:
        return feature_cols

    ics: dict[str, float] = {}
    for c in numeric:
        s = df[[c, target_col]].dropna()
        if len(s) < 100:
            ics[c] = 0.0
            continue
        ic, _ = spearmanr(s[c], s[target_col])
        ics[c] = abs(float(ic)) if np.isfinite(ic) else 0.0

    corr = df[numeric].corr(method="spearman").abs().fillna(0.0).to_numpy()
    np.fill_diagonal(corr, 1.0)
    dist = np.clip(1.0 - corr, 0.0, 2.0)
    z = linkage(squareform(dist, checks=False), method="average")
    clusters = fcluster(z, t=(1.0 - corr_threshold), criterion="distance")

    selected: set[str] = set()
    for cid in set(clusters):
        members = [numeric[i] for i in range(len(numeric)) if clusters[i] == cid]
        best = max(members, key=lambda c: (ics.get(c, 0.0), -df[c].isna().sum()))
        selected.add(best)

    kept = [c for c in feature_cols if (c in selected) or (c not in numeric)]
    return kept


def fit_garch_sigma(returns: np.ndarray, horizon_bars: int) -> dict[str, Any]:
    clean = np.asarray(returns, dtype=float)
    clean = clean[np.isfinite(clean)]
    if clean.size < 200:
        return {
            "method": "insufficient_data",
            "sigma_1bar": float(np.std(clean)) if clean.size else 0.0,
            "sigma_horizon": float(np.std(clean) * math.sqrt(max(1, horizon_bars))) if clean.size else 0.0,
        }

    try:
        from arch import arch_model  # type: ignore

        am = arch_model(clean * 100.0, mean="Zero", vol="GARCH", p=1, q=1, dist="t")
        res = am.fit(disp="off")
        forecast = res.forecast(horizon=1, reindex=False)
        var1 = float(forecast.variance.values[-1, 0]) / (100.0 * 100.0)
        sigma_1 = math.sqrt(max(var1, 1e-12))
        params = res.params.to_dict()
        return {
            "method": "garch11_t",
            "sigma_1bar": sigma_1,
            "sigma_horizon": sigma_1 * math.sqrt(max(1, horizon_bars)),
            "omega": float(params.get("omega", np.nan)),
            "alpha1": float(params.get("alpha[1]", np.nan)),
            "beta1": float(params.get("beta[1]", np.nan)),
        }
    except Exception:
        # EWMA fallback
        lam = 0.94
        var = float(np.var(clean[-500:]))
        for r in clean[-500:]:
            var = lam * var + (1 - lam) * float(r * r)
        sigma_1 = math.sqrt(max(var, 1e-12))
        return {
            "method": "ewma_proxy",
            "sigma_1bar": sigma_1,
            "sigma_horizon": sigma_1 * math.sqrt(max(1, horizon_bars)),
        }


def monte_carlo_summary(
    current_price: float,
    horizon_bars: int,
    drift_total: float,
    sigma_1bar: float,
    n_paths: int,
    seed: int,
    target_up: float | None,
    target_down: float | None,
) -> dict[str, float | None]:
    rng = np.random.default_rng(seed)
    sigma_1bar = max(float(sigma_1bar), 1e-8)
    mu_step = float(drift_total) / max(1, horizon_bars)

    steps = rng.normal(loc=mu_step, scale=sigma_1bar, size=(n_paths, horizon_bars))
    steps = np.clip(steps, -0.99, None)
    total_ret = np.prod(1.0 + steps, axis=1) - 1.0
    end_prices = current_price * (1.0 + total_ret)

    q10, q50, q90 = np.quantile(end_prices, [0.1, 0.5, 0.9])
    out: dict[str, float | None] = {
        "mc_q10": float(q10),
        "mc_q50": float(q50),
        "mc_q90": float(q90),
        "mc_prob_up": float(np.mean(end_prices > current_price)),
    }
    if target_up is not None:
        out["mc_prob_hit_upper_zone"] = float(np.mean(end_prices >= target_up))
    else:
        out["mc_prob_hit_upper_zone"] = None
    if target_down is not None:
        out["mc_prob_hit_lower_zone"] = float(np.mean(end_prices <= target_down))
    else:
        out["mc_prob_hit_lower_zone"] = None
    return out


def try_compute_shap(
    predictor: Any,
    feature_cols: list[str],
    train_x: pd.DataFrame,
    val_x: pd.DataFrame,
    seed: int,
) -> dict[str, Any]:
    # Best-effort SHAP. Falls back to feature importance if unavailable.
    try:
        import shap  # type: ignore

        bg = train_x[feature_cols].sample(min(32, len(train_x)), random_state=seed)
        ex = val_x[feature_cols].sample(min(64, len(val_x)), random_state=seed)

        f = lambda x: predictor.predict(pd.DataFrame(x, columns=feature_cols)).to_numpy()  # noqa: E731
        explainer = shap.KernelExplainer(f, bg.to_numpy())
        shap_vals = explainer.shap_values(ex.to_numpy(), nsamples=100)
        shap_arr = np.asarray(shap_vals)
        if shap_arr.ndim == 3:  # unexpected multi-output shape guard
            shap_arr = shap_arr[0]
        abs_mean = np.abs(shap_arr).mean(axis=0)
        pairs = sorted(
            [{"feature": feature_cols[i], "mean_abs_shap": float(abs_mean[i])} for i in range(len(feature_cols))],
            key=lambda r: -r["mean_abs_shap"],
        )
        return {"method": "kernel_shap", "top_features": pairs[:20]}
    except Exception as e:
        try:
            fi = predictor.feature_importance(val_x[feature_cols], silent=True)
            top = [
                {"feature": str(idx), "importance": float(row["importance"])}
                for idx, row in fi.head(20).iterrows()
            ]
            return {"method": "feature_importance_proxy", "reason": str(e), "top_features": top}
        except Exception as inner:
            return {"method": "none", "reason": f"{e} | fallback failed: {inner}", "top_features": []}


def main() -> None:
    args = parse_args()
    set_seed(args.seed)

    # Select horizons based on timeframe
    global HORIZONS
    HORIZONS = HORIZONS_15M if args.timeframe == "15m" else HORIZONS_1H
    print(f"[warbird] Timeframe: {args.timeframe} → horizons: {HORIZONS}")

    dataset_path = Path(args.dataset)
    if not dataset_path.is_absolute():
        dataset_path = (ROOT / dataset_path).resolve()
    out_root = Path(args.output_root)
    if not out_root.is_absolute():
        out_root = (ROOT / out_root).resolve()
    summary_path = Path(args.summary_out)
    if not summary_path.is_absolute():
        summary_path = (ROOT / summary_path).resolve()

    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")

    from autogluon.tabular import TabularPredictor

    print(f"[warbird] Loading dataset: {dataset_path}")
    df = pd.read_csv(dataset_path)
    if "timestamp" not in df.columns or "target" not in df.columns:
        raise RuntimeError("Dataset must include 'timestamp' and 'target' columns")

    df = df.sort_values("timestamp").reset_index(drop=True)
    data_hash = ds_hash(df)
    print(f"[warbird] rows={len(df):,} cols={len(df.columns)} hash={data_hash}")

    if args.model_determined_folds:
        print(
            "[warbird] model-determined folds requested; using leakage-safe walk-forward CV as robust default."
        )

    df = derive_targets(df)

    excluded_cols = {"item_id", "timestamp", "target"}
    feature_cols = [c for c in df.columns if c not in excluded_cols and not c.startswith("target_")]

    print(f"[warbird] feature candidates={len(feature_cols)}")

    ag = AgConfig(excluded_model_types=[])
    if args.clean and out_root.exists():
        shutil.rmtree(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    summary_path.parent.mkdir(parents=True, exist_ok=True)

    if args.preflight_only:
        preflight = {
            "dataset": str(dataset_path),
            "rows": int(len(df)),
            "cols": int(len(df.columns)),
            "feature_count": int(len(feature_cols)),
            "horizons": HORIZONS,
            "targets": list(TARGET_TYPES),
            "hash": data_hash,
            "status": "preflight_ok",
        }
        summary_path.write_text(json.dumps(preflight, indent=2))
        print(f"[warbird] preflight written: {summary_path}")
        return

    summary: dict[str, Any] = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "dataset": str(dataset_path),
        "dataset_hash": data_hash,
        "rows": int(len(df)),
        "cols": int(len(df.columns)),
        "feature_count": int(len(feature_cols)),
        "ag_settings": {
            "presets": ag.presets,
            "num_bag_folds": ag.num_bag_folds,
            "num_stack_levels": ag.num_stack_levels,
            "dynamic_stacking": ag.dynamic_stacking,
            "excluded_model_types": ag.excluded_model_types,
            "ag_args_fit": {
                "num_early_stopping_rounds": ag.early_stopping_rounds,
                "ag.max_memory_usage_ratio": ag.max_memory_ratio,
                "num_cpus": int(args.num_cpus),
            },
            "ag_args_ensemble": {
                "fold_fitting_strategy": ag.fold_fitting_strategy,
            },
        },
        "horizons": {},
    }

    overall_mae: list[float] = []

    for horizon, h_bars in HORIZONS.items():
        purge, embargo = compute_purge_embargo(h_bars, args.feature_max_lookback)
        horizon_block: dict[str, Any] = {
            "horizon_bars": h_bars,
            "purge": purge,
            "embargo": embargo,
            "targets": {},
        }

        # Store oof for zone/probability summary
        oof_by_target: dict[str, pd.DataFrame] = {}

        for target_type in TARGET_TYPES:
            target_col = f"target_{target_type}_{horizon}"
            if target_col not in df.columns:
                horizon_block["targets"][target_type] = {"status": "missing_target_col"}
                continue

            work = df.dropna(subset=[target_col]).reset_index(drop=True)
            splits = walk_forward_splits(len(work), args.n_folds, purge, embargo)
            if not splits:
                horizon_block["targets"][target_type] = {
                    "status": "insufficient_data",
                    "rows": int(len(work)),
                }
                continue

            time_limit = args.price_time_limit if target_type == "price" else args.risk_time_limit
            print(
                f"\n[warbird] {horizon}/{target_type} rows={len(work):,} folds={len(splits)} time_limit={time_limit}s"
            )

            oof_pred = np.full(len(work), np.nan, dtype=float)
            fold_metrics: list[dict[str, Any]] = []
            fold_feature_usage: dict[str, int] = {}
            shap_snapshot: dict[str, Any] | None = None

            for fold_idx, (tr_idx, va_idx) in enumerate(splits):
                train_df = work.iloc[tr_idx][feature_cols + [target_col]].dropna(subset=[target_col])
                val_df = work.iloc[va_idx][feature_cols + [target_col]].dropna(subset=[target_col])
                if len(train_df) < 300 or len(val_df) < 30:
                    continue

                ranked = rank_features_by_ic(
                    train_df, feature_cols, target_col, top_n=max(args.feature_top_n * 4, args.feature_top_n)
                )
                deduped = cluster_dedup_features(
                    train_df,
                    ranked,
                    target_col,
                    corr_threshold=args.feature_corr_threshold,
                )
                selected = deduped[: args.feature_top_n]
                if len(selected) < 5:
                    continue

                for f in selected:
                    fold_feature_usage[f] = fold_feature_usage.get(f, 0) + 1

                fold_dir = out_root / horizon / target_type / f"fold_{fold_idx}"
                fold_dir.mkdir(parents=True, exist_ok=True)

                predictor = TabularPredictor(
                    label=target_col,
                    path=str(fold_dir),
                    problem_type="regression",
                    eval_metric="mean_absolute_error",
                    verbosity=2,
                )

                fit_kwargs = dict(
                    train_data=train_df[selected + [target_col]],
                    presets=ag.presets,
                    num_gpus=0,
                    num_bag_folds=ag.num_bag_folds,
                    num_stack_levels=ag.num_stack_levels,
                    dynamic_stacking=ag.dynamic_stacking,
                    excluded_model_types=ag.excluded_model_types,
                    ag_args_fit={
                        "num_early_stopping_rounds": ag.early_stopping_rounds,
                        "ag.max_memory_usage_ratio": ag.max_memory_ratio,
                        "num_cpus": int(args.num_cpus),
                    },
                    ag_args_ensemble={
                        "fold_fitting_strategy": ag.fold_fitting_strategy,
                    },
                    time_limit=int(time_limit),
                )
                predictor.fit(**fit_kwargs)

                preds = predictor.predict(val_df[selected]).to_numpy(dtype=float)
                actual = val_df[target_col].to_numpy(dtype=float)
                oof_pred[val_df.index.to_numpy()] = preds

                resid_sigma = float(np.std(actual - preds)) if len(actual) > 1 else 0.0
                z10, z90 = norm.ppf(0.1), norm.ppf(0.9)
                q10 = preds + z10 * resid_sigma
                q50 = preds
                q90 = preds + z90 * resid_sigma

                m = {
                    "fold": int(fold_idx),
                    "n_train": int(len(train_df)),
                    "n_val": int(len(val_df)),
                    "n_features": int(len(selected)),
                    "mae": float(mean_absolute_error(actual, preds)),
                    "rmse": float(math.sqrt(mean_squared_error(actual, preds))),
                    "r2": float(r2_score(actual, preds)),
                    "ic": float(spearmanr(actual, preds)[0]) if len(actual) > 1 else float("nan"),
                    "pinball_q10": float(pinball_loss(actual, q10, 0.1)),
                    "pinball_q50": float(pinball_loss(actual, q50, 0.5)),
                    "pinball_q90": float(pinball_loss(actual, q90, 0.9)),
                    "residual_sigma": resid_sigma,
                }
                fold_metrics.append(m)

                if shap_snapshot is None and not args.skip_shap:
                    shap_snapshot = try_compute_shap(
                        predictor,
                        selected,
                        train_df[selected],
                        val_df[selected],
                        seed=args.seed,
                    )

                # Persist fold metadata
                (fold_dir / "fold_meta.json").write_text(
                    json.dumps(
                        {
                            "horizon": horizon,
                            "target_type": target_type,
                            "target_col": target_col,
                            "selected_features": selected,
                            "metrics": m,
                            "purge": purge,
                            "embargo": embargo,
                        },
                        indent=2,
                    )
                )

            mask = np.isfinite(oof_pred)
            if not np.any(mask):
                horizon_block["targets"][target_type] = {
                    "status": "no_oof",
                    "rows": int(len(work)),
                }
                continue

            actual_oof = work.loc[mask, target_col].to_numpy(dtype=float)
            pred_oof = oof_pred[mask]
            resid = actual_oof - pred_oof
            resid_sigma = float(np.std(resid)) if len(resid) > 1 else 0.0

            agg = {
                "status": "ok",
                "rows": int(len(work)),
                "oof_rows": int(mask.sum()),
                "folds_completed": int(len(fold_metrics)),
                "mae": float(mean_absolute_error(actual_oof, pred_oof)),
                "rmse": float(math.sqrt(mean_squared_error(actual_oof, pred_oof))),
                "r2": float(r2_score(actual_oof, pred_oof)),
                "ic": float(spearmanr(actual_oof, pred_oof)[0]) if len(actual_oof) > 1 else float("nan"),
                "pinball_q10": float(pinball_loss(actual_oof, pred_oof + norm.ppf(0.1) * resid_sigma, 0.1)),
                "pinball_q50": float(pinball_loss(actual_oof, pred_oof, 0.5)),
                "pinball_q90": float(pinball_loss(actual_oof, pred_oof + norm.ppf(0.9) * resid_sigma, 0.9)),
                "residual_sigma": resid_sigma,
                "fold_metrics": fold_metrics,
                "feature_stability": {
                    k: float(v / max(1, len(fold_metrics))) for k, v in sorted(fold_feature_usage.items(), key=lambda x: -x[1])[:50]
                },
                "shap": shap_snapshot,
            }

            if target_type == "price":
                # Probability and strategy-style Sharpe from predicted direction.
                scale = max(resid_sigma, 1e-8)
                prob_up = 1.0 / (1.0 + np.exp(-(pred_oof / scale)))
                y_cls = (actual_oof > 0).astype(int)
                if len(np.unique(y_cls)) > 1:
                    agg["auc_prob_up"] = float(roc_auc_score(y_cls, prob_up))
                else:
                    agg["auc_prob_up"] = None
                agg["brier_prob_up"] = float(np.mean((prob_up - y_cls) ** 2))
                strat = np.sign(pred_oof) * actual_oof
                strat_std = float(np.std(strat))
                ann = math.sqrt((252.0 * 24.0) / max(1, h_bars))
                agg["sharpe"] = float((np.mean(strat) / strat_std) * ann) if strat_std > 0 else None

            overall_mae.append(float(agg["mae"]))

            out_df = work.loc[mask, ["timestamp", "target"]].copy()
            out_df.rename(columns={"target": "current_price"}, inplace=True)
            out_df["actual"] = actual_oof
            out_df["pred"] = pred_oof
            out_path = out_root / horizon / target_type / "oof_predictions.csv"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_df.to_csv(out_path, index=False)
            oof_by_target[target_type] = out_df

            # Save simple calibrator for probability conversion of return predictions
            if target_type == "price":
                calib = {
                    "method": "logistic_from_residual_sigma",
                    "sigma": resid_sigma,
                }
                with open(out_root / horizon / target_type / "calibrator.pkl", "wb") as f:
                    pickle.dump(calib, f)

            horizon_block["targets"][target_type] = agg

        # Horizon-level zones + Monte Carlo summary
        if all(k in oof_by_target for k in TARGET_TYPES):
            merged = oof_by_target["price"].merge(
                oof_by_target["mae"][["timestamp", "pred", "actual"]].rename(
                    columns={"pred": "pred_mae", "actual": "actual_mae"}
                ),
                on="timestamp",
                how="inner",
            ).merge(
                oof_by_target["mfe"][["timestamp", "pred", "actual"]].rename(
                    columns={"pred": "pred_mfe", "actual": "actual_mfe"}
                ),
                on="timestamp",
                how="inner",
            )

            merged["upper_zone"] = merged["current_price"] * (1.0 + merged["pred_mfe"])
            merged["lower_zone"] = merged["current_price"] * (1.0 + merged["pred_mae"])
            merged["zone_upper_hit"] = (merged["actual_mfe"] >= merged["pred_mfe"]).astype(int)
            merged["zone_lower_hit"] = (merged["actual_mae"] <= merged["pred_mae"]).astype(int)

            garch = fit_garch_sigma(merged["actual"].to_numpy(dtype=float), h_bars)
            last_price = float(merged["current_price"].iloc[-1])
            drift = float(np.mean(merged["pred"].to_numpy(dtype=float)))
            up = float(last_price * (1.0 + float(np.mean(merged["pred_mfe"]))))
            down = float(last_price * (1.0 + float(np.mean(merged["pred_mae"]))))
            mc = monte_carlo_summary(
                current_price=last_price,
                horizon_bars=h_bars,
                drift_total=drift,
                sigma_1bar=float(garch.get("sigma_1bar", 0.0)),
                n_paths=int(args.mc_paths),
                seed=args.seed,
                target_up=up,
                target_down=down,
            )

            horizon_block["target_zones"] = {
                "rows": int(len(merged)),
                "upper_zone_hit_rate": float(np.mean(merged["zone_upper_hit"])),
                "lower_zone_hit_rate": float(np.mean(merged["zone_lower_hit"])),
                "last_price": last_price,
                "projected_upper_zone": up,
                "projected_lower_zone": down,
                "garch": garch,
                "monte_carlo": mc,
            }

        summary["horizons"][horizon] = horizon_block

    summary["overall"] = {
        "horizons_completed": int(len(summary["horizons"])),
        "mean_model_mae": float(np.mean(overall_mae)) if overall_mae else None,
        "notes": [
            "MES-only targets trained across 4 horizons in one run.",
            "Cross-validation uses strict walk-forward time splits with purge/embargo.",
            "AutoGluon bagging fixed at 5 per AGENTS hard rules.",
        ],
    }

    summary_path.write_text(json.dumps(summary, indent=2))
    print(f"\n[warbird] summary written: {summary_path}")


if __name__ == "__main__":
    main()

