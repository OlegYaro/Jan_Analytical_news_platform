import { join } from 'node:path'
import type { ScheduleEntry, Settings } from '../../shared/types.ts'
import { DEFAULT_PERSPECTIVE, DEFAULT_TOPIC } from '../../shared/types.ts'

export const SCHEMA_VERSION = 4

export function defaultWorkspaceDir(homeDir: string): string {
  return join(homeDir, 'RegWatch')
}

/** Расписание по умолчанию: понедельник 08:00, все включённые страны (docs/05 §6.2). */
export function defaultSchedule(): ScheduleEntry {
  return { id: 'main', name: 'Основная проверка', enabled: true, days: [1], time: '08:00', countries: [] }
}

export function defaultSettings(homeDir: string): Settings {
  return {
    topic: DEFAULT_TOPIC,
    perspective: DEFAULT_PERSPECTIVE,
    newsEnabled: true,
    schedules: [defaultSchedule()],
    uiLanguage: 'ru',
    launchAtLogin: true,
    catchUpMissed: true,
    mail: { service: 'gmail', address: '', recipients: [], server: '', port: 465, security: 'ssl', verified: false },
    reportLanguage: 'ru',
    failureAlerts: true,
    preset: 'balanced',
    limitPercent: 80,
    workspaceDir: defaultWorkspaceDir(homeDir),
    advanced: { stageModels: {}, timeoutsMin: {}, firstRunDays: 30, saveTranscripts: true, claudePath: '' },
    onboardingDone: false,
    schemaVersion: SCHEMA_VERSION,
  }
}
