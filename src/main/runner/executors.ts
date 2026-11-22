// Боевые исполнители этапов (docs/02 §4): сбор — код, новости/отбор/анализ/проверка — `claude -p` через
// claude-runner, проверка цитат — код (checks/evidence.ts). Без electron: всё внешнее приходит инъекцией.
//
// Решения (подробно — docs/FINDINGS.md «Фаза 5: этапы»):
// • Модель ничего не пишет: input.json пишет код, ответ — structured_output по схеме (PRM-05).
// • cwd процесса = realpath папки страны, все пути во входе абсолютные и реальные (FINDINGS «Фаза 3: правила Read»).
// • Отбор — пакетами по TRIAGE_BATCH кандидатов, чтобы ответ влезал и не обрезался. Пакет с потерянными/лишними
//   id повторяется ОДИН раз внутри исполнителя; итог полноты по всему набору считает оркестратор (HAL-04).
//   Готовые полные пакеты (out-<n>.json при том же входе) не повторяются: продолжение после паузы и повтор
//   оркестратора перезапускают только неполные пакеты (RUN-06, без потери полноты).
// • Канал А всегда relevant: код поправляет решение модели (и пишет об этом в reason_text и журнал).
// • Снимок качается только для отобранных (analyze), канал А — уже при сборе (ensureSnapshot идемпотентна).
// • budget.beforeProcess() — перед КАЖДЫМ процессом модели (пакеты отбора — каждый отдельно). Пауза/недельный
//   лимит бюджета становится провалом шага (budgetGate), чтобы расход уже сделанных пакетов попал в учёт.
//   Сведения о лимите после процесса передаёт в бюджет обёртка runStage (budget.ts observingRunStage, index.ts).
// • Домены WebFetch (PRM-04): см. allowedDomains — только проверенные источники (✅ и ⚠), FINDINGS «Фаза 6: PRM-04».

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, CollectOutput, ModelStage, Outcome, ProcessLog } from '../../shared/pipeline-types.ts';
import type { LedgerEntry } from '../../shared/run-types.ts';
import type { Card, NewsSweep, ScreenOutput, Translation, TriageOutput, Verification } from '../../shared/schema-types.ts';
import type { Country, SourceState, StageKey } from '../../shared/types.ts';
import { appendLog, safeActId } from '../archive.ts';
import { extractFragments, findTerms } from '../checks/bank-terms.ts';
import { checkCardEvidence, evidenceFailures } from '../checks/evidence.ts';
import { checkCompleteness } from '../checks/completeness.ts';
import { compareNumbers } from '../checks/numbers.ts';
import type { TranslateFn, TranslateResult } from '../digest/contracts.ts';
import { GLOSSARY } from '../digest/glossary.ts';
import type { CompletenessResult } from '../checks/completeness.ts';
import type { RelatedSource } from '../collect/snapshot.ts';
import { ensureSnapshot, isLexuzUrl, watchedStateFile } from '../collect/collector.ts';
import type { Collector, SnapshotMeta, WatchedFile } from '../collect/collector.ts';
import {
  dedupeDocs,
  editionCandidates,
  lexuzEditions,
  lexuzSearchNew,
  ruDateToIso,
  toCandidate,
} from '../collect/adapters/lexuz.ts';
import type { LexuzDoc } from '../collect/adapters/lexuz.ts';
import type { Fetcher } from '../collect/fetcher-types.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';
import { loadLedger } from '../ledger.ts';
import { createValidator, schemaForCli } from '../schemas.ts';
import type { SchemaName } from '../schemas.ts';
import { budgetGate } from './budget.ts';
import { runStage as realRunStage } from './claude-runner.ts';
import type { RunStageOptions, StageResult, ValidateFn } from './claude-runner.ts';
import { outcomeFromStage } from './orchestrator.ts';
import type {
  EvidenceResult,
  LeadHint,
  RejectedCandidate,
  ReviewerNotes,
  ScreenInputItem,
  StageContext,
  StageExecutors,
  VerifyCardInput,
} from './orchestrator.ts';
import { BLIND_HEAD_CHARS, MIN_TEXT_CHARS, type ScreenPrep } from './screen.ts';
import { buildStageInvocation, normalizeDomain, withPromptSuffix } from './stage-profiles.ts';

// ---------------------------------------------------------------------------------------------
// Публичные константы и типы
// ---------------------------------------------------------------------------------------------

/** Кандидатов в одном вызове /triage: ответ должен влезать целиком и не обрезаться. */
export const TRIAGE_BATCH = 40;

/** Карточек в одном процессе проверки (на 2 карточки уходило 14 ходов — большой набор в один процесс не влезает). */
export const VERIFY_CARD_BATCH = 3;

/** Отброшенных в одном процессе проверки (только VER-02: вернуть ошибочно отброшенных). */
export const VERIFY_REJECTED_BATCH = 80;

/** Текст для пользователя, если программа claude не найдена (NFR-18). */
export const NO_CLAUDE_MESSAGE =
  'Не найдена программа Claude Code. Установите её (см. «Проверка компьютера» на главной) или укажите путь к ней в Настройки → Дополнительно.';

export const NO_CLAUDE_MESSAGE_EN =
  'The Claude Code program was not found. Install it (see "Computer check" on the home screen) or specify its path in Settings → Advanced.';

export type EvidenceCheckResult = { field: string; ok: boolean; reason: string };

/** Что пишется в acts/<id>/evidence-check.json (оркестратор сохраняет возвращённый объект целиком). */
export interface EvidenceReport extends EvidenceResult {
  results: EvidenceCheckResult[];
  /** Какие тексты сверялись (имена файлов относительно папки акта). */
  texts: string[];
}

type MaybePromise<T> = T | Promise<T>;
type ExecLog = (ctx: StageContext, event: string, text: string, data?: Record<string, unknown>) => void;

/** Подмена адаптера lex.uz (тесты resolveLead). */
export interface LeadAdapters {
  lexuzSearchNew: typeof lexuzSearchNew;
  lexuzEditions: typeof lexuzEditions;
}

export interface ExecutorOptions {
  /**
   * Рабочая папка и настройки «вне прогона». Этапы берут ctx.workspaceDir и ctx.settings (настройки,
   * зафиксированные на старте/продолжении прогона); эти поля — запасные и для совместимости вызова.
   */
  workspaceDir?: string | (() => string);
  getSettings?: () => StageContext['settings'];
  /** Папка JSON-схем ответов (в сборке — process.resourcesPath/schemas). */
  schemasDir: string;
  /** Путь к claude или null — не найден (→ провал `spawn` с понятным текстом). */
  claudeBin: () => MaybePromise<string | null>;
  /** Окружение для claude (login shell без переменных CLAUDE_* и CLAUDECODE, env.ts buildClaudeEnv). */
  claudeEnv: () => MaybePromise<NodeJS.ProcessEnv>;
  fetcher: Fetcher;
  /** Сборщик (createCollector) — этап COLLECT. */
  collector: Collector;
  /** Подмена запуска процесса (тесты); по умолчанию runStage из claude-runner. */
  runStage?: (opts: RunStageOptions) => Promise<StageResult>;
  /** Перед каждым процессом модели (фаза 8: пауза по доле 5-часового лимита). */
  budget?: { beforeProcess(): Promise<void> };
  now?: () => Date;
  /** Журнал страны; по умолчанию — log.jsonl в папке страны. */
  log?: ExecLog;
  adapters?: Partial<LeadAdapters>;
}

// ---------------------------------------------------------------------------------------------
// Домены WebFetch (PRM-04)
// ---------------------------------------------------------------------------------------------

/**
 * Домены для `WebFetch(domain:…)` этапов анализа и проверки (PRM-04): включённые источники страны (кроме типа
 * «новости» — это только подсказки, COL-02) и отслеживаемые акты, ПРОВЕРЕННЫЕ проверкой источников: состояние ✅ ('ok')
 * или ⚠ ('warn' — источник работает с ограничениями, например не удалось подобрать способ чтения списка, но сайт
 * открывается и официальный). «Не проверен» и ❌ — не допускаются.
 * ОТКЛОНЕНИЕ от буквы PRM-04 («только ✅»): ⚠ тоже допускается — FINDINGS «Фаза 6: PRM-04».
 * К каждому домену добавляется парный вариант с `www.`/без него (lex.uz ↔ www.lex.uz — один сайт).
 */
const TRUSTED: readonly SourceState[] = ['ok', 'warn'];

export function allowedDomains(country: Pick<Country, 'sources' | 'watchedActs'>): string[] {
  const out: string[] = [];
  const add = (url: string): void => {
    const d = normalizeDomain(url);
    if (!d) return;
    const pair = d.startsWith('www.') ? d.slice(4) : `www.${d}`;
    for (const x of [d, normalizeDomain(pair)]) if (x && !out.includes(x)) out.push(x);
  };
  for (const s of country.sources ?? []) {
    if (!s.enabled || !TRUSTED.includes(s.state) || s.type === 'news') continue;
    add(s.url);
  }
  for (const a of country.watchedActs ?? []) {
    if (!TRUSTED.includes(a.state)) continue;
    add(a.url);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------------------------

const errText = (e: unknown): string => ((e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '').trim() || 'неизвестная ошибка';

function readJsonOr<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Хвост к промпту при повторе неполного отбора (английский — язык промптов). */
export function triageRetrySuffix(c: Pick<CompletenessResult, 'missing' | 'duplicates' | 'extra' | 'invalidIrrelevant'>): string {
  const parts: string[] = [];
  if (c.missing.length) parts.push(`missing candidate ids: ${c.missing.join(', ')}`);
  if (c.duplicates.length) parts.push(`ids listed more than once: ${c.duplicates.join(', ')}`);
  if (c.extra.length) parts.push(`ids that are not in the input file: ${c.extra.join(', ')}`);
  if (c.invalidIrrelevant.length) parts.push(`irrelevant without reason_code: ${c.invalidIrrelevant.join(', ')}`);
  return `\n\nYour previous answer was incomplete (${parts.join('; ')}). Return exactly one item for every candidate in the input file, no other ids.`;
}

/** Номер акта из ключа журнала: `reg:3254-2` → 3254-2, `num:24/2|…` → 24/2. */
function keyNumber(key: string): string {
  if (key.startsWith('reg:')) return key.slice(4);
  if (key.startsWith('num:')) return key.slice(4).split('|')[0] ?? '';
  return '';
}

/** Номер для сравнения: без «№/No», пробелов, суффикса «-son/-сон», регистра. */
function normNum(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/^(?:№|no\.?|n)\s*/u, '')
    .replace(/[-\s]*(?:son|сон)$/u, '')
    .replace(/\s+/g, '')
    .trim();
}

/** Дата наводки: ISO или ДД.ММ.ГГГГ; иначе null. */
function leadDate(s: string): string | null {
  const t = s.trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  if (m) return m[1]!;
  return ruDateToIso(t.slice(0, 10));
}

/** Провал шага из нескольких процессов: расход берётся из всех процессов (оркестратор суммирует их сам). */
function failWith<T>(out: Extract<Outcome<unknown>, { ok: false }>, processes: ProcessLog[]): Outcome<T> {
  return { ok: false, failure: out.failure, message: out.message, ...(out.resetsAt ? { resetsAt: out.resetsAt } : {}), processes };
}

const addDays = (iso: string, days: number): string => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Исполнители
// ---------------------------------------------------------------------------------------------

export function createStageExecutors(opts: ExecutorOptions): StageExecutors {
  const run = opts.runStage ?? realRunStage;
  const now = opts.now ?? (() => new Date());
  const ad: LeadAdapters = { lexuzSearchNew, lexuzEditions, ...opts.adapters };
  const validators = new Map<SchemaName, ValidateFn>();
  const cliSchemas = new Map<SchemaName, string>();
  /** Связанные страницы для снимка кандидата, найденного проверкой (новая редакция отслеживаемого акта). */
  const relatedFor = new Map<string, RelatedSource[]>();

  const validator = (name: SchemaName): ValidateFn => {
    let v = validators.get(name);
    if (!v) {
      v = createValidator(name, opts.schemasDir);
      validators.set(name, v);
    }
    return v;
  };
  const cliSchema = (name: SchemaName): string => {
    let s = cliSchemas.get(name);
    if (s === undefined) {
      s = schemaForCli(name, opts.schemasDir);
      cliSchemas.set(name, s);
    }
    return s;
  };

  const log = (ctx: StageContext, event: string, text: string, data: Record<string, unknown> = {}): void => {
    try {
      if (opts.log) opts.log(ctx, event, text, data);
      else appendLog(ctx.countryDir, { ts: now().toISOString(), country: ctx.country.code, event, text, ...data });
    } catch {
      /* журнал не роняет этап */
    }
  };

  /** Реальный путь папки страны: cwd процесса и основа всех путей во входе (macOS: /var → /private/var). */
  const realCountryDir = (ctx: StageContext): string => {
    mkdirSync(ctx.countryDir, { recursive: true });
    return realpathSync(ctx.countryDir);
  };
  const realActDir = (ctx: StageContext, id: string): string => join(realCountryDir(ctx), 'acts', safeActId(id));

  const noClaude = <T>(): Outcome<T> => ({ ok: false, failure: 'spawn', message: NO_CLAUDE_MESSAGE });

  interface ModelCall {
    ctx: StageContext;
    stage: StageKey & ModelStage;
    schema: SchemaName;
    /** Абсолютный (реальный) путь input.json; файл пишется здесь. */
    inputPath: string;
    input: unknown;
    /** cwd = реальная папка страны. */
    cwd: string;
    domains?: string[];
    transcriptPath?: string;
    promptSuffix?: string;
    act?: string;
  }

  /** Один процесс модели: input.json → бюджет → claude -p → Outcome. */
  async function callModel<T>(c: ModelCall): Promise<Outcome<T>> {
    const bin = await opts.claudeBin();
    if (!bin) return noClaude<T>();
    writeJsonAtomic(c.inputPath, c.input);
    let inv = buildStageInvocation({
      stage: c.stage,
      settings: c.ctx.settings,
      countryDir: c.cwd,
      inputPath: c.inputPath,
      ...(c.domains ? { allowedDomains: c.domains } : {}),
      schemaJson: cliSchema(c.schema),
    });
    if (c.promptSuffix) inv = withPromptSuffix(inv, c.promptSuffix);
    // Бюджет лимита: пауза/недельный лимит → провал шага (пакеты выше вернут его вместе с расходом сделанного).
    const stop = await budgetGate(opts.budget);
    if (stop) return stop;
    const env = await opts.claudeEnv();
    const res = await run({
      invocation: inv,
      bin,
      env: env as Record<string, string | undefined>,
      validate: validator(c.schema),
      ...(c.transcriptPath ? { transcriptPath: c.transcriptPath } : {}),
    });
    return outcomeFromStage<T>(res, inv, c.act);
  }

  const transcriptsOn = (ctx: StageContext): boolean => !!ctx.settings.advanced?.saveTranscripts;

  // ----- COLLECT -----

  async function collect(ctx: StageContext): Promise<Outcome<CollectOutput>> {
    return opts.collector.collect(ctx);
  }

  // ----- NEWS -----

  async function news(ctx: StageContext, known: Candidate[]): Promise<Outcome<NewsSweep>> {
    if (!ctx.settings.newsEnabled) return { ok: true, output: { country: ctx.country.code, leads: [] } };
    const cdir = realCountryDir(ctx);
    const dir = join(cdir, 'news');
    mkdirSync(dir, { recursive: true });
    const knownIds = [...new Set(known.map((k) => keyNumber(k.key)).filter(Boolean))];
    return callModel<NewsSweep>({
      ctx,
      stage: 'news',
      schema: 'news-sweep',
      cwd: cdir,
      inputPath: join(dir, 'in.json'),
      input: {
        country: { code: ctx.country.code, name: ctx.country.name, languages: ctx.country.languages },
        topic: ctx.settings.topic,
        date_from: ctx.window.from,
        date_to: ctx.window.to,
        known_ids: knownIds,
      },
      ...(transcriptsOn(ctx) ? { transcriptPath: join(dir, 'transcript.jsonl') } : {}),
    });
  }

  // ----- Наводки: код ищет акт в первичной базе -----

  /** Поиск акта из новостной наводки на lex.uz по номеру принятия (`actnum`) и дате. */
  async function resolveNewsLead(ctx: StageContext, lead: Extract<LeadHint, { kind: 'news' }>['lead'], known: Candidate[]): Promise<Candidate | null> {
    const num = lead.act_number.trim();
    const n = normNum(num);
    if (!n) {
      log(ctx, 'lead_no_number', `Наводка «${lead.headline}» без номера акта — искать в первичной базе нечего`, { url: lead.url });
      return null;
    }
    // Уже найденный кандидат с тем же номером (рег. номер или номер принятия).
    const same = known.find((k) => normNum(keyNumber(k.key)) === n);
    if (same) return same;

    const lexSource = ctx.country.sources.find((s) => s.enabled && s.state !== 'fail' && s.type === 'legal_base' && isLexuzUrl(s.url));
    if (!lexSource) {
      log(ctx, 'lead_no_adapter', `Наводка «${lead.headline}»: для первичной базы страны нет кода поиска по номеру — не подтверждена`, { act_number: num });
      return null;
    }
    const date = leadDate(lead.act_date) ?? leadDate(lead.date);
    const from = addDays(date ?? ctx.window.from, -30);
    const to = date && date > ctx.window.to ? date : ctx.window.to;
    const docs: LexuzDoc[] = [];
    for (const regOnly of [true, false]) {
      const r = await ad.lexuzSearchNew({ fetcher: opts.fetcher, window: { from, to }, regOnly, actNum: num });
      if (!r.ok) {
        log(ctx, 'lead_search_failed', `Наводка «${lead.headline}»: поиск lex.uz не удался — ${r.reason}`, { act_number: num });
        continue;
      }
      docs.push(...r.docs);
    }
    const found = dedupeDocs(docs);
    // Сайт уже отфильтровал по номеру принятия; уточняем по видимому номеру и дате, если их видно.
    let pick = found.filter((d) => [d.registrationNumber, d.adoptionNumber, d.adoptionNumberRu].some((x) => normNum(x) === n));
    if (pick.length === 0) pick = found;
    if (pick.length > 1 && date) {
      const byDate = pick.filter((d) => d.adoptionDate === date || d.registrationDate === date);
      if (byDate.length) pick = byDate;
    }
    if (pick.length !== 1) {
      log(ctx, 'lead_ambiguous', `Наводка «${lead.headline}»: в lex.uz найдено актов с номером ${num}: ${pick.length} — подтвердить однозначно нельзя`, {
        act_number: num,
        found: pick.map((d) => d.url),
      });
      return null;
    }
    const doc = pick[0]!;
    const cand = toCandidate(doc, 'D');
    if (!cand.date) cand.date = date ?? ctx.window.to;
    cand.snippet = [`Наводка из новостей: «${lead.headline}» (${lead.outlet}, ${lead.date}, ${lead.url})`, cand.snippet].filter(Boolean).join(' | ');
    return known.find((k) => k.id === cand.id || k.key === cand.key) ?? cand;
  }

  /** Новая редакция отслеживаемого акта, найденная проверкой: код открывает историю редакций на lex.uz. */
  async function resolveWatched(ctx: StageContext, check: Extract<LeadHint, { kind: 'watched_edition' }>['check'], known: Candidate[]): Promise<Candidate | null> {
    const reg = normNum(check.registration_number);
    const act =
      ctx.country.watchedActs.find((a) => reg && normNum(a.registrationNumber) === reg) ??
      (check.url ? ctx.country.watchedActs.find((a) => a.url === check.url) : undefined);
    if (!act) {
      log(ctx, 'watched_unknown', `Проверка сообщила о редакции акта ${check.registration_number}, которого нет среди отслеживаемых`, { ...check });
      return null;
    }
    if (!isLexuzUrl(act.url)) {
      log(ctx, 'watched_no_adapter', `Отслеживаемый акт «${act.title}»: историю редакций код читает только на lex.uz — не подтверждено`, { url: act.url });
      return null;
    }
    const today = now();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const r = await ad.lexuzEditions({
      fetcher: opts.fetcher,
      docUrl: act.url,
      today: todayIso,
      ...(check.edition_date ? { detailDates: [check.edition_date] } : {}),
    });
    if (!r.ok) {
      log(ctx, 'watched_check_failed', `Отслеживаемый акт «${act.title}»: ${r.reason}`, { url: act.url });
      return null;
    }
    let edition = check.edition_date ? r.editions.find((e) => e.date === check.edition_date) : undefined;
    if (!edition && !check.edition_date) {
      const seen = readJsonOr<WatchedFile>(watchedStateFile(ctx.workspaceDir), {})[act.url];
      const knownDates = new Set(seen?.knownEditions ?? (seen?.lastSeenEdition ? [seen.lastSeenEdition] : []));
      edition = r.editions.filter((e) => !knownDates.has(e.date)).at(-1);
    }
    if (!edition) return null;
    const list = editionCandidates(r, edition);
    const fresh = list.find((c) => !known.some((k) => k.id === c.id || k.key === c.key));
    const pick = fresh ?? list[0];
    if (!pick) return null;
    const known1 = known.find((k) => k.id === pick.id || k.key === pick.key);
    if (known1) return known1;
    pick.snippet = `Канал А (найдено проверкой): ${act.title} — ${edition.label} | ${pick.snippet}`;
    const rel: RelatedSource[] = [{ label: 'Базовый акт (действующая редакция)', url: r.url }];
    if (edition.url !== pick.url) rel.push({ label: `Редакция на ${edition.date} (дата вступления изменений)`, url: edition.url });
    relatedFor.set(pick.id, rel);
    return pick;
  }

  async function resolveLead(ctx: StageContext, lead: LeadHint, known: Candidate[]): Promise<Candidate | null> {
    try {
      return lead.kind === 'news' ? await resolveNewsLead(ctx, lead.lead, known) : await resolveWatched(ctx, lead.check, known);
    } catch (e) {
      log(ctx, 'lead_error', `Проверка подсказки в первичной базе не удалась: ${errText(e)}`);
      return null;
    }
  }

  // ----- TRIAGE -----

  async function triage(ctx: StageContext, candidates: Candidate[]): Promise<Outcome<TriageOutput>> {
    const code = ctx.country.code;
    if (candidates.length === 0) return { ok: true, output: { country: code, items: [] } };
    const cdir = realCountryDir(ctx);
    const dir = join(cdir, 'triage');
    mkdirSync(dir, { recursive: true });
    const batches = chunk(candidates, TRIAGE_BATCH);
    const processes: ProcessLog[] = [];
    const items: TriageOutput['items'] = [];

    for (const [i, batch] of batches.entries()) {
      const n = i + 1;
      const ids = batch.map((c) => c.id);
      const input = {
        topic: ctx.settings.topic,
        perspective: ctx.settings.perspective,
        country: { code, name: ctx.country.name },
        candidates: batch.map((c) => ({
          id: c.id,
          title_original: c.title_original,
          title_en: c.title_en ?? '',
          issuer: c.issuer,
          date: c.date,
          doc_type: c.doc_type,
          url: c.url,
          snippet: c.snippet,
          channel: c.channel,
        })),
      };
      const inputPath = join(dir, `in-${n}.json`);
      const outPath = join(dir, `out-${n}.json`);

      // Готовый полный пакет с тем же входом не повторяется (продолжение после паузы, повтор оркестратора).
      const prevIn = readJsonOr<unknown>(inputPath, null);
      const prevOut = readJsonOr<TriageOutput | null>(outPath, null);
      if (prevOut && JSON.stringify(prevIn) === JSON.stringify(input) && validator('triage')(prevOut).ok && checkCompleteness(ids, prevOut.items).ok) {
        items.push(...prevOut.items);
        log(ctx, 'triage_batch_reused', `Отбор, пакет ${n} из ${batches.length}: уже готов, повторно не запускается`, { batch: n });
        continue;
      }

      const call = (suffix?: string): Promise<Outcome<TriageOutput>> =>
        callModel<TriageOutput>({
          ctx,
          stage: 'triage',
          schema: 'triage',
          cwd: cdir,
          inputPath,
          input,
          ...(suffix ? { promptSuffix: suffix } : {}),
          ...(transcriptsOn(ctx) ? { transcriptPath: join(dir, `transcript-${n}.jsonl`) } : {}),
        });

      // Повтор оркестратора (ctx.retry): хвост — про ошибки именно этого пакета, если его прошлый ответ сохранён.
      const retrySuffix = ctx.retry ? triageRetrySuffix(prevOut ? checkCompleteness(ids, prevOut.items ?? []) : ctx.retry.details) : undefined;
      let out = await call(retrySuffix);
      processes.push(...(out.processes ?? []));
      if (!out.ok) return failWith(out, processes);
      let comp = checkCompleteness(ids, out.output.items ?? []);
      if (!comp.ok && !ctx.retry) {
        // Один повтор пакета внутри исполнителя (HAL-04); второй шанс на уровне страны — у оркестратора.
        log(ctx, 'triage_batch_retry', `Отбор, пакет ${n}: ответ неполный — повтор пакета`, {
          batch: n,
          missing: comp.missing,
          extra: comp.extra,
          duplicates: comp.duplicates,
          invalid_irrelevant: comp.invalidIrrelevant,
        });
        const again = await call(triageRetrySuffix(comp));
        processes.push(...(again.processes ?? []));
        if (!again.ok) return failWith(again, processes);
        out = again;
        comp = checkCompleteness(ids, out.output.items ?? []);
      }
      writeJsonAtomic(outPath, out.output);
      if (!comp.ok) log(ctx, 'triage_batch_incomplete', `Отбор, пакет ${n}: ответ неполный и после повтора — решает оркестратор`, { batch: n, missing: comp.missing });
      items.push(...(out.output.items ?? []));
    }

    // Канал А всегда relevant (правило скилла + код).
    const channelA = new Set(candidates.filter((c) => c.channel === 'A').map((c) => c.id));
    const fixed = items.map((it) => {
      if (!channelA.has(it.id) || it.decision !== 'irrelevant') return it;
      log(ctx, 'triage_channel_a_forced', `${it.id}: модель отбросила акт канала А (${it.reason_code ?? '—'}) — принудительно relevant`, { id: it.id, reason_code: it.reason_code });
      const note = '[forced relevant: channel A — new edition of a watched act] ';
      return { ...it, decision: 'relevant' as const, reason_code: null, reason_text: (note + it.reason_text).slice(0, 200) };
    });
    return { ok: true, output: { country: code, items: fixed }, processes };
  }

  // ----- ANALYZE -----

  async function analyze(ctx: StageContext, candidate: Candidate, notes?: ReviewerNotes): Promise<Outcome<Card>> {
    const code = ctx.country.code;
    // Снимок — только для отобранных (канал А уже снят при сборе; функция идемпотентна).
    const snap = await ensureSnapshot(
      { candidate, ctx, fetcher: opts.fetcher, ...(relatedFor.has(candidate.id) ? { related: relatedFor.get(candidate.id)! } : {}) },
      now(),
    );
    if (!snap.ok) {
      return { ok: false, failure: 'source', message: `Не удалось сохранить страницу акта ${candidate.id} (${candidate.url}): ${snap.message}` };
    }
    const cdir = realCountryDir(ctx);
    const adir = realActDir(ctx, candidate.id);
    const meta = readJsonOr<SnapshotMeta | null>(join(adir, 'snapshot.json'), null);
    const related = (meta?.related ?? [])
      .filter((r) => r.ok && r.text)
      .map((r) => ({ label: r.label, url: r.url, text_path: join(adir, r.text!), ...(r.html ? { html_path: join(adir, r.html) } : {}) }));

    const ledger: LedgerEntry[] = ctx.mode === 'backfill' ? [] : loadLedger(ctx.workspaceDir, code);
    const entry = ledger.find((e) => e.key === candidate.key) ?? null;
    const reviewer = notes
      ? [
          ...notes.fields.map((f) => ({ ...f, round: notes.round })),
          ...notes.evidenceFailedFields.map((field) => ({
            field,
            status: 'quote_not_found',
            comment: 'The app could not find this quote verbatim in the saved snapshot. Copy the quote exactly from the snapshot or set the value to unknown.',
            round: notes.round,
          })),
        ]
      : null;

    const input = {
      topic: ctx.settings.topic,
      perspective: ctx.settings.perspective,
      country: { code, name: ctx.country.name, languages: ctx.country.languages },
      candidate: {
        id: candidate.id,
        title_original: candidate.title_original,
        issuer: candidate.issuer,
        date: candidate.date,
        url: candidate.url,
        channel: candidate.channel,
      },
      snapshot_text_path: join(adir, 'snapshot.txt'),
      snapshot_html_path: join(adir, 'snapshot.html'),
      related_snapshots: related,
      allowed_domains: allowedDomains(ctx.country),
      ...(entry ? { ledger_entry: entry } : {}),
      ...(reviewer ? { reviewer_notes: reviewer } : {}),
    };
    return callModel<Card>({
      ctx,
      stage: 'analyze',
      schema: 'card',
      cwd: cdir,
      inputPath: join(adir, 'input.json'),
      input,
      domains: input.allowed_domains,
      act: candidate.id,
      ...(transcriptsOn(ctx) ? { transcriptPath: join(adir, 'transcript.jsonl') } : {}),
    });
  }

  // ----- Проверка цитат (код, HAL-02/03) -----

  /** Тексты снимка акта: snapshot.txt и related/<n>.txt (по номеру). */
  function snapshotTexts(adir: string): { names: string[]; texts: string[] } {
    const names: string[] = [];
    const texts: string[] = [];
    if (existsSync(join(adir, 'snapshot.txt'))) {
      names.push('snapshot.txt');
      texts.push(readFileSync(join(adir, 'snapshot.txt'), 'utf8'));
    }
    let rel: string[] = [];
    try {
      rel = readdirSync(join(adir, 'related')).filter((f) => f.endsWith('.txt'));
    } catch {
      /* связанных страниц нет */
    }
    rel.sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b));
    for (const f of rel) {
      names.push(`related/${f}`);
      texts.push(readFileSync(join(adir, 'related', f), 'utf8'));
    }
    return { names, texts };
  }

  async function checkEvidence(ctx: StageContext, candidate: Candidate, card: Card): Promise<EvidenceReport> {
    const adir = realActDir(ctx, candidate.id);
    const { names, texts } = snapshotTexts(adir);
    const results = checkCardEvidence(card, texts);
    const failedFields = evidenceFailures(results);
    const report: EvidenceReport = { ok: failedFields.length === 0, failedFields, results, texts: names };
    writeJsonAtomic(join(adir, 'evidence-check.json'), report);
    return report;
  }

  // ----- VERIFY -----

  async function verify(ctx: StageContext, cards: VerifyCardInput[], rejected: RejectedCandidate[]): Promise<Outcome<Verification>> {
    const code = ctx.country.code;
    if (cards.length === 0 && rejected.length === 0) return { ok: true, output: { country: code, cards: [], returned: [], watched_acts_check: [] } };
    const cdir = realCountryDir(ctx);
    const dir = join(cdir, 'verify');
    const cacheDir = join(dir, 'cache');
    mkdirSync(cacheDir, { recursive: true });
    let n = 1;
    try {
      n = readdirSync(dir).filter((f) => /^in-\d+\.json$/.test(f)).length + 1;
    } catch {
      /* первый проход */
    }
    const watched = readJsonOr<WatchedFile>(watchedStateFile(ctx.workspaceDir), {});
    const domains = allowedDomains(ctx.country);

    // Пакеты: карточки по VERIFY_CARD_BATCH (отброшенных нет), затем отброшенные по VERIFY_REJECTED_BATCH (карточек нет).
    // watched_acts — в первый пакет вообще.
    const batches: Array<{ cards: VerifyCardInput[]; rejected: RejectedCandidate[] }> = [
      ...chunk(cards, VERIFY_CARD_BATCH).map((c) => ({ cards: c, rejected: [] as RejectedCandidate[] })),
      ...chunk(rejected, VERIFY_REJECTED_BATCH).map((r) => ({ cards: [] as VerifyCardInput[], rejected: r })),
    ];
    const processes: ProcessLog[] = [];
    const merged: Verification = { country: code, cards: [], returned: [], watched_acts_check: [] };
    const cacheFiles: string[] = [];

    for (const [i, batch] of batches.entries()) {
      const evidence = batch.cards
        .filter((c) => c.evidenceFailedFields.length > 0)
        .map((c) => {
          const adir = realActDir(ctx, c.candidate.id);
          const rep = readJsonOr<Partial<EvidenceReport> | null>(join(adir, 'evidence-check.json'), null);
          const failed = new Set(c.evidenceFailedFields);
          return {
            candidate_id: c.candidate.id,
            failed_fields: c.evidenceFailedFields,
            details: (rep?.results ?? []).filter((r) => failed.has(r.field) && !r.ok),
          };
        });
      const input = {
        country: { code, name: ctx.country.name, languages: ctx.country.languages },
        topic: ctx.settings.topic,
        perspective: ctx.settings.perspective,
        allowed_domains: domains,
        cards: batch.cards.map((c) => {
          const adir = realActDir(ctx, c.candidate.id);
          const meta = readJsonOr<SnapshotMeta | null>(join(adir, 'snapshot.json'), null);
          return {
            candidate_id: c.candidate.id,
            card_path: join(adir, 'card.json'),
            snapshot_text_path: join(adir, 'snapshot.txt'),
            related_snapshot_paths: (meta?.related ?? []).filter((r) => r.ok && r.text).map((r) => join(adir, r.text!)),
            round: c.round,
          };
        }),
        rejected: batch.rejected.map((r) => ({
          id: r.candidate.id,
          title: r.candidate.title_original,
          issuer: r.candidate.issuer,
          date: r.candidate.date,
          url: r.candidate.url,
          reason: `${r.reason_code ?? 'no_code'}: ${r.reason_text}`,
        })),
        watched_acts:
          i === 0
            ? ctx.country.watchedActs.map((a) => ({
                title: a.title,
                registration_number: a.registrationNumber,
                url: a.url,
                latest_edition_date: watched[a.url]?.lastSeenEdition ?? null,
              }))
            : [],
        evidence_check: evidence,
      };
      const ids = batch.cards.map((c) => c.candidate.id);
      const missingIn = (v: Verification): string[] => {
        const got = new Set((v.cards ?? []).map((x) => x.candidate_id));
        return ids.filter((id) => !got.has(id));
      };

      // Готовый пакет с тем же входом (после сбоя другого пакета) повторно не запускается.
      const cacheFile = join(cacheDir, `${createHash('sha1').update(JSON.stringify(input)).digest('hex')}.json`);
      const cached = readJsonOr<Verification | null>(cacheFile, null);
      let result: Verification | null = null;
      if (cached && validator('verification')(cached).ok && missingIn(cached).length === 0) {
        result = cached;
        cacheFiles.push(cacheFile);
        log(ctx, 'verify_batch_reused', `Проверка, пакет ${i + 1} из ${batches.length}: уже готов, повторно не запускается`, { batch: i + 1 });
      }

      if (!result) {
        const bn = n++;
        const inputPath = join(dir, `in-${bn}.json`);
        const call = (suffix?: string): Promise<Outcome<Verification>> =>
          callModel<Verification>({
            ctx,
            stage: 'verify',
            schema: 'verification',
            cwd: cdir,
            inputPath,
            input,
            domains,
            ...(suffix ? { promptSuffix: suffix } : {}),
            ...(transcriptsOn(ctx) ? { transcriptPath: join(dir, `transcript-${bn}.jsonl`) } : {}),
          });
        let out = await call();
        processes.push(...(out.processes ?? []));
        if (!out.ok) return failWith(out, processes);
        let missing = missingIn(out.output);
        if (missing.length) {
          // COV-03: один повтор пакета с перечнем пропущенных карточек.
          log(ctx, 'verify_retry', `Проверка не вернула ответ по карточкам ${missing.join(', ')} — повтор`, { missing, batch: i + 1 });
          const again = await call(
            `\n\nYour previous answer had no entry in "cards" for these candidate_id values: ${missing.join(', ')}. Check every card listed in the input file and return one entry per card.`,
          );
          processes.push(...(again.processes ?? []));
          if (!again.ok) return failWith(again, processes);
          out = again;
          missing = missingIn(out.output);
        }
        if (missing.length) {
          return {
            ok: false,
            failure: 'schema',
            message: `Проверка отчёта не вернула результат по карточкам: ${missing.join(', ')}`,
            processes,
          };
        }
        result = out.output;
        writeJsonAtomic(cacheFile, result);
        cacheFiles.push(cacheFile);
      }

      for (const c of result.cards ?? []) if (!merged.cards.some((x) => x.candidate_id === c.candidate_id)) merged.cards.push(c);
      for (const r of result.returned ?? []) if (!merged.returned.some((x) => x.id === r.id)) merged.returned.push(r);
      if (i === 0) merged.watched_acts_check = result.watched_acts_check ?? [];
    }

    // Проход завершён целиком: следующий проход (другой круг) начинает с чистого кэша.
    for (const f of cacheFiles) rmSync(f, { force: true });
    return { ok: true, output: merged, processes };
  }

  // ----- SCREEN (экран по тексту, SCR) -----

  /** Снимок страницы (с PDF для lex.uz), банковские термины и фрагменты текста — всё кодом, без модели. */
  async function prepareScreen(ctx: StageContext, candidate: Candidate): Promise<{ ok: true; prep: ScreenPrep } | { ok: false; message: string }> {
    const snap = await ensureSnapshot(
      { candidate, ctx, fetcher: opts.fetcher, ...(relatedFor.has(candidate.id) ? { related: relatedFor.get(candidate.id)! } : {}) },
      now(),
    );
    if (!snap.ok) return { ok: false, message: `страница акта не открылась: ${snap.message}` };
    const text = readFileSync(snap.textPath, 'utf8');
    const meta = readJsonOr<SnapshotMeta | null>(join(snap.dir, 'snapshot.json'), null);
    const fromPdf = meta?.pdf?.ok === true;
    if (text.length < MIN_TEXT_CHARS) {
      const why = meta?.pdf && !meta.pdf.ok ? `PDF не прочитан: ${meta.pdf.message ?? 'причина неизвестна'}` : 'на странице только заголовок, текста акта нет';
      return { ok: true, prep: { hasText: false, textSource: 'none', termCount: findTerms(text).length, fragments: [], message: why } };
    }
    const terms = findTerms(text);
    // Терминов нет: фрагментов вокруг них не будет, и модель увидела бы одну строку заголовка. Даём начало текста,
    // чтобы тему акта можно было понять (договор, квоты, миграция…), а не отправлять его «на всякий случай» на разбор.
    const fragments = terms.length === 0 ? [text.slice(0, BLIND_HEAD_CHARS)] : extractFragments(text).fragments.map((f) => f.text);
    return { ok: true, prep: { hasText: true, textSource: fromPdf ? 'pdf' : 'html', termCount: terms.length, fragments } };
  }

  /** Один процесс модели по пакету кандидатов. Режим `confirm` идёт на отдельный этап с моделью не слабее sonnet. */
  async function screen(ctx: StageContext, items: ScreenInputItem[], mode: 'screen' | 'confirm'): Promise<Outcome<ScreenOutput>> {
    const code = ctx.country.code;
    if (items.length === 0) return { ok: true, output: { country: code, mode, items: [] } };
    const cdir = realCountryDir(ctx);
    const dir = join(cdir, 'screen');
    mkdirSync(dir, { recursive: true });
    const input = {
      topic: ctx.settings.topic,
      perspective: ctx.settings.perspective,
      country: { code, name: ctx.country.name },
      mode,
      candidates: items.map((i) => ({
        id: i.candidate.id,
        title_original: i.candidate.title_original,
        issuer: i.candidate.issuer,
        issuer_class: i.candidate.issuerClass ?? 2,
        date: i.candidate.date,
        doc_type: i.candidate.doc_type,
        url: i.candidate.url,
        term_count: i.prep.termCount,
        fragments: i.prep.fragments,
        ...(i.previous ? { previous: i.previous } : {}),
      })),
    };
    const tag = createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 10);
    return callModel<ScreenOutput>({
      ctx,
      stage: mode === 'confirm' ? 'confirm' : 'screen',
      schema: 'screen',
      cwd: cdir,
      inputPath: join(dir, `in-${mode}-${tag}.json`),
      input,
      ...(transcriptsOn(ctx) ? { transcriptPath: join(dir, `transcript-${mode}-${tag}.jsonl`) } : {}),
    });
  }

  return { collect, news, resolveLead, triage, prepareScreen, screen, analyze, checkEvidence, verify };
}

// ---------------------------------------------------------------------------------------------
// Перевод письма (LNG-02/03): короткие английские фрагменты → русский, сверка чисел кодом
// ---------------------------------------------------------------------------------------------

/** Фрагментов в одном вызове /translate-ru: ответ должен влезать целиком и не обрезаться. */
export const TRANSLATE_BATCH = 60;

export type TranslatorOptions = Pick<ExecutorOptions, 'schemasDir' | 'claudeBin' | 'claudeEnv' | 'runStage' | 'budget'> & {
  /** Подмена глоссария (тесты); по умолчанию digest/glossary.ts. */
  glossary?: Readonly<Record<string, string>>;
  /** Размер пакета; по умолчанию TRANSLATE_BATCH. */
  batchSize?: number;
};

/** Что пишется в <runDir>/translate/result.json (для приложения и FINDINGS). */
export interface TranslateReport extends TranslateResult {
  total: number;
  translated: number;
  /** Пакеты, по которым модель не дала ответа (английский остаётся). */
  failedBatches: Array<{ batch: number; failure: string; message: string }>;
}

/**
 * Перевод фрагментов письма моделью этапа `translate` (скилл translate-ru, права — только Read своей папки, без сети).
 * Вход — <runDir>/translate/input.json (`{ glossary, items:[{id,text}] }`), пакеты по TRANSLATE_BATCH (второй
 * и дальше — input-<n>.json). Каждый перевод сверяется кодом с оригиналом (compareNumbers: числа, даты, номера, URL);
 * расхождение или отсутствие перевода → фрагмент в `rejected`, в `translations` не попадает: в письме остаётся
 * английский (LNG-03, T-7). Провал всех пакетов (или лимит подписки) → ok:false; провал части — ok:true без них.
 */
export function createTranslator(opts: TranslatorOptions): TranslateFn {
  const run = opts.runStage ?? realRunStage;
  const glossary = opts.glossary ?? GLOSSARY;
  const size = Math.max(1, opts.batchSize ?? TRANSLATE_BATCH);
  let validate: ValidateFn | null = null;
  let schemaJson: string | null = null;

  return async (ctx, texts) => {
    const uniq = [...new Set(texts)].filter((t) => typeof t === 'string' && t.trim() !== '');
    const result: TranslateResult = { translations: {}, rejected: [] };
    if (uniq.length === 0) return { ok: true, output: result };
    const bin = await opts.claudeBin();
    if (!bin) return { ok: false, failure: 'spawn', message: NO_CLAUDE_MESSAGE };
    validate ??= createValidator('translation', opts.schemasDir);
    schemaJson ??= schemaForCli('translation', opts.schemasDir);

    const base = join(ctx.runDir, 'translate');
    mkdirSync(base, { recursive: true });
    // cwd процесса = реальная папка перевода (изоляция чтения, macOS: /var → /private/var).
    const dir = realpathSync(base);
    const processes: ProcessLog[] = [];
    const failedBatches: TranslateReport['failedBatches'] = [];
    const batches = chunk(uniq, size);
    let okBatches = 0;
    let lastFail: Extract<Outcome<unknown>, { ok: false }> | null = null;

    for (const [i, batch] of batches.entries()) {
      const n = i + 1;
      const items = batch.map((text, j) => ({ id: `t${i * size + j + 1}`, text }));
      const inputPath = join(dir, n === 1 ? 'input.json' : `input-${n}.json`);
      writeJsonAtomic(inputPath, { glossary, items });
      const inv = buildStageInvocation({ stage: 'translate', settings: ctx.settings, countryDir: dir, inputPath, schemaJson });
      // Бюджет лимита: пауза или недельный лимит → перевод не получен, письмо уйдёт с английскими фрагментами.
      const stop = await budgetGate(opts.budget);
      if (stop) return failWith<TranslateResult>(stop, processes);
      const env = await opts.claudeEnv();
      const res = await run({
        invocation: inv,
        bin,
        env: env as Record<string, string | undefined>,
        validate,
        ...(ctx.settings.advanced?.saveTranscripts ? { transcriptPath: join(dir, `transcript-${n}.jsonl`) } : {}),
      });
      const out = outcomeFromStage<Translation>(res, inv);
      processes.push(...(out.processes ?? []));
      if (!out.ok) {
        lastFail = out;
        failedBatches.push({ batch: n, failure: out.failure, message: out.message });
        // Лимит подписки: дальше пакеты тоже упрутся — возвращаем провал, оркестратор решит (пауза/английский).
        if (out.failure === 'limit') return failWith<TranslateResult>(out, processes);
        continue;
      }
      okBatches++;
      writeJsonAtomic(join(dir, n === 1 ? 'output.json' : `output-${n}.json`), out.output);
      const got = new Map<string, string>();
      for (const it of out.output.items ?? []) if (!got.has(it.id)) got.set(it.id, it.ru);
      for (const it of items) {
        const ru = got.get(it.id)?.trim();
        if (!ru) {
          result.rejected.push({ text: it.text, diffs: ['нет перевода в ответе модели'] });
          continue;
        }
        const check = compareNumbers(it.text, ru);
        if (!check.ok) {
          result.rejected.push({ text: it.text, diffs: check.details });
          continue;
        }
        if (ru !== it.text) result.translations[it.text] = ru;
      }
    }

    const report: TranslateReport = {
      ...result,
      total: uniq.length,
      translated: Object.keys(result.translations).length,
      failedBatches,
    };
    try {
      writeJsonAtomic(join(dir, 'result.json'), report);
    } catch {
      /* отчёт о переводе не роняет письмо */
    }
    if (okBatches === 0 && lastFail) return failWith<TranslateResult>(lastFail, processes);
    return { ok: true, output: result, processes };
  };
}
