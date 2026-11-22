// Эталоны из приложения (HAL-07): кнопки «Ложное срабатывание» и «Был пропущен акт…» в «Истории» сохраняют случай
// в <рабочая папка>/golden/cases/<kind>-<country>-<id>.json. Без electron, без модели.
//
// Правила:
// - случай — снимок того, что было в прогоне: реквизиты кандидата (candidates.json), решения отбора (triage.json)
//   и экрана (screen.json, иначе run.json), где он оказался в итоге (result.json) и чего ждём в следующий раз;
// - ничего не придумывается: нет кандидата с такой ссылкой — в случае только ссылка;
// - текст акта сохраняется рядом (`<имя>.snapshot.txt`), только если снимок есть в архиве прогона (acts/<id>/snapshot.txt);
// - запись атомарная; тот же вид + тот же кандидат (или та же ссылка) второго файла не создаёт — возвращается прежний;
// - docs/golden и эталоны из репозитория (golden/*.expected.json) не трогаются: случаи лежат в своей подпапке.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GoldenCaseDto, GoldenCaseInput, GoldenCaseKind, GoldenCaseResult } from '../shared/history-types.ts';
import type { Candidate, CandidatesFile, CountryResult } from '../shared/pipeline-types.ts';
import type { ScreenFinal, ScreenRun } from '../shared/run-types.ts';
import type { TriageOutput } from '../shared/schema-types.ts';
import type { UiLanguage } from '../shared/types.ts';
import { safeActId } from './archive.ts';
import { archivePath, fileInsideWorkspace, isCountryCode, isRunId, loadRunSafe, readJsonSafe, readLimited } from './archive-read.ts';
import { findTerms } from './checks/bank-terms.ts';
import { writeAtomic, writeJsonAtomic } from './fs-atomic.ts';
import { mt } from './i18n.ts';
import { MIN_TEXT_CHARS, routeCandidate } from './runner/screen.ts';
import type { Route } from './runner/screen.ts';

export const CASE_FORMAT = 1;
export const COMMENT_MAX = 1000;
export const URL_MAX = 2000;
export const CANDIDATE_ID_MAX = 200;
/** Снимок больше этого рядом со случаем не сохраняется (случай остаётся, без текста). */
export const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
const CASE_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const KINDS: readonly GoldenCaseKind[] = ['false_positive', 'missed'];

export const casesDir = (workspaceDir: string): string => join(workspaceDir, 'golden', 'cases');

/** Где кандидат оказался в итоге страны. */
export type ResultLevel = 'material' | 'for_info' | 'unverified' | 'none';

/** Файл случая (docs/04 §11). */
export interface GoldenCaseFile {
  format: 1;
  kind: GoldenCaseKind;
  id: string;
  country: string;
  created_at: string;
  run_id: string;
  comment: string;
  /** Реквизиты из candidates.json прогона; для пропущенного без найденного кандидата — только url. */
  candidate: {
    url: string;
    id?: string;
    key?: string;
    title_original?: string;
    issuer?: string;
    date?: string;
    doc_type?: string;
    issuer_class?: 1 | 2 | 3;
  };
  decision_at_that_time: {
    /** Кандидат был среди кандидатов прогона (собран кодом). */
    collected: boolean;
    /** Решение отбора по названию (triage.json) или null. */
    triage: string | null;
    /** Итог экрана по тексту (screen.json / run.json) или null. */
    screen: ScreenFinal | null;
    /** Кто принял последнее решение: экран (code | screen | confirm), иначе отбор. */
    by: 'triage' | 'code' | 'screen' | 'confirm' | null;
    reason: string | null;
    result_level: ResultLevel;
  };
  /** none — не должен попасть в письмо; material_or_for_info — должен быть виден (существенный / для сведения / не проверен). */
  expected: { level: 'none' } | { level: 'material_or_for_info' };
  /** Имя файла с текстом акта рядом со случаем (если снимок был в архиве). */
  snapshot_text?: string;
  snapshot_sha256?: string;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Ключ ссылки для дублей и поиска кандидата: без протокола, «www.», якоря и конечного «/», хост в нижнем регистре. */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${u.port ? `:${u.port}` : ''}${path}${u.search}`;
  } catch {
    return raw.trim();
  }
}

/** Ссылка на акт из формы: http(s), есть хост с точкой, без логина/пароля, не длиннее URL_MAX. */
export function validActUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > URL_MAX) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const caseFileName = (kind: GoldenCaseKind, country: string, id: string): string => `${kind}-${country}-${id}.json`;

export function caseIdFor(kind: GoldenCaseKind, candidateIdOrUrl: string): string {
  return kind === 'false_positive' ? safeActId(candidateIdOrUrl).slice(0, 120) : `url-${sha256(urlKey(candidateIdOrUrl)).slice(0, 16)}`;
}

interface RunData {
  candidates: Candidate[];
  triage: TriageOutput['items'];
  screen: Record<string, ScreenRun>;
  result: CountryResult | null;
}

function runData(cdir: string, screenFromRun: Record<string, ScreenRun> | undefined): RunData {
  const cf = readJsonSafe<Partial<CandidatesFile>>(join(cdir, 'candidates.json'));
  const tr = readJsonSafe<Partial<TriageOutput>>(join(cdir, 'triage.json'));
  const sf = readJsonSafe<{ items?: Array<ScreenRun & { id?: string }> }>(join(cdir, 'screen.json'));
  const screen: Record<string, ScreenRun> = { ...(screenFromRun ?? {}) };
  if (sf && Array.isArray(sf.items)) for (const it of sf.items) if (it && typeof it.id === 'string') screen[it.id] = it;
  return {
    candidates: Array.isArray(cf?.candidates) ? cf.candidates.filter((c): c is Candidate => !!c && typeof c.id === 'string') : [],
    triage: Array.isArray(tr?.items) ? tr.items.filter((t) => !!t && typeof t.id === 'string') : [],
    screen,
    result: readJsonSafe<CountryResult>(join(cdir, 'result.json')),
  };
}

function resultLevel(r: CountryResult | null, id: string | undefined): ResultLevel {
  if (!r || !id) return 'none';
  if (Array.isArray(r.items) && r.items.some((i) => i?.candidate_id === id)) return 'material';
  if (Array.isArray(r.for_information) && r.for_information.some((i) => i?.candidate_id === id)) return 'for_info';
  if (Array.isArray(r.unverified) && r.unverified.some((i) => i?.candidate_id === id)) return 'unverified';
  return 'none';
}

/** Кандидат по id: candidates.json, иначе строки итога «для сведения» / «не удалось проверить». */
function findCandidate(d: RunData, id: string): GoldenCaseFile['candidate'] | null {
  const c = d.candidates.find((k) => k.id === id);
  if (c) return candidateOf(c);
  const r = d.result;
  const row = [...(Array.isArray(r?.for_information) ? r.for_information : []), ...(Array.isArray(r?.unverified) ? r.unverified : [])].find(
    (x) => x?.candidate_id === id,
  );
  if (!row) return null;
  return { id, url: row.url ?? '', title_original: row.title_original ?? '', issuer: row.issuer ?? '', date: row.date ?? '' };
}

function candidateOf(c: Candidate): GoldenCaseFile['candidate'] {
  return {
    id: c.id,
    key: c.key ?? '',
    title_original: c.title_original ?? '',
    issuer: c.issuer ?? '',
    date: c.date ?? '',
    url: c.url ?? '',
    doc_type: c.doc_type ?? '',
    ...(c.issuerClass === 1 || c.issuerClass === 2 || c.issuerClass === 3 ? { issuer_class: c.issuerClass } : {}),
  };
}

function decisionOf(d: RunData, id: string | undefined): GoldenCaseFile['decision_at_that_time'] {
  if (!id) return { collected: false, triage: null, screen: null, by: null, reason: null, result_level: 'none' };
  const t = d.triage.find((x) => x.id === id);
  const s = d.screen[id];
  const screenFinal = s?.state === 'done' && s.final ? s.final : null;
  return {
    collected: true,
    triage: t?.decision ?? null,
    screen: screenFinal,
    by: screenFinal ? (s?.by ?? null) : t ? 'triage' : null,
    reason: (screenFinal ? s?.reason : undefined) ?? t?.reason_text ?? null,
    result_level: resultLevel(d.result, id),
  };
}

/** Тексты ошибок формы (на языке интерфейса). */
function errText(L: UiLanguage, what: 'kind' | 'run' | 'country' | 'comment' | 'candidate' | 'url' | 'write', extra = ''): string {
  switch (what) {
    case 'kind':
      return mt(L, 'Неизвестный вид случая.', 'Unknown case type.');
    case 'run':
      return mt(L, 'Такого прогона нет в рабочей папке.', 'There is no such run in the working folder.');
    case 'country':
      return mt(L, 'Этой страны нет в прогоне.', 'This country is not in the run.');
    case 'comment':
      return mt(L, `Комментарий длиннее ${COMMENT_MAX} знаков — сократите его.`, `The comment is longer than ${COMMENT_MAX} characters — please shorten it.`);
    case 'candidate':
      return mt(L, 'Такой находки нет в этом прогоне.', 'This finding is not in this run.');
    case 'url':
      return mt(
        L,
        'Нужна ссылка на акт, начинающаяся с https:// (например, https://lex.uz/docs/1234567).',
        'A link to the act starting with https:// is needed (for example, https://lex.uz/docs/1234567).',
      );
    case 'write':
      return mt(L, `Не удалось сохранить случай: ${extra}`, `Could not save the case: ${extra}`);
  }
}

/**
 * Добавить случай (HAL-07). false_positive — кандидат из прогона, missed — ссылка из формы.
 * Повтор того же случая — `ok` с прежним файлом. Ошибки — текстом, без исключений.
 */
export function addGoldenCase(workspaceDir: string, input: GoldenCaseInput, now: Date = new Date(), L: UiLanguage = 'ru'): GoldenCaseResult {
  const inp = (input && typeof input === 'object' ? input : {}) as Partial<GoldenCaseInput>;
  const kind = inp.kind;
  if (kind !== 'false_positive' && kind !== 'missed') return { ok: false, error: errText(L, 'kind') };
  if (!isRunId(inp.runId)) return { ok: false, error: errText(L, 'run') };
  if (!isCountryCode(inp.country)) return { ok: false, error: errText(L, 'country') };
  const comment = typeof inp.comment === 'string' ? inp.comment.trim() : '';
  if (comment.length > COMMENT_MAX) return { ok: false, error: errText(L, 'comment') };

  const runP = archivePath(workspaceDir, inp.runId);
  if (!runP.ok || !runP.exists) return { ok: false, error: errText(L, 'run') };
  const state = loadRunSafe(runP.path);
  if (!state) return { ok: false, error: errText(L, 'run') };
  const cP = archivePath(workspaceDir, inp.runId, inp.country);
  if (!cP.ok || !cP.exists || !state.countries[inp.country]) return { ok: false, error: errText(L, 'country') };
  const d = runData(cP.path, state.countries[inp.country]?.screen);

  let candidate: GoldenCaseFile['candidate'];
  let id: string;
  if (kind === 'false_positive') {
    const cid = inp.candidateId;
    if (typeof cid !== 'string' || !cid || cid.length > CANDIDATE_ID_MAX) return { ok: false, error: errText(L, 'candidate') };
    const found = findCandidate(d, cid);
    if (!found) return { ok: false, error: errText(L, 'candidate') };
    candidate = found;
    id = caseIdFor(kind, cid);
  } else {
    const url = validActUrl(inp.url);
    if (!url) return { ok: false, error: errText(L, 'url') };
    const key = urlKey(url);
    const match = d.candidates.find((c) => typeof c.url === 'string' && c.url && urlKey(c.url) === key);
    candidate = match ? { ...candidateOf(match), url } : { url };
    id = caseIdFor(kind, url);
  }
  if (!CASE_ID_RE.test(id)) return { ok: false, error: errText(L, 'candidate') };

  const dir = casesDir(workspaceDir);
  const name = caseFileName(kind, inp.country, id);
  const file = join(dir, name);
  // Дубль: тот же вид и тот же кандидат/ссылка — прежний файл, второй не создаётся.
  if (existsSync(file) && validateCaseFile(readJsonSafe<unknown>(file), name).length === 0) return { ok: true, file };

  const data: GoldenCaseFile = {
    format: CASE_FORMAT,
    kind,
    id,
    country: inp.country,
    created_at: now.toISOString(),
    run_id: inp.runId,
    comment,
    candidate,
    decision_at_that_time: decisionOf(d, candidate.id),
    expected: kind === 'false_positive' ? { level: 'none' } : { level: 'material_or_for_info' },
  };
  try {
    // Текст акта — только настоящий снимок из архива прогона (тот, что видели экран и анализ).
    if (candidate.id) {
      const snap = join(cP.path, 'acts', safeActId(candidate.id), 'snapshot.txt');
      if (existsSync(snap) && fileInsideWorkspace(workspaceDir, snap)) {
        const t = readLimited(snap, SNAPSHOT_MAX_BYTES);
        if (t && !t.truncated) {
          const snapName = name.replace(/\.json$/, '.snapshot.txt');
          writeAtomic(join(dir, snapName), t.text);
          data.snapshot_text = snapName;
          data.snapshot_sha256 = sha256(t.text);
        }
      }
    }
    writeJsonAtomic(file, data);
  } catch (e) {
    return { ok: false, error: errText(L, 'write', e instanceof Error ? e.message : String(e)) };
  }
  return { ok: true, file };
}

/** Проверка формата файла случая; пусто — формат верен. `fileName` — сверка имени файла с kind/country/id. */
export function validateCaseFile(raw: unknown, fileName?: string, dir?: string): string[] {
  const errs: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['не JSON-объект'];
  const c = raw as Partial<GoldenCaseFile>;
  if (c.format !== CASE_FORMAT) errs.push(`format должен быть ${CASE_FORMAT}`);
  if (!KINDS.includes(c.kind as GoldenCaseKind)) errs.push('kind: false_positive | missed');
  if (typeof c.id !== 'string' || !CASE_ID_RE.test(c.id)) errs.push('id: [A-Za-z0-9._-]{1,160}');
  if (!isCountryCode(c.country)) errs.push('country: две латинские заглавные');
  if (typeof c.created_at !== 'string' || Number.isNaN(Date.parse(c.created_at))) errs.push('created_at: дата ISO');
  if (!isRunId(c.run_id)) errs.push('run_id: YYYY-MM-DD_HHMM');
  if (typeof c.comment !== 'string' || c.comment.length > COMMENT_MAX) errs.push(`comment: строка ≤ ${COMMENT_MAX}`);
  const cand = c.candidate;
  if (!cand || typeof cand !== 'object' || typeof cand.url !== 'string') errs.push('candidate.url: строка');
  else if (c.kind === 'missed' && !validActUrl(cand.url)) errs.push('candidate.url: ссылка http(s)');
  if (c.kind === 'false_positive' && (typeof cand?.id !== 'string' || !cand.id)) errs.push('candidate.id: обязателен для false_positive');
  const dec = c.decision_at_that_time;
  if (!dec || typeof dec !== 'object' || typeof dec.collected !== 'boolean') errs.push('decision_at_that_time: объект с collected');
  const wantLevel = c.kind === 'false_positive' ? 'none' : 'material_or_for_info';
  if (!c.expected || c.expected.level !== wantLevel) errs.push(`expected.level: ${wantLevel}`);
  if (fileName && KINDS.includes(c.kind as GoldenCaseKind) && typeof c.id === 'string' && typeof c.country === 'string') {
    const want = caseFileName(c.kind as GoldenCaseKind, c.country, c.id);
    if (fileName !== want) errs.push(`имя файла должно быть ${want}`);
  }
  if (c.snapshot_text !== undefined) {
    if (typeof c.snapshot_text !== 'string' || !/^[A-Za-z0-9._-]+\.snapshot\.txt$/.test(c.snapshot_text)) errs.push('snapshot_text: имя файла рядом');
    else if (dir) {
      const t = readLimited(join(dir, c.snapshot_text), SNAPSHOT_MAX_BYTES);
      if (!t || t.truncated) errs.push(`снимок ${c.snapshot_text} не читается`);
      else if (c.snapshot_sha256 && sha256(t.text) !== c.snapshot_sha256) errs.push(`снимок ${c.snapshot_text}: sha256 не совпадает`);
    }
  }
  return errs;
}

/** Все файлы случаев (*.json) папки с разбором; битые — с ошибкой разбора (для `npm run golden --app-cases`). */
export function readCaseFiles(workspaceDir: string): Array<{ file: string; name: string; data: unknown; errors: string[] }> {
  const dir = casesDir(workspaceDir);
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = join(dir, name);
    const data = readJsonSafe<unknown>(file);
    return { file, name, data, errors: data === null ? ['не читается как JSON'] : validateCaseFile(data, name, dir) };
  });
}

/** Случаи для окна, новые сверху. Битые файлы пропускаются. */
export function listGoldenCases(workspaceDir: string): GoldenCaseDto[] {
  const out: GoldenCaseDto[] = [];
  for (const f of readCaseFiles(workspaceDir)) {
    if (f.errors.length) continue;
    const c = f.data as GoldenCaseFile;
    out.push({
      id: c.id,
      kind: c.kind,
      country: c.country,
      title: c.candidate.title_original || c.candidate.url,
      url: c.candidate.url,
      comment: c.comment,
      createdAt: c.created_at,
      runId: c.run_id,
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** id кандидатов страны, уже помеченных «Ложное срабатывание» (для HistoryFindingDto.markedFalsePositive). */
export function falsePositiveIds(workspaceDir: string, country: string): Set<string> {
  const ids = new Set<string>();
  for (const f of readCaseFiles(workspaceDir)) {
    if (f.errors.length) continue;
    const c = f.data as GoldenCaseFile;
    if (c.kind === 'false_positive' && c.country === country && c.candidate.id) ids.add(c.candidate.id);
  }
  return ids;
}

/** Итог проверки кодовой части экрана на сохранённом тексте случая. */
export interface CaseScreenCheck {
  /**
   * pass — код сам даёт ожидаемое; fail — код снова ошибётся (отбросит пропущенный / покажет ложный как «не проверен»);
   * needs_model — решает модель (живой прогон — следующий шаг); no_text_saved — текста у случая нет, проверки нет.
   */
  status: 'pass' | 'fail' | 'needs_model' | 'no_text_saved';
  route?: Route['kind'];
  termCount?: number;
  textChars?: number;
  detail: string;
}

/**
 * Решение экрана по тексту (SCR-01/04), которое принимает КОД без модели, на сохранённом тексте случая:
 * нет текста → «не удалось проверить»; орган класса 3 без банковских терминов → отброшен; иначе — к модели.
 * Только если у случая есть сохранённый текст; иначе ничего не придумываем.
 */
export function screenCheckOnSavedText(c: GoldenCaseFile, dir: string): CaseScreenCheck {
  if (!c.snapshot_text) return { status: 'no_text_saved', detail: 'текст акта у случая не сохранён — проверка экрана не делается' };
  const t = readLimited(join(dir, c.snapshot_text), SNAPSHOT_MAX_BYTES);
  if (!t || t.truncated) return { status: 'no_text_saved', detail: `снимок ${c.snapshot_text} не читается` };
  const text = t.text;
  const termCount = findTerms(text).length;
  const hasText = text.length >= MIN_TEXT_CHARS;
  const route = routeCandidate(
    { ...(c.candidate.issuer_class ? { issuerClass: c.candidate.issuer_class } : {}) },
    { hasText, textSource: hasText ? 'html' : 'none', termCount, fragments: [] },
  );
  const base = { route: route.kind, termCount, textChars: text.length };
  if (route.kind === 'ask') return { ...base, status: 'needs_model', detail: `код передаёт акт модели (терминов ${termCount}); решение — за живым прогоном` };
  const visible = route.kind === 'no_text'; // «⚠ не удалось проверить» видно в письме
  const wantVisible = c.expected.level !== 'none';
  const reason = route.reason;
  return visible === wantVisible
    ? { ...base, status: 'pass', detail: `код: ${route.kind} — ${reason}` }
    : { ...base, status: 'fail', detail: `код: ${route.kind} — ${reason}; ожидалось ${wantVisible ? 'видно в письме' : 'не в письме'}` };
}
