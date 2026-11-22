import type { SettingsPatch, UiLanguage } from '../../shared/types.ts'
import { mt } from '../i18n.ts'
import { checkWorkspaceDir } from './workspace-dir.ts'
import { MAX_SCHEDULES, STAGE_KEYS } from '../../shared/types.ts'
import { SCHEDULE_COUNTRY_RE, SCHEDULE_ID_RE, SCHEDULE_NAME_MAX, SCHEDULE_TIME_RE } from '../../shared/schedule-types.ts'

export interface ValidationResult {
  ok: boolean
  /** Путь поля ('mail.address') → сообщение простыми словами. */
  errors: Record<string, string>
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const SERVICES = ['gmail', 'outlook', 'icloud', 'yandex', 'mailru', 'other']
const SECURITY = ['ssl', 'starttls', 'none']
const LANGS = ['ru', 'en', 'both_one', 'both_two']
const PRESETS = ['economy', 'balanced', 'max']
const UI_LANGS = ['ru', 'en']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Список расписаний приходит целиком (патч массива заменяет его). Ошибки — по ключам schedules.<i>.<поле>. */
function validateSchedules(list: unknown, e: Record<string, string>, L: UiLanguage): void {
  if (!Array.isArray(list) || list.length === 0) {
    e.schedules = mt(L, 'Нужно хотя бы одно расписание.', 'At least one schedule is required.')
    return
  }
  if (list.length > MAX_SCHEDULES) {
    e.schedules = mt(L, `Расписаний может быть не больше ${MAX_SCHEDULES}. Удалите лишние.`, `No more than ${MAX_SCHEDULES} schedules are allowed. Remove the extra ones.`)
    return
  }
  const ids = new Set<string>()
  list.forEach((item: unknown, i: number) => {
    const k = `schedules.${i}`
    if (!isObj(item)) {
      e[k] = mt(L, 'Расписание заполнено неверно. Удалите его и создайте заново.', 'The schedule is filled in incorrectly. Delete it and create it again.')
      return
    }
    if (typeof item.id !== 'string' || !SCHEDULE_ID_RE.test(item.id)) e[`${k}.id`] = mt(L, 'Внутренняя ошибка расписания. Удалите его и создайте заново.', 'Internal schedule error. Delete it and create it again.')
    else if (ids.has(item.id)) e[`${k}.id`] = mt(L, 'Два расписания перепутались. Удалите одно из них и создайте заново.', 'Two schedules got mixed up. Delete one of them and create it again.')
    else ids.add(item.id)
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (name === '') e[`${k}.name`] = mt(L, 'Дайте расписанию название, например «Центральная Азия, понедельник».', 'Give the schedule a name, for example "Central Asia, Monday".')
    else if (name.length > SCHEDULE_NAME_MAX) e[`${k}.name`] = mt(L, `Название слишком длинное: не больше ${SCHEDULE_NAME_MAX} знаков.`, `The name is too long: at most ${SCHEDULE_NAME_MAX} characters.`)
    if (typeof item.enabled !== 'boolean') e[`${k}.enabled`] = mt(L, 'Укажите, включено ли расписание.', 'Specify whether the schedule is enabled.')
    const d = item.days
    if (!Array.isArray(d) || d.length === 0) e[`${k}.days`] = mt(L, 'Выберите хотя бы один день недели.', 'Choose at least one day of the week.')
    else if (d.some((x) => !Number.isInteger(x) || (x as number) < 0 || (x as number) > 6)) e[`${k}.days`] = mt(L, 'Выберите дни недели из списка.', 'Choose days of the week from the list.')
    if (typeof item.time !== 'string' || !SCHEDULE_TIME_RE.test(item.time)) e[`${k}.time`] = mt(L, 'Введите время в виде часы:минуты, например 08:00.', 'Enter the time as hours:minutes, for example 08:00.')
    const c = item.countries
    if (!Array.isArray(c)) e[`${k}.countries`] = mt(L, 'Выберите страны из списка или оставьте «все включённые страны».', 'Choose countries from the list or leave "all enabled countries".')
    else if (c.some((x) => typeof x !== 'string' || !SCHEDULE_COUNTRY_RE.test(x))) e[`${k}.countries`] = mt(L, 'Выберите страны из списка.', 'Choose countries from the list.')
    else if (new Set(c).size !== c.length) e[`${k}.countries`] = mt(L, 'Одна и та же страна выбрана дважды.', 'The same country is selected twice.')
  })
}

export function isEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim())
}

/** Проверяет только те поля, что присутствуют (для полного объекта Settings — все). */
export function validateSettings(p: SettingsPatch, L: UiLanguage = 'ru'): ValidationResult {
  const e: Record<string, string> = {}

  if (p.topic !== undefined && (typeof p.topic !== 'string' || p.topic.trim() === '')) {
    e.topic = mt(L, 'Опишите, какие изменения вас интересуют. Поле не может быть пустым.', 'Describe which changes interest you. The field cannot be empty.')
  }
  if (p.perspective !== undefined && (typeof p.perspective !== 'string' || p.perspective.trim() === '')) {
    e.perspective = mt(L, 'Укажите, для кого оценивать значимость изменений. Поле не может быть пустым.', 'Specify for whom to assess the significance of changes. The field cannot be empty.')
  }
  if (p.schedules !== undefined) validateSchedules(p.schedules, e, L)
  if (p.uiLanguage !== undefined && !UI_LANGS.includes(p.uiLanguage)) e.uiLanguage = mt(L, 'Выберите язык интерфейса: русский или английский.', 'Choose the interface language: Russian or English.')
  if (p.limitPercent !== undefined) {
    const v = p.limitPercent
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 10 || v > 100) e.limitPercent = mt(L, 'Выберите значение от 10 до 100 процентов.', 'Choose a value from 10 to 100 percent.')
  }
  if (p.preset !== undefined && !PRESETS.includes(p.preset)) e.preset = mt(L, 'Выберите один из режимов: экономно, сбалансировано или максимальная точность.', 'Choose one of the modes: economy, balanced or maximum accuracy.')
  if (p.reportLanguage !== undefined && !LANGS.includes(p.reportLanguage)) e.reportLanguage = mt(L, 'Выберите язык отчёта из списка.', 'Choose the report language from the list.')
  if (p.workspaceDir !== undefined) {
    const w = checkWorkspaceDir(p.workspaceDir as string, undefined, undefined, L)
    if (w) e.workspaceDir = w
  }

  const m = p.mail
  if (m) {
    if (m.service !== undefined && !SERVICES.includes(m.service)) e['mail.service'] = mt(L, 'Выберите почтовый сервис из списка.', 'Choose a mail service from the list.')
    if (m.address !== undefined) {
      if (typeof m.address !== 'string' || m.address.trim() === '') e['mail.address'] = mt(L, 'Укажите ваш адрес электронной почты.', 'Enter your e-mail address.')
      else if (!isEmail(m.address)) e['mail.address'] = mt(L, 'Похоже, в адресе ошибка. Он должен выглядеть так: name@example.com.', 'The address looks wrong. It should look like this: name@example.com.')
    }
    if (m.recipients !== undefined) {
      const r = m.recipients
      if (!Array.isArray(r) || r.length === 0 || r.every((x) => typeof x !== 'string' || x.trim() === '')) {
        e['mail.recipients'] = mt(L, 'Укажите хотя бы один адрес, куда отправлять отчёты.', 'Enter at least one address to send reports to.')
      } else {
        const bad = r.filter((x) => typeof x !== 'string' || !isEmail(x))
        if (bad.length > 0) e['mail.recipients'] = mt(L, `Проверьте адреса получателей: ${bad.map(String).join(', ')}.`, `Check the recipient addresses: ${bad.map(String).join(', ')}.`)
      }
    }
    if (m.server !== undefined && typeof m.server !== 'string') e['mail.server'] = mt(L, 'Укажите адрес почтового сервера.', 'Enter the mail server address.')
    if (m.service === 'other' && m.server !== undefined && String(m.server).trim() === '') e['mail.server'] = mt(L, 'Укажите адрес почтового сервера, например mail.example.com.', 'Enter the mail server address, for example mail.example.com.')
    if (m.port !== undefined && (!Number.isInteger(m.port) || (m.port as number) < 1 || (m.port as number) > 65535)) {
      e['mail.port'] = mt(L, 'Номер порта — целое число от 1 до 65535, например 465.', 'The port number is a whole number from 1 to 65535, for example 465.')
    }
    if (m.security !== undefined && !SECURITY.includes(m.security)) e['mail.security'] = mt(L, 'Выберите способ защиты соединения из списка.', 'Choose the connection security method from the list.')
  }

  const a = p.advanced
  if (a) {
    if (a.firstRunDays !== undefined && (!Number.isInteger(a.firstRunDays) || (a.firstRunDays as number) < 1 || (a.firstRunDays as number) > 365)) {
      e['advanced.firstRunDays'] = mt(L, 'Укажите число дней от 1 до 365.', 'Enter a number of days from 1 to 365.')
    }
    if (a.claudePath !== undefined && typeof a.claudePath !== 'string') e['advanced.claudePath'] = mt(L, 'Укажите путь к Claude Code или оставьте поле пустым.', 'Enter the path to Claude Code or leave the field empty.')
    if (a.timeoutsMin) {
      for (const k of STAGE_KEYS) {
        const v = a.timeoutsMin[k]
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 120)) {
          e[`advanced.timeoutsMin.${k}`] = mt(L, 'Укажите время ожидания в минутах, от 1 до 120.', 'Enter the timeout in minutes, from 1 to 120.')
        }
      }
    }
  }

  return { ok: Object.keys(e).length === 0, errors: e }
}
