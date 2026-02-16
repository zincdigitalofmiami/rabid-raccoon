"""
model_report_utils.py

Reusable reporting helpers for trained models:
- metrics JSON
- diagnostic charts
- pyfolio tear sheets
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import statsmodels.api as sm
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    precision_recall_curve,
    r2_score,
    roc_auc_score,
    roc_curve,
)


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _to_utc_index(timestamps: pd.Series | np.ndarray | list[Any]) -> pd.DatetimeIndex:
    ts = pd.to_datetime(pd.Series(timestamps), utc=True, errors="coerce")
    ts = ts.dropna()
    return pd.DatetimeIndex(ts)


def _save_json(path: Path, payload: dict[str, Any]) -> None:
    _ensure_dir(path.parent)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _safe_close_fig(fig: plt.Figure | None) -> None:
    if fig is not None:
        plt.close(fig)


def _strategy_returns(
    index: pd.DatetimeIndex,
    actual: np.ndarray,
    signal: np.ndarray,
) -> tuple[pd.Series, pd.Series]:
    strategy = pd.Series(signal * actual, index=index).sort_index()
    benchmark = pd.Series(actual, index=index).sort_index()
    return strategy, benchmark


def _daily_aggregate(series: pd.Series) -> pd.Series:
    if series.empty:
        return series
    return series.resample("1D").sum().dropna()


def _write_pyfolio_artifacts(
    strategy_returns: pd.Series,
    benchmark_returns: pd.Series,
    out_dir: Path,
    prefix: str,
) -> dict[str, Any]:
    artifacts: dict[str, Any] = {"enabled": False}

    try:
        import pyfolio as pf
    except Exception as exc:  # pragma: no cover
        artifacts["error"] = f"pyfolio import failed: {exc}"
        return artifacts

    daily_strategy = _daily_aggregate(strategy_returns)
    daily_benchmark = _daily_aggregate(benchmark_returns)

    if len(daily_strategy) < 20:
        artifacts["error"] = "insufficient daily returns for pyfolio tear sheet"
        return artifacts

    perf_stats = pf.timeseries.perf_stats(daily_strategy)
    perf_stats_path = out_dir / f"{prefix}_pyfolio_perf_stats.csv"
    perf_stats.to_csv(perf_stats_path, header=["value"])

    fig = None
    try:
        fig = pf.create_returns_tear_sheet(
            daily_strategy,
            benchmark_rets=daily_benchmark if not daily_benchmark.empty else None,
            return_fig=True,
        )
        tear_sheet_path = out_dir / f"{prefix}_pyfolio_tear_sheet.png"
        fig.savefig(tear_sheet_path, dpi=160, bbox_inches="tight")
    finally:
        _safe_close_fig(fig)

    artifacts.update(
        {
            "enabled": True,
            "daily_samples": int(len(daily_strategy)),
            "perf_stats_csv": str(perf_stats_path),
            "tear_sheet_png": str(out_dir / f"{prefix}_pyfolio_tear_sheet.png"),
        }
    )
    return artifacts


def generate_regression_report(
    model_name: str,
    timestamps: pd.Series | np.ndarray | list[Any],
    actual: np.ndarray,
    predicted: np.ndarray,
    out_dir: Path,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _ensure_dir(out_dir)

    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    mask = np.isfinite(actual) & np.isfinite(predicted)
    actual = actual[mask]
    predicted = predicted[mask]
    idx = _to_utc_index(pd.Series(timestamps)[mask])

    if len(actual) == 0 or len(idx) == 0:
        summary = {"model_name": model_name, "error": "no valid samples", "n": 0}
        _save_json(out_dir / "summary.json", summary)
        return summary

    n = min(len(actual), len(predicted), len(idx))
    actual = actual[:n]
    predicted = predicted[:n]
    idx = idx[:n]
    residuals = actual - predicted

    mae = float(np.mean(np.abs(residuals)))
    rmse = float(np.sqrt(np.mean(np.square(residuals))))
    if n > 1:
        try:
            r2 = float(r2_score(actual, predicted))
        except Exception:
            r2 = 0.0
        corr = float(np.corrcoef(actual, predicted)[0, 1])
        if not np.isfinite(corr):
            corr = 0.0
    else:
        r2 = 0.0
        corr = 0.0

    residual_skew = float(stats.skew(residuals, bias=False)) if n > 2 else 0.0
    residual_kurtosis = float(stats.kurtosis(residuals, bias=False)) if n > 3 else 0.0
    if not np.isfinite(residual_skew):
        residual_skew = 0.0
    if not np.isfinite(residual_kurtosis):
        residual_kurtosis = 0.0

    summary: dict[str, Any] = {
        "model_name": model_name,
        "n": int(n),
        "mae": mae,
        "rmse": rmse,
        "r2": r2,
        "corr": corr,
        "residual_mean": float(np.mean(residuals)),
        "residual_std": float(np.std(residuals)),
        "residual_skew": residual_skew,
        "residual_kurtosis": residual_kurtosis,
    }
    if metadata:
        summary["metadata"] = metadata

    # Save aligned samples
    rows = pd.DataFrame(
        {
            "timestamp": idx,
            "actual": actual,
            "predicted": predicted,
            "residual": residuals,
        }
    ).set_index("timestamp")
    rows.to_csv(out_dir / "aligned_predictions.csv")

    # Time-series actual vs predicted
    fig, ax = plt.subplots(figsize=(12, 5))
    rows["actual"].plot(ax=ax, lw=1.0, alpha=0.85, label="actual")
    rows["predicted"].plot(ax=ax, lw=1.0, alpha=0.85, label="predicted")
    ax.set_title(f"{model_name} - Actual vs Predicted")
    ax.set_ylabel("target")
    ax.grid(alpha=0.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_dir / "actual_vs_predicted.png", dpi=160)
    _safe_close_fig(fig)

    # Scatter
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.scatter(actual, predicted, s=10, alpha=0.3)
    mn = min(np.min(actual), np.min(predicted))
    mx = max(np.max(actual), np.max(predicted))
    ax.plot([mn, mx], [mn, mx], "--", lw=1)
    ax.set_xlabel("actual")
    ax.set_ylabel("predicted")
    ax.set_title(f"{model_name} - Scatter")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_dir / "scatter_actual_predicted.png", dpi=160)
    _safe_close_fig(fig)

    # Residual distribution
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.hist(residuals, bins=60, alpha=0.75, density=True)
    mu, sigma = np.mean(residuals), np.std(residuals)
    x = np.linspace(np.min(residuals), np.max(residuals), 200)
    if sigma > 0:
        ax.plot(x, stats.norm.pdf(x, mu, sigma), lw=1.2)
    ax.set_title(f"{model_name} - Residual Distribution")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_dir / "residual_distribution.png", dpi=160)
    _safe_close_fig(fig)

    # QQ
    fig = plt.figure(figsize=(6, 6))
    sm.qqplot(residuals, line="45", fit=True, ax=fig.add_subplot(111))
    plt.title(f"{model_name} - Residual QQ")
    plt.tight_layout()
    fig.savefig(out_dir / "residual_qq.png", dpi=160)
    _safe_close_fig(fig)

    # Rolling MAE
    rolling_mae = rows["residual"].abs().rolling(128, min_periods=16).mean()
    fig, ax = plt.subplots(figsize=(12, 4))
    rolling_mae.plot(ax=ax, lw=1.0)
    ax.set_title(f"{model_name} - Rolling MAE")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_dir / "rolling_mae.png", dpi=160)
    _safe_close_fig(fig)

    # Strategy returns
    signal = np.sign(predicted)
    strategy, benchmark = _strategy_returns(idx, actual, signal)
    strategy.name = "strategy_return"
    benchmark.name = "benchmark_return"
    strategy.to_csv(out_dir / "strategy_returns.csv", header=True)
    benchmark.to_csv(out_dir / "benchmark_returns.csv", header=True)

    cum = (1 + strategy).cumprod()
    cum_b = (1 + benchmark).cumprod()
    fig, ax = plt.subplots(figsize=(12, 4))
    cum.plot(ax=ax, lw=1.0, label="strategy")
    cum_b.plot(ax=ax, lw=1.0, label="benchmark", alpha=0.8)
    ax.set_title(f"{model_name} - Cumulative Returns")
    ax.grid(alpha=0.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_dir / "cumulative_returns.png", dpi=160)
    _safe_close_fig(fig)

    summary["pyfolio"] = _write_pyfolio_artifacts(strategy, benchmark, out_dir, "regression")
    _save_json(out_dir / "summary.json", summary)
    return summary


def generate_classification_report(
    model_name: str,
    timestamps: pd.Series | np.ndarray | list[Any],
    y_true: np.ndarray,
    y_prob: np.ndarray,
    expected_payoff: np.ndarray,
    out_dir: Path,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _ensure_dir(out_dir)

    y_true = np.asarray(y_true, dtype=float)
    y_prob = np.asarray(y_prob, dtype=float)
    payoff = np.asarray(expected_payoff, dtype=float)
    mask = np.isfinite(y_true) & np.isfinite(y_prob) & np.isfinite(payoff)
    y_true = y_true[mask].astype(int)
    y_prob = y_prob[mask]
    payoff = payoff[mask]
    idx = _to_utc_index(pd.Series(timestamps)[mask])

    if len(y_true) == 0 or len(idx) == 0:
        summary = {"model_name": model_name, "error": "no valid samples", "n": 0}
        _save_json(out_dir / "summary.json", summary)
        return summary

    n = min(len(y_true), len(y_prob), len(payoff), len(idx))
    y_true = y_true[:n]
    y_prob = y_prob[:n]
    payoff = payoff[:n]
    idx = idx[:n]

    y_pred = (y_prob >= 0.5).astype(int)
    accuracy = float(np.mean(y_pred == y_true))
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    precision = float(tp / (tp + fp)) if (tp + fp) > 0 else 0.0
    recall = float(tp / (tp + fn)) if (tp + fn) > 0 else 0.0

    has_both_classes = np.unique(y_true).size > 1
    if has_both_classes:
        fpr, tpr, _ = roc_curve(y_true, y_prob)
        roc_auc = float(roc_auc_score(y_true, y_prob))
    else:
        fpr = np.array([0.0, 1.0])
        tpr = np.array([0.0, 1.0])
        roc_auc = 0.5

    precision_curve, recall_curve, _ = precision_recall_curve(y_true, y_prob)
    if np.any(y_true == 1):
        pr_auc = float(average_precision_score(y_true, y_prob))
    else:
        pr_auc = 0.0

    summary: dict[str, Any] = {
        "model_name": model_name,
        "n": int(n),
        "positive_rate": float(np.mean(y_true)),
        "accuracy_0_5": accuracy,
        "precision_0_5": precision,
        "recall_0_5": recall,
        "roc_auc": roc_auc,
        "pr_auc": pr_auc,
        "confusion_matrix_0_5": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }
    if metadata:
        summary["metadata"] = metadata

    rows = pd.DataFrame(
        {
            "timestamp": idx,
            "y_true": y_true,
            "y_prob": y_prob,
            "expected_payoff": payoff,
            "signal_0_5": y_pred,
        }
    ).set_index("timestamp")
    rows.to_csv(out_dir / "aligned_predictions.csv")

    # ROC
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.plot(fpr, tpr, lw=1.4, label=f"AUC={summary['roc_auc']:.3f}")
    ax.plot([0, 1], [0, 1], "--", lw=1)
    ax.set_title(f"{model_name} - ROC")
    ax.set_xlabel("FPR")
    ax.set_ylabel("TPR")
    ax.legend()
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_dir / "roc_curve.png", dpi=160)
    _safe_close_fig(fig)

    # PR
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.plot(recall_curve, precision_curve, lw=1.4, label=f"AUC={summary['pr_auc']:.3f}")
    ax.set_title(f"{model_name} - Precision/Recall")
    ax.set_xlabel("Recall")
    ax.set_ylabel("Precision")
    ax.legend()
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_dir / "precision_recall_curve.png", dpi=160)
    _safe_close_fig(fig)

    # Probability distribution by class
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.hist(y_prob[y_true == 0], bins=40, alpha=0.6, label="class 0")
    ax.hist(y_prob[y_true == 1], bins=40, alpha=0.6, label="class 1")
    ax.set_title(f"{model_name} - Probability Distribution")
    ax.set_xlabel("predicted probability")
    ax.legend()
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_dir / "probability_distribution.png", dpi=160)
    _safe_close_fig(fig)

    # Calibration
    bins = np.linspace(0, 1, 11)
    bin_ids = np.clip(np.digitize(y_prob, bins, right=True) - 1, 0, 9)
    cal_x, cal_y = [], []
    for b in range(10):
        m = bin_ids == b
        if not np.any(m):
            continue
        cal_x.append(float(np.mean(y_prob[m])))
        cal_y.append(float(np.mean(y_true[m])))
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.plot([0, 1], [0, 1], "--", lw=1)
    if cal_x:
        ax.plot(cal_x, cal_y, marker="o", lw=1.2)
    ax.set_title(f"{model_name} - Calibration")
    ax.set_xlabel("predicted")
    ax.set_ylabel("observed")
    ax.grid(alpha=0.25)
    fig.tight_layout()
    fig.savefig(out_dir / "calibration_curve.png", dpi=160)
    _safe_close_fig(fig)

    # Strategy returns based on classification probability
    strategy_signal = (y_prob >= 0.5).astype(float)
    strategy, benchmark = _strategy_returns(idx, payoff, strategy_signal)
    strategy.name = "strategy_return"
    benchmark.name = "benchmark_return"
    strategy.to_csv(out_dir / "strategy_returns.csv", header=True)
    benchmark.to_csv(out_dir / "benchmark_returns.csv", header=True)

    cum = (1 + strategy).cumprod()
    cum_b = (1 + benchmark).cumprod()
    fig, ax = plt.subplots(figsize=(12, 4))
    cum.plot(ax=ax, lw=1.0, label="strategy")
    cum_b.plot(ax=ax, lw=1.0, alpha=0.85, label="always-trade baseline")
    ax.set_title(f"{model_name} - Cumulative Event Returns")
    ax.grid(alpha=0.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_dir / "cumulative_returns.png", dpi=160)
    _safe_close_fig(fig)

    summary["pyfolio"] = _write_pyfolio_artifacts(strategy, benchmark, out_dir, "classification")
    _save_json(out_dir / "summary.json", summary)
    return summary
