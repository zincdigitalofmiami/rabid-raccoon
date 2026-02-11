# Rabid Raccoon 🦝
### A Multi-Feature Pine Script v6 Trading Indicator

**Author:** Kirk / ZINC Digital  
**Pine Script Version:** v6  
**Primary Use:** MES (Micro E-mini S&P 500) Futures

---

## Features

| Module | Status | Description |
|--------|--------|-------------|
| Measured Move Detection | 🔲 TODO | Equal-length price swing identification with projected targets |
| Auto-Fibonacci Engine | 🔲 TODO | Multi-timeframe fib methodology (4H → 1H → 15m) |
| Break-Hook-Go | 🔲 TODO | Structure break → retest → continuation pattern detection |
| Correlation Analysis | 🔲 TODO | Dynamic VIX/DXY/NQ correlation with divergence signals |
| Risk Management | 🔲 TODO | Position sizing, stop placement, R:R calculation |

## Project Structure

```
rabid-raccoon/
├── indicators/          # Main indicator scripts
│   └── rabid-raccoon.pine
├── strategies/          # Strategy (backtesting) versions
├── libraries/           # Publishable Pine Script libraries
├── docs/                # Documentation, methodology notes
├── templates/           # Reusable code templates
└── README.md
```

## Development Workflow

1. **Edit** in VS Code (with kaigouthro Pine Script extension for real-time linting)
2. **Validate** — extension catches errors via TradingView's pine-facade API
3. **Copy-paste** into TradingView Pine Editor → "Add to Chart"
4. **Debug** using Pine Logs, Pine Profiler, debug dashboard (toggle Debug Mode input)
5. **Iterate** — paste errors back, fix, commit, re-paste

## VS Code Extensions

- `kaigouthro.pinescript-vscode` — Primary: real-time linting, v6 support, autocompletion
- `usernamehw.errorlens` — Inline error display
- `eamodio.gitlens` — Git history and blame

## Architecture Notes

- Single indicator file with `//#region` blocks for modularity
- Each feature has a toggle input for isolation/debugging
- Shared swing detection core feeds multiple modules
- UDTs for structured data (MeasuredMove, FibLevel, RiskProfile, etc.)
- v6 dynamic requests enable loop-based correlation analysis
- Debug mode activates status dashboard + log output

## Web App AI Analysis Setup

For the Next.js dashboard analysis overlay (`/api/analyse/ai`), set:

- `OPENAI_API_KEY`
- `OPENAI_ANALYSIS_MODEL` (default fallback chain in code starts with `gpt-5.2-pro`)
- `OPENAI_FORECAST_MODEL` (optional; defaults to `OPENAI_ANALYSIS_MODEL`)

Copy `.env.example` to `.env.local` and fill the keys.
