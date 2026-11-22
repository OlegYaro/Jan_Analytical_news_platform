// Этап COLLECT (docs/02 §4, шаг 1): код собирает кандидатов по каналам А/Б/В, 0 вызовов модели (COL-01).
// Без electron и без раннера модели: сеть — только через инъектируемый Fetcher (COL-06).
//
// Решения (подробно — docs/FINDINGS.md, «Фаза 4: сбор UZ»):
// • Способ чтения источника: хост lex.uz → адаптер (COL-07); иначе — профиль извлечения Source.profile (SRC-04);
//   нет ни того ни другого → честный пропуск с причиной (COV-04), а не «нет изменений».
// • Критичность сбоя (COV-04): сбой критичен, если в стране не прочитан НИ ОДИН включённый источник того же типа
//   (тип = Source.type, «своего типа»). Есть прочитанный дубль того же типа → предупреждение в письме.
//   Источник с ❌ после проверки (SRC-05) не опрашивается и даёт только предупреждение.
// • Окно: lex.uz показывает дату регистрации/принятия, а на сайт акт попадает позже, поэтому адаптер берёт ещё
//   7 дней запаса назад (inWindow:false). Такие акты НЕ отбрасываются (иначе акт, выложенный после прошлого
//   прогона с датой до его конца, потерялся бы между окнами) — они помечены в snippet «по запасу»; уже
//   отправленные отсеет журнал (COL-04). В ретро-прогоне (backfill) окно задано пользователем — строго по окну.
//   Профили (RSS/HTML/JSON) показывают дату публикации на сайте — строго по окну. Документ без даты берётся
//   с date = конец окна и snippet «дата не найдена в списке» (в Candidate.date нет 'unknown').
// • Аномалия (COV-05): число документов источника → sourceCounts (историю пишет оркестратор, только
//   scheduled|manual). Профиль: весь прочитанный список (не зависит от окна). lex.uz: число актов за окно —
//   точка пишется, только если окно ≥ 7 дней (иначе короткое окно дало бы законный 0 и ложную аномалию).
// • Канал А (lex.uz): новые редакции отслеживаемых актов по state/watched.json. Чтобы новая редакция не
//   потерялась, если прогон страны потом провалится, показанные редакции запоминаются в `reported` и
//   показываются снова, пока окно (с даты последнего успешного прогона) их не перерастёт.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate, Channel, CollectOutput, Outcome, SourceAnomaly, SourceFailure } from '../../shared/pipeline-types.ts';
import type { ExtractionProfile } from '../../shared/profile-types.ts';
import type { LedgerEntry } from '../../shared/run-types.ts';
import type { Source, SourceType, WatchedAct } from '../../shared/types.ts';
import { actDir, actPaths, appendLog } from '../archive.ts';
import { detectAnomaly, loadSourceHealth } from '../checks/anomaly.ts';
import { setSourceState } from '../countries/store.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';
import { classify, ledgerKey, loadLedger, shouldWriteLedger } from '../ledger.ts';
import type { StageContext } from '../runner/orchestrator.ts';
import {
  baseDocUrl,
  dedupeDocs,
  editionCandidates,
  lexuzEditions,
  lexuzPdfUrl,
  lexuzSearchNew,
  newEditionsSince,
  nextWatchedState,
  toCandidate,
  type LexuzDoc,
  type LexuzEdition,
  type WatchedActState,
} from './adapters/lexuz.ts';
import type { FetchOptions, FetchResult, Fetcher } from './fetcher-types.ts';
import { runProfile, type CollectedDoc } from './profile.ts';
import { takeSnapshot, type PdfSnapshotInfo, type RelatedSource } from './snapshot.ts';

// ───────────────────────── Публичные типы ─────────────────────────

/** Что сборщику нужно из контекста этапа (StageContext оркестратора подходит как есть). */
export type CollectContext = Pick<StageContext, 'runId' | 'workspaceDir' | 'countryDir' | 'country' | 'mode' | 'window'>;

/** Запись в log.jsonl страны: событие, текст по-русски, данные. */
export type CollectLog = (event: string, text: string, data?: Record<string, unknown>) => void;

/** Подмена адаптеров (тесты). По умолчанию — настоящие функции lexuz.ts. */
export interface CollectorAdapters {
  lexuzSearchNew: typeof lexuzSearchNew;
  lexuzEditions: typeof lexuzEditions;
}

export interface CollectorOptions {
  fetcher: Fetcher;
  /** Рабочая папка: state/watched.json, state/source-health.json, state/ledger/. */
  workspaceDir: string;
  now?: () => Date;
  adapters?: Partial<CollectorAdapters>;
  /** Журнал; по умолчанию — log.jsonl в папке страны (как у оркестратора). */
  log?: (ctx: CollectContext, event: string, text: string, data?: Record<string, unknown>) => void;
  /** Папка countries.json (настройки приложения) — для пометки ⚠ сломанного источника (SRC-08). Нет — не помечаем. */
  countriesDir?: string;
}

export interface Collector {
  /** Формат StageExecutors.collect. */
  collect(ctx: CollectContext): Promise<Outcome<CollectOutput>>;
}

/** Причины пропуска — дословно для письма и журнала. */
export const NO_METHOD_REASON = 'для источника ещё нет способа чтения — запустите проверку источников';
export const BAD_PROFILE_REASON = 'профиль чтения источника повреждён — запустите проверку источников';
export const FAILED_SOURCE_REASON = 'источник отмечен ❌ при проверке и не участвует в прогоне';
/** SRC-08: причина ⚠ в countries.json. */
export const BROKEN_LIST_REASON = 'Список документов не разобран — перепроверьте источник';
export const NO_DATE_NOTE = 'дата не найдена в списке';

/** Файл состояния канала А: url отслеживаемого акта → состояние. */
export const watchedStateFile = (workspaceDir: string): string => join(workspaceDir, 'state', 'watched.json');

/**
 * Состояние акта в state/watched.json. `reported` — дата редакции → местная дата, когда её редакцию впервые
 * показали кандидатом; пока эта дата ≥ начала окна (последний успешный прогон был раньше), редакция
 * показывается снова — провал страны после сбора её не теряет.
 */
export interface WatchedEntry extends WatchedActState {
  reported?: Record<string, string>;
}
export type WatchedFile = Record<string, WatchedEntry>;

// ───────────────────────── Помощники ─────────────────────────

const DAY = 86_400_000;
const pad = (n: number): string => String(n).padStart(2, '0');
const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY);

const TYPE_RU: Record<SourceType, string> = { legal_base: 'правовая база', regulator: 'регулятор', drafts: 'проекты', news: 'новости' };

/** Хост lex.uz (с www и поддоменами) → адаптер. */
export function isLexuzUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'lex.uz' || h.endsWith('.lex.uz');
  } catch {
    return false;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Профиль пригоден к запуску (форма как в docs/04 §5). Повреждённый — как отсутствующий, с другой причиной. */
export function isUsableProfile(p: unknown): p is ExtractionProfile {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  if (!isStr(o['url']) || !/^https?:\/\//i.test(o['url'])) return false;
  if (o['kind'] === 'rss') return true;
  if (o['kind'] === 'html_list') return isStr(o['item']);
  if (o['kind'] === 'json_api') {
    const j = o['json_paths'] as Record<string, unknown> | undefined;
    return !!j && typeof j === 'object' && ['items', 'title', 'link', 'date'].every((k) => typeof j[k] === 'string');
  }
  return false;
}

/** Fetcher со счётчиком запросов и последним ответом (чтобы отличить «сайт не ответил» от «список не разобран»). */
function tracked(base: Fetcher): Fetcher & { requests: number; first: FetchResult | null } {
  const t = {
    requests: 0,
    first: null as FetchResult | null,
    async get(url: string, o?: FetchOptions) {
      t.requests++;
      const r = await base.get(url, o);
      t.first ??= r;
      return r;
    },
    async postForm(url: string, f: Record<string, string>, o?: FetchOptions) {
      t.requests++;
      const r = await base.postForm(url, f, o);
      t.first ??= r;
      return r;
    },
  };
  return t;
}

const errText = (e: unknown): string => ((e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '').trim() || 'неизвестная ошибка';

function hostSlug(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^A-Za-z0-9.-]/g, '_');
  } catch {
    return 'src';
  }
}

/** Документ профиля → кандидат. id стабилен (хост + хэш адреса) — одинаковые ссылки двух источников склеиваются. */
export function profileDocCandidate(doc: CollectedDoc, source: Pick<Source, 'name'>, channel: Channel, windowTo: string): Candidate {
  const hash = createHash('sha1').update(doc.url).digest('hex').slice(0, 12);
  const parts = [`${source.name}: ${doc.title}`];
  if (doc.issuer) parts.push(doc.issuer);
  if (!doc.date) parts.unshift(NO_DATE_NOTE);
  return {
    id: `${hostSlug(doc.url)}-${hash}`,
    // Без даты ключ — по адресу (дата окна менялась бы каждый прогон и журнал бы не узнавал документ).
    key: ledgerKey({ date: doc.date ?? undefined, url: doc.url }),
    title_original: doc.title,
    issuer: doc.issuer,
    date: doc.date ?? windowTo,
    doc_type: '',
    url: doc.url,
    snippet: parts.join(' | '),
    channel,
  };
}

/** Акт lex.uz → кандидат канала Б: дата «по запасу» и отсутствие даты помечаются в snippet. */
export function lexuzDocCandidate(doc: LexuzDoc, window: { from: string; to: string }): Candidate {
  const c = toCandidate(doc, 'B');
  const notes: string[] = [];
  if (!c.date) {
    c.date = window.to;
    notes.push(NO_DATE_NOTE);
  } else if (!doc.inWindow) {
    notes.push(`по запасу: видимая дата ${c.date} раньше начала окна ${window.from} (акт мог появиться на сайте позже)`);
  }
  if (notes.length) c.snippet = [...notes, c.snippet].filter(Boolean).join(' | ');
  return c;
}

/**
 * Склейка кандидатов по id между источниками и каналами: первая запись выигрывает (канал А идёт первым, его
 * maybeUpdate и канал сохраняются); пустые issuer/doc_type дополняются из повторов, а их название и snippet
 * дописываются в snippet — для отбора видно и собственное название изменяющего акта.
 */
export function mergeCandidates(list: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of list) {
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, { ...c });
      continue;
    }
    if (!prev.issuer && c.issuer) prev.issuer = c.issuer;
    if (!prev.doc_type && c.doc_type) prev.doc_type = c.doc_type;
    const extra = [c.title_original !== prev.title_original ? `Название: ${c.title_original}` : '', c.snippet]
      .filter((x) => x && !prev.snippet.includes(x))
      .join(' | ');
    if (extra) prev.snippet = prev.snippet ? `${prev.snippet} | ${extra}` : extra;
  }
  return [...byId.values()];
}

function loadWatched(workspaceDir: string): WatchedFile {
  const file = watchedStateFile(workspaceDir);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as WatchedFile) : {};
  } catch {
    return {};
  }
}

/** Стадия для сравнения с журналом (TRI-05): будущая редакция — опубликован, иначе — действует. */
function editionStage(e: LexuzEdition): 'published' | 'in_force' {
  return e.status === 'future' ? 'published' : 'in_force';
}

// ───────────────────────── Снимки (COL-05) ─────────────────────────

export interface EnsureSnapshotInput {
  candidate: Pick<Candidate, 'id' | 'url'>;
  ctx: Pick<CollectContext, 'workspaceDir' | 'runId' | 'country'>;
  fetcher: Fetcher;
  /** Связанные страницы (базовый акт, редакция на дату вступления) → related/<n>.html|.txt. */
  related?: RelatedSource[];
}

export type EnsureSnapshotResult =
  | { ok: true; dir: string; htmlPath: string; textPath: string; /** false — снимок уже был, сеть не трогали. */ fresh: boolean }
  | { ok: false; dir: string; message: string };

/** Описание снимка рядом с ним: откуда, когда, какие связанные страницы (для этапа анализа). */
export interface SnapshotMeta {
  url: string;
  finalUrl: string;
  takenAt: string;
  bytes: number;
  related: Array<{ label: string; url: string; ok: boolean; html?: string; text?: string; message?: string }>;
  /** Есть, если текста в HTML было мало и пробовали PDF (lex.uz). */
  pdf?: PdfSnapshotInfo;
}

/**
 * Снимок кандидата в acts/<safeActId>/ (snapshot.html + snapshot.txt + snapshot.json). Идемпотентна: если снимок
 * уже есть — ничего не качает. Вызывается сборщиком для канала А и шагом анализа для relevant|borderline.
 */
export async function ensureSnapshot(input: EnsureSnapshotInput, now: Date = new Date()): Promise<EnsureSnapshotResult> {
  const dir = actDir(input.ctx.workspaceDir, input.ctx.runId, input.ctx.country.code, input.candidate.id);
  const p = actPaths(dir);
  if (existsSync(p.snapshotHtml) && existsSync(p.snapshotTxt)) {
    return { ok: true, dir, htmlPath: p.snapshotHtml, textPath: p.snapshotTxt, fresh: false };
  }
  const r = await takeSnapshot({ fetcher: input.fetcher, url: input.candidate.url, dir, relatedSnapshots: input.related, pdfUrlFor: lexuzPdfUrl });
  if (!r.ok) return { ok: false, dir, message: r.message };
  const meta: SnapshotMeta = {
    url: input.candidate.url,
    finalUrl: r.finalUrl,
    takenAt: now.toISOString(),
    bytes: r.bytes,
    related: r.related.map((x) => ({
      label: x.label,
      url: x.url,
      ok: x.ok,
      ...(x.htmlPath ? { html: x.htmlPath.slice(dir.length + 1) } : {}),
      ...(x.textPath ? { text: x.textPath.slice(dir.length + 1) } : {}),
      ...(x.message ? { message: x.message } : {}),
    })),
    ...(r.pdf ? { pdf: r.pdf } : {}),
  };
  writeJsonAtomic(join(dir, 'snapshot.json'), meta);
  return { ok: true, dir, htmlPath: r.htmlPath, textPath: r.textPath, fresh: true };
}

// ───────────────────────── Сборщик ─────────────────────────

/** Итог чтения одного источника. */
interface SourceRead {
  source: Source;
  ok: boolean;
  candidates: Candidate[];
  /** Число документов для COV-05 (null — точку не пишем). */
  count: number | null;
  failure?: { message: string; forceNonCritical?: boolean; noMethod?: boolean };
  /** Список не разобран при непустой странице → ⚠ (SRC-08). */
  broken?: boolean;
}

export function createCollector(opts: CollectorOptions): Collector {
  const now = opts.now ?? (() => new Date());
  const ad: CollectorAdapters = { lexuzSearchNew, lexuzEditions, ...opts.adapters };

  function logFor(ctx: CollectContext): CollectLog {
    if (opts.log) return (e, t, d) => opts.log!(ctx, e, t, d);
    return (event, text, data = {}) => {
      try {
        appendLog(ctx.countryDir, { ts: now().toISOString(), country: ctx.country.code, event, text, ...data });
      } catch {
        /* лог не должен ронять сбор */
      }
    };
  }

  // ── Канал Б: lex.uz ──
  async function readLexuz(ctx: CollectContext, s: Source, log: CollectLog): Promise<SourceRead> {
    const f = tracked(opts.fetcher);
    const docs: LexuzDoc[] = [];
    const fails: string[] = [];
    let parserFail = false;
    for (const regOnly of [true, false]) {
      const r = await ad.lexuzSearchNew({ fetcher: f, window: ctx.window, regOnly });
      const what = regOnly ? 'акты с регистрацией Минюста' : 'акты без регистрации (законы, указы, постановления)';
      if (!r.ok) {
        fails.push(`${what}: ${r.reason}`);
        if (r.failure === 'parser') parserFail = true;
        continue;
      }
      for (const w of r.warnings) log('source_note', `«${s.name}» (${what}): ${w}`, { sourceId: s.id });
      docs.push(...r.docs);
    }
    let found = dedupeDocs(docs);
    if (ctx.mode === 'backfill') found = found.filter((d) => d.inWindow); // ретро: строго по окну пользователя
    const inWin = found.filter((d) => d.inWindow).length;
    const candidates = found.map((d) => lexuzDocCandidate(d, ctx.window));
    log(
      'source_read',
      `«${s.name}» (${TYPE_RU[s.type]}, адаптер lex.uz): актов ${found.length}, из них в окне ${inWin}, по запасу ${found.length - inWin}; запросов ${f.requests}`,
      { sourceId: s.id, method: 'adapter:lexuz', docs: found.length, inWindow: inWin, requests: f.requests },
    );
    const longWindow = daysBetween(ctx.window.from, ctx.window.to) >= 7;
    if (fails.length) {
      return { source: s, ok: false, candidates, count: null, failure: { message: `lex.uz: ${fails.join('; ')}` }, broken: parserFail };
    }
    if (!longWindow) log('source_count_skipped', `«${s.name}»: окно короче 7 дней — число актов в историю (COV-05) не пишется`, { sourceId: s.id });
    return { source: s, ok: true, candidates, count: longWindow ? inWin : null };
  }

  // ── Каналы Б/В: профиль ──
  async function readProfile(ctx: CollectContext, s: Source, profile: ExtractionProfile, channel: Channel, log: CollectLog): Promise<SourceRead> {
    const f = tracked(opts.fetcher);
    const r = await runProfile(profile, f);
    if (!r.ok) {
      const pageOk = !!f.first && f.first.ok && f.first.body.trim().length > 0;
      log('source_failed', `«${s.name}»: ${pageOk ? 'список не разобран' : 'не ответил'} — ${r.reason}`, { sourceId: s.id, method: profile.kind, requests: f.requests });
      return pageOk
        ? { source: s, ok: false, candidates: [], count: null, broken: true, failure: { message: `${BROKEN_LIST_REASON}: ${r.reason}` } }
        : { source: s, ok: false, candidates: [], count: null, failure: { message: r.reason } };
    }
    const { from, to } = ctx.window;
    const inWindow = r.docs.filter((d) => d.date === null || (d.date >= from && d.date <= to));
    const undated = inWindow.filter((d) => d.date === null).length;
    log(
      'source_read',
      `«${s.name}» (${TYPE_RU[s.type]}, профиль ${profile.kind}): документов в списке ${r.docs.length}, в окне ${inWindow.length - undated}, без даты ${undated}; запросов ${f.requests}`,
      { sourceId: s.id, method: profile.kind, docs: r.docs.length, inWindow: inWindow.length - undated, undated, requests: f.requests },
    );
    return { source: s, ok: true, candidates: inWindow.map((d) => profileDocCandidate(d, s, channel, to)), count: r.docs.length };
  }

  async function readSource(ctx: CollectContext, s: Source, log: CollectLog): Promise<SourceRead> {
    if (s.state === 'fail') {
      log('source_skipped', `«${s.name}»: ${FAILED_SOURCE_REASON}`, { sourceId: s.id });
      return { source: s, ok: false, candidates: [], count: null, failure: { message: FAILED_SOURCE_REASON, forceNonCritical: true } };
    }
    const channel: Channel = s.type === 'drafts' ? 'C' : 'B';
    if (channel === 'B' && isLexuzUrl(s.url)) return readLexuz(ctx, s, log);
    if (s.profile != null && isUsableProfile(s.profile)) return readProfile(ctx, s, s.profile, channel, log);
    const reason = s.profile != null ? BAD_PROFILE_REASON : NO_METHOD_REASON;
    log('source_skipped', `«${s.name}» (${TYPE_RU[s.type]}) пропущен: ${reason}`, { sourceId: s.id });
    return { source: s, ok: false, candidates: [], count: null, failure: { message: reason, noMethod: s.profile == null } };
  }

  // ── Канал А: редакции отслеживаемых актов lex.uz ──
  async function readWatched(
    ctx: CollectContext,
    acts: WatchedAct[],
    ledger: LedgerEntry[],
    log: CollectLog,
  ): Promise<{ candidates: Candidate[]; failures: SourceFailure[]; related: Map<string, RelatedSource[]> }> {
    const today = localDate(now());
    const backfill = ctx.mode === 'backfill';
    const write = shouldWriteLedger(ctx.mode);
    const state = backfill ? {} : loadWatched(opts.workspaceDir);
    const out: Candidate[] = [];
    const failures: SourceFailure[] = [];
    const related = new Map<string, RelatedSource[]>();
    let dirty = false;

    for (const act of acts) {
      if (!isLexuzUrl(act.url)) {
        log('watched_skipped', `Отслеживаемый акт «${act.title}»: история редакций кодом читается только на lex.uz — пропущен`, { actId: act.id, url: act.url });
        continue;
      }
      const f = tracked(opts.fetcher);
      const r = await ad.lexuzEditions({ fetcher: f, docUrl: act.url, today });
      if (!r.ok) {
        const msg = `Отслеживаемый акт «${act.title}»: ${r.reason}`;
        log('watched_failed', msg, { actId: act.id, failure: r.failure, requests: f.requests });
        failures.push({ sourceId: act.id, message: msg, critical: false });
        continue;
      }
      const prev: WatchedEntry = state[act.url] ?? { url: act.url, lastSeenEdition: null };
      let fresh: LexuzEdition[];
      if (backfill) {
        fresh = newEditionsSince(r.editions, null, { firstRunFrom: ctx.window.from });
      } else {
        const byState = newEditionsSince(r.editions, prev.lastSeenEdition, { known: prev.knownEditions, firstRunFrom: ctx.window.from });
        const again = r.editions.filter((e) => (prev.reported?.[e.date] ?? '') >= ctx.window.from && !byState.includes(e));
        fresh = [...byState, ...again].sort((a, b) => a.date.localeCompare(b.date));
      }
      const base = baseDocUrl(act.url);
      let added = 0;
      for (const e of fresh) {
        for (const c of editionCandidates(r, e)) {
          if (backfill && c.date > ctx.window.to) continue; // ретро: изменяющий акт позже окна — не наш период
          const entry = ledger.find((x) => x.key === c.key) ?? null;
          if (entry && classify(entry, { stage: editionStage(e), effective_date: e.date }).kind === 'update') c.maybeUpdate = true;
          c.snippet = `Канал А: ${act.title} — ${e.label} | ${c.snippet}`;
          const rel: RelatedSource[] = [{ label: 'Базовый акт (действующая редакция)', url: base }];
          if (e.url !== c.url) rel.push({ label: `Редакция на ${e.date} (дата вступления изменений)`, url: e.url });
          if (!related.has(c.id)) related.set(c.id, rel);
          out.push(c);
          added++;
        }
      }
      log(
        'watched_read',
        `Отслеживаемый акт «${act.title}»: редакций ${r.editions.length}, новых ${fresh.length} (${fresh.map((e) => e.date).join(', ') || '—'}), кандидатов ${added}; запросов ${f.requests}`,
        { actId: act.id, editions: r.editions.map((e) => e.date), fresh: fresh.map((e) => e.date), requests: f.requests },
      );
      if (write) {
        const next: WatchedEntry = nextWatchedState(prev, r.editions, now());
        const reported: Record<string, string> = {};
        for (const [d, at] of Object.entries(prev.reported ?? {})) if (at >= ctx.window.from) reported[d] = at;
        for (const e of fresh) reported[e.date] ??= today;
        if (Object.keys(reported).length) next.reported = reported;
        state[act.url] = next;
        dirty = true;
      }
    }
    if (dirty) writeJsonAtomic(watchedStateFile(opts.workspaceDir), state);
    return { candidates: out, failures, related };
  }

  async function collect(ctx: CollectContext): Promise<Outcome<CollectOutput>> {
    const log = logFor(ctx);
    const code = ctx.country.code;
    if (!ctx.country.active) {
      log('collect_skipped', `Страна ${code} выключена — источники не опрашиваются`);
      return { ok: true, output: { candidates: [] } };
    }
    const t0 = now();
    log('collect_start', `Сбор ${code} за окно ${ctx.window.from}…${ctx.window.to} (режим ${ctx.mode})`, { window: ctx.window, mode: ctx.mode });

    // Каналы Б и В — по источникам.
    const reads: SourceRead[] = [];
    for (const s of ctx.country.sources) {
      if (!s.enabled) continue;
      if (s.type === 'news') {
        log('source_skipped', `«${s.name}» (новости) кодом не собирается — только этап поиска в новостях`, { sourceId: s.id });
        continue;
      }
      try {
        reads.push(await readSource(ctx, s, log));
      } catch (e) {
        log('source_failed', `«${s.name}»: внутренняя ошибка сборщика — ${errText(e)}`, { sourceId: s.id });
        reads.push({ source: s, ok: false, candidates: [], count: null, failure: { message: `внутренняя ошибка сборщика: ${errText(e)}` } });
      }
    }

    // COV-04: критичен сбой, если ни один включённый источник этого типа не прочитан.
    const okTypes = new Set(reads.filter((r) => r.ok).map((r) => r.source.type));
    // Источник, у которого ещё нет способа чтения (не проверен), — не «недоступный»: он критичен,
    // только если в стране вообще нечем читать (иначе до проверки источников страна всегда была бы failed:source).
    const anyReadable = reads.some((r) => r.ok);
    const sourceFailures: SourceFailure[] = reads
      .filter((r) => r.failure)
      .map((r) => ({
        sourceId: r.source.id,
        message: `«${r.source.name}»: ${r.failure!.message}`,
        critical: !r.failure!.forceNonCritical && (r.failure!.noMethod ? !anyReadable : !okTypes.has(r.source.type)),
      }));

    // SRC-08: сломанный список → ⚠ в countries.json (только режимы, которые пишут состояние).
    const marks = shouldWriteLedger(ctx.mode) && !!opts.countriesDir;
    for (const r of reads.filter((x) => x.broken)) {
      if (!marks) {
        log('source_warn_not_marked', `«${r.source.name}»: список не разобран; ⚠ не ставится (режим ${ctx.mode})`, { sourceId: r.source.id });
        continue;
      }
      try {
        const res = setSourceState(opts.countriesDir!, code, r.source.id, 'warn', BROKEN_LIST_REASON, now());
        if (res.changed) log('source_marked_warn', `«${r.source.name}» помечен ⚠: ${BROKEN_LIST_REASON}`, { sourceId: r.source.id });
      } catch (e) {
        log('source_mark_failed', `«${r.source.name}»: не удалось пометить ⚠ — ${errText(e)}`, { sourceId: r.source.id });
      }
    }

    // COV-05: числа документов и аномалия «0 при обычно > 0».
    const health = loadSourceHealth(opts.workspaceDir);
    const sourceCounts: Array<{ sourceId: string; count: number }> = [];
    const anomalies: SourceAnomaly[] = [];
    for (const r of reads) {
      if (r.count === null) continue;
      sourceCounts.push({ sourceId: r.source.id, count: r.count });
      const a = detectAnomaly(health[r.source.id] ?? [], t0, r.count);
      if (a.anomaly) anomalies.push({ sourceId: r.source.id, median: a.median, message: `«${r.source.name}»: 0 документов` });
    }

    // Канал А.
    const ledger = ctx.mode === 'backfill' ? [] : loadLedger(opts.workspaceDir, code);
    const watched = await readWatched(ctx, ctx.country.watchedActs ?? [], ledger, log);
    sourceFailures.push(...watched.failures);

    // Склейка: канал А первым (выигрывает), дальше Б/В в порядке источников.
    const candidates = mergeCandidates([...watched.candidates, ...reads.flatMap((r) => r.candidates)]);

    // Снимки канала А сразу (решение пользователя); уже отправленные без новой стадии журнал отсеет — их не качаем.
    const sent = new Set(ledger.map((e) => e.key));
    for (const c of candidates) {
      if (c.channel !== 'A') continue;
      if (sent.has(c.key) && !c.maybeUpdate) {
        log('snapshot_skipped', `Снимок ${c.id} не нужен: уже отправлялся (${c.key})`, { id: c.id });
        continue;
      }
      try {
        const snap = await ensureSnapshot({ candidate: c, ctx, fetcher: opts.fetcher, related: watched.related.get(c.id) }, now());
        if (snap.ok) log('snapshot', `Снимок ${c.id}: ${snap.textPath}${snap.fresh ? '' : ' (уже был)'}`, { id: c.id, dir: snap.dir });
        else log('snapshot_failed', `Снимок ${c.id} не сохранён: ${snap.message} (повторит этап анализа)`, { id: c.id });
      } catch (e) {
        log('snapshot_failed', `Снимок ${c.id} не сохранён: ${errText(e)}`, { id: c.id });
      }
    }

    const byCh = (ch: Channel): number => candidates.filter((c) => c.channel === ch).length;
    log(
      'collect_summary',
      `Собрано кандидатов ${candidates.length} (А ${byCh('A')}, Б ${byCh('B')}, В ${byCh('C')}); сбоев источников ${sourceFailures.length}` +
        `${sourceFailures.some((x) => x.critical) ? ' (есть критичные)' : ''}; аномалий ${anomalies.length}; 0 вызовов модели`,
      { candidates: candidates.length, A: byCh('A'), B: byCh('B'), C: byCh('C'), failures: sourceFailures.length, anomalies: anomalies.length },
    );
    return { ok: true, output: { candidates, sourceFailures, anomalies, sourceCounts } };
  }

  return { collect };
}
