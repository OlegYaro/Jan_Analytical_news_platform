import type { DoctorCheck } from './doctor-types.ts'
import type { HistoryApi } from './history-types.ts'
import type { RunStartMode, RunStartOptions, RunStatusDto } from './run-types.ts'
import type { ScheduleStatusDto } from './schedule-types.ts'
import type { ActProposalDto, DiscoverResultDto, SourceCheckScope, SourceProposalDto, SourcesStatusDto } from './sources-types.ts'
import type { CatalogCountry, Country, Settings, SettingsPatch, SourceType } from './types.ts'

export interface SettingsUpdateResult {
  ok: boolean
  /** Путь поля → сообщение простыми словами. */
  errors: Record<string, string>
  settings: Settings
}

export interface CountriesResult {
  ok: boolean
  /** Имя поля → сообщение простыми словами. */
  errors: Record<string, string>
  countries: Country[]
}

export type ResetSection = 'search' | 'schedule' | 'mail' | 'spend' | 'folders' | 'advanced' | 'all'

export interface SourceInputDto {
  name?: string
  url: string
  type: SourceType
  language: string
  priority?: 'main' | 'extra'
  enabled?: boolean
  note?: string
}

export interface ActInputDto {
  title: string
  registrationNumber?: string
  url: string
}

export interface GateStatus {
  canRun: boolean
  canDryRun: boolean
  message: string
}

export interface RwApi {
  settings: {
    get(): Promise<Settings>
    update(patch: SettingsPatch): Promise<SettingsUpdateResult>
    /** Возвращает к умолчаниям только поля раздела. */
    resetSection(section: ResetSection): Promise<SettingsUpdateResult>
  }
  doctor: {
    run(): Promise<DoctorCheck[]>
  }
  workspace: {
    info(): Promise<{ dir: string; exists: boolean }>
    /** Открывает выбор папки; null — пользователь отменил. */
    choose(): Promise<string | null>
    openInFinder(): Promise<void>
  }
  secrets: {
    status(): Promise<{ mailPasswordSet: boolean }>
    /** Пароль только записывается; назад не возвращается. */
    setMailPassword(password: string): Promise<void>
  }
  countries: {
    list(): Promise<Country[]>
    catalog(): Promise<CatalogCountry[]>
    add(input: { code: string; name: string; languages: string[] }): Promise<CountriesResult>
    /** issuerClasses: null — вернуть стартовые правила органов. */
    update(code: string, patch: { name?: string; languages?: string[]; issuerClasses?: { class1: string[]; class2: string[] } | null }): Promise<CountriesResult>
    remove(code: string): Promise<CountriesResult>
    setActive(code: string, active: boolean): Promise<CountriesResult>
  }
  sources: {
    add(code: string, input: SourceInputDto): Promise<CountriesResult>
    update(code: string, id: string, patch: Partial<SourceInputDto>): Promise<CountriesResult>
    remove(code: string, id: string): Promise<CountriesResult>
    /**
     * Проверка источников (SRC-01..06) в фоне: один источник ({code, sourceId}), страна ({code}) или все ({all:true}).
     * Одновременно — одно задание; во время проверки изменений — отказ «Дождитесь окончания проверки».
     * Итог — в Source.state/stateReason/checkedAt/seenLatest (countries.list()) и в status().
     */
    check(scope: SourceCheckScope): Promise<{ ok: boolean; message: string }>
    status(): Promise<SourcesStatusDto>
    /** Подписка на ход проверки/поиска; возвращает функцию отписки. */
    onProgress(cb: (s: SourcesStatusDto) => void): () => void
    /**
     * Поиск (SRC-07/09): 'missing' — недостающие типы источников, 'watched' — основные законы (7 типов docs/08).
     * Возвращает только подтверждённые приложением предложения; ничего не добавляет.
     */
    discover(code: string, mode: 'missing' | 'watched'): Promise<DiscoverResultDto>
    /** «Добавить» предложенный источник (из последнего поиска по стране). */
    acceptSource(code: string, proposal: SourceProposalDto): Promise<CountriesResult>
    /** «Добавить» предложенный акт (из последнего поиска по стране). */
    acceptAct(code: string, proposal: ActProposalDto): Promise<CountriesResult>
  }
  acts: {
    add(code: string, input: ActInputDto): Promise<CountriesResult>
    update(code: string, id: string, patch: Partial<ActInputDto>): Promise<CountriesResult>
    remove(code: string, id: string): Promise<CountriesResult>
  }
  mail: {
    /** Тестовое письмо по сохранённым настройкам и паролю. */
    sendTest(): Promise<{ ok: boolean; message: string }>
  }
  gate: {
    status(): Promise<GateStatus>
  }
  run: {
    status(): Promise<RunStatusDto>
    start(mode: RunStartMode, opts?: RunStartOptions): Promise<{ ok: boolean; message: string }>
    /** Мягкая остановка: текущий шаг доделывается, состояние сохраняется. */
    stop(): Promise<{ ok: boolean; message: string }>
    /** Подписка на изменения состояния; возвращает функцию отписки. */
    onProgress(cb: (s: RunStatusDto) => void): () => void
  }
  schedule: {
    /** Ближайший запуск, последний старт и итоговые страны каждого расписания; какие ждут очереди. */
    status(): Promise<ScheduleStatusDto>
  }
  skills: {
    list(): Promise<string[]>
    /** Только чтение; имя должно быть из list(). */
    read(name: string): Promise<string>
  }
  app: {
    completeOnboarding(): Promise<void>
  }
  /** «История» (ARC-03, VER-04) и эталоны из приложения (HAL-07). */
  history: HistoryApi
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsResetSection: 'settings:resetSection',
  doctorRun: 'doctor:run',
  workspaceInfo: 'workspace:info',
  workspaceChoose: 'workspace:choose',
  workspaceOpenInFinder: 'workspace:openInFinder',
  secretsStatus: 'secrets:status',
  secretsSetMailPassword: 'secrets:setMailPassword',
  countriesList: 'countries:list',
  countriesCatalog: 'countries:catalog',
  countriesAdd: 'countries:add',
  countriesUpdate: 'countries:update',
  countriesRemove: 'countries:remove',
  countriesSetActive: 'countries:setActive',
  sourcesAdd: 'sources:add',
  sourcesUpdate: 'sources:update',
  sourcesRemove: 'sources:remove',
  sourcesCheck: 'sources:check',
  sourcesStatus: 'sources:status',
  sourcesProgress: 'sources:progress',
  sourcesDiscover: 'sources:discover',
  sourcesAcceptSource: 'sources:acceptSource',
  sourcesAcceptAct: 'sources:acceptAct',
  actsAdd: 'acts:add',
  actsUpdate: 'acts:update',
  actsRemove: 'acts:remove',
  mailSendTest: 'mail:sendTest',
  gateStatus: 'gate:status',
  runStatus: 'run:status',
  runStart: 'run:start',
  runStop: 'run:stop',
  runProgress: 'run:progress',
  scheduleStatus: 'schedule:status',
  skillsList: 'skills:list',
  skillsRead: 'skills:read',
  appCompleteOnboarding: 'app:completeOnboarding',
  historyList: 'history:list',
  historyCountry: 'history:country',
  historyOpen: 'history:open',
  historyAddCase: 'history:addCase',
  historyCases: 'history:cases',
} as const
