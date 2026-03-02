"""
Cross-Asset Correlation Engine — Rabid Raccoon
===============================================
Computes daily Pearson correlations between MES and 6 cross-asset symbols
using daily close data from the database. Outputs enriched JSON consumed
by the /api/correlation route.

Data sources:
  - MES:  mkt_futures_mes_1d (close)
  - NQ:   mkt_futures_1d     (close, symbolCode='NQ')
  - GC:   mkt_futures_1d     (close, symbolCode='GC')
  - CL:   mkt_futures_1d     (close, symbolCode='CL')
  - ZN:   mkt_futures_1d     (close, symbolCode='ZN')
  - VX:   econ_vol_indices_1d (value, seriesId='VIXCLS')
  - DX:   econ_fx_1d          (value, seriesId='DTWEXBGS')

Why forward-fill: FRED econ data doesn't report on weekends/holidays
but futures trade on some of those days. Forward-fill ensures we don't
lose observations when calendars don't align.
"""

import os
import json
import warnings
import sys
from datetime import datetime

import psycopg2
import numpy as np
import pandas as pd
from dotenv import load_dotenv

warnings.filterwarnings('ignore', category=UserWarning, module='pandas')
warnings.filterwarnings('ignore', category=FutureWarning, module='pandas')

load_dotenv('.env.local')
database_url = os.environ.get('DIRECT_URL')

if not database_url:
    print("FATAL: DIRECT_URL not found in .env.local", file=sys.stderr)
    sys.exit(1)

# ── Configuration ──────────────────────────────────────────────────────────────
LOOKBACK_DAYS = 180  # 6 months of data
ROLLING_WINDOWS = [30, 90, 180]  # Rolling correlation windows

# Each asset's expected relationship to MES for bullish alignment:
#   +1 = positive correlation is bullish (e.g. NQ confirms MES)
#   -1 = negative correlation is bullish (e.g. VIX inverse = risk-on)
ASSET_CONFIG = {
    'NQ': {'sign': +1, 'weight': 0.25, 'label': 'Nasdaq 100'},
    'VX': {'sign': -1, 'weight': 0.25, 'label': 'VIX (CBOE)'},
    'DX': {'sign': -1, 'weight': 0.15, 'label': 'US Dollar Index'},
    'GC': {'sign': +1, 'weight': 0.10, 'label': 'Gold'},
    'CL': {'sign': +1, 'weight': 0.15, 'label': 'Crude Oil WTI'},
    'ZN': {'sign': -1, 'weight': 0.10, 'label': '10Y Treasury Note'},
}


def fetch_data() -> pd.DataFrame:
    conn = psycopg2.connect(database_url)

    queries = {
        'MES': '''
            SELECT "eventDate" AS event_date, close AS close_value
            FROM mkt_futures_mes_1d
            ORDER BY "eventDate"
        ''',
        'NQ': '''
            SELECT "eventDate" AS event_date, close AS close_value
            FROM mkt_futures_1d
            WHERE "symbolCode" = 'NQ'
            ORDER BY "eventDate"
        ''',
        'GC': '''
            SELECT "eventDate" AS event_date, close AS close_value
            FROM mkt_futures_1d
            WHERE "symbolCode" = 'GC'
            ORDER BY "eventDate"
        ''',
        'CL': '''
            SELECT "eventDate" AS event_date, close AS close_value
            FROM mkt_futures_1d
            WHERE "symbolCode" = 'CL'
            ORDER BY "eventDate"
        ''',
        'ZN': '''
            SELECT "eventDate" AS event_date, close AS close_value
            FROM mkt_futures_1d
            WHERE "symbolCode" = 'ZN'
            ORDER BY "eventDate"
        ''',
        'VX': '''
            SELECT "eventDate" AS event_date, value AS close_value
            FROM econ_vol_indices_1d
            WHERE "seriesId" = 'VIXCLS' AND value IS NOT NULL
            ORDER BY "eventDate"
        ''',
        'DX': '''
            SELECT "eventDate" AS event_date, value AS close_value
            FROM econ_fx_1d
            WHERE "seriesId" = 'DTWEXBGS' AND value IS NOT NULL
            ORDER BY "eventDate"
        ''',
    }

    frames = []
    for symbol, query in queries.items():
        df = pd.read_sql(query, conn)
        df['symbol'] = symbol
        frames.append(df)

    conn.close()
    return pd.concat(frames, ignore_index=True)


def compute_engine():
    print(f"[{datetime.utcnow().isoformat()}] Fetching daily data from DB...")
    raw = fetch_data()
    raw['event_date'] = pd.to_datetime(raw['event_date'])
    raw['close_value'] = pd.to_numeric(raw['close_value'])

    # Filter to lookback window
    max_date = raw['event_date'].max()
    cutoff = max_date - pd.Timedelta(days=LOOKBACK_DAYS)
    raw = raw[raw['event_date'] >= cutoff]

    # Pivot: each column is a symbol's close
    pivot = raw.pivot_table(index='event_date', columns='symbol', values='close_value')

    # Forward-fill then back-fill to handle calendar misalignment
    # (FRED doesn't report weekends; futures sometimes do)
    pivot = pivot.ffill().bfill()

    # Log which symbols have data and how many observations
    available = [col for col in pivot.columns if pivot[col].notna().sum() > 20]
    missing = [s for s in ['MES'] + list(ASSET_CONFIG.keys()) if s not in available]

    if 'MES' not in available:
        print("FATAL: MES data not found in database.", file=sys.stderr)
        sys.exit(1)

    # Compute daily returns (log returns for better statistical properties)
    returns = np.log(pivot / pivot.shift(1)).dropna()

    total_obs = len(returns)
    print(f"  Observations (after ffill + log returns): {total_obs}")
    print(f"  Date range: {returns.index.min().date()} → {returns.index.max().date()}")
    print(f"  Available: {available}")
    if missing:
        print(f"  Missing: {missing}")

    # ── Per-symbol correlation analysis ──
    symbols_output = {}
    composite_bullish = 0.0
    total_weight = 0.0

    for sym, config in ASSET_CONFIG.items():
        if sym not in returns.columns:
            symbols_output[sym.lower()] = {
                'symbol': sym,
                'label': config['label'],
                'correlation': None,
                'rollingCorrelations': {},
                'bullishAligned': False,
                'bullishScore': 0,
                'weight': config['weight'],
                'observations': 0,
                'status': 'NO_DATA',
            }
            continue

        # Full-window Pearson correlation
        r_value = returns['MES'].corr(returns[sym])

        # Rolling correlations
        rolling = {}
        for window in ROLLING_WINDOWS:
            if len(returns) >= window:
                roll_series = returns['MES'].rolling(window).corr(returns[sym])
                latest_roll = roll_series.iloc[-1]
                if pd.notna(latest_roll):
                    rolling[f'{window}d'] = round(float(latest_roll), 4)

        # Directional alignment score
        # sign=+1 means positive r is bullish; sign=-1 means negative r is bullish
        bullish_score = config['sign'] * r_value
        is_bullish_aligned = bullish_score > 0

        weighted_contribution = config['weight'] * bullish_score
        composite_bullish += weighted_contribution
        total_weight += config['weight']

        symbols_output[sym.lower()] = {
            'symbol': sym,
            'label': config['label'],
            'correlation': round(float(r_value), 4),
            'rollingCorrelations': rolling,
            'bullishAligned': bool(is_bullish_aligned),
            'bullishScore': round(float(bullish_score), 4),
            'weight': config['weight'],
            'observations': int(returns[['MES', sym]].dropna().shape[0]),
            'status': 'OK',
        }

        print(f"  {sym:>3}: r={r_value:+.4f}  bullishScore={bullish_score:+.4f}  "
              f"aligned={'YES' if is_bullish_aligned else 'NO':>3}  "
              f"weight={config['weight']:.2f}  "
              f"rolling30d={rolling.get('30d', 'N/A')}")

    # ── Composite score ──
    # Normalize by total weight to keep it in [-1, 1]
    if total_weight > 0:
        composite_bullish = max(-1.0, min(1.0, composite_bullish / total_weight))

    composite_pct = abs(composite_bullish) * 100
    is_aligned_bullish = composite_bullish > 0
    is_aligned_bearish = composite_bullish < 0

    print(f"\n  COMPOSITE: {composite_bullish:+.4f} ({composite_pct:.1f}% "
          f"{'Bullish' if is_aligned_bullish else 'Bearish'} aligned)")

    # ── Build output ──
    output = {
        'generatedAt': datetime.utcnow().isoformat() + 'Z',
        'lookbackDays': LOOKBACK_DAYS,
        'observations': total_obs,
        'dateRange': {
            'start': str(returns.index.min().date()),
            'end': str(returns.index.max().date()),
        },
        'symbols': symbols_output,
        'composite': {
            'bullishScore': round(float(composite_bullish), 4),
            'bearishScore': round(float(-composite_bullish), 4),
            'bullishAligned': bool(is_aligned_bullish),
            'bearishAligned': bool(is_aligned_bearish),
            'pctAligned': round(float(composite_pct), 1),
        },
    }

    output_path = 'public/daily-correlations.json'
    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n  Output saved to {output_path}")


if __name__ == '__main__':
    compute_engine()
