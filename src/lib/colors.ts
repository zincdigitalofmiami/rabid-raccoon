/**
 * TradingView-Grade Color System
 * Reused from ZINC Fusion V15
 */

export const TV = {
  bg: {
    primary: '#131722',
    secondary: '#1e222d',
    tertiary: '#2a2e39',
    hover: '#363a45',
  },
  text: {
    primary: '#d1d4dc',
    secondary: '#787b86',
    tertiary: '#434651',
  },
  border: {
    primary: 'rgba(255, 255, 255, 0.1)',
    secondary: 'rgba(255, 255, 255, 0.05)',
  },
  bull: {
    primary: '#26a69a',
    bright: '#22ab94',
    muted: 'rgba(38, 166, 154, 0.2)',
  },
  bear: {
    primary: '#ef5350',
    bright: '#f23645',
    muted: 'rgba(239, 83, 80, 0.2)',
  },
  neutral: {
    primary: '#787b86',
  },
  blue: {
    primary: '#2962ff',
  },
  orange: {
    primary: '#ff9800',
  },
} as const

// Fibonacci level colors (from Pine Script)
export const FIB_COLORS: Record<number, string> = {
  0:     '#787b86',
  0.236: '#f44336',
  0.382: '#81c784',
  0.5:   '#4caf50',
  0.618: '#009688',
  0.786: '#64b5f6',
  1.0:   '#787b86',
  1.236: '#81c784',
  1.618: '#2962ff',
}

export default TV
