import { getSymbolsByRole } from '@/lib/symbol-registry'
import { SYMBOL_REGISTRY_SNAPSHOT } from '@/lib/symbol-registry/snapshot'

export interface IngestionSymbol {
  code: string
  displayName: string
  shortName: string
  description: string
  databentoSymbol: string
  dataset: string
  tickSize: number
}

const INGESTION_ROLE_KEY = 'INGESTION_ACTIVE'
const DATABENTO_DEFAULT_DATASET = 'GLBX.MDP3'

type SnapshotSymbol = (typeof SYMBOL_REGISTRY_SNAPSHOT.symbols)[number]

function roleMembersFromSnapshot(roleKey: string): string[] {
  const members = SYMBOL_REGISTRY_SNAPSHOT.roleMembers
    .filter((member) => member.roleKey === roleKey && member.enabled)
    .sort((a, b) => a.position - b.position || a.symbolCode.localeCompare(b.symbolCode))
    .map((member) => member.symbolCode)

  if (members.length === 0) {
    throw new Error(`[ingestion-symbols adapter] snapshot role "${roleKey}" has no enabled members`)
  }

  return members
}

function getSnapshotSymbolByCode(code: string): SnapshotSymbol {
  const symbol = SYMBOL_REGISTRY_SNAPSHOT.symbols.find((entry) => entry.code === code)
  if (!symbol) {
    throw new Error(`[ingestion-symbols adapter] symbol "${code}" missing from registry snapshot`)
  }
  return symbol
}

function toIngestionSymbol(symbol: SnapshotSymbol): IngestionSymbol {
  if (symbol.dataSource !== 'DATABENTO') {
    throw new Error(
      `[ingestion-symbols adapter] symbol "${symbol.code}" has unsupported data source "${symbol.dataSource}"`,
    )
  }

  return {
    code: symbol.code,
    displayName: symbol.displayName || symbol.code,
    shortName: symbol.shortName || symbol.displayName || symbol.code,
    description: symbol.description || symbol.displayName || symbol.code,
    databentoSymbol: symbol.databentoSymbol || `${symbol.code}.c.0`,
    dataset: symbol.dataset || DATABENTO_DEFAULT_DATASET,
    tickSize: symbol.tickSize,
  }
}

function buildIngestionSymbolsFromSnapshot(): IngestionSymbol[] {
  const roleMembers = roleMembersFromSnapshot(INGESTION_ROLE_KEY)
  const symbols = roleMembers.map((code) => toIngestionSymbol(getSnapshotSymbolByCode(code)))
  if (symbols.length === 0) {
    throw new Error('[ingestion-symbols adapter] ingestion symbol list resolved to empty from snapshot')
  }
  return symbols
}

export async function getIngestionSymbolsFromRegistry(): Promise<IngestionSymbol[]> {
  const symbols = await getSymbolsByRole(INGESTION_ROLE_KEY)
  const adapted = symbols.map((symbol) => toIngestionSymbol(symbol))
  if (adapted.length === 0) {
    throw new Error(`[ingestion-symbols adapter] registry role "${INGESTION_ROLE_KEY}" resolved to empty`)
  }
  return adapted
}

export const INGESTION_SYMBOLS: IngestionSymbol[] = buildIngestionSymbolsFromSnapshot()

export const INGESTION_SYMBOL_CODES = INGESTION_SYMBOLS.map((symbol) => symbol.code)
