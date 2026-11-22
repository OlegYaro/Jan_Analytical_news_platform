import { homedir } from 'node:os'
import type { ResetSection } from '../../shared/api.ts'
import type { Settings } from '../../shared/types.ts'
import { defaultSettings } from './defaults.ts'
import { loadSettings, saveSettings } from './store.ts'
import type { StoreOptions } from './store.ts'

/** Возвращает к умолчаниям только поля раздела; остальное не трогает. */
export function resetSection(dir: string, section: ResetSection, opts: StoreOptions = {}): Settings {
  const cur = loadSettings(dir, opts)
  const def = defaultSettings(opts.homeDir ?? homedir())
  let next: Settings
  switch (section) {
    case 'search':
      next = { ...cur, topic: def.topic, perspective: def.perspective, newsEnabled: def.newsEnabled }
      break
    case 'schedule':
      // Все расписания заменяются одним стандартным (пн 08:00, все включённые страны).
      next = { ...cur, schedules: def.schedules, launchAtLogin: def.launchAtLogin, catchUpMissed: def.catchUpMissed }
      break
    case 'mail':
      // Настройки сервиса — к умолчанию; адрес и получатели очищаются; почта снова не проверена.
      next = { ...cur, reportLanguage: def.reportLanguage, failureAlerts: def.failureAlerts, mail: { ...def.mail, address: '', recipients: [], verified: false } }
      break
    case 'spend':
      next = { ...cur, preset: def.preset, limitPercent: def.limitPercent }
      break
    case 'folders':
      next = { ...cur, workspaceDir: def.workspaceDir }
      break
    case 'advanced':
      next = { ...cur, advanced: def.advanced }
      break
    case 'all':
      // Язык интерфейса не сбрасывается: иначе после «вернуть всё» окно внезапно сменит язык.
      next = { ...def, onboardingDone: cur.onboardingDone, uiLanguage: cur.uiLanguage }
      break
    default:
      return cur
  }
  saveSettings(dir, next)
  return next
}
