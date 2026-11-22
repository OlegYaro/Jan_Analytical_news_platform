// Эталоны (HAL-06, T-2, T-16): машиночитаемые эталоны docs/golden/*.expected.json, сравнение карточки с эталоном
// и прогон эталона на реальном claude без сети. Без electron.
//
// Решения (подробно — docs/FINDINGS.md «Фаза 5: T-2, T-6, T-16»):
// • Источник правды — таблицы docs/golden/<id>.md; .expected.json — их машинная форма. Проверка целостности
//   сверяет .expected.json с таблицами .md и снимки — с sha256 (снимки не правятся).
// • Прогон эталона не ходит в сеть: код получает страницы из сохранённых снимков (локальный Fetcher),
//   у страны нет источников → WebFetch модели не выдаётся (PRM-04: пустой список доменов).
// • Мягкие сравнения (ключевые слова, допуски значимости/сложности, места изменений) описаны в самом эталоне.

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Candidate } from '../shared/pipeline-types.ts';
import type { ActStage, Card } from '../shared/schema-types.ts';
import type { Country, Settings } from '../shared/types.ts';
import { checkCardEvidence, evidenceFailures, hasNumberToken, normalizeForQuote } from './checks/evidence.ts';
import type { EvidenceFieldResult } from './checks/evidence.ts';
import { ensureSnapshot } from './collect/collector.ts';
import type { FetchResult, Fetcher } from './collect/fetcher-types.ts';
import { htmlToText } from './collect/snapshot.ts';
import { seedCountries } from './countries/seed.ts';
import { writeJsonAtomic } from './fs-atomic.ts';
import { casesDir, readCaseFiles, screenCheckOnSavedText } from './golden-cases.ts';
import type { CaseScreenCheck, GoldenCaseFile } from './golden-cases.ts';
import { runStage as realRunStage } from './runner/claude-runner.ts';
import type { RunStageOptions, SpawnFn, StageResult } from './runner/claude-runner.ts';
import { createStageExecutors } from './runner/executors.ts';
import type { EvidenceReport } from './runner/executors.ts';
import type { StageContext } from './runner/orchestrator.ts';
import { ensureWorkspace } from './workspace.ts';

// ───────────────────────────── Формат эталона ─────────────────────────────

export type Significance = Card['changes'][number]['significance'];
export type Difficulty = Card['changes'][number]['implementation_difficulty'];

export const SIGNIFICANCE_SCALE: readonly Significance[] = ['not_significant', 'less_significant', 'significant'];
export const DIFFICULTY_SCALE: readonly Difficulty[] = ['low', 'medium', 'high'];

/** Если значение `unknown` (и поле в allow_unknown): что тогда должно быть в другом поле карточки. */
export interface IfUnknown {
  field: string;
  contains_number: string;
}

export type FieldSpec = { golden: string; note?: string; if_unknown?: IfUnknown } & (
  | { match: 'keywords'; groups: string[][] }
  | { match: 'number' | 'date' | 'enum' | 'url' | 'contains_number'; value: string }
  | { match: 'count'; value: number }
  | { match: 'one_of'; values: string[] }
);

export interface SnapshotFile {
  label?: string;
  url: string;
  /** Путь относительно папки эталонов. */
  file: string;
  /** Откуда скопирован (относительно корня проекта), для сверки. */
  fixture?: string;
  sha256: string;
}

export interface ChangeExpect {
  n: number;
  location: string;
  golden_where: string;
  significance: { golden: Significance; tolerance: number };
  difficulty: { golden: Difficulty[]; tolerance: number };
}

export interface GoldenExpected {
  format: number;
  id: string;
  country: string;
  source_md?: string;
  candidate: Candidate & { channel_note?: string };
  triage: { decision: 'relevant' | 'borderline' };
  card_fields: Record<string, FieldSpec>;
  stage: {
    golden: string;
    allowed: ActStage[];
    by_date?: { switch_date: string; before: ActStage; on_or_after: ActStage };
  };
  change_locations: { golden: string; keys: string[]; groups?: Record<string, string[]> };
  changes_expect: ChangeExpect[];
  /** Поле → почему допустимо `unknown`. */
  allow_unknown: Record<string, string>;
  snapshots: { main: SnapshotFile; related: SnapshotFile[] };
}

export interface GoldenCase {
  id: string;
  /** Путь к .expected.json. */
  file: string;
  /** Папка эталонов (относительно неё — пути снимков). */
  dir: string;
  expected: GoldenExpected;
}

/** Все эталоны папки (`*.expected.json`), по имени. Ошибка разбора — исключение с понятным текстом. */
export function loadGoldenCases(dir: string): GoldenCase[] {
  const root = resolve(dir);
  const files = readdirSync(root)
    .filter((f) => f.endsWith('.expected.json'))
    .sort();
  return files.map((f) => {
    const file = join(root, f);
    let expected: GoldenExpected;
    try {
      expected = JSON.parse(readFileSync(file, 'utf8')) as GoldenExpected;
    } catch (e) {
      throw new Error(`Эталон ${f} не читается как JSON: ${(e as Error).message}`);
    }
    return { id: expected.id ?? basename(f, '.expected.json'), file, dir: root, expected };
  });
}

// ───────────────────────────── Нормализация ─────────────────────────────

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Номер для сравнения: без «№/No./рег.» в начале, «-son/-сон» в конце, пробелов и регистра. */
export function normNumber(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/^[^\p{N}]*/u, '')
    .replace(/[-\s]*(?:sonli|son|сонли|сон)\b.*$/u, '')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, '');
}

/** Адрес для сравнения: без схемы и www., хост в нижнем регистре, без «/» в конце; из запроса — только ONDATE (дата). */
export function normUrl(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const ondate = [...u.searchParams.entries()].find(([k]) => k.toLowerCase() === 'ondate')?.[1];
    const d = ondate ? /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(ondate) : null;
    const q = d ? `?ondate=${d[1]!.padStart(2, '0')}.${d[2]!.padStart(2, '0')}.${d[3]}` : '';
    return `${host}${path}${q}`;
  } catch {
    return s.toLowerCase();
  }
}

const SUP_DIGITS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

/** Текст места изменения: надстрочные цифры → «^n» (8¹, 8<sup>1</sup>, 8^1 → 8^1), тире → «-», нижний регистр. */
export function normalizeLocationText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/<sup>\s*(\d+)\s*<\/sup>/gi, '^$1')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => '^' + [...m].map((c) => SUP_DIGITS[c] ?? '').join(''))
    .replace(/(\d)\s*\^\s*(\d)/g, '$1^$2')
    .replace(/[‐‑‒–—―−]/g, '-')
    // Запись надстрочного индекса через дефис без пробелов: «8-1» = 8¹, «50-1» = 50¹ (вставленные главы и пункты).
    // Диапазоном это быть не может: второе число меньше первого («2-5» остаётся диапазоном).
    .replace(/(?<![\d^.\/-])(\d+)-(\d)(?![\d^\/.])/g, (m, a: string, b: string) => (+b < +a ? `${a}^${b}` : m))
    .toLowerCase();
}

/** Ключ места в эталоне: «8¹» → «8^1», «ch:8¹» → «ch:8^1». */
export function locationKey(k: string): string {
  return normalizeLocationText(k).replace(/\s+/g, '');
}

const NUM = String.raw`\d+(?:\^\d+)?`;
const SEP = String.raw`\s*(?:,|and|и|va|&|-|to|по|до)\s*`;
const LIST = `${NUM}(?:${SEP}${NUM})*`;
/** Абзацы и пункты приложения: местом изменения не считаются. */
const RE_PARAGRAPH = new RegExp(
  String.raw`(?<!\p{L})(?:sub-?paragraphs?|paragraphs?|paras?\.?|абз\p{L}*\.?|абзац\p{L}*|xatboshi\p{L}*|indents?|annex\s+items?|items?)\s*(?:№|no\.?|#)?\s*${LIST}` +
    String.raw`|\d+(?:st|nd|rd|th|-?й|-?го)?\s+(?:new\s+|новы\p{L}*\s+)?(?:paragraphs?|абзац\p{L}*|xatboshi\p{L}*)`,
  'giu',
);
const RE_CHAPTER = new RegExp(String.raw`(?<!\p{L})(?:chapters?|ch\.|глав\p{L}*|гл\.|bob\p{L}*|боб\p{L}*)\s*(?:№|no\.?)?\s*(${LIST})`, 'giu');
const RE_CHAPTER_SUFFIX = new RegExp(String.raw`(?<![\d^])(${NUM})\s*-?\s*(?:bob|боб)\p{L}*`, 'giu');
const RE_POINT = new RegExp(
  String.raw`(?<!\p{L})(?:points?|pts?\.?|pp?\.|пп?\.|пункт\p{L}*|band\p{L}*|банд\p{L}*|clauses?|§)\s*(?:№|no\.?)?\s*(${LIST})`,
  'giu',
);
const RE_POINT_SUFFIX = new RegExp(String.raw`(?<![\d^])(${NUM})\s*-?\s*(?:band|банд)\p{L}*`, 'giu');
const RE_NUM = new RegExp(`(?<![\\d^])${NUM}`, 'g');

/** Разворачивает список «3, 5», диапазоны «50^1-50^5» и «2-5» в номера. */
function expandList(list: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(${NUM})(?:\\s*-\\s*(${NUM}))?`, 'g');
  for (let m = re.exec(list); m; m = re.exec(list)) {
    const a = m[1]!;
    const b = m[2];
    if (!b) {
      out.push(a);
      continue;
    }
    const [ab, as] = a.split('^');
    const [bb, bs] = b.split('^');
    if (as !== undefined && bs !== undefined && ab === bb && +bs >= +as && +bs - +as <= 50) {
      for (let i = +as; i <= +bs; i++) out.push(`${ab}^${i}`);
    } else if (as === undefined && bs === undefined && +b >= +a && +b - +a <= 50) {
      for (let i = +a; i <= +b; i++) out.push(String(i));
    } else {
      // «53 – 3 …»: убывающий «диапазон» — это не диапазон, второе число к месту не относится.
      out.push(a);
      if (+b.split('^')[0]! > +a.split('^')[0]!) out.push(b);
    }
  }
  return out;
}

export interface ParsedLocation {
  points: string[];
  chapters: string[];
}

/**
 * Номера пунктов и глав из текста места изменения: «Point 16», «п. 16», «пункт 16», «16-band», «16-банд» → пункт 16;
 * «Chapter 8¹ (points 50¹–50⁵)», «глава 8¹», «8¹-bob» → глава 8^1 и пункты 50^1…50^5. Абзацы и номера пунктов
 * приложения не учитываются. Без ключевых слов — первое число.
 */
export function parseLocation(text: string): ParsedLocation {
  let t = normalizeLocationText(text).replace(RE_PARAGRAPH, ' ');
  const chapters: string[] = [];
  const points: string[] = [];
  const take = (re: RegExp, into: string[]): void => {
    t = t.replace(re, (_m, list: string) => {
      into.push(...expandList(list));
      return ' ';
    });
  };
  take(RE_CHAPTER, chapters);
  take(RE_CHAPTER_SUFFIX, chapters);
  take(RE_POINT, points);
  take(RE_POINT_SUFFIX, points);
  if (chapters.length === 0 && points.length === 0) {
    const first = t.match(RE_NUM)?.[0];
    if (first) points.push(first);
  }
  return { points: [...new Set(points)], chapters: [...new Set(chapters)] };
}

interface LocationIndex {
  keys: Set<string>;
  /** Пункт-член группы → ключ группы (50^1 → ch:8^1). */
  member: Map<string, string>;
}

function locationIndex(exp: GoldenExpected['change_locations']): LocationIndex {
  const keys = new Set(exp.keys.map(locationKey));
  const member = new Map<string, string>();
  for (const [g, list] of Object.entries(exp.groups ?? {})) for (const p of list) member.set(locationKey(p), locationKey(g));
  return { keys, member };
}

export interface ResolvedLocation {
  keys: string[];
  /** Номера, совпавшие только после склейки надстрочного индекса (снимок-текст: «8¹» → «81»). */
  flattened: string[];
}

/** Ключи эталона для одного места изменения карточки. Неизвестные номера возвращаются как есть (лишние места). */
export function resolveLocation(text: string, exp: GoldenExpected['change_locations']): ResolvedLocation {
  const idx = locationIndex(exp);
  const { points, chapters } = parseLocation(text);
  const out = new Set<string>();
  const flattened: string[] = [];
  const known = (k: string): boolean => idx.keys.has(k);
  const flatMatch = (tok: string, chapter: boolean): string | null => {
    // В snapshot.txt надстрочные цифры склеены с номером (8¹-bob → 81-bob, 50¹ → 501). Принимаем, только если
    // такой номер сам в эталоне не встречается.
    if (tok.includes('^')) return null;
    for (const k of idx.keys) {
      const bare = k.replace(/^ch:/, '');
      if (bare.includes('^') && bare.replace('^', '') === tok && (chapter ? k.startsWith('ch:') : true)) return k;
    }
    for (const [m, g] of idx.member) if (m.includes('^') && m.replace('^', '') === tok) return g;
    return null;
  };
  const resolveTok = (tok: string, chapter: boolean): string => {
    if (chapter) {
      if (known(`ch:${tok}`)) return `ch:${tok}`;
      const f = known(tok) ? null : flatMatch(tok, true);
      if (f) {
        flattened.push(tok);
        return f;
      }
      return `ch:${tok}`;
    }
    const g = idx.member.get(tok);
    if (g) return g;
    if (known(tok)) return tok;
    // «8¹» без слова «глава»: надстрочный номер есть только у вставленной главы.
    if (tok.includes('^') && known(`ch:${tok}`)) return `ch:${tok}`;
    const f = flatMatch(tok, false);
    if (f) {
      flattened.push(tok);
      return f;
    }
    return tok;
  };
  for (const c of chapters) out.add(resolveTok(c, true));
  for (const p of points) out.add(resolveTok(p, false));
  return { keys: [...out], flattened };
}

/** Ключ для показа: «ch:8^1» → «глава 8¹», «50^1» → «50¹». */
export function showKey(k: string): string {
  const sup = (s: string): string => s.replace(/\^(\d+)/g, (_m, d: string) => [...d].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+c]).join(''));
  return k.startsWith('ch:') ? `глава ${sup(k.slice(3))}` : sup(k);
}

// ───────────────────────────── Сравнение карточки ─────────────────────────────

export interface GoldenCheck {
  /** Путь поля или имя проверки: act.effective_date, changes[7].significance, change_locations… */
  field: string;
  ok: boolean;
  expected: string;
  actual: string;
  /** Пояснение по-русски. */
  reason: string;
}

export interface CompareResult {
  ok: boolean;
  passed: string[];
  failed: Array<{ field: string; expected: string; actual: string; reason: string }>;
  /** Все проверки по порядку (для таблицы отчёта). */
  checks: GoldenCheck[];
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const isFact = (x: unknown): x is { value: unknown; quote: unknown } =>
  !!x && typeof x === 'object' && !Array.isArray(x) && 'value' in x && 'quote' in x;

const show = (v: unknown): string => {
  if (v === undefined) return '— (нет поля)';
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
};

/** Слово начинается с синонима (после нормализации кавычек, апострофов и регистра). */
function hasKeyword(norm: string, syn: string): boolean {
  const s = normalizeForQuote(syn);
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc(s)}`, 'u').test(norm);
}

function checkField(field: string, spec: FieldSpec, raw: unknown, allowUnknown: Record<string, string>, card: unknown): GoldenCheck {
  const value = isFact(raw) ? raw.value : raw;
  const expected = spec.golden;
  const actual = show(value);
  const res = (ok: boolean, reason: string): GoldenCheck => ({ field, ok, expected, actual, reason });

  if (value === undefined) return res(false, 'поля нет в карточке');
  if (value === 'unknown') {
    if (!(field in allowUnknown)) return res(false, 'unknown, а эталон требует значение (поле не в allow_unknown)');
    if (spec.if_unknown) {
      const other = String(getPath(card, spec.if_unknown.field) ?? '');
      if (!hasNumberToken(normalizeForQuote(other), normalizeForQuote(spec.if_unknown.contains_number))) {
        return { ...res(false, `unknown допустим, но тогда в ${spec.if_unknown.field} должно быть число ${spec.if_unknown.contains_number}`), actual: `unknown; ${spec.if_unknown.field}: ${show(other)}` };
      }
      return { ...res(true, `unknown допустим (${allowUnknown[field]}); число ${spec.if_unknown.contains_number} — в ${spec.if_unknown.field}`), actual: `unknown; ${spec.if_unknown.field}: ${show(other)}` };
    }
    return res(true, `unknown допустим: ${allowUnknown[field]}`);
  }
  switch (spec.match) {
    case 'date':
    case 'enum':
      return String(value).trim().toLowerCase() === spec.value.toLowerCase() ? res(true, 'совпадает') : res(false, `ожидалось ${spec.value}`);
    case 'number':
      return normNumber(value) === normNumber(spec.value) ? res(true, 'совпадает') : res(false, `ожидался номер ${spec.value}`);
    case 'count':
      return Number(value) === spec.value ? res(true, 'совпадает') : res(false, `ожидалось число ${spec.value}`);
    case 'one_of':
      return spec.values.includes(String(value).trim().toLowerCase()) ? res(true, 'совпадает') : res(false, `ожидалось одно из: ${spec.values.join(', ')}`);
    case 'url':
      return normUrl(value) === normUrl(spec.value) ? res(true, 'тот же адрес') : res(false, `ожидался адрес ${normUrl(spec.value)}, в карточке ${normUrl(value) || '—'}`);
    case 'contains_number': {
      if (!Array.isArray(value)) return res(false, 'ожидался список');
      const want = normalizeForQuote(spec.value);
      const hit = value.some((x) => {
        const num = x && typeof x === 'object' ? (x as { number?: unknown }).number : x;
        return hasNumberToken(normalizeForQuote(String(num ?? '')), want);
      });
      return hit ? res(true, `содержит ${spec.value}`) : res(false, `нет ${spec.value} в списке`);
    }
    case 'keywords': {
      const norm = normalizeForQuote(String(value));
      const missing = spec.groups.filter((g) => !g.some((syn) => hasKeyword(norm, syn)));
      return missing.length === 0
        ? res(true, 'все понятия названы')
        : res(false, `не названо: ${missing.map((g) => g.slice(0, 3).join(' / ')).join('; ')}`);
    }
  }
}

/** Пути всех Fact-полей карточки (объекты с value и quote). */
function factPaths(card: unknown, prefix = ''): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) return out;
  for (const [k, v] of Object.entries(card as Record<string, unknown>)) {
    if (k === 'changes') continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (isFact(v)) out.push({ path: p, value: v.value });
    else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...factPaths(v, p));
  }
  return out;
}

export interface CompareOptions {
  /** Дата прогона ГГГГ-ММ-ДД (для стадии, зависящей от даты). По умолчанию — сегодня (местная дата). */
  today?: string;
}

function localToday(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Ожидаемая стадия на дату прогона. */
export function expectedStage(exp: GoldenExpected['stage'], today: string): ActStage[] {
  if (!exp.by_date) return exp.allowed;
  return [today < exp.by_date.switch_date ? exp.by_date.before : exp.by_date.on_or_after];
}

/** Разрешённые ступени: от min(golden)−допуск до max(golden)+допуск. */
function allowedSteps<T>(scale: readonly T[], golden: T[], tolerance: number): T[] {
  const idx = golden.map((g) => scale.indexOf(g)).filter((i) => i >= 0);
  if (idx.length === 0) return [];
  const lo = Math.max(0, Math.min(...idx) - tolerance);
  const hi = Math.min(scale.length - 1, Math.max(...idx) + tolerance);
  return scale.slice(lo, hi + 1);
}

/**
 * Сравнение карточки с эталоном: поля card_fields, стадия по дате, множество мест изменений, значимость и сложность
 * каждого изменения (с допусками эталона), `unknown` вне allow_unknown.
 */
export function compareCard(card: Card, expected: GoldenExpected, opts: CompareOptions = {}): CompareResult {
  const today = opts.today ?? localToday();
  const allow = expected.allow_unknown ?? {};
  const checks: GoldenCheck[] = [];

  // 1. Поля
  for (const [field, spec] of Object.entries(expected.card_fields)) checks.push(checkField(field, spec, getPath(card, field), allow, card));

  // 2. Стадия
  const stages = expectedStage(expected.stage, today);
  checks.push({
    field: 'stage',
    ok: stages.includes(card.stage),
    expected: `${stages.join(' | ')} (на ${today}; эталон: ${expected.stage.golden})`,
    actual: show(card.stage),
    reason: stages.includes(card.stage) ? 'совпадает' : `на ${today} ожидается ${stages.join(' | ')}`,
  });

  // 3. Места изменений
  const cl = expected.change_locations;
  const wantKeys = cl.keys.map(locationKey);
  const changes = Array.isArray(card.changes) ? card.changes : [];
  const rowKeys = changes.map((ch) => {
    const r = resolveLocation(String(ch?.location ?? ''), cl);
    return { ch, keys: r.keys.length ? r.keys : [`?${String(ch?.location ?? '')}`], flattened: r.flattened };
  });
  const got = new Set(rowKeys.flatMap((r) => r.keys));
  const missing = wantKeys.filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !wantKeys.includes(k));
  const flat = rowKeys.flatMap((r) => r.flattened);
  checks.push({
    field: 'changes[].location',
    ok: missing.length === 0 && extra.length === 0,
    expected: cl.golden,
    actual: [...got].map((k) => (k.startsWith('?') ? `«${k.slice(1)}» (не разобрано)` : showKey(k))).join(', ') || '—',
    reason:
      missing.length === 0 && extra.length === 0
        ? `множество совпадает${flat.length ? ` (надстрочный индекс склеен в тексте: ${flat.join(', ')})` : ''}`
        : [
            missing.length ? `нет: ${missing.map(showKey).join(', ')}` : '',
            extra.length ? `лишние: ${extra.map((k) => (k.startsWith('?') ? `«${k.slice(1)}»` : showKey(k))).join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
  });

  // 4. Значимость и сложность по строкам эталона
  for (const row of expected.changes_expect) {
    const key = locationKey(row.location);
    const rows = rowKeys.filter((r) => r.keys.includes(key)).map((r) => r.ch);
    const sigAllowed = allowedSteps(SIGNIFICANCE_SCALE, [row.significance.golden], row.significance.tolerance);
    const difAllowed = allowedSteps(DIFFICULTY_SCALE, row.difficulty.golden, row.difficulty.tolerance);
    const where = `#${row.n} ${row.golden_where}`;
    if (rows.length === 0) {
      for (const what of ['significance', 'difficulty'] as const) {
        checks.push({
          field: `changes(${showKey(key)}).${what}`,
          ok: false,
          expected: `${where}: ${(what === 'significance' ? sigAllowed : difAllowed).join(' | ')}`,
          actual: '—',
          reason: 'изменение с этим местом не найдено в карточке',
        });
      }
      continue;
    }
    // Место разбито на несколько строк → берётся наибольшая значимость и сложность.
    const sig = SIGNIFICANCE_SCALE[Math.max(...rows.map((c) => SIGNIFICANCE_SCALE.indexOf(c.significance)))];
    const dif = DIFFICULTY_SCALE[Math.max(...rows.map((c) => DIFFICULTY_SCALE.indexOf(c.implementation_difficulty)))];
    const tol = (t: number): string => (t === 0 ? 'строго' : `±${t}`);
    checks.push({
      field: `changes(${showKey(key)}).significance`,
      ok: !!sig && sigAllowed.includes(sig),
      expected: `${where}: ${row.significance.golden} (${tol(row.significance.tolerance)}) → ${sigAllowed.join(' | ')}`,
      actual: show(sig),
      reason: sig && sigAllowed.includes(sig) ? 'в допуске' : 'вне допуска',
    });
    checks.push({
      field: `changes(${showKey(key)}).difficulty`,
      ok: !!dif && difAllowed.includes(dif),
      expected: `${where}: ${row.difficulty.golden.join('–')} (${tol(row.difficulty.tolerance)}) → ${difAllowed.join(' | ')}`,
      actual: show(dif),
      reason: dif && difAllowed.includes(dif) ? 'в допуске' : 'вне допуска',
    });
  }

  // 5. Прочие unknown (поля вне card_fields): допустимы только из allow_unknown.
  const stray = factPaths(card)
    .filter((f) => f.value === 'unknown' && !(f.path in expected.card_fields) && !(f.path in allow))
    .map((f) => f.path);
  if (card.act?.official_russian_text === 'unknown' && !('act.official_russian_text' in expected.card_fields) && !('act.official_russian_text' in allow)) {
    stray.push('act.official_russian_text');
  }
  checks.push({
    field: 'unknown (прочие поля)',
    ok: stray.length === 0,
    expected: `unknown только в: ${Object.keys(allow).join(', ') || '—'}`,
    actual: stray.length ? stray.join(', ') : 'нет',
    reason: stray.length ? 'unknown вне allow_unknown' : 'лишних unknown нет',
  });

  const passed = checks.filter((c) => c.ok).map((c) => c.field);
  const failed = checks.filter((c) => !c.ok).map(({ field, expected: e, actual, reason }) => ({ field, expected: e, actual, reason }));
  return { ok: failed.length === 0, passed, failed, checks };
}

// ───────────────────────────── Целостность эталона ─────────────────────────────

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

const RU_SIG: Record<string, Significance> = { незначимое: 'not_significant', 'менее значимое': 'less_significant', значимое: 'significant' };
const RU_DIF: Record<string, Difficulty> = { низкая: 'low', средняя: 'medium', высокая: 'high' };

/** Строки таблицы Markdown под заголовком `## <title>` (без шапки и разделителя). */
function mdTable(md: string, title: string): string[][] {
  const start = md.indexOf(`## ${title}`);
  if (start < 0) return [];
  const rest = md.slice(start).split('\n').slice(1);
  const rows: string[][] = [];
  let seen = false;
  for (const line of rest) {
    if (line.startsWith('## ')) break;
    if (!line.trim().startsWith('|')) {
      if (seen) break;
      continue;
    }
    seen = true;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }
  return rows.slice(1); // без шапки
}

/**
 * Целостность эталона: обязательные разделы, снимки на месте и не изменены (sha256, сверка с fixtures),
 * .expected.json повторяет таблицы .md. Возвращает список ошибок по-русски (пусто — всё в порядке).
 */
export function checkGoldenIntegrity(c: GoldenCase, opts: { repoRoot?: string } = {}): string[] {
  const e = c.expected;
  const errors: string[] = [];
  for (const k of ['id', 'country', 'candidate', 'triage', 'card_fields', 'stage', 'change_locations', 'changes_expect', 'allow_unknown', 'snapshots'] as const) {
    if (e[k] === undefined || e[k] === null) errors.push(`нет раздела «${k}»`);
  }
  if (errors.length) return errors;
  if (!e.candidate.id || !e.candidate.url) errors.push('у кандидата нет id или url');

  // Снимки
  const snaps = [e.snapshots.main, ...(e.snapshots.related ?? [])];
  for (const s of snaps) {
    const p = join(c.dir, s.file);
    if (!existsSync(p)) {
      errors.push(`нет снимка ${s.file}`);
      continue;
    }
    if (sha256(p) !== s.sha256) errors.push(`снимок ${s.file} изменён (sha256 не совпадает с эталоном)`);
    if (opts.repoRoot && s.fixture) {
      const fx = join(opts.repoRoot, s.fixture);
      if (existsSync(fx) && sha256(fx) !== s.sha256) errors.push(`снимок ${s.file} не совпадает с ${s.fixture}`);
    }
  }

  // Места и строки изменений
  const keys = new Set(e.change_locations.keys.map(locationKey));
  for (const r of e.changes_expect) {
    if (!keys.has(locationKey(r.location))) errors.push(`строка изменений #${r.n}: места «${r.location}» нет в change_locations`);
    if (!SIGNIFICANCE_SCALE.includes(r.significance.golden)) errors.push(`строка #${r.n}: неизвестная значимость ${r.significance.golden}`);
    if (!r.difficulty.golden.every((d) => DIFFICULTY_SCALE.includes(d))) errors.push(`строка #${r.n}: неизвестная сложность`);
  }

  // Сверка с таблицами .md
  if (e.source_md) {
    const mdPath = join(c.dir, e.source_md);
    if (!existsSync(mdPath)) errors.push(`нет ${e.source_md}`);
    else {
      const md = readFileSync(mdPath, 'utf8');
      const must = mdTable(md, 'Обязательные совпадения');
      if (must.length === 0) errors.push(`в ${e.source_md} не найдена таблица «Обязательные совпадения»`);
      for (const [field, value] of must) {
        if (!field) continue;
        let golden: string | undefined;
        if (field === 'stage') golden = e.stage.golden;
        else if (field.startsWith('changes[].location')) golden = e.change_locations.golden;
        else golden = e.card_fields[field]?.golden;
        if (golden === undefined) errors.push(`поле «${field}» из ${e.source_md} отсутствует в эталоне`);
        else if (golden !== value) errors.push(`поле «${field}»: в .md «${value}», в .expected.json «${golden}»`);
      }
      for (const field of Object.keys(e.card_fields)) {
        if (!must.some(([f]) => f === field)) errors.push(`поле «${field}» есть в .expected.json, но нет в таблице ${e.source_md}`);
      }
      const rows = mdTable(md, 'Изменения');
      if (rows.length !== e.changes_expect.length) errors.push(`строк изменений: в .md ${rows.length}, в .expected.json ${e.changes_expect.length}`);
      const strict = /кроме строк ([\d,\s]+)/.exec(md)?.[1]?.split(',').map((x) => +x.trim()) ?? [];
      for (const row of rows) {
        const [n, where, , sigRu, difRu] = row;
        const r = e.changes_expect.find((x) => x.n === Number(n));
        if (!r) {
          errors.push(`строка изменений #${n} из .md отсутствует в эталоне`);
          continue;
        }
        if (r.golden_where !== where) errors.push(`строка #${n}: место в .md «${where}», в эталоне «${r.golden_where}»`);
        if (RU_SIG[sigRu ?? ''] !== r.significance.golden) errors.push(`строка #${n}: значимость в .md «${sigRu}», в эталоне ${r.significance.golden}`);
        const difs = (difRu ?? '').split(/[–-]/).map((x) => RU_DIF[x.trim()]);
        if (difs.join(',') !== r.difficulty.golden.join(',')) errors.push(`строка #${n}: сложность в .md «${difRu}», в эталоне ${r.difficulty.golden.join('–')}`);
        const wantTol = strict.includes(r.n) ? 0 : 1;
        if (r.significance.tolerance !== wantTol) errors.push(`строка #${n}: допуск значимости ${r.significance.tolerance}, по .md ${wantTol}`);
      }
    }
  }
  return errors;
}

// ───────────────────────────── Снимки эталона без сети ─────────────────────────────

/** Тексты снимков эталона в том порядке, в каком их сверяет код (snapshot.txt, related/1.txt, …). */
export function goldenSnapshotTexts(c: GoldenCase): string[] {
  return [c.expected.snapshots.main, ...c.expected.snapshots.related].map((s) => htmlToText(readFileSync(join(c.dir, s.file), 'utf8')));
}

/** Fetcher, который отдаёт только сохранённые снимки эталона. Любой другой адрес → отказ (и запись в `misses`). */
export function goldenFetcher(c: GoldenCase): Fetcher & { misses: string[]; served: string[] } {
  const byUrl = new Map<string, SnapshotFile>();
  for (const s of [c.expected.snapshots.main, ...c.expected.snapshots.related]) byUrl.set(normUrl(s.url), s);
  const misses: string[] = [];
  const served: string[] = [];
  const get = async (url: string): Promise<FetchResult> => {
    const s = byUrl.get(normUrl(url));
    if (!s) {
      misses.push(url);
      return { ok: false, kind: 'http', status: 404, message: `Эталонный прогон не ходит в сеть: адреса ${url} нет среди снимков эталона` };
    }
    served.push(url);
    return { ok: true, status: 200, url: s.url, body: readFileSync(join(c.dir, s.file), 'utf8'), contentType: 'text/html; charset=utf-8' };
  };
  return {
    misses,
    served,
    get,
    async postForm(url: string) {
      misses.push(`POST ${url}`);
      return { ok: false, kind: 'http', status: 404, message: `Эталонный прогон не ходит в сеть: POST ${url}` };
    },
  };
}

/** Страна эталона без источников и отслеживаемых актов: WebFetch модели не выдаётся (нет доменов). */
export function goldenCountry(code: string): Country {
  const seed = seedCountries().find((x) => x.code === code);
  return {
    code,
    name: seed?.name ?? code,
    languages: seed?.languages ?? [],
    active: true,
    sources: [],
    watchedActs: [],
    lastCheckedAt: null,
    lastRunSummary: '',
  };
}

/** Контекст этапов в рабочей папке эталона. */
export function goldenContext(c: GoldenCase, workspaceDir: string, settings: Settings): StageContext {
  const runId = `golden-${c.id}`;
  const runDir = join(workspaceDir, 'runs', runId);
  const countryDir = join(runDir, c.expected.country);
  mkdirSync(countryDir, { recursive: true });
  return {
    runId,
    runDir,
    workspaceDir,
    countryDir,
    country: goldenCountry(c.expected.country),
    mode: 'backfill',
    window: { from: '2026-07-01', to: '2026-11-17' },
    settings: { ...settings, workspaceDir, newsEnabled: false },
  };
}

/** Кандидат эталона (без служебных пояснений). */
export function goldenCandidate(c: GoldenCase): Candidate {
  const { channel_note: _note, ...cand } = c.expected.candidate;
  return cand;
}

/** Снимок акта и связанных страниц из файлов эталона (как у канала А при сборе): acts/<id>/snapshot.*, related/*. */
export async function prepareGoldenAct(c: GoldenCase, ctx: Pick<StageContext, 'workspaceDir' | 'runId' | 'country'>, fetcher: Fetcher): Promise<string> {
  const r = await ensureSnapshot({
    candidate: goldenCandidate(c),
    ctx,
    fetcher,
    related: c.expected.snapshots.related.map((s) => ({ label: s.label ?? s.file, url: s.url })),
  });
  if (!r.ok) throw new Error(`Не удалось подготовить снимок эталона ${c.id}: ${r.message}`);
  return realpathSync(r.dir);
}

// ───────────────────────────── Офлайн-прогон ─────────────────────────────

export interface GoldenOfflineCaseResult {
  id: string;
  integrity: string[];
  /** Если передана готовая карточка. */
  compare?: CompareResult;
  evidence?: EvidenceFieldResult[];
}

/** Целостность эталонов и (если дана) сравнение готовой карточки + проверка её цитат по снимкам эталона. */
export function runGoldenOffline(opts: {
  cases: GoldenCase[];
  repoRoot?: string;
  /** Готовые карточки: id эталона → card.json. */
  cards?: Record<string, Card>;
  today?: string;
}): GoldenOfflineCaseResult[] {
  return opts.cases.map((c) => {
    const integrity = checkGoldenIntegrity(c, opts.repoRoot ? { repoRoot: opts.repoRoot } : {});
    const card = opts.cards?.[c.id];
    if (!card) return { id: c.id, integrity };
    return {
      id: c.id,
      integrity,
      compare: compareCard(card, c.expected, opts.today ? { today: opts.today } : {}),
      evidence: checkCardEvidence(card, goldenSnapshotTexts(c)),
    };
  });
}

// ───────────────────────────── Живой прогон ─────────────────────────────

export interface GoldenProcess {
  stage: string;
  model: string;
  ok: boolean;
  failure?: string;
  message?: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  turns: number | null;
  durationMs: number;
  attempts: number;
  /** Доля 5-часового окна после процесса (0..1), если CLI её сообщил. */
  fiveHour?: number;
  /** Отказы в инструментах (permission_denials и вызовы отсутствующих инструментов). */
  denied?: string[];
}

export interface GoldenLiveCaseResult {
  id: string;
  ok: boolean;
  /** Процент пройденных проверок. */
  percent: number;
  checks: GoldenCheck[];
  triageDecision: string | null;
  card: Card | null;
  evidence: EvidenceReport | null;
  processes: GoldenProcess[];
  /** Адреса, которые код пытался скачать мимо снимков (должно быть пусто). */
  networkMisses: string[];
  error?: string;
  dirs: { workspace: string; countryDir: string; actDir: string | null; cardPath: string | null };
}

export interface GoldenLiveOptions {
  claudeBin: string;
  env: Record<string, string | undefined>;
  schemasDir: string;
  /** Папка скиллов (skills/), копируется в рабочую папку эталона. */
  skillsSrc: string;
  settings: Settings;
  cases: GoldenCase[];
  /** Рабочая папка; по умолчанию новая во временной папке. */
  workDir?: string;
  today?: string;
  now?: () => Date;
  /** Подмена запуска (тесты). */
  runStage?: (o: RunStageOptions) => Promise<StageResult>;
  /** Один процесс на этап: без повтора раннера (бережём лимит). По умолчанию true. */
  singleAttempt?: boolean;
  /** Ход прогона (по-русски). */
  progress?: (text: string) => void;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Расход одного процесса модели (токены, стоимость, ходы) для отчёта. */
export function processOf(o: RunStageOptions, r: StageResult): GoldenProcess {
  const u = (r.usage ?? {}) as Record<string, unknown>;
  const p: GoldenProcess = {
    stage: o.invocation.stage,
    model: o.invocation.model,
    ok: r.ok,
    inputTokens: num(u['input_tokens']),
    outputTokens: num(u['output_tokens']),
    cacheRead: num(u['cache_read_input_tokens']),
    cacheWrite: num(u['cache_creation_input_tokens']),
    costUsd: num(r.costUsd),
    turns: r.ok ? (r.numTurns ?? null) : null,
    durationMs: r.durationMs,
    attempts: r.attempts,
  };
  if (!r.ok) {
    p.failure = r.failure;
    p.message = r.message;
  }
  const fh = r.rateLimit?.utilization;
  if (typeof fh === 'number') p.fiveHour = fh;
  if (r.denied.length) p.denied = r.denied.map((d) => d.tool);
  return p;
}

/** spawn, разрешающий ровно один запуск: второй (повтор раннера) отклоняется — эталон тратит один процесс на этап. */
export function onceSpawn(): SpawnFn {
  let used = false;
  return (bin, args, o) => {
    if (used) throw Object.assign(new Error('повтор отключён в эталонном прогоне'), { code: 'GOLDEN_NO_RETRY' });
    used = true;
    return nodeSpawn(bin, args as string[], o);
  };
}

/**
 * Живой прогон эталонов: для каждого — (1) отбор одного кандидата, (2) анализ на снимках эталона (без сети),
 * (3) проверка цитат кодом, (4) сравнение карточки с эталоном. Один процесс на этап.
 */
export async function runGoldenLive(opts: GoldenLiveOptions): Promise<GoldenLiveCaseResult[]> {
  const say = opts.progress ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const today = opts.today ?? localToday(now());
  const ws = opts.workDir ?? mkdtempSync(join(tmpdir(), 'regwatch-golden-'));
  mkdirSync(ws, { recursive: true });
  const workspace = realpathSync(ws);
  ensureWorkspace({ dir: workspace, skillsSrc: opts.skillsSrc, goldenSrc: opts.cases[0]?.dir ?? join(workspace, 'none') });

  const results: GoldenLiveCaseResult[] = [];
  for (const c of opts.cases) {
    const processes: GoldenProcess[] = [];
    const inner = opts.runStage ?? realRunStage;
    const runStage = async (o: RunStageOptions): Promise<StageResult> => {
      const r = await inner(opts.singleAttempt === false ? o : { ...o, spawn: onceSpawn() });
      processes.push(processOf(o, r));
      return r;
    };
    const fetcher = goldenFetcher(c);
    const ctx = goldenContext(c, workspace, opts.settings);
    say(`${c.id}: рабочая папка ${workspace}`);
    const ex = createStageExecutors({
      schemasDir: opts.schemasDir,
      claudeBin: () => opts.claudeBin,
      claudeEnv: () => opts.env as NodeJS.ProcessEnv,
      fetcher,
      collector: { collect: async () => ({ ok: true, output: { candidates: [] } }) },
      runStage,
      now,
      log: () => {},
    });
    const cand = goldenCandidate(c);
    const checks: GoldenCheck[] = [];
    const res: GoldenLiveCaseResult = {
      id: c.id,
      ok: false,
      percent: 0,
      checks,
      triageDecision: null,
      card: null,
      evidence: null,
      processes,
      networkMisses: fetcher.misses,
      dirs: { workspace, countryDir: realpathSync(ctx.countryDir), actDir: null, cardPath: null },
    };
    results.push(res);
    try {
      // (1) отбор
      say(`${c.id}: отбор (${opts.settings.preset})…`);
      const t = await ex.triage(ctx, [cand]);
      const item = t.ok ? t.output.items.find((i) => i.id === cand.id) : undefined;
      res.triageDecision = item?.decision ?? null;
      checks.push({
        field: 'triage.decision',
        ok: item?.decision === c.expected.triage.decision,
        expected: c.expected.triage.decision,
        actual: t.ok ? (item ? `${item.decision}${item.reason_text ? ` — ${item.reason_text}` : ''}` : 'кандидата нет в ответе') : `ошибка: ${t.message}`,
        reason: item?.decision === c.expected.triage.decision ? 'совпадает' : 'отбор не пропустил акт',
      });

      // (2) анализ на снимках эталона
      const adir = await prepareGoldenAct(c, ctx, fetcher);
      res.dirs.actDir = adir;
      say(`${c.id}: анализ…`);
      const a = await ex.analyze(ctx, cand);
      if (!a.ok) {
        checks.push({ field: 'analyze', ok: false, expected: 'карточка', actual: `${a.failure}: ${a.message}`, reason: 'анализ не вернул карточку' });
      } else {
        res.card = a.output;
        const cardPath = join(adir, 'card.json');
        writeJsonAtomic(cardPath, a.output);
        res.dirs.cardPath = cardPath;
        // (3) цитаты
        const ev = (await ex.checkEvidence!(ctx, cand, a.output)) as EvidenceReport;
        res.evidence = ev;
        const bad = ev.results.filter((r) => !r.ok);
        checks.push({
          field: 'evidence (HAL-02/03)',
          ok: ev.ok,
          expected: 'все цитаты дословно в снимках, даты и номера — в цитатах',
          actual: ev.ok ? `проверено полей: ${ev.results.length}` : bad.map((r) => `${r.field}: ${r.reason}`).join('; '),
          reason: ev.ok ? 'все цитаты подтверждены' : `не подтверждено полей: ${bad.length}`,
        });
        // (4) сравнение с эталоном
        checks.push(...compareCard(a.output, c.expected, { today }).checks);
      }
    } catch (e) {
      res.error = (e as Error).message;
      checks.push({ field: 'прогон', ok: false, expected: 'без ошибок', actual: res.error, reason: 'исключение' });
    }
    checks.push({
      field: 'сеть',
      ok: fetcher.misses.length === 0,
      expected: 'только снимки эталона',
      actual: fetcher.misses.length ? fetcher.misses.join(', ') : `запросов мимо снимков: 0 (отдано снимков: ${fetcher.served.length})`,
      reason: fetcher.misses.length ? 'код пытался скачать страницы мимо снимков' : 'без сети',
    });
    const passed = checks.filter((x) => x.ok).length;
    res.percent = checks.length ? Math.round((passed / checks.length) * 1000) / 10 : 0;
    res.ok = passed === checks.length;
  }
  return results;
}

// ───────────────────────────── Отчёт ─────────────────────────────

/** Таблица проверок по-русски: ✅/❌, поле, ожидание, карточка, причина. */
export function formatChecks(checks: GoldenCheck[]): string {
  return checks
    .map((c) => `${c.ok ? '✅' : '❌'} ${c.field}\n     эталон:   ${c.expected}\n     карточка: ${c.actual}\n     ${c.reason}`)
    .join('\n');
}

/** Отчёт живого прогона по-русски: проверки, процент, расход. */
export function formatGoldenReport(results: GoldenLiveCaseResult[]): string {
  const lines: string[] = [];
  let all = 0;
  let ok = 0;
  for (const r of results) {
    const passed = r.checks.filter((c) => c.ok).length;
    all += r.checks.length;
    ok += passed;
    lines.push(`\n══ Эталон ${r.id}: ${r.ok ? '✅' : '❌'} ${passed} из ${r.checks.length} (${r.percent}%)`);
    lines.push(formatChecks(r.checks));
    lines.push('\nРасход:');
    for (const p of r.processes) {
      const tokens = `вход ${p.inputTokens}, выход ${p.outputTokens}, кэш чтение ${p.cacheRead}, кэш запись ${p.cacheWrite}`;
      lines.push(
        `  ${p.stage} (${p.model}): ${p.ok ? 'ok' : `${p.failure}: ${p.message}`}; ${tokens}; $${p.costUsd.toFixed(4)}; ходов ${p.turns ?? '—'}; ` +
          `${(p.durationMs / 1000).toFixed(0)} с; попыток ${p.attempts}${p.fiveHour !== undefined ? `; 5-часовое окно ${(p.fiveHour * 100).toFixed(0)}%` : ''}` +
          `${p.denied?.length ? `; отказы в инструментах: ${p.denied.join(', ')}` : ''}`,
      );
    }
    const cost = r.processes.reduce((s, p) => s + p.costUsd, 0);
    lines.push(`  итого: процессов ${r.processes.length}, $${cost.toFixed(4)}`);
    lines.push(`Папка прогона: ${r.dirs.workspace}${r.dirs.cardPath ? `\nКарточка: ${r.dirs.cardPath}` : ''}`);
  }
  const pct = all ? Math.round((ok / all) * 1000) / 10 : 0;
  lines.push(`\nИтого по эталонам: ${ok} из ${all} проверок (${pct}%) — ${pct === 100 ? '✅ T-16 пройден' : '❌ T-16 не пройден'}`);
  return lines.join('\n');
}

// ───────────────────────────── Случаи из приложения (HAL-07) ─────────────────────────────
// `npm run golden -- --app-cases`: только перечисление случаев <рабочая папка>/golden/cases/*.json, проверка формата
// и кодовой части экрана по тексту на сохранённом тексте случая (если он есть). Модель не вызывается: живой прогон
// отбора/экрана по таким случаям — следующий шаг (docs/FINDINGS.md, фаза 9).

export interface AppCaseCheck {
  name: string;
  kind: string;
  country: string;
  title: string;
  url: string;
  runId: string;
  comment: string;
  /** Ошибки формата; пусто — формат верен. */
  errors: string[];
  /** Кодовая часть экрана на сохранённом тексте; нет — у битого файла. */
  screen?: CaseScreenCheck;
}

export interface AppCasesReport {
  dir: string;
  cases: AppCaseCheck[];
  /** Битые файлы или код снова ошибается на сохранённом тексте. */
  ok: boolean;
}

export function checkAppCases(workspaceDir: string): AppCasesReport {
  const dir = casesDir(workspaceDir);
  const cases: AppCaseCheck[] = readCaseFiles(workspaceDir).map((f) => {
    const c = (f.data && typeof f.data === 'object' ? f.data : {}) as Partial<GoldenCaseFile>;
    return {
      name: f.name,
      kind: String(c.kind ?? '?'),
      country: String(c.country ?? '?'),
      title: String(c.candidate?.title_original || c.candidate?.url || ''),
      url: String(c.candidate?.url ?? ''),
      runId: String(c.run_id ?? ''),
      comment: String(c.comment ?? ''),
      errors: f.errors,
      ...(f.errors.length === 0 ? { screen: screenCheckOnSavedText(f.data as GoldenCaseFile, dir) } : {}),
    };
  });
  return { dir, cases, ok: cases.every((c) => c.errors.length === 0 && c.screen?.status !== 'fail') };
}

const KIND_RU: Record<string, string> = { false_positive: 'ложное срабатывание', missed: 'пропущен' };
const SCREEN_MARK: Record<CaseScreenCheck['status'], string> = { pass: '✅', fail: '❌', needs_model: '…', no_text_saved: '—' };

export function formatAppCasesReport(r: AppCasesReport): string {
  const lines = [`\n══ Случаи из приложения (${r.dir}): ${r.cases.length}`];
  if (r.cases.length === 0) lines.push('  нет — кнопки «Ложное срабатывание» / «Был пропущен акт…» в «Истории» ещё не нажимались');
  for (const c of r.cases) {
    if (c.errors.length) {
      lines.push(`❌ ${c.name}: формат неверен:\n  - ${c.errors.join('\n  - ')}`);
      continue;
    }
    lines.push(`✅ ${c.name}: ${KIND_RU[c.kind] ?? c.kind}, ${c.country}, прогон ${c.runId}\n     ${c.title}${c.url && c.url !== c.title ? `\n     ${c.url}` : ''}${c.comment ? `\n     комментарий: ${c.comment}` : ''}`);
    if (c.screen) lines.push(`     ${SCREEN_MARK[c.screen.status]} экран (код, без модели): ${c.screen.detail}`);
  }
  lines.push(`\nИтого: ${r.ok ? '✅ форматы верны, код не повторяет ошибку на сохранённых текстах' : '❌ есть битые случаи или код повторяет ошибку'}. Прогон модели по случаям — не делается (следующий шаг).`);
  return lines.join('\n');
}
