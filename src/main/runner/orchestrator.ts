// Оркестратор прогона (docs/02 §4). Это КОД, а не модель (NFR-04): порядок стран, статусы,
// повторы, полнота и круги проверки решает TypeScript; модель вызывается только через
// инъецированные исполнители этапов. Без импорта electron: всё внешнее — через OrchestratorDeps.
//
// Главные правила:
// - страны идут по одной, по порядку; сбой страны не останавливает остальные (T-13);
// - состояние пишется в run.json атомарно до и после каждого шага, поэтому прогон продолжается
//   с той страны, того этапа и того акта, где прервался, без повторения сделанного (RUN-06);
// - один акт — один вызов analyze (NFR-05); канал А всегда идёт в анализ;
// - полнота triage считается кодом (HAL-04): нарушение → один повтор этапа → `failed:completeness`;
// - этап без результата → `failed:<причина раннера>`; свой повтор поверх повтора раннера не делаем (COV-03);
// - ошибка лимита или порог бюджета (budget.ts) → пауза (`paused_until`), прогон не завершается (NFR-06);
//   автопродолжение по таймеру — src/main/auto-resume.ts + index.ts. Сброс дальше 6 ч (недельный лимит) — `failed:limit`;
// - журнал отправленного оркестратор НЕ пишет: в result.json кладётся только «что закоммитить»
//   (COMMIT — после успешной отправки, фаза 7).

import type { UiLanguage } from '../../shared/types.ts';
import { langOf, mt } from '../i18n.ts';
import { translateMsg } from './messages-en.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Country, Settings } from '../../shared/types.ts';
import type {
  CountryRun,
  CountryStatus,
  ScreenFinal,
  CurrentActivity,
  ISODate,
  LedgerEntry,
  RunMode,
  RunState,
  StageName,
  Usage,
} from '../../shared/run-types.ts';
import type { Card, NewsSweep, ReasonCode, ScreenOutput, TriageOutput, Verification } from '../../shared/schema-types.ts';
import type {
  Candidate,
  CandidatesFile,
  CollectOutput,
  CommitItem,
  CountryResult,
  ForInfoItem,
  ModelStage,
  Outcome,
  ProcessLog,
  ResultItem,
  RunReport,
  StartResult,
  UnverifiedItem,
} from '../../shared/pipeline-types.ts';
import { actDir, actPaths, appendLog, countryDir, countryPaths } from '../archive.ts';
import { recordSourceCount } from '../checks/anomaly.ts';
import { accountingTotals, checkCompleteness, completenessFailure } from '../checks/completeness.ts';
import type { CompletenessResult } from '../checks/completeness.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';
import { classify, filterCandidates, ledgerKey, loadLedger, shouldWriteLedger } from '../ledger.ts';
import { classifyIssuer, issuerRulesFor } from '../collect/issuer-class.ts';
import { guardRun } from '../mail-gate.ts';
import type { GateStatus } from '../mail-gate.ts';
import type { StageResult } from './claude-runner.ts';
import { SCREEN_BATCH, afterConfirm, afterScreen, normalizeScreenOutput, routeCandidate, type Decided, type ScreenPrep } from './screen.ts';
import type { StageInvocation } from './stage-profiles.ts';
import { CountryFailure, PauseSignal, StopSignal, WEEKLY_LIMIT_FAILURE } from './signals.ts';
import {
  addUsage,
  createRun,
  findUnfinishedRun,
  finishRun,
  loadRun,
  markAct,
  markStage,
  resumePlan,
  saveRun,
  setCountryStatus,
  setCurrent,
} from './run-state.ts';

export type * from '../../shared/pipeline-types.ts';
export { CountryFailure, PauseSignal, StopSignal, WEEKLY_LIMIT_FAILURE } from './signals.ts';

// ---------------------------------------------------------------------------------------------
// Контракт исполнителей этапов и хуков
// ---------------------------------------------------------------------------------------------

/** Что получает каждый исполнитель этапа. Данных других стран здесь нет (SKL-03). */
export interface StageContext {
  runId: string;
  runDir: string;
  workspaceDir: string;
  /** Папка страны в прогоне (существует). */
  countryDir: string;
  country: Country;
  mode: RunMode;
  window: { from: ISODate; to: ISODate };
  settings: Settings;
  /** Папка акта — только для analyze/checkEvidence (создана заранее). */
  actDir?: string;
  /** Повтор этапа оркестратором: сейчас только полнота triage (HAL-04). */
  retry?: { reason: 'completeness'; message: string; details: CompletenessResult };
}

/** HAL-02/03: проверка цитат карточки (фаза 5). */
export interface EvidenceResult {
  ok: boolean;
  failedFields: string[];
}

export type VerificationField = Verification['cards'][number]['fields'][number];

/** Карточка, которую оркестратор передаёт на VERIFY. */
export interface VerifyCardInput {
  candidate: Candidate;
  card: Card;
  /** Поля, не прошедшие проверку цитат: карточка идёт в VERIFY «с пометкой». */
  evidenceFailedFields: string[];
  /** Номер круга проверки этой карточки (1 или 2). */
  round: number;
}

/** Отброшенный на triage кандидат: верификатор может вернуть его (VER-02). */
export interface RejectedCandidate {
  candidate: Candidate;
  reason_code: ReasonCode | null;
  reason_text: string;
}

/** Замечания проверяющего для повторного анализа (VER-03). */
export interface ReviewerNotes {
  /** Круг проверки, по итогам которого сделаны замечания. */
  round: number;
  /** Поля со статусом mismatch/unverifiable (с correct_value, цитатой и комментарием). */
  fields: VerificationField[];
  evidenceFailedFields: string[];
}

export type NewsLead = NewsSweep['leads'][number];
export type WatchedCheck = Verification['watched_acts_check'][number];

/** Подсказка, которую код может превратить в кандидата, найдя акт в первичном источнике. */
export type LeadHint = { kind: 'news'; lead: NewsLead } | { kind: 'watched_edition'; check: WatchedCheck };

/** Исполнители этапов (в проде — сборщик и claude-runner; в тестах — заглушки). */
export interface StageExecutors {
  collect(ctx: StageContext): Promise<Outcome<CollectOutput>>;
  /** Новости — только подсказки; кандидата из них создаёт лишь resolveLead. */
  news?(ctx: StageContext, known: Candidate[]): Promise<Outcome<NewsSweep>>;
  /** Код ищет акт из подсказки в первичной правовой базе; null — не найден. */
  resolveLead?(ctx: StageContext, lead: LeadHint, known: Candidate[]): Promise<Candidate | null>;
  triage(ctx: StageContext, candidates: Candidate[]): Promise<Outcome<TriageOutput>>;
  analyze(ctx: StageContext, candidate: Candidate, reviewerNotes?: ReviewerNotes): Promise<Outcome<Card>>;
  checkEvidence?(ctx: StageContext, candidate: Candidate, card: Card): Promise<EvidenceResult>;
  verify(ctx: StageContext, cards: VerifyCardInput[], rejected: RejectedCandidate[]): Promise<Outcome<Verification>>;
  /**
   * Экран по тексту (SCR). Оба метода нужны вместе; без них отобранные идут прямо в анализ, как раньше.
   * prepareScreen: снимок страницы (с PDF, если надо), банковские термины и фрагменты текста — всё кодом.
   */
  prepareScreen?(ctx: StageContext, candidate: Candidate): Promise<{ ok: true; prep: ScreenPrep } | { ok: false; message: string }>;
  /** Один вызов модели по пакету кандидатов: режим `screen` или `confirm` (перепроверка сильнее). */
  screen?(ctx: StageContext, items: ScreenInputItem[], mode: 'screen' | 'confirm'): Promise<Outcome<ScreenOutput>>;
}

/** Кандидат для экрана: реквизиты, подготовленные кодом фрагменты и (в перепроверке) прежнее решение. */
export interface ScreenInputItem {
  candidate: Candidate;
  prep: ScreenPrep;
  previous?: { decision: string; reason: string };
}

export interface OrchestratorDeps {
  executors: StageExecutors;
  /** Перед каждым процессом модели (фаза 8 повесит сюда паузу по доле лимита). */
  budget?: { beforeProcess(): Promise<void> };
  /** Не давать Mac уснуть на время прогона (RUN-05). */
  powerSave?: { start(): void; stop(): void };
  /** Шаги 7–10 (DIGEST/TRANSLATE/SEND/COMMIT, фаза 7). Должен быть идемпотентным: при сбое повторится. */
  finalize?(report: RunReport): Promise<void>;
  /** Копия состояния после каждой записи run.json (для экрана «Прогон»). */
  onProgress?(state: RunState): void;
  now?(): Date;
}

export interface StartOptions {
  mode: RunMode;
  /** Все страны; запускаются только включённые (CTY-07). */
  countries: Country[];
  settings: Settings;
  /** Гейт почты (evaluateGate): без проверенной почты запускается только dry_run (CFG-14). */
  gate: GateStatus;
  windowOverride?: { from: ISODate; to: ISODate };
  /** «Проверить сейчас» одну страну (RUN-02). */
  onlyCountries?: string[];
  skillsHash?: string;
}

export interface ResumeOptions {
  countries: Country[];
  settings: Settings;
  /** Явная папка прогона (в т.ч. остановленного пользователем). По умолчанию — findUnfinishedRun. */
  runDir?: string;
}

// ---------------------------------------------------------------------------------------------
// Константы и вспомогательные функции
// ---------------------------------------------------------------------------------------------

/** VER-03: не больше 2 кругов проверки на карточку. */
export const MAX_VERIFY_ROUNDS = 2;
/** Пауза по лимиту, если CLI не сообщил время сброса (docs/02 §8). */
export const DEFAULT_LIMIT_PAUSE_MS = 30 * 60_000;
/**
 * Самая длинная пауза по лимиту. 5-часовое окно сбрасывается не позже чем через 5 ч; сброс дальше 6 ч означает
 * недельный лимит — такую паузу не ждём (дни), страна получает `failed:limit` (docs/02 §8).
 */
export const MAX_LIMIT_PAUSE_MS = 6 * 3600_000;

const STAGE_LABEL_EN: Record<StageName, string> = {
  collect: 'Document collection',
  news: 'News search',
  triage: 'Candidate selection',
  screen: 'Text screening',
  analyze: 'Act analysis',
  verify: 'Report verification',
};

const STAGE_LABEL: Record<StageName, string> = {
  collect: 'Сбор документов',
  news: 'Поиск в новостях',
  triage: 'Отбор кандидатов',
  screen: 'Экран по тексту',
  analyze: 'Анализ акта',
  verify: 'Проверка отчёта',
};

const FINAL_VERDICTS = new Set(['confirmed', 'unconfirmed']);

/**
 * Ключевые поля карточки (VER-03): номера, даты, вступление, переходный период, ссылки и сами изменения.
 * Расхождение в них — повод для второго круга; в остальных (охват, число изменений, названия) — нет.
 */
const KEY_FIELD = /^(act\.(number|registration_number|adoption_date|registration_date|publication_date|effective_date|transition_period)|links\.|changes\b)/;
export const isKeyField = (field: string): boolean => KEY_FIELD.test(field.trim());

/** Обоснование возврата отброшенного (VER-02): не пустое и не «на всякий случай». */
const GENERIC_RETURN = /^(just in case|may be relevant|might be relevant|could be relevant|possibly relevant|to be safe|на всякий случай|возможно)/i;
export function hasReturnReason(reason: string | undefined): boolean {
  const r = (reason ?? '').trim();
  return r.length >= 20 && !GENERIC_RETURN.test(r);
}

/** Файл итога страны. */
export const countryResultFile = (cdir: string): string => join(cdir, 'result.json');
/** Служебный файл оркестратора по акту: итог кругов проверки и замечания для повторного анализа. */
export const actReviewFile = (adir: string): string => join(adir, 'review.json');

/** Итог проверки акта (review.json). */
export interface ActReview {
  round: number;
  verdict: 'confirmed' | 'needs_correction' | 'unconfirmed' | 'pending';
  disputed_fields: string[];
  notes: ReviewerNotes;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Дата `YYYY-MM-DD` по местному времени. */
export function isoLocalDate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Окно поиска страны (RUN-09): с даты последнего успешного прогона страны
 * (state/last_success.json), для первой проверки — firstRunDays дней назад; по сегодня.
 */
export function computeWindow(
  workspaceDir: string,
  code: string,
  settings: Pick<Settings, 'advanced'>,
  now: Date,
  override?: { from: ISODate; to: ISODate },
): { from: ISODate; to: ISODate } {
  if (override) return { ...override };
  let from: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(join(workspaceDir, 'state', 'last_success.json'), 'utf8')) as Record<string, unknown>;
    const v = raw?.[code];
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) from = isoLocalDate(new Date(v));
  } catch {
    /* нет файла или он битый — как первая проверка */
  }
  if (!from) {
    const d = new Date(now);
    d.setDate(d.getDate() - (settings.advanced?.firstRunDays ?? 30));
    from = isoLocalDate(d);
  }
  return { from, to: isoLocalDate(now) };
}

/** Текст ошибки без стектрейса (первая строка). */
function errText(e: unknown, L: UiLanguage = 'ru'): string {
  const s = e instanceof Error ? e.message : String(e);
  return (s.split('\n')[0] ?? '').trim() || mt(L, 'неизвестная ошибка', 'unknown error');
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return readJson<T>(file);
  } catch {
    return fallback;
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Расход из ответа `claude -p` (поле usage события result) в формат RunState. */
export function usageFromRunner(usage: Record<string, unknown> | null | undefined, costUsd: number | null | undefined): Usage {
  const u = usage ?? {};
  return {
    input: num(u['input_tokens']),
    output: num(u['output_tokens']),
    cache_read: num(u['cache_read_input_tokens']),
    cache_write: num(u['cache_creation_input_tokens']),
    cost_usd: num(costUsd),
  };
}

/** Перевод результата claude-runner в Outcome (для боевых исполнителей этапов). */
export function outcomeFromStage<T>(res: StageResult, inv: Pick<StageInvocation, 'stage' | 'model'>, act?: string): Outcome<T> {
  const tokens = usageFromRunner(res.usage ?? null, res.costUsd ?? null);
  const proc: ProcessLog = {
    stage: inv.stage as ModelStage,
    model: inv.model,
    durationMs: res.durationMs,
    tokens,
    exitCode: res.exitCode,
    attempts: res.attempts,
    ...(act ? { act } : {}),
    ...(res.ok ? {} : { failure: res.failure }),
    ...(res.denied.length ? { denied: res.denied.map((d) => d.tool) } : {}),
  };
  if (res.ok) return { ok: true, output: res.output as T, usage: tokens, processes: [proc] };
  return {
    ok: false,
    failure: res.failure,
    message: res.message,
    ...(res.resetsAt ? { resetsAt: res.resetsAt } : {}),
    usage: tokens,
    processes: [proc],
  };
}

/** Читает итоги стран (result.json) и карточки — вход для шагов 7–10. */
export function loadRunReport(runDirPath: string, state: RunState): RunReport {
  const countries: RunReport['countries'] = [];
  for (const code of Object.keys(state.countries)) {
    const cdir = join(runDirPath, code);
    const file = countryResultFile(cdir);
    if (!existsSync(file)) continue;
    const r = readJson<CountryResult>(file);
    const cards: Record<string, Card> = {};
    for (const it of r.items) {
      try {
        cards[it.candidate_id] = readJson<Card>(join(cdir, it.card_file));
      } catch {
        /* карточка пропала — дайджест покажет без неё */
      }
    }
    countries.push({ ...r, cards });
  }
  return { runDir: runDirPath, state, countries };
}

// Сигналы (PauseSignal, StopSignal, CountryFailure) — в signals.ts: их же бросает бюджет лимита (budget.ts).

const isFinalStatus = (s: CountryStatus): boolean => s !== 'pending' && s !== 'running';

// ---------------------------------------------------------------------------------------------
// Один прогон
// ---------------------------------------------------------------------------------------------

class RunSession {
  readonly dir: string;
  readonly state: RunState;
  readonly ws: string;
  private readonly deps: OrchestratorDeps;
  private readonly ex: StageExecutors;
  private readonly settings: Settings;
  /** Русский или английский вариант текста для окна «Прогон» (по Settings.uiLanguage); журнал разбора остаётся русским. */
  private tt(ru: string, en: string): string {
    return mt(langOf(this.settings), ru, en);
  }
  private msg(text: string): string {
    return translateMsg(text, langOf(this.settings));
  }
  private stageLabel(stage: StageName): string {
    return this.tt(STAGE_LABEL[stage], STAGE_LABEL_EN[stage]);
  }
  private readonly countries: Map<string, Country>;
  private readonly stopRequested: () => boolean;

  constructor(o: {
    dir: string;
    state: RunState;
    deps: OrchestratorDeps;
    settings: Settings;
    countries: Country[];
    stopRequested: () => boolean;
  }) {
    this.dir = o.dir;
    this.state = o.state;
    // run.json лежит в <рабочая папка>/runs/<id>/
    this.ws = resolve(o.dir, '..', '..');
    this.deps = o.deps;
    this.ex = o.deps.executors;
    this.settings = o.settings;
    this.countries = new Map(o.countries.map((c) => [c.code, c]));
    this.stopRequested = o.stopRequested;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Атомарная запись run.json и уведомление экрана. */
  private save(): void {
    saveRun(this.dir, this.state);
    if (this.deps.onProgress) {
      try {
        this.deps.onProgress(structuredClone(this.state));
      } catch {
        /* ошибка экрана не ломает прогон */
      }
    }
  }

  private cdir(code: string): string {
    return countryDir(this.ws, this.state.id, code);
  }

  private country(code: string): CountryRun {
    return this.state.countries[code]!;
  }

  /** Запись в log.jsonl страны (NFR-13). Ошибка записи лога прогон не роняет. */
  private log(code: string, event: string, text: string, data: Record<string, unknown> = {}): void {
    try {
      appendLog(this.cdir(code), { ts: this.now().toISOString(), country: code, event, text, ...data });
    } catch {
      /* диск недоступен — состояние всё равно в run.json */
    }
  }

  /** Лог уровня прогона: runs/<id>/log.jsonl. */
  private runLog(event: string, text: string, data: Record<string, unknown> = {}): void {
    try {
      appendLog(this.dir, { ts: this.now().toISOString(), event, text, ...data });
    } catch {
      /* см. log() */
    }
  }

  private current(code: string, stage: CurrentActivity['stage'], text: string, act?: string): void {
    setCurrent(this.state, { country: code, stage, text, ...(act ? { act } : {}) });
  }

  private addWarning(code: string, text: string): void {
    const c = this.country(code);
    const list = c.warnings ?? [];
    if (!list.includes(text)) c.warnings = [...list, text];
  }

  private checkStop(): void {
    if (this.stopRequested()) throw new StopSignal(this.tt('Остановлено пользователем', 'Stopped by the user'));
  }

  private ctx(code: string, country: Country): StageContext {
    const cdir = this.cdir(code);
    mkdirSync(cdir, { recursive: true });
    return {
      runId: this.state.id,
      runDir: this.dir,
      workspaceDir: this.ws,
      countryDir: cdir,
      country,
      mode: this.state.mode,
      window: this.country(code).window,
      settings: this.settings,
    };
  }

  /** Журнал отправленного для фильтра и классификации. В ретро-режиме не учитывается: нужен весь период. */
  private ledgerFor(code: string): LedgerEntry[] {
    return this.state.mode === 'backfill' ? [] : loadLedger(this.ws, code);
  }

  // ----- прогон целиком -----

  async execute(): Promise<StartResult> {
    const s = this.state;
    const resumed = !!s.paused_until || !!s.stopped || Object.values(s.countries).some((c) => c.status !== 'pending');
    delete s.paused_until;
    delete s.stopped;
    this.save();
    this.runLog(resumed ? 'run_resume' : 'run_start', resumed ? 'Прогон продолжен с места остановки' : 'Прогон начат', {
      mode: s.mode,
      countries: Object.keys(s.countries),
    });
    try {
      for (const code of Object.keys(s.countries)) {
        this.checkStop();
        await this.processCountry(code);
      }
    } catch (e) {
      if (e instanceof PauseSignal) {
        s.paused_until = e.until;
        setCurrent(s, undefined);
        this.save();
        this.runLog('run_paused', `Прогон на паузе до ${e.until}: ${e.message}`, { paused_until: e.until });
        return { ok: true, end: 'paused', runDir: this.dir, state: structuredClone(s) };
      }
      if (e instanceof StopSignal) {
        s.stopped = true;
        setCurrent(s, undefined);
        this.save();
        this.runLog('run_stopped', 'Прогон остановлен пользователем; состояние сохранено');
        return { ok: true, end: 'stopped', runDir: this.dir, state: structuredClone(s) };
      }
      throw e;
    }

    // COV-02: прогон завершён, только когда у каждой страны есть итоговый статус.
    const open = Object.entries(s.countries).filter(([, c]) => !isFinalStatus(c.status)).map(([k]) => k);
    if (open.length) throw new Error(this.tt(`Не у всех стран есть итоговый статус: ${open.join(', ')}`, `Not every country has a final status: ${open.join(', ')}`));

    if (this.deps.finalize) {
      try {
        await this.deps.finalize(loadRunReport(this.dir, s));
      } catch (e) {
        this.runLog('finalize_error', `Ошибка на шагах дайджеста/отправки: ${errText(e)}`);
      }
    }
    finishRun(s, this.now());
    this.save();
    this.runLog('run_finished', 'Прогон завершён', {
      statuses: Object.fromEntries(Object.entries(s.countries).map(([k, c]) => [k, c.status])),
    });
    return { ok: true, end: 'finished', runDir: this.dir, state: structuredClone(s) };
  }

  // ----- одна страна -----

  private async processCountry(code: string): Promise<void> {
    const plan = resumePlan(this.state).find((p) => p.code === code)!;
    if (plan.skip) return;
    const c = this.country(code);
    try {
      const country = this.countries.get(code);
      if (!country) throw new CountryFailure('missing', this.tt(`Страны ${code} больше нет в списке стран — проверить её нельзя`, `Country ${code} is no longer in the country list — it cannot be checked`));
      const resumedHere = c.status === 'running';
      setCountryStatus(this.state, code, 'running');
      this.save();
      this.log(code, resumedHere ? 'country_resume' : 'country_start', resumedHere ? `Продолжение с этапа «${STAGE_LABEL[plan.nextStage ?? 'collect']}»` : 'Страна начата', {
        window: c.window,
        next_stage: plan.nextStage,
      });
      const ctx = this.ctx(code, country);

      let cands = plan.stages.collect === 'run' ? await this.collect(code, ctx) : this.readCandidates(code).candidates;
      if (plan.stages.news === 'run') cands = await this.news(code, ctx, cands);

      if (cands.length === 0) {
        // NFR-07: страна без кандидатов — 0 вызовов модели на шагах 3–5.
        for (const st of ['triage', 'analyze', 'verify'] as const) {
          if (c.stages[st].state !== 'done') markStage(this.state, code, st, { state: 'skipped' });
        }
        this.save();
        this.log(code, 'no_candidates', 'Кандидатов нет: отбор, анализ и проверка пропущены (0 вызовов модели)');
      } else {
        if (plan.stages.triage === 'run') await this.triage(code, ctx, cands);
        if (plan.stages.screen === 'run') await this.screenStage(code, ctx, cands);
        if (plan.stages.analyze === 'run') await this.analyzeStage(code, ctx, cands);
        if (plan.stages.verify === 'run') await this.verifyStage(code, ctx, cands);
      }
      this.finishCountry(code, cands);
    } catch (e) {
      if (e instanceof PauseSignal || e instanceof StopSignal) {
        this.revertRunning(code);
        this.log(code, e instanceof PauseSignal ? 'paused' : 'stopped', e instanceof PauseSignal ? `Пауза по лимиту до ${e.until}` : 'Остановлено пользователем');
        throw e;
      }
      const f = e instanceof CountryFailure ? e : new CountryFailure('internal', this.tt(`Внутренняя ошибка: ${errText(e)}`, `Internal error: ${errText(e, langOf(this.settings))}`));
      this.failCountry(code, f);
    }
  }

  /** Прерванный (не сделанный) шаг возвращается в «ждёт», чтобы resume начал его заново. */
  private revertRunning(code: string): void {
    const c = this.country(code);
    for (const [st, v] of Object.entries(c.stages)) if (v.state === 'running') markStage(this.state, code, st as StageName, { state: 'pending' });
    for (const [id, a] of Object.entries(c.acts)) if (a.analyze === 'running') markAct(this.state, code, id, { analyze: 'pending' });
    this.save();
  }

  private failCountry(code: string, f: CountryFailure): void {
    const c = this.country(code);
    let stage: StageName | undefined;
    for (const [st, v] of Object.entries(c.stages)) {
      if (v.state === 'running') {
        stage = st as StageName;
        markStage(this.state, code, stage, { state: 'failed', error: f.message });
      }
    }
    for (const [id, a] of Object.entries(c.acts)) if (a.analyze === 'running') markAct(this.state, code, id, { analyze: 'failed' });
    const status: CountryStatus = `failed:${f.code}`;
    const result: CountryResult = {
      country: code,
      status,
      error: f.message,
      items: [],
      duplicates: [],
      warnings: c.warnings ?? [],
      to_commit: [],
    };
    try {
      writeJsonAtomic(countryResultFile(this.cdir(code)), result);
    } catch {
      /* статус всё равно попадёт в run.json */
    }
    setCountryStatus(this.state, code, status);
    setCurrent(this.state, undefined);
    this.save();
    this.log(code, 'status', `Итог: сбой (${status}). ${f.message}`, { status, stage: stage ?? null });
  }

  // ----- вызов исполнителя -----

  /**
   * Вызов одного шага. Модельные шаги: проверка остановки и бюджет перед процессом.
   * Исключение исполнителя → `failed:internal`; Outcome без результата → `failed:<failure>`;
   * лимит → пауза. Расход и процессы пишутся в состояние и лог.
   */
  private async callStep<T>(
    code: string,
    stage: StageName,
    act: string | undefined,
    model: boolean,
    fn: () => Promise<Outcome<T>>,
  ): Promise<T> {
    this.checkStop();
    // Бюджет лимита (NFR-06): PauseSignal → пауза прогона; CountryFailure('limit') → недельный лимит, страна не проверена.
    if (model && this.deps.budget) await this.deps.budget.beforeProcess();
    let out: Outcome<T>;
    try {
      out = await fn();
    } catch (e) {
      // Сигналы прогона из исполнителя (например, бюджет перед вторым пакетом) — не внутренняя ошибка.
      if (e instanceof PauseSignal || e instanceof StopSignal || e instanceof CountryFailure) throw e;
      throw new CountryFailure(
        'internal',
        this.tt(
          `Внутренняя ошибка на этапе «${STAGE_LABEL[stage]}»${act ? ` (акт ${act})` : ''}: ${errText(e)}`,
          `Internal error at the "${this.stageLabel(stage)}" stage${act ? ` (act ${act})` : ''}: ${errText(e, langOf(this.settings))}`,
        ),
      );
    }
    if (!out || typeof out !== 'object' || typeof out.ok !== 'boolean') {
      throw new CountryFailure(
        'internal',
        this.tt(
          `Внутренняя ошибка на этапе «${STAGE_LABEL[stage]}»: исполнитель вернул неверный ответ`,
          `Internal error at the "${this.stageLabel(stage)}" stage: the executor returned an invalid answer`,
        ),
      );
    }
    this.account(code, out.usage, out.processes);
    if (out.ok) return out.output;
    if (out.failure === WEEKLY_LIMIT_FAILURE) {
      // Бюджет: недельный лимит почти исчерпан — ждать его сброса несколько дней нельзя (docs/02 §8).
      throw new CountryFailure('limit', this.msg(out.message || '') || this.tt('Недельный лимит Claude почти исчерпан', 'The weekly Claude limit is almost used up'));
    }
    if (out.failure === 'limit') {
      const until = out.resetsAt && !Number.isNaN(Date.parse(out.resetsAt)) ? out.resetsAt : new Date(this.now().getTime() + DEFAULT_LIMIT_PAUSE_MS).toISOString();
      if (Date.parse(until) - this.now().getTime() > MAX_LIMIT_PAUSE_MS) {
        // Сброс дальше 5-часового окна — это недельный лимит: страна не проверена, прогон идёт дальше и завершается
        // (письмо с уже найденным уходит), страна проверится следующим прогоном после сброса (docs/02 §8).
        const when = new Date(until).toLocaleString(langOf(this.settings) === 'en' ? 'en-GB' : 'ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        throw new CountryFailure(
          'limit',
          this.tt(
            `Недельный лимит Claude исчерпан (сброс около ${when}) — страна не проверена, она будет проверена следующим прогоном после сброса`,
            `The weekly Claude limit is used up (resets around ${when}) — the country was not checked; it will be checked by the next run after the reset`,
          ),
        );
      }
      throw new PauseSignal(until, this.msg(out.message || '') || this.tt('Исчерпан лимит подписки Claude', 'The Claude subscription limit is exhausted'));
    }
    throw new CountryFailure(
      out.failure || 'no_result',
      this.tt(
        `${STAGE_LABEL[stage]}${act ? ` (акт ${act})` : ''}: ${out.message || 'этап не дал результата'}`,
        `${this.stageLabel(stage)}${act ? ` (act ${act})` : ''}: ${this.msg(out.message || '') || 'the stage gave no result'}`,
      ),
    );
  }

  /** Немодельный шаг кода (resolveLead, checkEvidence): исключение → `failed:internal`. */
  private async guard<T>(code: string, stage: StageName, what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new CountryFailure(
        'internal',
        this.tt(
          `Внутренняя ошибка на этапе «${STAGE_LABEL[stage]}» (${what}): ${errText(e)}`,
          `Internal error at the "${this.stageLabel(stage)}" stage (${what}): ${errText(e, langOf(this.settings))}`,
        ),
      );
    }
  }

  private account(code: string, usage: Partial<Usage> | undefined, processes: ProcessLog[] | undefined): void {
    for (const p of processes ?? []) {
      const t = p.tokens ?? {};
      this.log(
        code,
        'process',
        `Процесс модели: этап ${p.stage}, модель ${p.model}, ${(p.durationMs / 1000).toFixed(1)} с, токены ${t.input ?? 0}/${t.output ?? 0}, код выхода ${p.exitCode ?? 'нет'}${p.failure ? `, сбой ${p.failure}` : ''}`,
        { ...p },
      );
    }
    let u: Partial<Usage> | undefined = usage;
    if (!u && processes?.length) {
      u = {};
      for (const p of processes) {
        for (const k of ['input', 'output', 'cache_read', 'cache_write', 'cost_usd'] as const) u[k] = (u[k] ?? 0) + (p.tokens?.[k] ?? 0);
      }
    }
    if (u) addUsage(this.state, code, u);
  }

  // ----- 1 COLLECT -----

  private readCandidates(code: string): CandidatesFile {
    return readJson<CandidatesFile>(countryPaths(this.cdir(code)).candidates);
  }

  private writeCandidates(code: string, f: CandidatesFile): void {
    writeJsonAtomic(countryPaths(this.cdir(code)).candidates, f);
  }

  private async collect(code: string, ctx: StageContext): Promise<Candidate[]> {
    const c = this.country(code);
    markStage(this.state, code, 'collect', { state: 'running', attempts: c.stages.collect.attempts + 1 });
    this.current(code, 'collect', this.tt('Собираю новые документы с источников', 'Collecting new documents from the sources'));
    this.save();
    const out = await this.callStep(code, 'collect', undefined, false, () => this.ex.collect(ctx));

    // История числа документов (COV-05); пробный и ретро-режимы её не пишут.
    for (const sc of out.sourceCounts ?? []) recordSourceCount(this.ws, sc.sourceId, sc.count, this.now(), this.state.mode);

    // Повторяющиеся id сломали бы учёт полноты: оставляем первый.
    const seen = new Set<string>();
    const unique: Candidate[] = [];
    for (const cand of out.candidates ?? []) {
      if (seen.has(cand.id)) {
        this.log(code, 'candidate_duplicate_id', `Повторный id кандидата ${cand.id} отброшен сборщиком`, { id: cand.id });
        continue;
      }
      seen.add(cand.id);
      unique.push({ ...cand, issuerClass: classifyIssuer(issuerRulesFor(ctx.country), cand.issuer, cand.doc_type) });
    }
    const kept = this.state.mode === 'backfill' ? unique : filterCandidates(this.ledgerFor(code), unique);
    const keptIds = new Set(kept.map((k) => k.id));
    const filtered = unique.filter((u) => !keptIds.has(u.id)).map((u) => ({ id: u.id, key: u.key }));

    const file: CandidatesFile = {
      country: code,
      window: c.window,
      candidates: kept,
      filtered_by_ledger: filtered,
      source_failures: out.sourceFailures ?? [],
      anomalies: out.anomalies ?? [],
      source_counts: out.sourceCounts ?? [],
    };
    this.writeCandidates(code, file);

    for (const sc of file.source_counts) this.log(code, 'source', `Источник ${sc.sourceId}: документов ${sc.count}`, { ...sc });
    for (const k of kept) this.log(code, 'candidate', `Кандидат ${k.id} (канал ${k.channel}): ${k.title_original}`, { id: k.id, key: k.key, channel: k.channel, url: k.url, date: k.date });
    for (const f of filtered) this.log(code, 'ledger_filtered', `Кандидат ${f.id} уже отправлялся (${f.key}) — не кандидат`, f);
    if (this.state.mode === 'backfill') this.log(code, 'ledger_ignored', 'Ретро-прогон: журнал отправленного не учитывается');

    for (const sf of file.source_failures) {
      if (sf.critical) continue;
      const w = this.tt(`Источник ${sf.sourceId} недоступен (есть дублирующий): ${sf.message}`, `Source ${sf.sourceId} is unavailable (a duplicate source exists): ${this.msg(sf.message)}`);
      this.addWarning(code, w);
      this.log(code, 'source_warning', w, { ...sf });
    }
    const critical = file.source_failures.filter((sf) => sf.critical);
    if (critical.length) {
      throw new CountryFailure('source', this.tt(`Источник недоступен: ${critical.map((sf) => `${sf.sourceId} — ${sf.message}`).join('; ')}`, `Source unavailable: ${critical.map((sf) => `${sf.sourceId} — ${this.msg(sf.message)}`).join('; ')}`));
    }
    if (file.anomalies.length) {
      throw new CountryFailure(
        'parser',
        this.tt(
          `Источник вернул 0 документов, хотя обычно они есть (вероятно, сломался разбор сайта): ${file.anomalies
            .map((a) => `${a.sourceId}${a.message ? ` — ${a.message}` : ''} (обычно ${a.median})`)
            .join('; ')}`,
          `A source returned 0 documents although it usually has some (the site parsing has probably broken): ${file.anomalies
            .map((a) => `${a.sourceId}${a.message ? ` — ${this.msg(a.message)}` : ''} (usually ${a.median})`)
            .join('; ')}`,
        ),
      );
    }
    markStage(this.state, code, 'collect', { state: 'done' });
    this.save();
    this.log(code, 'collect_done', `Сбор завершён: кандидатов ${kept.length}, отфильтровано журналом ${filtered.length}`, {
      candidates: kept.length,
      filtered: filtered.length,
    });
    return kept;
  }

  // ----- 2 NEWS -----

  private async news(code: string, ctx: StageContext, cands: Candidate[]): Promise<Candidate[]> {
    const c = this.country(code);
    if (!this.settings.newsEnabled || !this.ex.news) {
      markStage(this.state, code, 'news', { state: 'skipped' });
      this.save();
      this.log(code, 'news_skipped', this.settings.newsEnabled ? 'Поиск в новостях недоступен' : 'Поиск в новостях выключен в настройках');
      return cands;
    }
    markStage(this.state, code, 'news', { state: 'running', attempts: c.stages.news.attempts + 1 });
    this.current(code, 'news', this.tt('Ищу упоминания в новостях', 'Searching for mentions in the news'));
    this.save();
    const news = this.ex.news.bind(this.ex);
    const sweep = await this.callStep(code, 'news', undefined, true, () => news(ctx, cands));
    writeJsonAtomic(countryPaths(this.cdir(code)).news, sweep);

    const all = [...cands];
    const added: Candidate[] = [];
    for (const lead of sweep.leads ?? []) {
      const resolver = this.ex.resolveLead?.bind(this.ex);
      const cand = resolver ? await this.guard(code, 'news', 'проверка наводки', () => resolver(ctx, { kind: 'news', lead }, all)) : null;
      if (cand && !all.some((k) => k.id === cand.id || k.key === cand.key)) {
        all.push(cand);
        added.push(cand);
        this.log(code, 'lead_confirmed', `Наводка подтверждена в первичном источнике: ${cand.id}`, { headline: lead.headline, id: cand.id, url: cand.url });
      } else if (cand) {
        this.log(code, 'lead_known', `Наводка совпала с уже найденным кандидатом ${cand.id}`, { headline: lead.headline, id: cand.id });
      } else {
        this.log(code, 'lead_unconfirmed', 'Наводка без подтверждения в первичном источнике — в письмо не попадает', { headline: lead.headline, url: lead.url, act_number: lead.act_number });
      }
    }
    const kept = this.state.mode === 'backfill' ? added : filterCandidates(this.ledgerFor(code), added);
    for (const a of added) if (!kept.includes(a)) this.log(code, 'ledger_filtered', `Кандидат ${a.id} из наводки уже отправлялся (${a.key})`, { id: a.id, key: a.key });
    const result = [...cands, ...kept];
    if (kept.length) {
      const f = this.readCandidates(code);
      f.candidates = [...f.candidates, ...kept];
      this.writeCandidates(code, f);
    }
    markStage(this.state, code, 'news', { state: 'done' });
    this.save();
    this.log(code, 'news_done', `Новости: наводок ${sweep.leads?.length ?? 0}, новых кандидатов ${kept.length}`);
    return result;
  }

  // ----- 3 TRIAGE -----

  private async triage(code: string, ctx: StageContext, cands: Candidate[]): Promise<void> {
    const ids = cands.map((k) => k.id);
    const byId = new Map(cands.map((k) => [k.id, k]));
    const triageFn = this.ex.triage.bind(this.ex);
    let retry: StageContext['retry'];
    for (let attempt = 1; ; attempt++) {
      const c = this.country(code);
      markStage(this.state, code, 'triage', { state: 'running', attempts: c.stages.triage.attempts + 1 });
      this.current(
        code,
        'triage',
        attempt > 1
          ? this.tt('Повторяю отбор кандидатов (ответ был неполным)', 'Repeating candidate selection (the answer was incomplete)')
          : this.tt(`Отбираю кандидатов по теме (${ids.length})`, `Selecting candidates by topic (${ids.length})`),
      );
      this.save();
      const tctx: StageContext = retry ? { ...ctx, retry } : ctx;
      const out = await this.callStep(code, 'triage', undefined, true, () => triageFn(tctx, cands));
      const items = Array.isArray(out?.items) ? out.items : [];
      writeJsonAtomic(countryPaths(this.cdir(code)).triage, out);

      // HAL-04: полноту считает код.
      const comp = checkCompleteness(ids, items);
      const totals = accountingTotals(ids, items);
      this.log(code, 'completeness', comp.ok ? `Полнота отбора: все ${ids.length} кандидатов учтены` : (completenessFailure(comp) ?? ''), {
        ok: comp.ok,
        attempt,
        missing: comp.missing,
        extra: comp.extra,
        duplicates: comp.duplicates,
        invalid_irrelevant: comp.invalidIrrelevant,
        totals,
      });
      if (!comp.ok) {
        const msg = completenessFailure(comp)!;
        if (attempt >= 2) throw new CountryFailure('completeness', this.tt(`${msg}; повтор не помог`, `${this.msg(msg)}; the retry did not help`));
        this.log(code, 'retry', `Повтор отбора: ${msg}`, { stage: 'triage', reason: 'completeness' });
        retry = { reason: 'completeness', message: msg, details: comp };
        continue;
      }

      // Решения и акты на анализ: relevant | borderline, а канал А — всегда.
      for (const it of items) {
        const cand = byId.get(it.id)!;
        const toAnalyze = it.decision !== 'irrelevant' || cand.channel === 'A';
        this.log(
          code,
          'triage_decision',
          `${it.id}: ${it.decision}${it.reason_code ? ` (${it.reason_code})` : ''}${it.decision === 'irrelevant' && cand.channel === 'A' ? ' — канал А всё равно идёт в анализ' : ''}`,
          { id: it.id, decision: it.decision, reason_code: it.reason_code, reason_text: it.reason_text, confidence: it.confidence, channel: cand.channel, to_analyze: toAnalyze },
        );
        if (!toAnalyze) continue;
        // Канал А и работа без экрана — сразу в анализ; остальные сначала проходят дешёвый экран по тексту (SCR).
        if (cand.channel === 'A' || !this.screenEnabled()) {
          if (!c.acts[it.id]) markAct(this.state, code, it.id, { analyze: 'pending', rounds: 0 });
        } else {
          this.setScreen(code, it.id, { state: 'pending' });
        }
      }
      markStage(this.state, code, 'triage', { state: 'done' });
      this.save();
      const toScreen = Object.keys(c.screen ?? {}).length;
      this.log(code, 'triage_done', toScreen ? `Отбор: на экран по тексту ${toScreen}, на анализ сразу ${Object.keys(c.acts).length}, отброшено ${totals.discarded}` : `Отбор: на анализ ${Object.keys(c.acts).length}, отброшено ${totals.discarded}`, { ...totals, to_screen: toScreen });
      return;
    }
  }

  // ----- 3б SCREEN (экран по тексту, SCR-01…SCR-04) -----

  private screenEnabled(): boolean {
    return !!(this.ex.screen && this.ex.prepareScreen);
  }

  private setScreen(code: string, id: string, patch: Partial<NonNullable<CountryRun['screen']>[string]>): void {
    const c = this.country(code);
    c.screen ??= {};
    c.screen[id] = { ...(c.screen[id] ?? { state: 'pending' as const }), ...patch };
  }

  private async screenStage(code: string, ctx: StageContext, cands: Candidate[]): Promise<void> {
    const c = this.country(code);
    if (!this.screenEnabled() || !Object.values(c.screen ?? {}).some((s) => s.state === 'pending')) {
      markStage(this.state, code, 'screen', { state: 'skipped' });
      this.save();
      this.log(code, 'screen_skipped', 'Экран по тексту не нужен: кандидатов на него нет');
      return;
    }
    markStage(this.state, code, 'screen', { state: 'running', attempts: c.stages.screen.attempts + 1 });
    this.save();
    await this.screenPending(code, ctx, cands);
    markStage(this.state, code, 'screen', { state: 'done' });
    this.save();
  }

  /**
   * Экран всех ожидающих кандидатов: код готовит текст и отсекает очевидный шум, дешёвая модель судит по фрагментам,
   * сомнительное перепроверяет модель не слабее sonnet. Итог каждого пишется сразу (продолжение после паузы).
   */
  private async screenPending(code: string, ctx: StageContext, cands: Candidate[]): Promise<void> {
    const c = this.country(code);
    const prepareScreen = this.ex.prepareScreen?.bind(this.ex);
    const screen = this.ex.screen?.bind(this.ex);
    const pending = Object.entries(c.screen ?? {}).filter(([, s]) => s.state === 'pending').map(([id]) => id);
    if (!pending.length || !prepareScreen || !screen) return;

    const finish = (id: string, final: ScreenFinal, by: 'code' | 'screen' | 'confirm', reason: string, extra: { points?: string[]; quote?: string } = {}): void => {
      this.setScreen(code, id, { state: 'done', final, by, reason, ...extra });
      if (final === 'material' && !c.acts[id]) markAct(this.state, code, id, { analyze: 'pending', rounds: 0 });
      this.save();
      this.log(code, 'screen_decision', `${id}: ${final} (${by}) — ${reason}`, { id, final, by, reason, ...extra });
    };

    // 1. Код: снимок, термины, фрагменты; очевидный шум и «нет текста» решаются без модели.
    const asks: Array<{ cand: Candidate; prep: ScreenPrep }> = [];
    for (const [i, id] of pending.entries()) {
      this.checkStop();
      const cand = cands.find((k) => k.id === id);
      if (!cand) throw new CountryFailure('internal', this.tt(`Кандидат ${id} не найден в candidates.json`, `Candidate ${id} was not found in candidates.json`));
      this.current(code, 'screen', this.tt(`Читаю текст акта ${i + 1} из ${pending.length}: ${cand.title_original}`, `Reading the text of act ${i + 1} of ${pending.length}: ${cand.title_original}`), id);
      this.save();
      const r = await this.guard(code, 'screen', 'подготовка текста', () => prepareScreen(ctx, cand));
      const route = routeCandidate(cand, r.ok ? r.prep : null, r.ok ? undefined : r.message);
      if (r.ok) this.setScreen(code, id, { term_count: r.prep.termCount });
      if (route.kind === 'no_text') finish(id, 'no_text', 'code', route.reason);
      else if (route.kind === 'drop') finish(id, 'dropped', 'code', route.reason);
      else if (r.ok) asks.push({ cand, prep: r.prep });
    }
    if (!asks.length) {
      this.writeScreenFile(code); // всё решил код: итог экрана всё равно нужен архиву и письму
      return;
    }

    const fragmentsOf = new Map(asks.map((a) => [a.cand.id, a.prep.fragments]));
    const byId = new Map(asks.map((a) => [a.cand.id, a]));
    const doubtful: Array<{ cand: Candidate; prep: ScreenPrep; first: Decided }> = [];

    // 2. Модель по фрагментам: пакеты по SCREEN_BATCH.
    for (let i = 0; i < asks.length; i += SCREEN_BATCH) {
      const batch = asks.slice(i, i + SCREEN_BATCH);
      this.current(code, 'screen', this.tt(`Быстрая оценка по тексту: ${i + 1}–${i + batch.length} из ${asks.length}`, `Quick assessment by text: ${i + 1}–${i + batch.length} of ${asks.length}`));
      this.save();
      const out = await this.callStep(code, 'screen', undefined, true, () => screen(ctx, batch.map((b) => ({ candidate: b.cand, prep: b.prep })), 'screen'));
      for (const d of normalizeScreenOutput(batch.map((b) => b.cand.id), out, fragmentsOf)) {
        const a = byId.get(d.id)!;
        const next = afterScreen(a.cand, d);
        if (next.kind === 'final') finish(d.id, next.final, 'screen', d.reason || d.decision, { points: d.points, quote: d.quote });
        else {
          doubtful.push({ cand: a.cand, prep: a.prep, first: d });
          this.log(code, 'screen_doubt', `${d.id}: ${d.decision}${d.downgraded ? ` (${d.downgraded})` : ''} — на перепроверку`, { id: d.id, decision: d.decision, downgraded: d.downgraded });
        }
      }
    }

    // 3. Перепроверка сомнительного моделью не слабее sonnet: сомнение идёт на полный разбор (SCR-03).
    for (let i = 0; i < doubtful.length; i += SCREEN_BATCH) {
      const batch = doubtful.slice(i, i + SCREEN_BATCH);
      this.current(code, 'screen', this.tt(`Перепроверяю сомнительное: ${i + 1}–${i + batch.length} из ${doubtful.length}`, `Rechecking doubtful items: ${i + 1}–${i + batch.length} of ${doubtful.length}`));
      this.save();
      const inputs = batch.map((b) => ({ candidate: b.cand, prep: b.prep, previous: { decision: b.first.decision, reason: b.first.reason } }));
      const out = await this.callStep(code, 'screen', undefined, true, () => screen(ctx, inputs, 'confirm'));
      for (const d of normalizeScreenOutput(batch.map((b) => b.cand.id), out, fragmentsOf)) {
        const fin = afterConfirm(d);
        finish(d.id, fin, 'confirm', d.reason || (fin === 'material' ? 'сомнение — идёт на полный разбор' : d.decision), { points: d.points, quote: d.quote });
      }
    }
    this.writeScreenFile(code);
  }

  /** screen.json страны: итог экрана по каждому кандидату (для архива и письма). */
  private writeScreenFile(code: string): void {
    const c = this.country(code);
    const items = Object.entries(c.screen ?? {}).map(([id, s]) => ({ id, ...s }));
    writeJsonAtomic(join(this.cdir(code), 'screen.json'), { country: code, items });
  }

  // ----- 4 ANALYZE -----

  private async analyzeStage(code: string, ctx: StageContext, cands: Candidate[]): Promise<void> {
    const c = this.country(code);
    if (Object.keys(c.acts).length === 0) {
      markStage(this.state, code, 'analyze', { state: 'skipped' });
      this.save();
      this.log(code, 'analyze_skipped', 'Нет актов для анализа');
      return;
    }
    markStage(this.state, code, 'analyze', { state: 'running', attempts: c.stages.analyze.attempts + 1 });
    this.save();
    await this.analyzePending(code, ctx, cands, 'analyze');
    markStage(this.state, code, 'analyze', { state: 'done' });
    this.save();
  }

  /** Анализ всех недоделанных актов по одному: «акт = процесс» (NFR-05). Готовые не повторяются. */
  private async analyzePending(code: string, ctx: StageContext, cands: Candidate[], phase: 'analyze' | 'verify'): Promise<void> {
    const c = this.country(code);
    const analyze = this.ex.analyze.bind(this.ex);
    const ids = Object.keys(c.acts);
    for (const [i, id] of ids.entries()) {
      const a = c.acts[id]!;
      if (a.analyze === 'done') continue;
      const cand = cands.find((k) => k.id === id);
      if (!cand) throw new CountryFailure('internal', this.tt(`Кандидат ${id} не найден в candidates.json`, `Candidate ${id} was not found in candidates.json`));
      const adir = actDir(this.ws, this.state.id, code, id);
      mkdirSync(adir, { recursive: true });
      const review = a.verdict === 'needs_correction' ? readJsonOr<ActReview | null>(actReviewFile(adir), null) : null;
      const notes = review?.notes;
      markAct(this.state, code, id, { analyze: 'running' });
      this.current(
        code,
        phase,
        notes
          ? this.tt(`Исправляю карточку по замечаниям проверки: ${cand.title_original}`, `Fixing the card per the verification remarks: ${cand.title_original}`)
          : this.tt(`Анализирую акт ${i + 1} из ${ids.length}: ${cand.title_original}`, `Analyzing act ${i + 1} of ${ids.length}: ${cand.title_original}`),
        id,
      );
      this.save();
      const actx: StageContext = { ...ctx, actDir: adir };
      const card = await this.callStep(code, 'analyze', id, true, () => analyze(actx, cand, notes));
      const paths = actPaths(adir);
      writeJsonAtomic(paths.card, card);
      if (card?.candidate_id !== id) this.log(code, 'card_id_mismatch', `В карточке указан другой candidate_id (${String(card?.candidate_id)}), учитывается ${id}`, { act: id });

      if (this.ex.checkEvidence) {
        const check = this.ex.checkEvidence.bind(this.ex);
        const ev = await this.guard(code, 'analyze', 'проверка цитат', () => check(actx, cand, card));
        writeJsonAtomic(paths.evidenceCheck, ev);
        this.log(code, 'evidence', ev.ok ? `Цитаты карточки ${id} найдены в снимке` : `Цитаты карточки ${id} не подтвердились: ${ev.failedFields.join(', ')} — карточка идёт в проверку с пометкой`, { act: id, ...ev });
      }
      markAct(this.state, code, id, { analyze: 'done' });
      this.save();
      this.log(code, 'act_done', notes ? `Карточка ${id} исправлена по замечаниям` : `Карточка ${id} готова`, { act: id, with_notes: !!notes });
    }
  }

  private readEvidence(adir: string): EvidenceResult {
    const ev = readJsonOr<EvidenceResult | null>(actPaths(adir).evidenceCheck, null);
    return ev && Array.isArray(ev.failedFields) ? ev : { ok: true, failedFields: [] };
  }

  // ----- 5 VERIFY -----

  private async verifyStage(code: string, ctx: StageContext, cands: Candidate[]): Promise<void> {
    const c = this.country(code);
    const triage = readJson<TriageOutput>(countryPaths(this.cdir(code)).triage);
    // VER-02: проверка просматривает отброшенных отбором (`irrelevant`) и экраном (`none`, класс 3 без терминов).
    const rejected = (): RejectedCandidate[] => [
      ...triage.items
        .filter((it) => it.decision === 'irrelevant' && !c.acts[it.id] && !c.screen?.[it.id])
        .map((it) => ({ candidate: cands.find((k) => k.id === it.id)!, reason_code: it.reason_code, reason_text: it.reason_text })),
      ...Object.entries(c.screen ?? {})
        .filter(([id, s]) => s.state === 'done' && s.final === 'dropped' && !c.acts[id])
        .map(([id, s]) => ({ candidate: cands.find((k) => k.id === id)!, reason_code: null, reason_text: `screen: ${s.reason ?? 'none'}` })),
    ].filter((r) => r.candidate);
    const verify = this.ex.verify.bind(this.ex);

    // attempts этапа verify = число ЗАВЕРШЁННЫХ проходов проверки (пишется вместе с их итогами).
    markStage(this.state, code, 'verify', { state: 'running' });
    this.save();
    for (;;) {
      await this.screenPending(code, ctx, cands); // возвращённые проверкой сначала на экран (VER-02)
      await this.analyzePending(code, ctx, cands, 'verify');
      const firstPass = c.stages.verify.attempts === 0;
      const rej = firstPass ? rejected() : [];
      const toVerify = Object.entries(c.acts)
        .filter(([, a]) => a.analyze === 'done' && !FINAL_VERDICTS.has(a.verdict ?? ''))
        .map(([id]) => id);
      if (!toVerify.length && !(firstPass && rej.length)) break;

      const pass = c.stages.verify.attempts + 1;
      const inputs: VerifyCardInput[] = toVerify.map((id) => {
        const adir = actDir(this.ws, this.state.id, code, id);
        return {
          candidate: cands.find((k) => k.id === id)!,
          card: readJson<Card>(actPaths(adir).card),
          evidenceFailedFields: this.readEvidence(adir).failedFields,
          round: c.acts[id]!.rounds + 1,
        };
      });
      this.current(
        code,
        'verify',
        this.tt(
          `Проверяю карточки (${inputs.length}${rej.length ? `, отброшенных ${rej.length}` : ''}), проход ${pass}`,
          `Verifying cards (${inputs.length}${rej.length ? `, rejected ${rej.length}` : ''}), pass ${pass}`,
        ),
      );
      this.save();
      const ver = await this.callStep(code, 'verify', undefined, true, () => verify(ctx, inputs, rej));
      const p = countryPaths(this.cdir(code));
      writeJsonAtomic(p.verification, ver);
      writeJsonAtomic(join(this.cdir(code), `verification.pass-${pass}.json`), ver);

      for (const id of toVerify) this.applyVerdict(code, id, (ver.cards ?? []).find((v) => v.candidate_id === id));
      for (const v of ver.cards ?? []) {
        if (!toVerify.includes(v.candidate_id)) this.log(code, 'verify_unknown_card', `Проверка вернула карточку ${v.candidate_id}, которой не было на входе — пропущено`, { id: v.candidate_id });
      }
      if (firstPass) {
        this.applyReturned(code, ver, rej);
        await this.applyWatched(code, ctx, ver, cands);
      }
      markStage(this.state, code, 'verify', { attempts: pass });
      this.save();
    }
    markStage(this.state, code, 'verify', { state: c.stages.verify.attempts > 0 ? 'done' : 'skipped' });
    this.save();
  }

  /** Итог круга проверки для одной карточки (VER-03 + правило docs/04 §4 про evidence-check). */
  private applyVerdict(code: string, id: string, entry: Verification['cards'][number] | undefined): void {
    const c = this.country(code);
    const a = c.acts[id]!;
    const rounds = a.rounds + 1;
    const adir = actDir(this.ws, this.state.id, code, id);
    const ev = this.readEvidence(adir);
    const fields = entry?.fields ?? [];
    const mismatch = fields.filter((f) => f.status === 'mismatch');
    const keyMismatch = mismatch.filter((f) => isKeyField(f.field));
    const notOk = fields.filter((f) => f.status !== 'ok');
    const uniq = (xs: string[]): string[] => [...new Set(xs)];

    let verdict: ActReview['verdict'];
    let disputed: string[];
    let reanalyze = false;
    if (!entry) {
      // Проверяющий пропустил карточку: повторить проверку (без нового анализа) или сдаться.
      disputed = ['(проверка не вернула ответ по карточке)'];
      verdict = rounds < MAX_VERIFY_ROUNDS ? 'pending' : 'unconfirmed';
    } else if (entry.verdict === 'confirmed' && !mismatch.length && ev.failedFields.length === 0) {
      verdict = 'confirmed';
      disputed = [];
    } else if (this.screenEnabled() && entry.verdict !== 'unconfirmed' && keyMismatch.length === 0 && ev.failedFields.length === 0) {
      // VER-03: расхождение только в неключевых полях — второй круг не стоит затрат; карточка принимается,
      // спорные поля остаются в review.json и в архиве. Так же — при `confirmed` проверяющего с неключевым mismatch
      // (иначе такая карточка ушла бы в `unconfirmed`, а та же с `needs_correction` — в `confirmed`).
      verdict = 'confirmed';
      disputed = [];
    } else {
      disputed = uniq([...mismatch.map((f) => f.field), ...ev.failedFields]);
      const fixable = this.screenEnabled()
        ? keyMismatch.length > 0 || ev.failedFields.length > 0
        : mismatch.length > 0 || ev.failedFields.length > 0 || entry.verdict === 'needs_correction';
      if (fixable && rounds < MAX_VERIFY_ROUNDS) {
        verdict = 'needs_correction';
        reanalyze = true;
      } else {
        verdict = 'unconfirmed';
        disputed = uniq([...disputed, ...notOk.map((f) => f.field)]);
        if (!disputed.length) disputed = ['(проверяющий не указал поля)'];
      }
    }
    const review: ActReview = {
      round: rounds,
      verdict,
      disputed_fields: disputed,
      notes: { round: rounds, fields: notOk, evidenceFailedFields: ev.failedFields },
    };
    writeJsonAtomic(actReviewFile(adir), review);
    markAct(this.state, code, id, {
      rounds,
      verdict: verdict === 'pending' ? undefined : verdict,
      ...(reanalyze ? { analyze: 'pending' as const } : {}),
    });
    const text =
      verdict === 'confirmed'
        ? `Карточка ${id} подтверждена (круг ${rounds})`
        : verdict === 'needs_correction'
          ? `Карточка ${id}: расхождения (${disputed.join(', ')}) — повторный анализ с замечаниями`
          : verdict === 'unconfirmed'
            ? `Карточка ${id} не подтверждена после ${rounds} кругов: ${disputed.join(', ')}`
            : `Карточка ${id}: проверка не дала ответа — повтор проверки`;
    this.log(code, 'verify_card', text, { act: id, round: rounds, verdict, verifier_verdict: entry?.verdict ?? null, disputed });
  }

  /** VER-02: кандидат, возвращённый из отброшенных, идёт в анализ и проверку. */
  private applyReturned(code: string, ver: Verification, rej: RejectedCandidate[]): void {
    const c = this.country(code);
    for (const r of ver.returned ?? []) {
      if (!rej.some((x) => x.candidate.id === r.id) || c.acts[r.id]) {
        this.log(code, 'returned_ignored', `Проверка вернула ${r.id}, но его нет среди отброшенных — пропущено`, { id: r.id });
        continue;
      }
      // VER-02: возврат только с обоснованием, называющим связь с темой; «на всякий случай» не принимается.
      if (!hasReturnReason(r.reason)) {
        this.log(code, 'returned_ignored', `Проверка вернула ${r.id} без обоснования («${r.reason}») — пропущено`, { id: r.id, reason: r.reason });
        continue;
      }
      if (this.screenEnabled()) {
        this.setScreen(code, r.id, { state: 'pending', returned: true });
        this.log(code, 'returned', `Проверка вернула отброшенного кандидата ${r.id}: ${r.reason} — идёт на экран по тексту`, { id: r.id, reason: r.reason });
      } else {
        markAct(this.state, code, r.id, { analyze: 'pending', rounds: 0 });
        this.log(code, 'returned', `Проверка вернула отброшенного кандидата ${r.id}: ${r.reason} — идёт в анализ`, { id: r.id, reason: r.reason });
      }
    }
  }

  /** Новая редакция отслеживаемого акта → кандидат канала А (только если код нашёл его в источнике). */
  private async applyWatched(code: string, ctx: StageContext, ver: Verification, cands: Candidate[]): Promise<void> {
    const c = this.country(code);
    for (const w of ver.watched_acts_check ?? []) {
      if (!w.new_edition_found) continue;
      const resolver = this.ex.resolveLead?.bind(this.ex);
      const cand = resolver ? await this.guard(code, 'verify', 'новая редакция акта', () => resolver(ctx, { kind: 'watched_edition', check: w }, cands)) : null;
      if (!cand) {
        const text = `Проверка нашла новую редакцию отслеживаемого акта ${w.registration_number}, но код не подтвердил её в первичном источнике`;
        this.addWarning(code, text);
        this.log(code, 'watched_unconfirmed', text, { ...w });
        continue;
      }
      const known = cands.find((k) => k.id === cand.id || k.key === cand.key);
      if (known) {
        if (!c.acts[known.id]) {
          markAct(this.state, code, known.id, { analyze: 'pending', rounds: 0 });
          this.log(code, 'watched_added', `Новая редакция ${w.registration_number} — кандидат ${known.id} идёт в анализ`, { id: known.id });
        }
        continue;
      }
      if (this.state.mode !== 'backfill' && filterCandidates(this.ledgerFor(code), [cand]).length === 0) {
        this.log(code, 'ledger_filtered', `Новая редакция ${w.registration_number} уже отправлялась (${cand.key})`, { id: cand.id, key: cand.key });
        continue;
      }
      const a: Candidate = { ...cand, channel: 'A' };
      cands.push(a);
      const f = this.readCandidates(code);
      f.candidates = [...f.candidates, a];
      this.writeCandidates(code, f);
      markAct(this.state, code, a.id, { analyze: 'pending', rounds: 0 });
      this.log(code, 'watched_added', `Новая редакция ${w.registration_number} найдена в источнике — кандидат ${a.id} (канал А) идёт в анализ`, { id: a.id, url: a.url });
    }
  }

  // ----- 6 STATUS -----

  private finishCountry(code: string, cands: Candidate[]): void {
    const c = this.country(code);
    const ledger = this.ledgerFor(code);
    const cdir = this.cdir(code);
    const items: ResultItem[] = [];
    const duplicates: CountryResult['duplicates'] = [];
    const commit: CommitItem[] = [];
    for (const [id, a] of Object.entries(c.acts)) {
      const adir = actDir(this.ws, this.state.id, code, id);
      const card = readJsonOr<Card | null>(actPaths(adir).card, null);
      if (!card || a.analyze !== 'done') throw new CountryFailure('internal', this.tt(`Нет готовой карточки акта ${id}`, `There is no finished card for act ${id}`));
      const review = readJsonOr<ActReview | null>(actReviewFile(adir), null);
      const cand = cands.find((k) => k.id === id);
      const cardKey = ledgerKey({
        registrationNumber: String(card.act?.registration_number?.value ?? ''),
        number: String(card.act?.number?.value ?? ''),
        date: String(card.act?.adoption_date?.value ?? ''),
        url: card.links?.amending_act ?? '',
      });
      const key = cand?.key ?? cardKey;
      const entry =
        ledger.find((e) => e.key === key) ??
        ledger.find((e) => e.key === cardKey) ??
        (card.update_of ? ledger.find((e) => e.key === card.update_of!.ledger_key) : undefined) ??
        null;
      const effective = String(card.act?.effective_date?.value ?? 'unknown');
      const cls = classify(entry, { stage: card.stage, effective_date: effective });
      if (cls.kind === 'duplicate') {
        duplicates.push({ candidate_id: id, key });
        this.log(code, 'duplicate', `Карточка ${id} — дубль уже отправленного (${key}), в результат не идёт`, { act: id, key });
        continue;
      }
      const confirmed = a.verdict === 'confirmed';
      items.push({
        candidate_id: id,
        key,
        channel: cand?.channel ?? 'B',
        kind: cls.kind,
        ...(cls.kind === 'update' ? { first_reported_at: cls.since, update_reason: cls.reason } : {}),
        confirmed,
        disputed_fields: confirmed ? [] : (review?.disputed_fields ?? ['(проверка не завершена)']),
        rounds: a.rounds,
        title_en: card.act?.title_en ?? cand?.title_en ?? '',
        card_file: relative(cdir, actPaths(adir).card).split('\\').join('/'),
      });
      commit.push({ key, stage: card.stage, effective_date: effective, title_en: card.act?.title_en ?? '' });
      this.log(
        code,
        'result_item',
        `${cls.kind === 'update' ? '🔄 Обновление' : 'Новое'}: ${id}${confirmed ? '' : ' — ⚠ не подтверждено'}`,
        { act: id, key, kind: cls.kind, confirmed },
      );
    }
    // Экран по тексту: «для сведения» и «не удалось проверить» — тоже результат (полнота, HAL-08).
    const forInfo: ForInfoItem[] = [];
    const unverified: UnverifiedItem[] = [];
    for (const [id, s] of Object.entries(c.screen ?? {})) {
      const cand = cands.find((k) => k.id === id);
      if (!cand || s.state !== 'done') continue;
      if (s.final === 'minor') {
        forInfo.push({ candidate_id: id, key: cand.key, title_original: cand.title_original, issuer: cand.issuer, date: cand.date, url: cand.url, reason: s.reason ?? '', points: s.points ?? [] });
      } else if (s.final === 'no_text') {
        unverified.push({ candidate_id: id, title_original: cand.title_original, issuer: cand.issuer, date: cand.date, url: cand.url, reason: s.reason ?? '' });
      }
    }
    const screened = c.screen !== undefined;
    const status: CountryStatus = items.length || forInfo.length || unverified.length ? 'changes' : 'no_changes';
    const result: CountryResult = {
      country: code,
      status,
      items,
      ...(screened ? { for_information: forInfo, unverified } : {}),
      duplicates,
      warnings: c.warnings ?? [],
      // COMMIT делает фаза 7 после отправки; пробный и ретро-прогоны журнал не пишут.
      to_commit: shouldWriteLedger(this.state.mode) ? commit : [],
    };
    writeJsonAtomic(countryResultFile(cdir), result);
    setCountryStatus(this.state, code, status);
    setCurrent(this.state, undefined);
    this.save();
    this.log(code, 'status', status === 'changes' ? `Итог: есть изменения (${items.length})` : 'Итог: изменений нет', {
      status,
      items: items.length,
      for_information: forInfo.length,
      unverified: unverified.length,
      duplicates: duplicates.length,
      usage: c.usage,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Оркестратор: один прогон одновременно (RUN-07), старт, продолжение, остановка
// ---------------------------------------------------------------------------------------------

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private active: Promise<StartResult> | null = null;
  private session: RunSession | null = null;
  private stopFlag = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** Идёт ли прогон в этом процессе. */
  get running(): boolean {
    return this.active !== null;
  }

  /** Копия состояния идущего прогона (для экрана «Прогон»); null — ничего не идёт. */
  current(): RunState | null {
    return this.session ? structuredClone(this.session.state) : null;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * Новый прогон. Если прогон уже идёт — возвращает его же Promise (RUN-07).
   * Гейт почты проверяется до создания чего-либо: отказ → `{ ok: false, blocked }`.
   */
  start(opts: StartOptions): Promise<StartResult> {
    if (this.active) return this.active;
    const g = guardRun(opts.mode, opts.gate);
    if (!g.allowed) return Promise.resolve({ ok: false, blocked: g.message });
    const only = opts.onlyCountries?.length ? new Set(opts.onlyCountries) : null;
    const active = opts.countries.filter((c) => c.active && (!only || only.has(c.code)));
    if (active.length === 0) {
      return Promise.resolve({ ok: false, blocked: mt(langOf(opts.settings), 'Нет ни одной включённой страны. Включите страну в разделе «Страны».', 'No country is enabled. Enable a country in the "Countries" section.') });
    }
    return this.launch(opts.settings, opts.countries, () => {
      const ws = opts.settings.workspaceDir;
      const now = this.now();
      return createRun({
        workspaceDir: ws,
        mode: opts.mode,
        countries: active.map((c) => ({ code: c.code, window: computeWindow(ws, c.code, opts.settings, now, opts.windowOverride) })),
        skillsHash: opts.skillsHash ?? '',
        ...(opts.windowOverride ? { windowOverride: opts.windowOverride } : {}),
        now,
      });
    });
  }

  /**
   * Продолжить прерванный прогон (RUN-06) с того этапа и акта, где он остановился.
   * Без runDir берётся самый свежий незавершённый и НЕ остановленный пользователем.
   * null — продолжать нечего. Если прогон уже идёт — его Promise.
   */
  resume(opts: ResumeOptions): Promise<StartResult | null> {
    if (this.active) return this.active;
    let found: { dir: string; state: RunState } | null;
    if (opts.runDir) {
      const state = loadRun(opts.runDir);
      found = state.finished_at ? null : { dir: opts.runDir, state };
    } else {
      found = findUnfinishedRun(opts.settings.workspaceDir);
    }
    if (!found) return Promise.resolve(null);
    const f = found;
    return this.launch(opts.settings, opts.countries, () => f);
  }

  /**
   * Мягкая остановка (RUN-08): текущий шаг доделывается, следующий не начинается, состояние
   * сохраняется, прогон помечается `stopped` и сам не возобновляется. Возвращает итог прогона.
   */
  stop(): Promise<StartResult> | null {
    if (!this.active) return null;
    this.stopFlag = true;
    return this.active;
  }

  private launch(settings: Settings, countries: Country[], make: () => { dir: string; state: RunState }): Promise<StartResult> {
    this.stopFlag = false;
    const p = (async (): Promise<StartResult> => {
      // Отложить тело: this.active должен быть присвоен до любого finally.
      await Promise.resolve();
      let power = false;
      try {
        const { dir, state } = make();
        this.session = new RunSession({ dir, state, deps: this.deps, settings, countries, stopRequested: () => this.stopFlag });
        if (this.deps.powerSave) {
          this.deps.powerSave.start();
          power = true;
        }
        return await this.session.execute();
      } finally {
        if (power) {
          try {
            this.deps.powerSave!.stop();
          } catch {
            /* не мешаем завершению */
          }
        }
        this.session = null;
        this.active = null;
        this.stopFlag = false;
      }
    })();
    this.active = p;
    return p;
  }
}
