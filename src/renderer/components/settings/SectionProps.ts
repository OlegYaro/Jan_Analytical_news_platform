import type { Settings } from '../../../shared/types.ts'

export interface SectionProps {
  settings: Settings
  onSettings: (s: Settings) => void
  compact?: boolean
}
