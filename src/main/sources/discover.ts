// Поиск недостающих источников и основных законов страны (SRC-07, SRC-09). Без electron.
// Модель (`discover-sources`) только предлагает; КОД открывает каждое предложение и оставляет лишь подтверждённые:
// страница открывается (без входа и капчи), а для акта — на странице видно название, номер или цитата из предложения.
// Ничего не добавляется само: accept* вызываются только по кнопке «Добавить» (SRC-07/09).
import { mkdirSync, realpathSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CountriesResult } from '../../shared/api.ts';
import type { DiscoverSources } from '../../shared/schema-types.ts';
import type { ActProposalDto, DiscoverResultDto, SourceProposalDto, WatchedActType } from '../../shared/sources-types.ts';
import type { Country, Settings, SourceType } from '../../shared/types.ts';
import { langFromDir, langOf, mt } from '../i18n.ts';
import { isLexuzUrl } from '../collect/collector.ts';
import type { Fetcher } from '../collect/fetcher-types.ts';
import { htmlToText } from '../collect/snapshot.ts';
import { addSource, addWatchedAct, loadCountries, normalizeUrl } from '../countries/store.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';
import type { RateLimitInfo } from '../runner/claude-runner.ts';
import { checksDir, normActNumber, normText, numberSeen, titleSeen } from './checker.ts';
import { callModel } from './model-call.ts';
import type { ModelDeps } from './model-call.ts';
import { captchaReason, loginReason, probePage, unreachableReason } from './page-probe.ts';

export type DiscoverMode = 'missing' | 'watched';

export const SOURCE_TYPES: readonly SourceType[] = ['legal_base', 'regulator', 'drafts', 'news'];

/** Типы актов для отслеживания (docs/08 «Типы актов для отслеживания», 7 типов). */
export const WATCHED_ACT_TYPES: readonly WatchedActType[] = [
  'banking_law',
  'central_bank_law',
  'joint_stock_law',
  'fx_law',
  'aml_law',
  'deposit_insurance_law',
  'cb_corporate_governance',
];

export const ACT_TYPE_RU: Readonly<Record<WatchedActType, string>> = {
  banking_law: 'закон о банках и банковской деятельности',
  central_bank_law: 'закон о центральном банке',
  joint_stock_law: 'закон об акционерных обществах',
  fx_law: 'закон о валютном регулировании',
  aml_law: 'закон о противодействии отмыванию денег',
  deposit_insurance_law: 'закон о гарантировании вкладов',
  cb_corporate_governance: 'положение центрального банка о корпоративном управлении в банках',
};

export const ACT_TYPE_EN: Readonly<Record<WatchedActType, string>> = {
  banking_law: 'law on banks and banking activity',
  central_bank_law: 'law on the central bank',
  joint_stock_law: 'law on joint-stock companies',
  fx_law: 'law on currency regulation',
  aml_law: 'law on anti-money laundering',
  deposit_insurance_law: 'law on deposit guarantees',
  cb_corporate_governance: 'central bank regulation on corporate governance in banks',
};

export const SOURCE_TYPE_RU: Readonly<Record<SourceType, string>> = {
  legal_base: 'правовая база',
  regulator: 'регулятор',
  drafts: 'проекты актов',
  news: 'новости',
};

export interface DiscoverOptions extends ModelDeps {
  mode: DiscoverMode;
  /** Код страны. */
  country: string;
  fetcher: Fetcher;
  workspaceDir: string;
  countriesDir: string;
  settings: Settings | (() => Settings);
  /** Режим 'missing': какие типы искать (по умолчанию — типы без работающего источника). */
  types?: SourceType[];
  now?: () => Date;
  log?: (event: string, text: string, data?: Record<string, unknown>) => void;
}

export interface Rejected {
  kind: 'source' | 'act';
  title: string;
  url: string;
  /** Почему отброшено, по-русски. */
  reason: string;
}

export interface DiscoverResult extends DiscoverResultDto {
  rejected: Rejected[];
  /** Сколько предложила модель (до проверки кодом). */
  proposed: { sources: number; acts: number };
  costUsd: number;
  rateLimit?: RateLimitInfo;
  dir: string;
}

/** Типы источников, которых у страны нет (только включённые и не ❌ считаются «есть»). */
export function missingTypes(country: Pick<Country, 'sources'>): SourceType[] {
  return SOURCE_TYPES.filter((t) => !country.sources.some((s) => s.type === t && s.enabled && s.state !== 'fail'));
}

/** Уже есть такой источник: тот же адрес или страница внутри уже заведённого адреса того же хоста. */
export function sourceExists(country: Pick<Country, 'sources'>, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '').toLowerCase();
  return country.sources.some((s) => {
    if (normalizeUrl(s.url) === normalizeUrl(url)) return true;
    try {
      const e = new URL(s.url);
      if (e.hostname.toLowerCase().replace(/^www\./, '') !== host) return false;
      const ep = e.pathname.replace(/\/+$/, '').toLowerCase();
      return ep === '' || path === ep || path.startsWith(ep + '/');
    } catch {
      return false;
    }
  });
}

/** Ключ документа lex.uz: |id| (отрицательный id — тот же документ другой письменностью); иначе нормализованный адрес. */
function actUrlKey(url: string): string {
  if (isLexuzUrl(url)) {
    const m = /\/docs\/(-?\d+)/.exec(url);
    if (m) return `lexuz:${/\/ru\//.test(url) ? 'ru' : 'uz'}:${m[1]!.replace(/^-/, '')}`;
  }
  return normalizeUrl(url);
}

/** Акт уже отслеживается: та же ссылка (для lex.uz — тот же документ) или тот же номер. */
export function actTracked(country: Pick<Country, 'watchedActs'>, p: { url: string; number: string }): boolean {
  const key = actUrlKey(p.url);
  const num = p.number && p.number !== 'unknown' ? normActNumber(p.number) : '';
  return country.watchedActs.some((a) => actUrlKey(a.url) === key || (num.length >= 2 && normActNumber(a.registrationNumber) === num));
}

const isHttp = (u: string): boolean => /^https?:\/\/[^\s]+$/i.test(u.trim());

export async function discoverSources(o: DiscoverOptions): Promise<DiscoverResult> {
  const now = o.now ?? (() => new Date());
  const settings = typeof o.settings === 'function' ? o.settings() : o.settings;
  const code = o.country.trim().toUpperCase();
  const L = langOf(settings);
  const tt = (ru: string, en: string): string => mt(L, ru, en);
  const base = checksDir(o.workspaceDir, code);
  mkdirSync(join(base, `discover-${o.mode}`), { recursive: true });
  const cwd = realpathSync(base);
  const dir = join(cwd, `discover-${o.mode}`);
  const log = (event: string, text: string, data: Record<string, unknown> = {}): void => {
    try {
      if (o.log) o.log(event, text, { country: code, ...data });
      else appendFileSync(join(cwd, 'log.jsonl'), JSON.stringify({ ts: now().toISOString(), country: code, event, text, ...data }) + '\n', 'utf8');
    } catch {
      /* журнал не роняет поиск */
    }
  };
  const result = (ok: boolean, message: string, extra: Partial<DiscoverResult> = {}): DiscoverResult => ({
    ok,
    message,
    sourceProposals: [],
    actProposals: [],
    rejected: [],
    proposed: { sources: 0, acts: 0 },
    costUsd: 0,
    dir,
    ...extra,
  });

  const country = loadCountries(o.countriesDir).find((c) => c.code === code);
  if (!country) return result(false, tt('Страна не найдена в списке', 'The country was not found in the list'));

  const types = o.mode === 'missing' ? (o.types ?? missingTypes(country)).filter((t) => SOURCE_TYPES.includes(t)) : [];
  if (o.mode === 'missing' && types.length === 0) return result(true, tt('У страны есть источники всех типов — искать нечего', 'The country has sources of all types — nothing to search for'));

  const input = {
    country: { code: country.code, name: country.name, languages: country.languages },
    topic: settings.topic,
    existing_sources: country.sources.map((s) => ({ url: s.url, type: s.type, name: s.name })),
    missing_types: types,
    watched_act_types: o.mode === 'watched' ? [...WATCHED_ACT_TYPES] : [],
    watched_acts: country.watchedActs.map((a) => ({ title: a.title, registration_number: a.registrationNumber, url: a.url })),
  };
  const res = await callModel<DiscoverSources>(o, {
    stage: 'srcDiscover',
    schema: 'discover-sources',
    settings,
    cwd,
    inputPath: join(dir, 'input.json'),
    input,
    ...(settings.advanced?.saveTranscripts ? { transcriptPath: join(dir, 'transcript.jsonl') } : {}),
  });
  log('discover_model', `Поиск (${o.mode}): ${res.ok ? 'ответ получен' : res.message}; $${res.costUsd.toFixed(3)}`, { ok: res.ok, costUsd: res.costUsd });
  const rl = res.rateLimit ? { rateLimit: res.rateLimit } : {};
  if (!res.ok) {
    const msg =
      res.failure === 'limit'
        ? tt('Исчерпан лимит Claude — попробуйте позже', 'The Claude limit is exhausted — try later')
        : res.failure === 'spawn'
          ? res.message
          : tt('Поиск не удался: Claude Code не вернул ответ. Попробуйте ещё раз позже', 'The search failed: Claude Code did not return an answer. Try again later');
    return result(false, msg, { costUsd: res.costUsd, ...rl });
  }
  writeJsonAtomic(join(dir, 'output.json'), res.output);

  const rejected: Rejected[] = [];
  const reject = (r: Rejected): void => {
    rejected.push(r);
    log('discover_rejected', `${r.kind === 'act' ? 'Акт' : 'Источник'} «${r.title}» ${r.url}: ${r.reason}`, { kind: r.kind, url: r.url });
  };

  // ── источники ──
  const sourceProposals: SourceProposalDto[] = [];
  const seenSites = new Set<string>();
  for (const p of o.mode === 'missing' ? res.output.proposals : []) {
    const title = p.name || p.url;
    if (!SOURCE_TYPES.includes(p.type)) {
      reject({ kind: 'source', title, url: p.url, reason: tt('неизвестный тип источника', 'unknown source type') });
      continue;
    }
    if (!isHttp(p.url)) {
      reject({ kind: 'source', title, url: p.url, reason: tt('адрес записан неправильно', 'the address is malformed') });
      continue;
    }
    if (sourceExists(country, p.url) || (p.listing_url && isHttp(p.listing_url) && sourceExists(country, p.listing_url))) {
      reject({ kind: 'source', title, url: p.url, reason: tt('такой источник уже есть', 'this source already exists') });
      continue;
    }
    const key = normalizeUrl(p.url);
    if (seenSites.has(key)) {
      reject({ kind: 'source', title, url: p.url, reason: tt('повтор в ответе', 'duplicate in the answer') });
      continue;
    }
    seenSites.add(key);
    const probe = await probePage(o.fetcher, p.url);
    if (!probe.ok || probe.loginRequired || probe.captcha) {
      reject({ kind: 'source', title, url: p.url, reason: !probe.ok ? unreachableReason(probe, L) : probe.loginRequired ? loginReason(L) : captchaReason(L) });
      continue;
    }
    let listingOk = false;
    if (p.listing_url && isHttp(p.listing_url) && normalizeUrl(p.listing_url) !== key) {
      const lp = await probePage(o.fetcher, p.listing_url);
      listingOk = lp.ok && !lp.loginRequired && !lp.captcha;
    } else listingOk = !!p.listing_url;
    sourceProposals.push({
      type: p.type,
      name: p.name.trim() || new URL(p.url).hostname,
      url: p.url.trim(),
      listing_url: (p.listing_url || p.url).trim(),
      language: p.language,
      reason: p.reason,
      checkNote: listingOk
        ? tt('Сайт и страница списка документов открываются без входа', 'The site and the document list page open without signing in')
        : tt('Сайт открывается без входа; страницу списка документов приложение не открыло — проверьте источник после добавления', 'The site opens without signing in; the app could not open the document list page — check the source after adding it'),
      listingOk,
      verified: true,
    });
  }

  // ── отслеживаемые акты (SRC-09) ──
  const actProposals: ActProposalDto[] = [];
  const seenActs = new Set<string>();
  for (const p of o.mode === 'watched' ? res.output.watched_act_proposals : []) {
    const title = p.title_original || p.url;
    if (!WATCHED_ACT_TYPES.includes(p.act_type)) {
      reject({ kind: 'act', title, url: p.url, reason: tt('неизвестный тип акта', 'unknown act type') });
      continue;
    }
    if (!isHttp(p.url)) {
      reject({ kind: 'act', title, url: p.url, reason: tt('адрес записан неправильно', 'the address is malformed') });
      continue;
    }
    if (actTracked(country, p)) {
      reject({ kind: 'act', title, url: p.url, reason: tt('этот акт уже отслеживается', 'this act is already tracked') });
      continue;
    }
    const key = actUrlKey(p.url);
    if (seenActs.has(key)) {
      reject({ kind: 'act', title, url: p.url, reason: tt('повтор в ответе', 'duplicate in the answer') });
      continue;
    }
    seenActs.add(key);
    const probe = await probePage(o.fetcher, p.url);
    if (!probe.ok || probe.loginRequired || probe.captcha) {
      reject({ kind: 'act', title, url: p.url, reason: !probe.ok ? unreachableReason(probe, L) : probe.loginRequired ? loginReason(L) : captchaReason(L) });
      continue;
    }
    const text = probe.format === 'html' ? htmlToText(probe.body ?? '') : (probe.body ?? '');
    const norm = normText(text);
    const quoteOk = p.quote.trim().length >= 10 && norm.includes(normText(p.quote));
    const titleOk = p.title_original.trim().length >= 6 && (norm.includes(normText(p.title_original)) || titleSeen(p.title_original, text));
    const numberOk = p.number !== 'unknown' && normActNumber(p.number).length >= 2 && numberSeen(p.number, text);
    if (!quoteOk && !titleOk && !numberOk) {
      reject({ kind: 'act', title, url: p.url, reason: tt('на странице не найдены ни название, ни номер, ни цитата из предложения', 'the page contains neither the title, nor the number, nor the quote from the suggestion') });
      continue;
    }
    const seen = [titleOk ? tt('название', 'title') : '', numberOk ? tt('номер', 'number') : '', quoteOk ? tt('цитата', 'quote') : ''].filter(Boolean).join(', ');
    actProposals.push({
      act_type: p.act_type,
      act_type_ru: (L === 'en' ? ACT_TYPE_EN : ACT_TYPE_RU)[p.act_type],
      title_original: p.title_original.trim(),
      number: p.number.trim(),
      url: p.url.trim(),
      last_edition_date: p.last_edition_date,
      quote: p.quote,
      reason: p.reason,
      checkNote: tt(`Страница открывается; на ней найдено: ${seen}`, `The page opens; found on it: ${seen}`),
      verified: true,
    });
  }

  const proposed = { sources: o.mode === 'missing' ? res.output.proposals.length : 0, acts: o.mode === 'watched' ? res.output.watched_act_proposals.length : 0 };
  const found = o.mode === 'missing' ? sourceProposals.length : actProposals.length;
  const total = o.mode === 'missing' ? proposed.sources : proposed.acts;
  const what = o.mode === 'missing' ? 'источник' : 'акт';
  const message =
    found === 0
      ? total === 0
        ? tt(`Подходящих ${o.mode === 'missing' ? 'источников' : 'актов'} не найдено`, `No suitable ${o.mode === 'missing' ? 'sources' : 'acts'} found`)
        : tt(`Найдено ${total}, но ни одно предложение не подтвердилось при проверке — ничего не предлагаем`, `Found ${total}, but no suggestion was confirmed by the check — suggesting nothing`)
      : tt(
          `Подтверждено ${found} из ${total} (${what}ы добавляются только после нажатия «Добавить»)`,
          `Confirmed ${found} of ${total} (${o.mode === 'missing' ? 'sources' : 'acts'} are added only after pressing "Add")`,
        );
  const out = result(true, message, { sourceProposals, actProposals, rejected, proposed, costUsd: res.costUsd, ...rl });
  try {
    writeJsonAtomic(join(dir, 'result.json'), { ...out, at: now().toISOString() });
  } catch {
    /* вспомогательный файл */
  }
  return out;
}

/** «Добавить» источник из предложения (SRC-07): новый источник в состоянии «не проверен». */
export function acceptSourceProposal(dir: string, code: string, p: SourceProposalDto): CountriesResult {
  const country = loadCountries(dir).find((c) => c.code === code);
  const lang = typeof p.language === 'string' ? p.language.trim().toLowerCase().slice(0, 3) : '';
  const language = /^[a-z]{2,3}$/.test(lang) ? lang : (country?.languages[0] ?? 'en');
  const url = p.listingOk && p.listing_url && isHttp(p.listing_url) ? p.listing_url : p.url;
  return addSource(dir, code, {
    name: p.name,
    url,
    type: p.type,
    language,
    priority: p.type === 'news' ? 'extra' : 'main',
    note: url !== p.url ? mt(langFromDir(dir), `Найден поиском источников; сайт: ${p.url}`, `Found by the source search; site: ${p.url}`) : mt(langFromDir(dir), 'Найден поиском источников', 'Found by the source search'),
  });
}

/** «Добавить» акт из предложения (SRC-09). */
export function acceptActProposal(dir: string, code: string, p: ActProposalDto): CountriesResult {
  return addWatchedAct(dir, code, {
    title: p.title_original,
    registrationNumber: p.number && p.number !== 'unknown' ? p.number : '',
    url: p.url,
  });
}
