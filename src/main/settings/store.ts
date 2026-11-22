import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings, SettingsPatch } from '../../shared/types.ts'
import { defaultSettings } from './defaults.ts'
import { migrateSettings } from './migrations.ts'
import { validateSettings } from './validate.ts'
import type { ValidationResult } from './validate.ts'

export const SETTINGS_FILE = 'settings.json'

export interface StoreOptions {
  /** Для вычисления рабочей папки по умолчанию; по умолчанию — домашняя папка. */
  homeDir?: string
}

export interface UpdateResult extends ValidationResult {
  settings: Settings
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Читает настройки; нет файла — создаёт из defaults; битый — переименовывает в .bak и возвращает defaults. */
export function loadSettings(dir: string, opts: StoreOptions = {}): Settings {
  const home = opts.homeDir ?? homedir()
  const file = join(dir, SETTINGS_FILE)
  if (!existsSync(file)) {
    const s = defaultSettings(home)
    mkdirSync(dir, { recursive: true })
    atomicWrite(file, JSON.stringify(s, null, 2) + '\n')
    return s
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not an object')
  } catch {
    try {
      renameSync(file, file + '.bak')
    } catch {
      /* ignore */
    }
    const s = defaultSettings(home)
    atomicWrite(file, JSON.stringify(s, null, 2) + '\n')
    return s
  }
  const migrated = migrateSettings(raw, home)
  if (JSON.stringify(migrated) !== JSON.stringify(raw)) atomicWrite(file, JSON.stringify(migrated, null, 2) + '\n')
  return migrated
}

export function saveSettings(dir: string, settings: Settings): void {
  mkdirSync(dir, { recursive: true })
  atomicWrite(join(dir, SETTINGS_FILE), JSON.stringify(settings, null, 2) + '\n')
}

/** Поля почты, смена которых требует нового тестового письма. */
export const MAIL_IDENTITY_KEYS = ['service', 'address', 'server', 'port', 'security'] as const

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Глубокое слияние: объекты сливаются, массивы заменяются, undefined пропускается. */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>, path = ''): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const cur = out[k]
    if (isObj(v) && isObj(cur)) {
      out[k] = merge(cur, v, path + k + '.')
    } else if (path === 'advanced.stageModels.' && v === '') {
      delete out[k] // пустая модель = вернуться к модели пресета
    } else {
      out[k] = v
    }
  }
  return out
}

/** Проверяет патч, сливает с текущими настройками и сохраняет. При ошибках ничего не пишет. */
export function updateSettings(dir: string, patch: SettingsPatch, opts: StoreOptions = {}): UpdateResult {
  const current = loadSettings(dir, opts)
  const res = validateSettings(patch, patch.uiLanguage === 'en' || (patch.uiLanguage === undefined && current.uiLanguage === 'en') ? 'en' : 'ru')
  if (!res.ok) return { ...res, settings: current }
  const patchRec = { ...(patch as Record<string, unknown>) }
  delete patchRec.schemaVersion
  const merged = merge(current as unknown as Record<string, unknown>, patchRec)
  const next = migrateSettings(merged, opts.homeDir ?? homedir())
  // Тестовое письмо подтверждало прежнюю конфигурацию почты: при её смене проверка снимается (CFG-14).
  if (patch.mail?.verified === undefined && MAIL_IDENTITY_KEYS.some((k) => next.mail[k] !== current.mail[k])) {
    next.mail.verified = false
  }
  saveSettings(dir, next)
  return { ok: true, errors: {}, settings: next }
}
