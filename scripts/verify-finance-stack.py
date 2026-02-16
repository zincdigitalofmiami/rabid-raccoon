"""
verify-finance-stack.py

Smoke-tests all requested finance packages and prints an auditable JSON report.
"""

from __future__ import annotations

import json
import sys
from importlib.metadata import version, PackageNotFoundError


def package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "not-installed"


def run_checks() -> dict[str, object]:
    report: dict[str, object] = {
        "python": sys.version.split()[0],
        "packages": {
            "scipy": package_version("scipy"),
            "statsmodels": package_version("statsmodels"),
            "quandl": package_version("Quandl"),
            "QuantLib": package_version("QuantLib"),
            "zipline-reloaded": package_version("zipline-reloaded"),
            "pyfolio-reloaded": package_version("pyfolio-reloaded"),
        },
        "checks": {},
    }

    # SciPy
    from scipy.stats import norm

    report["checks"]["scipy_norm_cdf_0"] = float(norm.cdf(0.0))

    # statsmodels
    import numpy as np
    import statsmodels.api as sm

    y = np.array([1.0, 2.0, 3.0, 4.0])
    x = np.array([1.0, 2.0, 3.0, 4.0])
    x_const = sm.add_constant(x)
    ols = sm.OLS(y, x_const).fit()
    report["checks"]["statsmodels_r2"] = float(ols.rsquared)

    # Quandl
    import quandl

    report["checks"]["quandl_has_get"] = hasattr(quandl, "get")

    # QuantLib
    import QuantLib as ql

    report["checks"]["quantlib_business_day"] = ql.Date(15, 1, 2026).weekday()

    # Zipline-reloaded exports as zipline module
    import zipline

    report["checks"]["zipline_version"] = getattr(zipline, "__version__", "unknown")

    # Pyfolio-reloaded exports as pyfolio module
    import pyfolio
    import pandas as pd

    report["checks"]["pyfolio_version"] = getattr(pyfolio, "__version__", "unknown")
    sample_rets = pd.Series([0.01, -0.005, 0.002], index=pd.date_range("2026-01-01", periods=3, freq="D"))
    stats = pyfolio.timeseries.perf_stats(sample_rets)
    report["checks"]["pyfolio_perf_stats_rows"] = int(stats.shape[0])

    return report


def main() -> None:
    report = run_checks()
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
