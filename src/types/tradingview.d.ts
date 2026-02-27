/**
 * TypeScript type declarations for TradingView widget web components
 *
 * These types extend the JSX namespace to recognize the custom <tv-ticker-tape>
 * web component used by the TradingView ticker tape widget.
 *
 * Source: https://widgets.tradingview-widget.com/
 */

/// <reference types="react" />

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "tv-ticker-tape": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        theme?: "dark" | "light";
        "item-size"?: "small" | "normal" | "compact";
        "show-hover"?: boolean | "true" | "false";
      };
    }
  }
}

export {};
