import { Inngest } from 'inngest'
import { normalizeServerEnv } from '@/lib/server-env'

// Inngest client — ID must remain "rabid-raccoon" for project isolation
normalizeServerEnv()
export const inngest = new Inngest({ id: 'rabid-raccoon' })
