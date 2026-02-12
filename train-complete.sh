#!/bin/bash
set -e

echo "===================================================================="
echo "COMPLETE AUTOGLUON TRAINING PIPELINE"
echo "===================================================================="
echo ""
echo "This script will:"
echo "  1. Build complete dataset (ALL economic data + news)"
echo "  2. Train on ALL symbols from database"
echo "  3. Use FULL AutoGluon 1.5 model zoo (35+ models)"
echo ""
echo "Estimated time: 4 hours (extreme quality)"
echo "===================================================================="
echo ""

# Check DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
    echo "❌ ERROR: DATABASE_URL not set"
    echo "Please set DATABASE_URL environment variable"
    exit 1
fi

# Parse arguments
DAYS_BACK=${1:-730}
TIMEFRAME=${2:-1h}
QUALITY=${3:-extreme}

echo "Configuration:"
echo "  Days back: $DAYS_BACK"
echo "  Timeframe: $TIMEFRAME"
echo "  Quality: $QUALITY"
echo ""

# Step 1: Build complete dataset
echo "===================================================================="
echo "STEP 1/2: Building complete dataset..."
echo "===================================================================="
npx tsx scripts/build-complete-dataset.ts \
  --days-back "$DAYS_BACK" \
  --out "datasets/autogluon/mes_${TIMEFRAME}_complete.csv"

if [ $? -ne 0 ]; then
    echo "❌ Dataset build failed"
    exit 1
fi

echo ""
echo "✅ Dataset built successfully"
echo ""

# Step 2: Train models
echo "===================================================================="
echo "STEP 2/2: Training AutoGluon models..."
echo "===================================================================="
cd mes_hft_halsey

python mes_autogluon_timeseries.py \
  --days-back "$DAYS_BACK" \
  --timeframe "$TIMEFRAME" \
  --quality "$QUALITY" \
  --use-database

if [ $? -ne 0 ]; then
    echo "❌ Training failed"
    exit 1
fi

echo ""
echo "===================================================================="
echo "✅ TRAINING COMPLETE!"
echo "===================================================================="
echo ""
echo "Output files:"
echo "  - Model: mes_hft_halsey/models/autogluon_mes_${TIMEFRAME}/"
echo "  - Forecast: mes_hft_halsey/output/mes_autogluon_forecast.csv"
echo "  - Summary: mes_hft_halsey/output/mes_autogluon_summary.json"
echo "  - Log: mes_hft_halsey/models/autogluon_mes_${TIMEFRAME}/logs/predictor_log.txt"
echo ""
echo "To view results:"
echo "  cat mes_hft_halsey/output/mes_autogluon_summary.json | jq ."
echo ""
