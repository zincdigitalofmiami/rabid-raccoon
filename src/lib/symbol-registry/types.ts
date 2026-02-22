import type { DataSource } from '@prisma/client'

export type SymbolRoleKey = string

export interface RegistrySymbol {
  code: string
  displayName: string
  shortName: string | null
  description: string | null
  tickSize: number
  dataSource: DataSource
  dataset: string | null
  databentoSymbol: string | null
  fredSymbol: string | null
  isActive: boolean
}

export interface RegistryRoleMember {
  roleKey: SymbolRoleKey
  symbolCode: string
  position: number
  enabled: boolean
}

export interface RegistryProviderMapping {
  symbolCode: string
  source: DataSource
  sourceTable: string
  sourceSymbol: string
  isPrimary: boolean
  confidenceScore: number | null
  notes: string | null
}

export interface SymbolRegistrySnapshot {
  generatedAt: string
  primarySymbol: string
  symbols: RegistrySymbol[]
  roleMembers: RegistryRoleMember[]
  providerMappings: RegistryProviderMapping[]
}
