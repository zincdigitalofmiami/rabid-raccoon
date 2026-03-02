import psycopg2
import pandas as pd
import warnings
from dotenv import load_dotenv
import os

warnings.filterwarnings('ignore')
load_dotenv('.env.local')
database_url = os.environ.get('DIRECT_URL')

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

df = pd.concat([mes_df, cross_df, vix_df, dxy_df])
df['event_date'] = pd.to_datetime(df['event_date'])
df['close'] = pd.to_numeric(df['close'])

recent_date = df['event_date'].max() - pd.Timedelta(days=180)
df = df[df['event_date'] >= recent_date]

pivot_df = df.pivot_table(index='event_date', columns='symbol_code', values='close')

# Use forward fill for weekends/holidays before computing returns to ensure we don't drop rows with misaligned closes.
pivot_df_ffill = pivot_df.ffill().bfill()
returns_df_ffill = pivot_df_ffill.pct_change().dropna()

print("Rows in pivot:", len(pivot_df))
print("Rows in traditional dropna pct_change:", len(pivot_df.pct_change().dropna()))
print("Rows in ffill pct_change:", len(returns_df_ffill))
print("--- COORRELATIONS (FFILL) ---")
print(returns_df_ffill.corr(method='pearson')['MES'])
