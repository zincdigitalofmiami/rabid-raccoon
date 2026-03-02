import os
import json
import warnings
import psycopg2
import pandas as pd
from dotenv import load_dotenv

warnings.filterwarnings('ignore', category=UserWarning, module='pandas')
warnings.filterwarnings('ignore', category=FutureWarning, module='pandas')

# Load env file
load_dotenv('.env.local')
database_url = os.environ.get('DIRECT_URL')

if not database_url:
    print("Error: DIRECT_URL not found in .env.local")
    exit(1)

def fetch_data():
    # pandas recommends sqlalchemy, let's just use psycopg2 but with correct quotes for Postgres camelCase columns
    conn = psycopg2.connect(database_url)
    
    query_mes = 'SELECT "eventDate" as event_date, close, \'MES\' as symbol_code FROM mkt_futures_mes_1d;'
    mes_df = pd.read_sql(query_mes, conn)
    
    query_cross = 'SELECT "eventDate" as event_date, close, "symbolCode" as symbol_code FROM mkt_futures_1d WHERE "symbolCode" IN (\'NQ\', \'GC\', \'CL\', \'ZN\');'
    cross_df = pd.read_sql(query_cross, conn)
    
    query_vix = 'SELECT "eventDate" as event_date, value as close, \'VX\' as symbol_code FROM econ_vol_indices_1d WHERE "seriesId" = \'VIXCLS\' AND value IS NOT NULL;'
    vix_df = pd.read_sql(query_vix, conn)

    query_dxy = 'SELECT "eventDate" as event_date, value as close, \'DX\' as symbol_code FROM econ_fx_1d WHERE "seriesId" = \'DTWEXBGS\' AND value IS NOT NULL;'
    dxy_df = pd.read_sql(query_dxy, conn)
    
    conn.close()
    
    return pd.concat([mes_df, cross_df, vix_df, dxy_df])

def compute_correlations():
    print("Fetching daily data from DB...")
    df = fetch_data()
    
    df['event_date'] = pd.to_datetime(df['event_date'])
    df['close'] = pd.to_numeric(df['close'])
    
    # Optional: Filter to last 180 days (6 months)
    recent_date = df['event_date'].max() - pd.Timedelta(days=180)
    df = df[df['event_date'] >= recent_date]
    
    # Pivot so each column is a symbol
    pivot_df = df.pivot_table(index='event_date', columns='symbol_code', values='close')
    
    # Compute correlation matrix on returns
    returns_df = pivot_df.pct_change().dropna()
    corr_matrix = returns_df.corr(method='pearson')
    
    mes_corr = corr_matrix['MES'].drop('MES')
    
    results = {}
    for symbol, val in mes_corr.items():
        results[symbol.lower()] = round(val, 3)
        
    print("Calculated Daily Correlations (vs MES):", json.dumps(results, indent=2))
    
    # Save output to a JSON file the app can read
    output_path = 'public/daily-correlations.json'
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
        
    print(f"Data saved to {output_path}")

if __name__ == "__main__":
    compute_correlations()
