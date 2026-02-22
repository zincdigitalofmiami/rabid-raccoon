import type { DataSource, Symbol, SymbolMapping } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import { SYMBOL_REGISTRY_SNAPSHOT } from './snapshot'
import type { RegistryProviderMapping, RegistrySymbol, SymbolRoleKey } from './types'

const PRIMARY_SYMBOL_ROLE: SymbolRoleKey = 'INNGEST_MES_ONLY'

type RoleMemberRow = {
  symbol_code: string
  position: number
}

function toRegistrySymbol(symbol: Symbol): RegistrySymbol {
  return {
    code: symbol.code,
    displayName: symbol.displayName,
    shortName: symbol.shortName,
    description: symbol.description,
    tickSize: Number(symbol.tickSize.toString()),
    dataSource: symbol.dataSource,
    dataset: symbol.dataset,
    databentoSymbol: symbol.databentoSymbol,
    fredSymbol: symbol.fredSymbol,
    isActive: symbol.isActive,
  }
}

function toRegistryProviderMapping(mapping: SymbolMapping): RegistryProviderMapping {
  return {
    symbolCode: mapping.symbolCode,
    source: mapping.source,
    sourceTable: mapping.sourceTable,
    sourceSymbol: mapping.sourceSymbol,
    isPrimary: mapping.isPrimary,
    confidenceScore: mapping.confidenceScore ? Number(mapping.confidenceScore.toString()) : null,
    notes: mapping.notes,
  }
}

function snapshotSymbolsByCode(): Map<string, RegistrySymbol> {
  return new Map(SYMBOL_REGISTRY_SNAPSHOT.symbols.map((symbol) => [symbol.code, symbol]))
}

function throwIfEmpty<T>(values: readonly T[], message: string): readonly T[] {
  if (values.length === 0) {
    throw new Error(message)
  }
  return values
}

function selectMapping(mappings: RegistryProviderMapping[]): RegistryProviderMapping {
  const ordered = [...mappings].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    const left = a.confidenceScore ?? -1
    const right = b.confidenceScore ?? -1
    if (left !== right) return right - left
    if (a.sourceTable !== b.sourceTable) return a.sourceTable.localeCompare(b.sourceTable)
    return a.sourceSymbol.localeCompare(b.sourceSymbol)
  })
  const selected = ordered[0]
  if (!selected) {
    throw new Error('[symbol-registry] no provider mapping candidate found')
  }
  return selected
}

async function dbRoleMemberRows(roleKey: SymbolRoleKey): Promise<RoleMemberRow[]> {
  const rows = await prisma.$queryRaw<RoleMemberRow[]>`
    SELECT m.symbol_code, m.position
    FROM symbol_role_members m
    JOIN symbol_roles r ON r.role_key = m.role_key
    WHERE m.role_key = ${roleKey}
      AND m.enabled = true
      AND r.is_active = true
    ORDER BY m.position ASC, m.symbol_code ASC
  `
  return rows
}

async function withDbThenSnapshot<T>(
  operation: string,
  dbReader: () => Promise<T>,
  snapshotReader: () => T,
): Promise<T> {
  try {
    return await dbReader()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[symbol-registry] ${operation} DB read failed; using snapshot fallback: ${message}`)
    return snapshotReader()
  }
}

export async function getSymbolsByRole(roleKey: SymbolRoleKey): Promise<RegistrySymbol[]> {
  if (!roleKey.trim()) {
    throw new Error('[symbol-registry] roleKey is required')
  }

  return withDbThenSnapshot(
    `getSymbolsByRole(${roleKey})`,
    async () => {
      const members = throwIfEmpty(
        await dbRoleMemberRows(roleKey),
        `[symbol-registry] role "${roleKey}" has no enabled symbols in DB`,
      ) as RoleMemberRow[]

      const symbols = await prisma.symbol.findMany({
        where: { code: { in: members.map((member) => member.symbol_code) }, isActive: true },
      })
      const byCode = new Map(symbols.map((symbol) => [symbol.code, toRegistrySymbol(symbol)]))

      const ordered = members
        .map((member) => byCode.get(member.symbol_code))
        .filter((symbol): symbol is RegistrySymbol => Boolean(symbol))

      return throwIfEmpty(
        ordered,
        `[symbol-registry] role "${roleKey}" symbols missing from DB result set`,
      ) as RegistrySymbol[]
    },
    () => {
      const byCode = snapshotSymbolsByCode()
      const members = SYMBOL_REGISTRY_SNAPSHOT.roleMembers
        .filter((member) => member.roleKey === roleKey && member.enabled)
        .sort((a, b) => a.position - b.position || a.symbolCode.localeCompare(b.symbolCode))

      throwIfEmpty(
        members,
        `[symbol-registry] role "${roleKey}" missing from snapshot and DB unavailable`,
      )

      const ordered = members
        .map((member) => byCode.get(member.symbolCode))
        .filter((symbol): symbol is RegistrySymbol => Boolean(symbol))

      return throwIfEmpty(
        ordered,
        `[symbol-registry] snapshot role "${roleKey}" resolved no valid symbols`,
      ) as RegistrySymbol[]
    },
  )
}

export async function getPrimarySymbol(): Promise<string> {
  return withDbThenSnapshot(
    'getPrimarySymbol',
    async () => {
      const rows = await prisma.$queryRaw<Array<{ symbol_code: string }>>`
        SELECT m.symbol_code
        FROM symbol_role_members m
        JOIN symbol_roles r ON r.role_key = m.role_key
        WHERE m.role_key = ${PRIMARY_SYMBOL_ROLE}
          AND m.enabled = true
          AND r.is_active = true
        ORDER BY m.position ASC, m.symbol_code ASC
        LIMIT 1
      `
      const row = rows[0]
      if (!row?.symbol_code) {
        throw new Error('[symbol-registry] primary symbol role is empty in DB')
      }
      return row.symbol_code
    },
    () => {
      if (!SYMBOL_REGISTRY_SNAPSHOT.primarySymbol) {
        throw new Error('[symbol-registry] primary symbol missing from snapshot and DB unavailable')
      }
      return SYMBOL_REGISTRY_SNAPSHOT.primarySymbol
    },
  )
}

export async function getActiveSymbols(): Promise<RegistrySymbol[]> {
  return withDbThenSnapshot(
    'getActiveSymbols',
    async () => {
      const symbols = await prisma.symbol.findMany({
        where: { isActive: true },
        orderBy: { code: 'asc' },
      })
      return throwIfEmpty(
        symbols.map(toRegistrySymbol),
        '[symbol-registry] active symbol list from DB is empty',
      ) as RegistrySymbol[]
    },
    () => {
      const active = SYMBOL_REGISTRY_SNAPSHOT.symbols
        .filter((symbol) => symbol.isActive)
        .sort((a, b) => a.code.localeCompare(b.code))

      return throwIfEmpty(active, '[symbol-registry] active symbol list from snapshot is empty') as RegistrySymbol[]
    },
  )
}

export async function getProviderMapping(
  symbolCode: string,
  source: DataSource,
  sourceTable?: string,
): Promise<RegistryProviderMapping> {
  if (!symbolCode.trim()) {
    throw new Error('[symbol-registry] symbolCode is required')
  }

  return withDbThenSnapshot(
    `getProviderMapping(${symbolCode}, ${source}${sourceTable ? `, ${sourceTable}` : ''})`,
    async () => {
      const mappings = await prisma.symbolMapping.findMany({
        where: {
          symbolCode,
          source,
          ...(sourceTable ? { sourceTable } : {}),
        },
      })
      if (mappings.length === 0) {
        throw new Error(
          `[symbol-registry] no provider mapping in DB for symbol "${symbolCode}" and source "${source}"`,
        )
      }
      return selectMapping(mappings.map(toRegistryProviderMapping))
    },
    () => {
      const candidates = SYMBOL_REGISTRY_SNAPSHOT.providerMappings.filter(
        (mapping) =>
          mapping.symbolCode === symbolCode &&
          mapping.source === source &&
          (!sourceTable || mapping.sourceTable === sourceTable),
      )
      if (candidates.length === 0) {
        throw new Error(
          `[symbol-registry] no provider mapping in snapshot for symbol "${symbolCode}" and source "${source}"`,
        )
      }
      return selectMapping(candidates)
    },
  )
}
