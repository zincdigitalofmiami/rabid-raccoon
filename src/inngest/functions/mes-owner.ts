export type MesHigherTfOwner = 'inngest' | 'worker'
export type Mes1mOwner = 'inngest' | 'worker'

const DEFAULT_MES_HIGHER_TF_OWNER: MesHigherTfOwner = 'inngest'
const DEFAULT_MES_1M_OWNER: Mes1mOwner = 'inngest'

export function getMesHigherTfOwner(): MesHigherTfOwner {
  const raw = (process.env.MES_HIGHER_TF_OWNER || DEFAULT_MES_HIGHER_TF_OWNER)
    .trim()
    .toLowerCase()

  return raw === 'worker' ? 'worker' : 'inngest'
}

export function shouldSkipMesHigherTfInngest(): boolean {
  return getMesHigherTfOwner() === 'worker'
}

export function getMes1mOwner(): Mes1mOwner {
  const raw = (
    process.env.MES_1M_OWNER ||
    process.env.MES_HIGHER_TF_OWNER ||
    DEFAULT_MES_1M_OWNER
  )
    .trim()
    .toLowerCase()

  return raw === 'worker' ? 'worker' : 'inngest'
}

export function shouldSkipMes1mInngest(): boolean {
  return getMes1mOwner() === 'worker'
}
