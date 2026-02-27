"use client";

import React, { useEffect, useRef, memo } from "react";

function TradingViewTickerTape() {
  const ref = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current || !ref.current) return;
    loaded.current = true;

    const script = document.createElement("script");
    script.src =
      "https://widgets.tradingview-widget.com/w/en/tv-ticker-tape.js";
    script.async = true;
    ref.current.appendChild(script);
  }, []);

  return (
    <div
      ref={ref}
      className="w-full border-b border-amber-500/20 bg-transparent"
      style={{ height: "40px", overflow: "hidden" }}
    >
      {/* Using React.createElement to bypass JSX type checking for TradingView web component */}
      {React.createElement(
        "tv-ticker-tape",
        {
          theme: "dark",
          "item-size": "compact",
          "show-hover": "true",
        },
        React.createElement("div", { slot: "promolink" }),
        React.createElement(
          "div",
          { slot: "items" },
          "CME_MINI:MES1!|MES FOREXCOM:SPXUSD|S&P 500 INDEX:VIX|VIX TVC:DXY|DXY TVC:TNX|10Y",
        ),
      )}
    </div>
  );
}

export default memo(TradingViewTickerTape);
