// Проверка источников страны (фаза 6, SRC-02..06, T-10). Без electron: всё внешнее — инъекцией.
//
// Главное (docs/FINDINGS «Фаза 6»):
// • Страницу открывает КОД (доступность, перенаправления, вход/капча, «нужен JavaScript») и кладёт её в файлы
//   `state/source-checks/<CC>/<sourceId>/page-0.html|txt`. Модель пишет способ чтения (профиль) по этим файлам (Read),
//   потому что WebFetch отдаёт обработанный текст, а не HTML (FINDINGS, замечание №3).
// • lex.uz читается адаптером — модель не нужна: код сам ищет новые акты за 14 дней (запасной путь — лента RSS).
// • Остальные источники страны — ОДИН вызов модели на страну (`verify-sources`, cwd = папка проверки страны);
//   предложенный профиль код скачивает и прогоняет сам; ✅ — только если код извлёк ≥ 3 документа с датами (SRC-04).
//   Не вышло — до 3 раундов: следующий вызов только по неудачным источникам, с `previous_attempt`.
// • «Что видно на сайте» (seenLatest) — только извлечённое кодом, ответ модели `seen_latest` не используется.
// • Отслеживаемые акты (SRC-06): lex.uz — код (номер/название на странице, история редакций); остальные — вердикт модели.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractionProfile } from '../../shared/profile-types.ts';
import type { SourcesCheck } from '../../shared/schema-types.ts';
import type { ActCheckResultDto, SourceCheckResultDto } from '../../shared/sources-types.ts';
import type { Country, SeenItem, Settings, Source, SourceState, WatchedAct } from '../../shared/types.ts';
import { lexuzEditions, lexuzSearchNew } from '../collect/adapters/lexuz.ts';
import type { LexuzDoc } from '../collect/adapters/lexuz.ts';
import { isLexuzUrl, isUsableProfile, BROKEN_LIST_REASON } from '../collect/collector.ts';
import type { FetchOptions, FetchResult, Fetcher } from '../collect/fetcher-types.ts';
import { profileHealthy, runProfile } from '../collect/profile.ts';
import type { CollectedDoc } from '../collect/profile.ts';
import { htmlToText } from '../collect/snapshot.ts';
import { loadCountries, setSourceState, setWatchedActState } from '../countries/store.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';
import type { RateLimitInfo } from '../runner/claude-runner.ts';
import { normalizeDomain } from '../runner/stage-profiles.ts';
import { callModel } from './model-call.ts';
import type { ModelDeps } from './model-call.ts';
import { analyzePage, captchaReason, loginReason, hostOf, probePage, savePage, siteOf, unreachableReason } from './page-probe.ts';
import type { PageProbe, SavedPage } from './page-probe.ts';
import { GENERIC_REASON_EN, GENERIC_REASON_RU, REASON_EN, REASON_RU, translateReasons } from './reasons-ru.ts';
import { langOf, mt } from '../i18n.ts';

// ───────────────────────── Константы ─────────────────────────

/** Раундов «модель предлагает способ чтения → код прогоняет». */
export const MAX_ROUNDS = 3;
/** Окно поиска новых актов lex.uz при проверке. */
export const LEXUZ_CHECK_DAYS = 14;
/** Лента lex.uz — запасной способ убедиться, что новые акты видны. */
export const LEXUZ_RSS_URL = 'https://lex.uz/ru/rss';
/** `item` профиля html_list, которым модель просит скачать страницу (её нет среди файлов). */
export const PAGE_REQUEST = '?';
/** Сколько документов с датами нужно для ✅ (SRC-04). */
export const MIN_DATED = 3;
/** Последний документ старше — список «давно не обновлялся». */
export const STALE_DAYS = 365;

export const checksDir = (workspaceDir: string, code: string): string => join(workspaceDir, 'state', 'source-checks', code);

// ───────────────────────── Типы ─────────────────────────

export interface CheckProgress {
  code: string;
  text: string;
  /** Сколько источников/актов страны уже с итогом. */
  done: number;
  total: number;
}

export interface CheckerDeps extends ModelDeps {
  fetcher: Fetcher;
  workspaceDir: string;
  /** Папка countries.json (настройки приложения). */
  countriesDir: string;
  settings: Settings | (() => Settings);
  now?: () => Date;
  log?: (event: string, text: string, data?: Record<string, unknown>) => void;
  onProgress?: (p: CheckProgress) => void;
  adapters?: Partial<{ lexuzSearchNew: typeof lexuzSearchNew; lexuzEditions: typeof lexuzEditions }>;
  maxRounds?: number;
  /** Без модели: только то, что код выясняет сам (открывается ли, вход/капча, lex.uz, сохранённые профили). Для ручных скриптов. */
  skipModel?: boolean;
}

export interface CheckSourcesOptions extends CheckerDeps {
  /** Код страны. */
  country: string;
  /** Только эти источники (без них — все включённые). */
  sourceIds?: string[];
  /** Только эти акты; без sourceIds и actIds — все акты страны; с sourceIds без actIds — акты не проверяются. */
  actIds?: string[];
}

export interface ModelCallLog {
  round: number;
  sources: string[];
  ok: boolean;
  failure?: string;
  costUsd: number;
  turns: number | null;
  durationMs: number;
  model: string;
  denied: string[];
}

export interface CheckSourcesResult {
  country: string;
  ok: boolean;
  /** Итог по-русски. */
  message: string;
  sources: SourceCheckResultDto[];
  acts: ActCheckResultDto[];
  costUsd: number;
  modelCalls: ModelCallLog[];
  rateLimit?: RateLimitInfo;
  /** Проверка прервана (лимит Claude, нет Claude Code): часть источников осталась без итога. */
  interrupted?: { failure: string; message: string; resetsAt?: string };
  /** Источники без итога (проверка прервана): что успел выяснить код. */
  unresolved: Array<{ sourceId: string; name: string; url: string; finalUrl: string | null; status: number | null; needsJs: boolean; passwordField: boolean; visibleTextChars: number }>;
  dir: string;
}

type ModelSource = SourcesCheck['sources'][number];

interface PreviousAttempt {
  profile: ExtractionProfile | ModelSource['profile'];
  extracted_count: number;
  dated_count: number;
  problem: string;
  html_path: string | null;
  text_path: string | null;
  sample: Array<{ title: string; date: string | null; url: string }>;
}

/** Рабочее состояние источника во время проверки. */
interface Work {
  s: Source;
  dir: string;
  probe: PageProbe;
  pages: SavedPage[];
  result?: SourceCheckResultDto;
  rounds: number;
  previous?: PreviousAttempt;
  lastModel?: ModelSource;
  /** Последнее, что извлёк код (для «что видно на сайте», даже если не хватило для ✅). */
  lastDocs: CollectedDoc[];
  recommendation?: string;
}

// ───────────────────────── Помощники ─────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');
const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (iso: string, days: number): string => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
const ruDate = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso);
const errText = (e: unknown): string => ((e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '').trim() || 'неизвестная ошибка';

/** До 5 последних документов: с датами по убыванию, затем без дат. */
export function latestSeen(docs: readonly CollectedDoc[], n = 5): SeenItem[] {
  const dated = docs.filter((d) => d.date).sort((a, b) => (b.date! < a.date! ? -1 : b.date! > a.date! ? 1 : 0));
  const undated = docs.filter((d) => !d.date);
  return [...dated, ...undated].slice(0, n).map((d) => ({ title: d.title, date: d.date ?? '', url: d.url }));
}

const datedCount = (docs: readonly CollectedDoc[]): number => docs.filter((d) => d.date !== null).length;

/** Документ lex.uz → запись списка (дата — видимая на сайте: регистрации, иначе принятия). */
function lexDoc(d: LexuzDoc): CollectedDoc {
  return { id: d.url, title: d.title, date: d.registrationDate ?? d.adoptionDate ?? null, url: d.url, issuer: d.issuer ?? '' };
}

/** Номер акта для сравнения: без «рег.», «№», пробелов, суффикса «-son/-сон», регистра. */
export function normActNumber(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/рег(?:истрационный)?\.?\s*(?:номер)?|ro[ʻ‘'’`]?yxat\s+raqami|№|\bno\.?(?=\s*\d)/gu, '')
    .replace(/\s+/g, '')
    .replace(/-?(?:son|сон|sonli|сонли)$/u, '')
    .replace(/^[.,:;-]+|[.,:;-]+$/g, '')
    .trim();
}

const STOP_WORDS = new Set(['закон', 'положение', 'постановление', 'республики', 'республика', 'рус', 'the', 'law', 'and', 'для', 'при']);

/** Значимые слова названия (≥ 4 букв, без служебных и того, что в скобках). */
function titleWords(title: string): string[] {
  return title
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/** Нормализация текста для поиска вхождений (пробелы, регистр, апострофы, кавычки). */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ʼʻ‘’`´]/g, "'")
    .replace(/[«»“”„]/g, '"')
    .replace(/[ ­​]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Название акта узнаётся на странице: ≥ 70% значимых слов есть в тексте (по началу слова — падежи). */
export function titleSeen(title: string, pageText: string): boolean {
  const words = titleWords(title);
  if (words.length === 0) return false;
  const text = normText(pageText);
  const hit = words.filter((w) => text.includes(w.slice(0, Math.max(4, Math.ceil(w.length * 0.75))))).length;
  return hit / words.length >= 0.7;
}

/** Номер виден в тексте как отдельный номер (3254 не совпадает с 3254-2 и 13254). */
export function numberSeen(num: string, pageText: string): boolean {
  const n = normActNumber(num);
  if (n.length < 2) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}/-])${esc}(?![\\p{N}]|[-/]\\p{N})`, 'iu').test(normText(pageText));
}

/** Fetcher, который отдаёт уже скачанные страницы из памяти (адрес → ответ) и запоминает последний ответ. */
function cachingFetcher(base: Fetcher, cache: Map<string, FetchResult>): Fetcher & { last: FetchResult | null; requests: number } {
  const key = (u: string): string => u.replace(/#.*$/, '').replace(/\/+$/, '');
  const f = {
    last: null as FetchResult | null,
    requests: 0,
    async get(url: string, o?: FetchOptions): Promise<FetchResult> {
      const hit = cache.get(key(url));
      if (hit) {
        f.last = hit;
        return hit;
      }
      f.requests++;
      const r = await base.get(url, { timeoutMs: 45_000, ...o });
      if (r.ok) cache.set(key(url), r);
      f.last = r;
      return r;
    },
    async postForm(url: string, fields: Record<string, string>, o?: FetchOptions): Promise<FetchResult> {
      f.requests++;
      const r = await base.postForm(url, fields, o);
      f.last = r;
      return r;
    },
  };
  return f;
}

/** Домены для `WebFetch(domain:…)` проверки (docs/02 §6): все проверяемые источники и акты, независимо от состояния. */
export function checkDomains(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const d = normalizeDomain(u);
    if (!d) continue;
    const pair = d.startsWith('www.') ? d.slice(4) : `www.${d}`;
    for (const x of [d, normalizeDomain(pair)]) if (x && !out.includes(x)) out.push(x);
  }
  return out;
}

// ───────────────────────── Основная функция ─────────────────────────

export async function checkSources(o: CheckSourcesOptions): Promise<CheckSourcesResult> {
  const now = o.now ?? (() => new Date());
  const settings = typeof o.settings === 'function' ? o.settings() : o.settings;
  const maxRounds = Math.max(1, o.maxRounds ?? MAX_ROUNDS);
  const ad = { lexuzSearchNew, lexuzEditions, ...o.adapters };
  const code = o.country.trim().toUpperCase();
  const L = langOf(settings);
  /** Тексты для окна — на языке интерфейса (журнал log.jsonl остаётся русским). */
  const tt = (ru: string, en: string): string => mt(L, ru, en);
  const RS = L === 'en' ? REASON_EN : REASON_RU;
  const GENERIC = L === 'en' ? GENERIC_REASON_EN : GENERIC_REASON_RU;

  const country: Country | undefined = loadCountries(o.countriesDir).find((c) => c.code === code);
  const base = checksDir(o.workspaceDir, code);
  mkdirSync(base, { recursive: true });
  const dir = realpathSync(base);
  const logFile = join(dir, 'log.jsonl');
  const log = (event: string, text: string, data: Record<string, unknown> = {}): void => {
    try {
      if (o.log) o.log(event, text, { country: code, ...data });
      else appendFileSync(logFile, JSON.stringify({ ts: now().toISOString(), country: code, event, text, ...data }) + '\n', 'utf8');
    } catch {
      /* журнал не роняет проверку */
    }
  };
  const empty = (message: string): CheckSourcesResult => ({ country: code, ok: false, message, sources: [], acts: [], costUsd: 0, modelCalls: [], unresolved: [], dir });
  if (!country) return empty(tt('Страна не найдена в списке', 'The country was not found in the list'));

  const sources = o.sourceIds ? country.sources.filter((s) => o.sourceIds!.includes(s.id)) : country.sources.filter((s) => s.enabled);
  const acts = o.actIds ? country.watchedActs.filter((a) => o.actIds!.includes(a.id)) : o.sourceIds ? [] : country.watchedActs;
  if (sources.length === 0 && acts.length === 0) return empty(tt('Нечего проверять: у страны нет включённых источников и отслеживаемых актов', 'Nothing to check: the country has no enabled sources or watched acts'));

  const total = sources.length + acts.length;
  let done = 0;
  const progress = (text: string): void => {
    try {
      o.onProgress?.({ code, text: `${country.name}: ${text}`, done, total });
    } catch {
      /* наблюдатель не ломает проверку */
    }
  };

  const works: Work[] = [];
  const actResults: ActCheckResultDto[] = [];
  const modelCalls: ModelCallLog[] = [];
  let costUsd = 0;
  let rateLimit: RateLimitInfo | undefined;
  let interrupted: CheckSourcesResult['interrupted'];
  /** Скачанные страницы (адрес → ответ): профиль на уже открытой странице не качается второй раз. */
  const cache = new Map<string, FetchResult>();

  const finish = (w: Work, state: SourceCheckResultDto['state'], reason: string, extra: Partial<SourceCheckResultDto> = {}): void => {
    const rec = extra.recommendation ?? w.recommendation;
    w.result = {
      sourceId: w.s.id,
      name: w.s.name,
      url: w.s.url,
      type: w.s.type,
      state,
      reason: rec && !reason.includes(rec) ? `${reason}. ${rec}` : reason,
      method: 'none',
      extracted: datedCount(w.lastDocs),
      seenLatest: latestSeen(w.lastDocs),
      rounds: w.rounds,
      ...(w.probe.finalUrl ? { finalUrl: w.probe.finalUrl } : {}),
      ...(w.lastModel ? { modelReasons: w.lastModel.reasons } : {}),
      ...(rec ? { recommendation: rec } : {}),
      written: false,
      ...extra,
    };
    done++;
    log('source_result', `«${w.s.name}»: ${state} — ${w.result.reason}`, {
      sourceId: w.s.id,
      state,
      extracted: w.result.extracted,
      rounds: w.rounds,
      method: w.result.method,
    });
    progress(`${w.s.name} — ${state === 'ok' ? tt('работает', 'works') : state === 'warn' ? tt('с ограничениями', 'with limitations') : tt('не работает', 'does not work')}`);
  };

  // ── (а) код открывает каждый источник ──
  for (const s of sources) {
    progress(tt(`открываем ${hostOf(s.url) || s.url}`, `opening ${hostOf(s.url) || s.url}`));
    const sdir = join(dir, safeName(s.id));
    rmSync(sdir, { recursive: true, force: true });
    mkdirSync(sdir, { recursive: true });
    const probe = await probePage(o.fetcher, s.url);
    const w: Work = { s, dir: sdir, probe, pages: [], rounds: 0, lastDocs: [] };
    works.push(w);
    if (probe.ok && probe.body !== undefined) {
      w.pages.push(savePage(sdir, 'page-0', { url: s.url, finalUrl: probe.finalUrl!, status: probe.status!, body: probe.body, format: probe.format }));
      cache.set(s.url.replace(/#.*$/, '').replace(/\/+$/, ''), { ok: true, status: probe.status!, url: probe.finalUrl!, body: probe.body, contentType: probe.contentType ?? '' });
      cache.set(probe.finalUrl!.replace(/#.*$/, '').replace(/\/+$/, ''), { ok: true, status: probe.status!, url: probe.finalUrl!, body: probe.body, contentType: probe.contentType ?? '' });
      if (probe.otherSite) w.recommendation = tt(`Сайт перенаправляет на ${probe.finalUrl} — возможно, адрес источника стоит заменить`, `The site redirects to ${probe.finalUrl} — the source address may need to be replaced`);
    }
    log('source_probe', `«${s.name}» ${s.url}: ${probe.ok ? `открывается (${probe.status}), итоговый адрес ${probe.finalUrl}` : probe.failMessage}`, {
      sourceId: s.id,
      ok: probe.ok,
      status: probe.status ?? null,
      finalUrl: probe.finalUrl ?? null,
      login: probe.loginRequired,
      captcha: probe.captcha,
      needsJs: probe.needsJs,
      visibleText: probe.visibleTextLength,
      scripts: probe.scriptCount,
    });
    if (!probe.ok) finish(w, 'fail', probe.loginRequired ? loginReason(L) : unreachableReason(probe, L));
    else if (probe.loginRequired) finish(w, 'fail', loginReason(L));
    else if (probe.captcha) finish(w, 'fail', captchaReason(L));
  }

  // ── (б) lex.uz: адаптер, без модели ──
  for (const w of works) {
    if (w.result || !isLexuzUrl(w.s.url) || (w.s.type !== 'legal_base' && w.s.type !== 'regulator')) continue;
    progress(tt(`ищем новые акты на lex.uz за ${LEXUZ_CHECK_DAYS} дней`, `searching for new acts on lex.uz for the last ${LEXUZ_CHECK_DAYS} days`));
    await checkLexuz(w);
  }

  async function checkLexuz(w: Work): Promise<void> {
    const to = localDate(now());
    const from = addDays(to, -(LEXUZ_CHECK_DAYS - 1));
    let reason = '';
    try {
      const r = await ad.lexuzSearchNew({ fetcher: o.fetcher, window: { from, to }, regOnly: false, withRussian: true, lookbackDays: 0, graceDays: 0, maxPages: 20 });
      if (r.ok) {
        const docs = r.docs.map(lexDoc);
        w.lastDocs = docs;
        log('lexuz_search', `lex.uz: поиск ${from}…${to}: найдено ${r.found}, с датами ${datedCount(docs)}; запросов ${r.requests}`, { found: r.found, requests: r.requests });
        if (profileHealthy(docs)) {
          finish(w, 'ok', tt(`Работает: новые акты читаются поиском lex.uz (за ${LEXUZ_CHECK_DAYS} дней найдено ${datedCount(docs)})`, `Works: new acts are read via the lex.uz search (${datedCount(docs)} found in ${LEXUZ_CHECK_DAYS} days)`), { method: 'adapter' });
          return;
        }
        reason = tt(`поиск lex.uz за ${LEXUZ_CHECK_DAYS} дней нашёл только ${datedCount(docs)} акт(ов) с датами`, `the lex.uz search found only ${datedCount(docs)} act(s) with dates in ${LEXUZ_CHECK_DAYS} days`);
      } else {
        reason = r.reason;
        log('lexuz_search_failed', `lex.uz: ${r.reason}`, { failure: r.failure, requests: r.requests });
      }
    } catch (e) {
      reason = errText(e);
    }
    // Запасной путь: лента lex.uz (новые акты видны, но поиск, которым читает прогон, не разобран).
    const rss = await runProfile({ kind: 'rss', url: LEXUZ_RSS_URL }, cachingFetcher(o.fetcher, cache), { maxPages: 1 });
    if (rss.ok && profileHealthy(rss.docs)) {
      w.lastDocs = rss.docs;
      finish(w, 'warn', tt(`Сайт работает и новые акты видны в ленте сайта, но поиск новых актов, которым пользуется проверка, сейчас не прочитан (${reason}). Повторите проверку позже`, `The site works and new acts are visible in the site feed, but the new-act search used by the check could not be read right now (${reason}). Repeat the check later`), { method: 'adapter' });
      return;
    }
    finish(w, 'warn', tt(`Сайт открывается, но новые акты прочитать не удалось (${reason})`, `The site opens, but new acts could not be read (${reason})`), { method: 'none' });
  }

  // ── уже сохранённый профиль: работает — модель не нужна ──
  for (const w of works) {
    if (w.result || !w.s.profile || !isUsableProfile(w.s.profile)) continue;
    progress(tt(`проверяем сохранённый способ чтения ${w.s.name}`, `checking the saved reading method for ${w.s.name}`));
    const attempt = await tryProfile(w, w.s.profile, 'saved');
    if (attempt.healthy) {
      const keepWarn = w.s.state === 'warn' && w.s.stateReason && w.s.stateReason !== BROKEN_LIST_REASON && !/не удалось|не прочитан|could not|not read/.test(w.s.stateReason);
      const stale = staleNote(w.lastDocs);
      if (keepWarn) finish(w, 'warn', w.s.stateReason, { method: 'profile', profile: w.s.profile });
      else if (stale) finish(w, 'warn', stale, { method: 'profile', profile: w.s.profile });
      else finish(w, 'ok', tt(`Работает: список новых документов читается (найдено ${datedCount(w.lastDocs)} с датами)`, `Works: the list of new documents is read (${datedCount(w.lastDocs)} found with dates)`), { method: 'profile', profile: w.s.profile });
    }
  }

  async function tryProfile(w: Work, profile: ExtractionProfile, label: string): Promise<{ healthy: boolean }> {
    const f = cachingFetcher(o.fetcher, cache);
    let res: Awaited<ReturnType<typeof runProfile>>;
    try {
      res = await runProfile(profile, f, { maxPages: 1 });
    } catch (e) {
      res = { ok: false, reason: errText(e) };
    }
    let saved: SavedPage | null = null;
    const last = f.last;
    if (last && last.ok) {
      const already = w.pages.find((p) => p.final_url === last.url || p.url === profile.url);
      if (already) saved = already;
      else {
        const a = analyzePage(last.body, last.url, last.contentType);
        saved = savePage(w.dir, `attempt-${label}`, { url: profile.url, finalUrl: last.url, status: last.status, body: last.body, format: a.format });
        w.pages.push(saved);
      }
    }
    const docs = res.ok ? res.docs : [];
    if (res.ok) w.lastDocs = docs;
    const healthy = res.ok && profileHealthy(docs);
    const problem = !res.ok
      ? last && !last.ok
        ? `the page ${profile.url} could not be downloaded by the app: ${last.message}`
        : `the app ran the profile and it failed: ${res.reason}`
      : healthy
        ? ''
        : `the app ran the profile on ${profile.url}: extracted ${docs.length} item(s), ${datedCount(docs)} with a parsed date; at least ${MIN_DATED} items with dates are required`;
    log('profile_run', `«${w.s.name}» (${label}): ${res.ok ? `извлечено ${docs.length}, с датами ${datedCount(docs)}` : res.reason}`, {
      sourceId: w.s.id,
      kind: profile.kind,
      url: profile.url,
      ok: res.ok,
      extracted: docs.length,
      dated: datedCount(docs),
    });
    if (!healthy) {
      w.previous = {
        profile,
        extracted_count: docs.length,
        dated_count: datedCount(docs),
        problem,
        html_path: saved?.html_path ?? null,
        text_path: saved?.text_path ?? null,
        sample: docs.slice(0, 5).map((d) => ({ title: d.title.slice(0, 200), date: d.date, url: d.url })),
      };
    }
    return { healthy };
  }

  function staleNote(docs: readonly CollectedDoc[]): string | null {
    const newest = docs.map((d) => d.date).filter((d): d is string => !!d).sort().at(-1);
    if (!newest) return null;
    if (newest < addDays(localDate(now()), -STALE_DAYS)) return tt(`${REASON_RU.stale}: последний документ в списке — от ${ruDate(newest)}`, `${REASON_EN.stale}: the latest document in the list is from ${ruDate(newest)}`);
    return null;
  }

  // ── отслеживаемые акты: lex.uz — код; остальные — открыть и отдать модели ──
  const modelActs: WatchedAct[] = [];
  /** Сохранённые страницы актов не на lex.uz (их проверяет модель). */
  const actPages = new Map<string, SavedPage>();
  const actKey = (a: WatchedAct): string => a.registrationNumber.trim() || `id:${a.id}`;
  const finishAct = (a: WatchedAct, state: ActCheckResultDto['state'], reason: string): void => {
    actResults.push({ actId: a.id, title: a.title, url: a.url, state, reason, written: false });
    done++;
    log('act_result', `Акт «${a.title}»: ${state} — ${reason}`, { actId: a.id, state });
    progress(tt(`акт «${a.title.slice(0, 60)}» — ${state === 'ok' ? 'в порядке' : state === 'warn' ? 'есть замечание' : 'ошибка'}`, `act "${a.title.slice(0, 60)}" — ${state === 'ok' ? 'OK' : state === 'warn' ? 'has a remark' : 'error'}`));
  };
  for (const a of acts) {
    progress(tt(`проверяем акт «${a.title.slice(0, 60)}»`, `checking act "${a.title.slice(0, 60)}"`));
    if (isLexuzUrl(a.url)) {
      await checkLexuzAct(a);
      continue;
    }
    const p = await probePage(o.fetcher, a.url);
    if (!p.ok) finishAct(a, 'fail', tt(`Страница акта не открывается: ${unreachableReason(p).replace(/^Сайт не открывается: /, '')}`, `The act page does not open: ${unreachableReason(p, 'en').replace(/^The site does not open: /, '')}`));
    else if (p.loginRequired) finishAct(a, 'fail', loginReason(L));
    else if (p.captcha) finishAct(a, 'fail', captchaReason(L));
    else {
      const adir = join(dir, `act-${safeName(a.id)}`);
      rmSync(adir, { recursive: true, force: true });
      const saved = savePage(adir, 'page-0', { url: a.url, finalUrl: p.finalUrl!, status: p.status!, body: p.body!, format: p.format });
      actPages.set(a.id, saved);
      modelActs.push(a);
    }
  }

  async function checkLexuzAct(a: WatchedAct): Promise<void> {
    let body = '';
    const f: Fetcher = {
      get: async (url, opt) => {
        const r = await o.fetcher.get(url, opt);
        if (r.ok && !body) body = r.body;
        return r;
      },
      postForm: (url, fields, opt) => o.fetcher.postForm(url, fields, opt),
    };
    const r = await ad.lexuzEditions({ fetcher: f, docUrl: a.url, today: localDate(now()), detailDates: [] });
    if (!r.ok) {
      if (r.failure === 'source') finishAct(a, 'fail', tt(`Страница акта не открывается: ${r.reason}`, `The act page does not open: ${r.reason}`));
      else finishAct(a, 'warn', tt('Страница открылась, но не похожа на страницу документа lex.uz — проверьте ссылку', 'The page opened but does not look like a lex.uz document page — check the link'));
      return;
    }
    const text = body ? htmlToText(body) : r.title;
    const head = `${r.headerNumber ?? ''} ${r.title}\n${text.slice(0, 4000)}`;
    const want = normActNumber(a.registrationNumber);
    const editions = r.editions.length;
    const lastEd = r.editions.filter((e) => e.status !== 'future').at(-1)?.date ?? r.editions.at(-1)?.date;
    const tail = editions > 0 ? tt(`; редакций: ${editions}${lastEd ? `, действующая от ${ruDate(lastEd)}` : ''}`, `; editions: ${editions}${lastEd ? `, current from ${ruDate(lastEd)}` : ''}`) : '';
    const shownTitle = r.title.length > 120 ? r.title.slice(0, 117) + '…' : r.title;
    if (want) {
      const header = normActNumber(r.headerNumber);
      const okNum = header ? header === want : numberSeen(a.registrationNumber, head);
      if (!okNum) {
        finishAct(
          a,
          'fail',
          tt(
            `Номер не совпадает: в записи «${a.registrationNumber}», а по ссылке ${header ? `акт № ${r.headerNumber}` : 'акт без этого номера'} («${shownTitle}»). Проверьте номер или ссылку`,
            `The number does not match: the record has "${a.registrationNumber}", but the link leads to ${header ? `act No. ${r.headerNumber}` : 'an act without this number'} ("${shownTitle}"). Check the number or the link`,
          ),
        );
        return;
      }
    } else if (!titleSeen(a.title, head)) {
      finishAct(a, 'warn', tt(`Не удалось убедиться по названию, что ссылка ведёт на этот акт (на странице: «${shownTitle}»)`, `Could not confirm by title that the link leads to this act (the page shows: "${shownTitle}")`));
      return;
    }
    if (editions === 0) {
      finishAct(a, 'warn', tt(`Акт найден («${shownTitle}»), но история редакций на странице не видна`, `The act was found ("${shownTitle}"), but the edition history is not visible on the page`));
      return;
    }
    finishAct(a, 'ok', tt(`Акт найден: «${shownTitle}»${r.headerNumber ? `, № ${r.headerNumber}` : ''}${tail}`, `Act found: "${shownTitle}"${r.headerNumber ? `, No. ${r.headerNumber}` : ''}${tail}`));
  }

  // ── (в–г) модель по остальным источникам страны + прогон предложенного профиля кодом ──
  const pending = (): Work[] => works.filter((w) => !w.result);
  let round = 0;
  let actsAsked = false;
  if (o.skipModel && (pending().length > 0 || modelActs.length > 0)) {
    interrupted = { failure: 'skipped', message: 'модель не вызывалась (режим без модели)' };
  }
  while ((pending().length > 0 || (!actsAsked && modelActs.length > 0)) && round < maxRounds && !interrupted) {
    round++;
    const batch = pending();
    const askActs = !actsAsked && modelActs.length > 0;
    for (const w of batch) w.rounds++;
    progress(tt(`подбираем способ чтения (${batch.map((w) => w.s.name).join(', ') || 'акты'}), раунд ${round} из ${maxRounds}`, `choosing a reading method (${batch.map((w) => w.s.name).join(', ') || 'acts'}), round ${round} of ${maxRounds}`));
    const input = {
      country: { code: country.code, name: country.name, languages: country.languages },
      round,
      max_rounds: maxRounds,
      sources: batch.map((w) => ({
        id: w.s.id,
        url: w.s.url,
        declared_type: w.s.type,
        language: w.s.language,
        pages: w.pages.map((p) => ({ url: p.url, final_url: p.final_url, http_status: p.http_status, html_path: p.html_path, text_path: p.text_path })),
        observed_by_app: {
          final_url: w.probe.finalUrl ?? w.s.url,
          password_field: w.probe.passwordField,
          little_visible_text_many_scripts: w.probe.needsJs,
          visible_text_chars: w.probe.visibleTextLength,
        },
        ...(w.previous ? { previous_attempt: w.previous } : {}),
      })),
      watched_acts: askActs
        ? modelActs.map((a) => ({
            registration_number: actKey(a),
            title: a.title,
            url: a.url,
            pages: actPages.has(a.id) ? [{ url: a.url, html_path: actPages.get(a.id)!.html_path, text_path: actPages.get(a.id)!.text_path }] : [],
          }))
        : [],
    };
    const domainUrls = [
      ...batch.flatMap((w) => [w.s.url, w.probe.finalUrl ?? '']),
      ...(askActs ? modelActs.map((a) => a.url) : []),
    ].filter(Boolean);
    const res = await callModel<SourcesCheck>(o, {
      stage: 'srcCheck',
      schema: 'verify-sources',
      settings,
      cwd: dir,
      inputPath: join(dir, `input-${round}.json`),
      input,
      domains: checkDomains(domainUrls),
      ...(settings.advanced?.saveTranscripts ? { transcriptPath: join(dir, `transcript-${round}.jsonl`) } : {}),
    });
    costUsd += res.costUsd;
    if (res.rateLimit) rateLimit = res.rateLimit;
    modelCalls.push({
      round,
      sources: batch.map((w) => w.s.id),
      ok: res.ok,
      ...(res.ok ? {} : { failure: res.failure }),
      costUsd: res.costUsd,
      turns: res.ok ? res.numTurns : null,
      durationMs: res.durationMs,
      model: res.model,
      denied: res.denied,
    });
    log('model_call', `Раунд ${round}: ${res.ok ? 'ответ получен' : res.message}; $${res.costUsd.toFixed(3)}`, {
      round,
      ok: res.ok,
      failure: res.ok ? null : res.failure,
      costUsd: res.costUsd,
      sources: batch.map((w) => w.s.id),
    });
    if (askActs) actsAsked = true;
    if (!res.ok) {
      if (res.failure === 'limit' || res.failure === 'spawn') {
        interrupted = { failure: res.failure, message: res.message, ...(res.resetsAt ? { resetsAt: res.resetsAt } : {}) };
        break;
      }
      for (const w of batch) {
        w.previous ??= { profile: null, extracted_count: 0, dated_count: 0, problem: '', html_path: null, text_path: null, sample: [] };
        w.previous.problem = `the previous check did not return an answer (${res.failure})`;
      }
      if (askActs) actsAsked = false; // акты спросим в следующем раунде
      continue;
    }
    writeJsonAtomic(join(dir, `output-${round}.json`), res.output);

    // акты (SRC-06): вердикт модели
    if (askActs) {
      for (const a of modelActs) {
        const v = res.output.watched_acts.find((x) => normActNumber(x.registration_number) === normActNumber(actKey(a)));
        if (!v) finishAct(a, 'warn', tt('Проверка не дала ответа по этому акту — проверьте ссылку вручную', 'The check gave no answer for this act — check the link manually'));
        else {
          const ru = translateReasons([v.reason], v.verdict === 'ok' ? ['reachable'] : [], L)[0];
          const text =
            v.verdict === 'ok'
              ? tt('Акт найден по ссылке', 'The act was found at the link')
              : v.verdict === 'fail'
                ? tt(`Ссылка не ведёт на этот акт или акт не найден${ru ? ` (${ru.toLowerCase()})` : ''}`, `The link does not lead to this act or the act was not found${ru ? ` (${ru.toLowerCase()})` : ''}`)
                : (ru ?? tt('Есть замечание к ссылке на акт', 'There is a remark about the act link'));
          finishAct(a, v.verdict, text);
        }
      }
    }

    for (const w of batch) {
      const ans = res.output.sources.find((x) => x.id === w.s.id);
      if (!ans) {
        w.previous ??= { profile: null, extracted_count: 0, dated_count: 0, problem: '', html_path: null, text_path: null, sample: [] };
        w.previous.problem = 'the previous answer did not include this source; return a result for every source id';
        continue;
      }
      w.lastModel = ans;
      if (ans.final_url && /^https?:\/\//.test(ans.final_url) && siteOf(ans.final_url) !== siteOf(w.s.url) && !w.recommendation) {
        w.recommendation = tt(`Проверка нашла сайт по адресу ${ans.final_url} — возможно, адрес источника стоит заменить`, `The check found the site at ${ans.final_url} — the source address may need to be replaced`);
      }
      if (!ans.profile) {
        // Модель не нашла способа чтения: повтор не поможет (вход тот же) — итог по её причинам.
        settleWithoutProfile(w, ans);
        continue;
      }
      const prof = ans.profile as unknown;
      const pageRequest =
        (ans.profile.kind === 'html_list' && (ans.profile.item ?? '').trim() === PAGE_REQUEST) || (ans.profile.kind === 'json_api' && !ans.profile.json_paths);
      if (pageRequest && /^https?:\/\//i.test(ans.profile.url)) {
        // Модель просит страницу, которой нет среди файлов: код скачивает её и отдаёт в следующем раунде.
        progress(tt(`скачиваем страницу списка ${hostOf(ans.profile.url)}`, `downloading the list page ${hostOf(ans.profile.url)}`));
        await fetchRequestedPage(w, ans.profile.url, round);
        continue;
      }
      if (!isUsableProfile(prof)) {
        w.previous = {
          profile: ans.profile,
          extracted_count: 0,
          dated_count: 0,
          problem: 'the proposed profile is incomplete (html_list needs "item"; json_api needs json_paths; url must start with http)',
          html_path: null,
          text_path: null,
          sample: [],
        };
        continue;
      }
      progress(tt(`пробуем прочитать ${w.s.name} предложенным способом`, `trying to read ${w.s.name} with the proposed method`));
      const t = await tryProfile(w, prof, `r${round}`);
      if (t.healthy) settleHealthy(w, prof, ans);
    }
  }

  function settleHealthy(w: Work, profile: ExtractionProfile, ans: ModelSource): void {
    const notes: string[] = [];
    // Новости — по определению СМИ, а не госорган: «не официальный» для них не замечание.
    if (!ans.official && w.s.type !== 'news') notes.push(RS.not_official);
    if (!ans.type_matches) notes.push(RS.type_mismatch);
    if (siteOf(profile.url) !== siteOf(w.s.url) && siteOf(profile.url) !== siteOf(w.probe.finalUrl ?? w.s.url)) {
      notes.push(`${RS.other_site} (${hostOf(profile.url)})`);
    }
    const stale = staleNote(w.lastDocs);
    if (stale) notes.push(stale);
    const n = datedCount(w.lastDocs);
    if (notes.length) finish(w, 'warn', tt(`Список документов читается (найдено ${n} с датами), но: ${notes.map((x) => x[0]!.toLowerCase() + x.slice(1)).join('; ')}`, `The document list is read (${n} found with dates), but: ${notes.map((x) => x[0]!.toLowerCase() + x.slice(1)).join('; ')}`), { method: 'profile', profile });
    else finish(w, 'ok', tt(`Работает: список новых документов читается (найдено ${n} с датами)`, `Works: the list of new documents is read (${n} found with dates)`), { method: 'profile', profile });
  }

  async function fetchRequestedPage(w: Work, url: string, round: number): Promise<void> {
    const f = cachingFetcher(o.fetcher, cache);
    const r = await f.get(url);
    let saved: SavedPage | null = null;
    if (r.ok) {
      saved = w.pages.find((p) => p.final_url === r.url || p.url === url) ?? null;
      if (!saved) {
        saved = savePage(w.dir, `requested-r${round}`, { url, finalUrl: r.url, status: r.status, body: r.body, format: analyzePage(r.body, r.url, r.contentType).format });
        w.pages.push(saved);
      }
    }
    log('page_request', `«${w.s.name}»: страница по запросу ${url}: ${r.ok ? 'скачана' : r.message}`, { sourceId: w.s.id, url, ok: r.ok });
    w.previous = {
      profile: null,
      extracted_count: 0,
      dated_count: 0,
      problem: r.ok
        ? `the app downloaded the page you asked for (${url}); it is now in pages[] and in html_path — write the profile from it`
        : `the app could not download the page you asked for (${url}): ${r.message}`,
      html_path: saved?.html_path ?? null,
      text_path: saved?.text_path ?? null,
      sample: [],
    };
  }

  function settleWithoutProfile(w: Work, ans: ModelSource): void {
    let ru = translateReasons(ans.reasons, undefined, L);
    if (w.s.type === 'news') ru.splice(0, ru.length, ...ru.filter((x) => x !== RS.not_official));
    else if (!ans.official && !ru.includes(RS.not_official)) ru.unshift(RS.not_official);
    if (ans.needs_js === 'yes' || w.probe.needsJs) if (!ru.includes(RS.needs_js)) ru.unshift(RS.needs_js);
    if (!ans.has_dated_listing && !ru.includes(RS.no_listing) && !ru.includes(RS.needs_js)) ru.push(RS.no_listing);
    if (ans.login_or_captcha) ru.unshift(tt('Похоже, список документов доступен только после входа или проверки «я не робот»', 'The document list seems to be available only after signing in or an "I am not a robot" check'));
    // «нужен JavaScript» уже объясняет, почему списка не видно; общая фраза — только если конкретных причин нет.
    if (ru.includes(RS.needs_js)) ru = ru.filter((x) => x !== RS.no_listing);
    if (ru.some((x) => x !== GENERIC)) ru = ru.filter((x) => x !== GENERIC);
    const why = ru.length ? ru.map((x) => x[0]!.toLowerCase() + x.slice(1)).join('; ') : RS.no_listing.toLowerCase();
    finish(w, 'warn', tt(`Сайт открывается, но способа читать новые документы нет: ${why}`, `The site opens, but there is no way to read new documents: ${why}`), { method: 'none', profile: null });
  }

  // ── итог по оставшимся (3 раунда без рабочего способа или проверка прервана) ──
  for (const w of pending()) {
    if (interrupted) continue; // без итога: состояние не меняется, пользователь повторит проверку
    const parts: string[] = [];
    if (w.probe.needsJs || w.lastModel?.needs_js === 'yes') parts.push(RS.needs_js.toLowerCase());
    if (w.lastModel && !w.lastModel.official && w.s.type !== 'news') parts.push(RS.not_official.toLowerCase());
    if (w.previous && w.previous.extracted_count > 0) parts.push(tt(`удалось извлечь только ${w.previous.dated_count} документ(ов) с датами из ${MIN_DATED} нужных`, `only ${w.previous.dated_count} document(s) with dates were extracted out of ${MIN_DATED} required`));
    const why = parts.length ? ` (${parts.join('; ')})` : '';
    finish(
      w,
      'warn',
      tt(
        `Сайт открывается, но приложение не смогло надёжно прочитать список новых документов за ${w.rounds} попытк${w.rounds === 1 ? 'у' : 'и'}${why}`,
        `The site opens, but the app could not reliably read the list of new documents in ${w.rounds} attempt${w.rounds === 1 ? '' : 's'}${why}`,
      ),
      {
      method: 'none',
      profile: null,
    });
  }
  if (!actsAsked && modelActs.length > 0 && !interrupted) {
    for (const a of modelActs) if (!actResults.some((r) => r.actId === a.id)) finishAct(a, 'warn', tt('Проверка не дала ответа по этому акту — проверьте ссылку вручную', 'The check gave no answer for this act — check the link manually'));
  }

  // ── запись в countries.json ──
  const results: SourceCheckResultDto[] = [];
  for (const w of works) {
    if (!w.result) continue;
    const r = w.result;
    const profile = r.state === 'fail' ? undefined : r.method === 'profile' ? (r.profile ?? undefined) : r.method === 'none' ? null : undefined;
    const wr = setSourceState(o.countriesDir, code, w.s.id, r.state as SourceState, r.reason, now(), {
      seenLatest: r.seenLatest,
      ...(profile !== undefined ? { profile } : {}),
      expectUrl: w.s.url,
    });
    r.written = wr.ok;
    if (!wr.ok) log('write_skipped', `«${w.s.name}»: ${Object.values(wr.errors).join('; ')}`, { sourceId: w.s.id });
    results.push(r);
  }
  for (const a of actResults) {
    const act = acts.find((x) => x.id === a.actId)!;
    const wr = setWatchedActState(o.countriesDir, code, a.actId, a.state, a.reason, now(), act.url);
    a.written = wr.ok;
  }

  const counts = { ok: results.filter((r) => r.state === 'ok').length, warn: results.filter((r) => r.state === 'warn').length, fail: results.filter((r) => r.state === 'fail').length };
  const unresolved = works.length - results.length;
  let message = `${country.name}: ✅ ${counts.ok}, ⚠ ${counts.warn}, ❌ ${counts.fail}`;
  if (actResults.length) message += tt(`; актов проверено ${actResults.length}`, `; acts checked: ${actResults.length}`);
  if (interrupted) message += tt(`. Проверка прервана: ${interrupted.message}${unresolved ? ` — без итога ${unresolved} источник(ов), повторите позже` : ''}`, `. The check was interrupted: ${interrupted.message}${unresolved ? ` — ${unresolved} source(s) without a result, repeat later` : ''}`);
  const out: CheckSourcesResult = {
    country: code,
    ok: !interrupted,
    message,
    sources: results,
    acts: actResults,
    costUsd,
    modelCalls,
    ...(rateLimit ? { rateLimit } : {}),
    ...(interrupted ? { interrupted } : {}),
    unresolved: works
      .filter((w) => !w.result)
      .map((w) => ({
        sourceId: w.s.id,
        name: w.s.name,
        url: w.s.url,
        finalUrl: w.probe.finalUrl ?? null,
        status: w.probe.status ?? null,
        needsJs: w.probe.needsJs,
        passwordField: w.probe.passwordField,
        visibleTextChars: w.probe.visibleTextLength,
      })),
    dir,
  };
  try {
    writeJsonAtomic(join(dir, 'result.json'), { ...out, checkedAt: now().toISOString() });
  } catch {
    /* итог в файле — вспомогательный */
  }
  return out;
}

/** Имя папки из id источника (id может быть любым текстом). */
function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'source';
}

/** Последний итог проверки страны (state/source-checks/<CC>/result.json) или null. */
export function loadLastCheck(workspaceDir: string, code: string): (CheckSourcesResult & { checkedAt: string }) | null {
  const f = join(checksDir(workspaceDir, code), 'result.json');
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as CheckSourcesResult & { checkedAt: string };
  } catch {
    return null;
  }
}
