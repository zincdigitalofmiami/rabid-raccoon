import { getPrimarySymbol as getRegistryPrimarySymbol, getSymbolsByRole } from '@/lib/symbol-registry'
import { SYMBOL_REGISTRY_SNAPSHOT } from '@/lib/symbol-registry/snapshot'

export interface SymbolConfig {
  displayName: string
  shortName: string
  dataSource: 'databento' | 'fred'
  databentoSymbol?: string
  dataset?: string
  stypeIn?: string
  fredSymbol?: string
  tickSize: number
  description: string
}

const SYMBOLS_ROLE_KEY = 'FORECAST_UNIVERSE'
const DATABENTO_DEFAULT_STYPE_IN = 'continuous'

type SnapshotSymbol = (typeof SYMBOL_REGISTRY_SNAPSHOT.symbols)[number]

function roleMembersFromSnapshot(roleKey: string): string[] {
  const members = SYMBOL_REGISTRY_SNAPSHOT.roleMembers
    .filter((member) => member.roleKey === roleKey && member.enabled)
    .sort((a, b) => a.position - b.position || a.symbolCode.localeCompare(b.symbolCode))
    .map((member) => member.symbolCode)

  if (members.length === 0) {
    throw new Error(`[symbols adapter] snapshot role "${roleKey}" has no enabled members`)
  }

  return members
}

function getSnapshotSymbolByCode(code: string): SnapshotSymbol {
  const symbol = SYMBOL_REGISTRY_SNAPSHOT.symbols.find((entry) => entry.code === code)
  if (!symbol) {
    throw new Error(`[symbols adapter] symbol "${code}" missing from registry snapshot`)
  }
  return symbol
}

function toLegacyDataSource(source: SnapshotSymbol['dataSource']): SymbolConfig['dataSource'] {
  if (source === 'DATABENTO') return 'databento'
  if (source === 'FRED') return 'fred'
  throw new Error(`[symbols adapter] unsupported data source "${source}" for legacy symbol config`)
}

function toSymbolConfig(symbol: SnapshotSymbol): SymbolConfig {
  const dataSource = toLegacyDataSource(symbol.dataSource)
  const config: SymbolConfig = {
    displayName: symbol.displayName || symbol.code,
    shortName: symbol.shortName || symbol.displayName || symbol.code,
    dataSource,
    tickSize: symbol.tickSize,
    description: symbol.description || symbol.displayName || symbol.code,
  }

  if (dataSource === 'databento') {
    config.databentoSymbol = symbol.databentoSymbol || `${symbol.code}.c.0`
    config.dataset = symbol.dataset || 'GLBX.MDP3'
    config.stypeIn = DATABENTO_DEFAULT_STYPE_IN
  } else {
    config.fredSymbol = symbol.fredSymbol || undefined
  }

  return config
}

function buildSymbolMapFromSnapshot(): Record<string, SymbolConfig> {
  const roleMembers = roleMembersFromSnapshot(SYMBOLS_ROLE_KEY)
  const entries = roleMembers.map((code) => [code, toSymbolConfig(getSnapshotSymbolByCode(code))] as const)
  if (entries.length === 0) {
    throw new Error('[symbols adapter] symbol map resolved to empty from snapshot')
  }
  return Object.fromEntries(entries)
}

export async function getLegacySymbolsFromRegistry(): Promise<Record<string, SymbolConfig>> {
  const symbols = await getSymbolsByRole(SYMBOLS_ROLE_KEY)
  const entries = symbols.map((symbol) => [symbol.code, toSymbolConfig(symbol)] as const)
  if (entries.length === 0) {
    throw new Error(`[symbols adapter] registry role "${SYMBOLS_ROLE_KEY}" resolved to empty`)
  }
  return Object.fromEntries(entries)
}

export async function getLegacyPrimarySymbolFromRegistry(): Promise<string> {
  return getRegistryPrimarySymbol()
}

export const SYMBOLS: Record<string, SymbolConfig> = buildSymbolMapFromSnapshot()

export const SYMBOL_KEYS = Object.keys(SYMBOLS)

export const PRIMARY_SYMBOL = SYMBOL_REGISTRY_SNAPSHOT.primarySymbol
