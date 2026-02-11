# MES HFT Halsey Module

Standalone intraday MES measured-move scanner using only:
- Databento (`GLBX.MDP3`) for OHLCV
- FRED (`VIXCLS`) for VIX regime filter
- Yahoo Finance (`MES=F`/`ES=F`) for daily validation

No Polygon dependency is used.

## Files

- `mes_hft_halsey/mes_intraday_halsey.py`: CLI scanner + CSV exporter
- `mes_hft_halsey/mes_api.py`: optional FastAPI wrapper
- `mes_hft_halsey/requirements.txt`: Python dependencies

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r mes_hft_halsey/requirements.txt
```

Required env vars:
- `DATABENTO_API_KEY`
- `FRED_API_KEY`
- `ANTHROPIC_API_KEY` (for `model=opus`)
- `OPENAI_API_KEY` (for `model=gpt`)

The repo `.env.example` already includes these keys.

## Run Scanner

```bash
python mes_hft_halsey/mes_intraday_halsey.py \
  --days-back 90 \
  --swing-order 5 \
  --min-rr 2.0 \
  --csv mes_hft_halsey/mes_halsey_signals.csv
```

Optional flags:
- `--require-volume-confirmation`
- `--last-n 5`

## Run API

```bash
uvicorn mes_hft_halsey.mes_api:app --reload --port 8000
```

Endpoints:
- `GET /health`
- `GET /mes/signals?timeframe=15m`
- `GET /mes/forecast?model=opus`
- `GET /mes/full`
- `GET /mes_signals?timeframe=15m` (compat alias)
- `GET /mes_forecast?model=gpt` (compat alias)

## Enhanced Forecast Output

`/mes/forecast` and `/mes_forecast` now include:
- `forecasts`: formatted horizon return strings
- `forecast_numeric_pct`: numeric horizon return values
- `sharpe`: annualized Sharpe from MES daily returns
- `correlations`: feature-to-return correlations (`vix`, `fed_rates`, `usd_fx`, `china`)
- `shap_proxy`: linear coefficient proxy by feature
- `nn_new_corr_example` + `nn_mse`: simple MLP stub diagnostics
- `mm_adjust_1d_4h_points`: measured-move adjustment folded into the forecast
- `features_last_row`: latest feature snapshot used by the model
- `llm_metadata`: provider/model/fallback diagnostics
- `baseline_quant`: numeric baseline used when LLM mode is active

Model query values:
- `model=opus`: Anthropic Claude Opus path
- `model=gpt`: OpenAI GPT path (`responses` API)
- `model=quant`: skip LLM, numeric baseline only

## Signal Rules

Implemented from the Halsey-style framing requested:
- Bullish setup: `A(low) -> B(high) -> C(low)` retrace in `50%-61.8%`
- Bearish setup: `A(high) -> B(low) -> C(high)` retrace in `50%-61.8%`
- Targets: `100%` and `123.6%` measured-move projections
- Risk filter: `R:R >= 1:2`
- VIX filters:
  - Longs filtered when `VIX > 18`
  - Shorts filtered when `VIX < 16`

Signals are emitted for `5m`, `15m`, `1h`, `4h`, and `1d` bars.
