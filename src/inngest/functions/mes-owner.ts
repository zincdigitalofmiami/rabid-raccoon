export type MesHigherTfOwner = 'inngest' | 'worker'

const DEFAULT_MES_HIGHER_TF_OWNER: MesHigherTfOwner = 'inngest'

export function getMesHigherTfOwner(): MesHigherTfOwner {
  const raw = (process.env.MES_HIGHER_TF_OWNER || DEFAULT_MES_HIGHER_TF_OWNER)
    .trim()
    .toLowerCase()

  return raw === 'worker' ? 'worker' : 'inngest'
}

export function shouldSkipMesHigherTfInngest(): boolean {
  return getMesHigherTfOwner() === 'worker'
}
