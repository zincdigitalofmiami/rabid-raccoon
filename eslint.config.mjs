import { defineConfig } from 'eslint/config'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  {
    ignores: [
      '.claude/**',
      '.next/**',
      'node_modules/**',
      '.venv-*/**',
      'out/**',
      'dist/**',
      'coverage/**',
    ],
  },
])
