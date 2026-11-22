import type { RwApi } from '../shared/api.ts'

declare global {
  interface Window {
    rw: RwApi
  }
}
