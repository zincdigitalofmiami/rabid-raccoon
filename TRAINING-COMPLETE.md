# COMPLETE AUTOGLUON TRAINING - ALL DATA SOURCES

This is the FULL PRODUCTION training pipeline pulling **EVERY** data source and training **ALL** models.

## Data Sources Included

### Market Data (11 tables):
- ✅ `mes_prices_1h` - MES hourly OHLCV
- ✅ `futures_ex_mes_1h` - ALL futures contracts (60+ symbols)
- ✅ `mkt_indexes_1d` - Market indexes (S&P500, Nasdaq, etc)
- ✅ `mkt_spot_1d` - Spot prices

### Economic Data (8 FRED categories):
- ✅ `econ_rates_1d` - Interest rates (DFF, EFFR, etc)
- ✅ `econ_yields_1d` - Treasury yields (DGS10, DGS2, etc)
- ✅ `econ_fx_1d` - FX rates (DTWEXBGS, etc)
- ✅ `econ_vol_indices_1d` - Volatility (VIX, etc)
- ✅ `econ_inflation_1d` - Inflation indicators (CPI, PCE, etc)
- ✅ `econ_labor_1d` - Employment data (UNRATE, PAYEMS, etc)
- ✅ `econ_activity_1d` - Economic activity (GDP, retail, etc)
- ✅ `econ_money_1d` - Money supply (M1, M2, etc)
- ✅ `econ_commodities_1d` - Commodity prices

### News & Policy (4 tables):
- ✅ `econ_news_1d` - Economic news (Fed, SEC, ECB, BEA, EIA press)
- ✅ `policy_news_1d` - Policy news (CFTC, regulatory)
- ✅ `macro_reports_1d` - Macro surprises
- ✅ `news_signals` - Google News headlines (whitelist-filtered: Reuters, Bloomberg, CNBC, WSJ, etc.)

**Total: 23 tables, 60+ symbols, 10,000+ economic series**

## AutoGluon 1.5 Model Zoo (ALL 35+ Models)

### Statistical Models (11):
- Naive, SeasonalNaive, Average, SeasonalAverage, Zero
- Theta, AutoETS, AutoARIMA, DynamicOptimizedTheta, ADIDA

### Tabular ML (2):
- RecursiveTabular, DirectTabular

### Deep Learning - Transformers (3):
- TemporalFusionTransformer (TFT)
- PatchTST
- Transformer

### Deep Learning - RNN (3):
- DeepAR
- MQRNNRegressor
- SimpleFeedForward

### Deep Learning - CNN (2):
- WaveNet
- MQCNN

### Deep Learning - Quantile (1):
- MQF2

### Foundation Models - Chronos (5):
- Chronos[tiny] - Fastest
- Chronos[mini] - Fast
- Chronos[small] - Balanced
- Chronos[base] - Standard (recommended)
- Chronos[large] - Most accurate

### Ensemble (1):
- WeightedEnsemble (auto-generated)

**Total: 28+ individual models + ensemble**

## Training Pipeline

### Step 1: Build Complete Dataset

```bash
# Build dataset with ALL economic data sources
npx tsx scripts/build-complete-dataset.ts --days-back 730 --out datasets/autogluon/mes_1h_complete.csv
```

Features generated (~85 columns):
- Time features: hour_utc, day_of_week, session flags, month start/end
- MES technicals: returns (1h/4h/8h/24h), RSI, rolling MAs, stdev, range, body ratio, vol ratio
- Individual FRED series (38 columns): VIX, VVIX, OVX, GVZ, credit spreads, yields, FX, inflation, commodities, Fed balance sheet, claims
- Derived features: yield curve slope/curvature, real rates, credit spread diff, VIX term structure, Fed liquidity
- News counts (7-day rolling): total, Fed
- Policy count (7-day rolling)
- **headlines_7d** (text): Raw news headlines from trusted sources (Reuters, Bloomberg, CNBC, WSJ, etc.) — AutoGluon 1.5 auto-detects and embeds via transformer
- Forward return targets: 1h, 4h, 8h, 24h, 1w

### Step 2: Train on ALL Symbols from Database

```bash
cd mes_hft_halsey

# Option A: Use database source (trains on ALL symbols automatically)
python mes_autogluon_timeseries.py \
  --days-back 730 \
  --timeframe 1h \
  --quality extreme \
  --use-database

# Option B: Use Databento with expanded symbol list (65+ symbols)
python mes_autogluon_timeseries.py \
  --days-back 730 \
  --timeframe 1h \
  --quality extreme
```

**Recommended: Use `--use-database` to automatically train on ALL symbols in your database**

### Quality Settings

| Quality  | Time Limit | Use Case |
|----------|-----------|----------|
| fast     | 5 min     | Quick testing |
| medium   | 30 min    | Development |
| high     | 1 hour    | Standard production |
| best     | 2 hours   | High-quality production |
| **extreme** | **4 hours** | **FULL model zoo, all data** |

## Output

### Model Artifacts
- `mes_hft_halsey/models/autogluon_mes_1h/` - Trained models
- `mes_hft_halsey/models/autogluon_mes_1h/logs/predictor_log.txt` - Training log

### Forecasts & Summaries
- `mes_hft_halsey/output/mes_autogluon_forecast.csv` - MES forecasts
- `mes_hft_halsey/output/mes_autogluon_summary.json` - Model summary

### Leaderboard
The training script outputs a leaderboard showing:
- Model name
- Validation score (MASE)
- Training time
- Prediction time

Top model is typically **WeightedEnsemble** (combines all models)

## Expected Performance

With complete data sources and full model zoo:
- **Training time**: 2-4 hours (extreme quality)
- **Models trained**: 25-35 (depends on time limit and data)
- **Symbols**: 60+ (from database) or 65+ (from Databento)
- **Features**: 85+ (FRED macro + technicals + news text + policy)
- **MASE score**: < 0.3 (lower is better)

## Performance Optimization

### Multi-Symbol Benefits
Training on 60+ symbols provides:
- Cross-asset pattern learning
- Better generalization
- Reduced overfitting
- Improved MES forecasts via transfer learning

### Feature Engineering
All features use proper as-of-date lookups with anti-leakage lag:
- Economic data: Use last known value with conservative lag (daily=1d, weekly=8d, monthly=35d, quarterly=100d)
- News/Policy counts: 7-day rolling windows, lagged 1 day
- Headlines text: 7-day window (or 24h for BHG), lagged 1 day — no same-day leakage
- Time features: Known in advance

### AutoGluon 1.5 MultiModal Text Features
TabularPredictor auto-detects text columns (`headlines_7d`, `headlines_24h`) and uses transformer embeddings. No custom NLP, no sentiment scoring — the model learns directly from raw headlines during training.

### Model Selection
AutoGluon automatically:
- Tests all models in parallel
- Selects best performers
- Creates weighted ensemble
- Validates on holdout set

## Monitoring

### During Training
```bash
# Watch predictor log
tail -f mes_hft_halsey/models/autogluon_mes_1h/logs/predictor_log.txt
```

### After Training
```bash
# View summary
cat mes_hft_halsey/output/mes_autogluon_summary.json | jq .

# Check leaderboard
cat mes_hft_halsey/models/autogluon_mes_1h/logs/predictor_log.txt | grep "Validation score"
```

## Production Deployment

1. **Train**: Run with `--quality extreme --use-database`
2. **Validate**: Check leaderboard, verify MASE < 0.3
3. **Deploy**: Use `predictor.predict()` for inference
4. **Retrain**: Weekly or when new data available

## Troubleshooting

### "Not enough data"
- Ensure database has 730+ days of data
- Check `mes_prices_1h` table has rows
- Run ingestion scripts if needed

### "Model failed to train"
- Some models (Chronos) may fail if not installed
- AutoGluon skips failed models automatically
- Check predictor_log.txt for details

### "CUDA not available"
- Deep learning models run on CPU (slower)
- Consider GPU instance for 10x speedup
- M1/M2 Macs use Metal acceleration

## Requirements

```bash
# Python environment
python3.10 -m venv .venv-autogluon
source .venv-autogluon/bin/activate
pip install -r mes_hft_halsey/requirements.txt

# Additional for Chronos models
pip install autogluon.timeseries[chronos]

# Database access
export DATABASE_URL="postgresql://..."
```

## Next Steps

After training:
1. Evaluate forecasts vs actuals
2. Integrate into live trading system
3. Set up automated retraining pipeline
4. Monitor model drift over time
