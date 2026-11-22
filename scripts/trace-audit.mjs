#!/usr/bin/env node
// Аудит docs/TRACEABILITY.md против docs/01-requirements.md и docs/07-test-plan.md (фаза 11).
// Без зависимостей. Запуск: node scripts/trace-audit.mjs  (код выхода 1 — есть нарушения).
//
// Что проверяется:
//  (а) каждый ID требования из docs/01 и теста T-N из docs/07 есть в TRACEABILITY ровно один раз;
//      лишние ID; приоритет совпадает с docs/01; строка таблицы не сломана (число колонок);
//  (б) у строк done/partial: упомянутые пути (src/…, skills/…, schemas/…, scripts/…, docs/…)
//      существуют; имена исходников без папки (`executors.ts`) находятся в репозитории;
//      файлы тестов из «Чем проверено» существуют, а названия тестов в «…» после файла
//      есть в этом файле (поиск подстроки);
//  (в) статус done без указания теста или ручной проверки — нарушение правила CLAUDE.md;
//  (г) печатает таблицу нарушений.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------- файлы репозитория (для поиска по имени) ----------
const SCAN_DIRS = ['src', 'scripts', 'skills', 'schemas', 'docs'];
const repoFiles = [];
function walk(rel) {
  for (const name of readdirSync(join(ROOT, rel))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = `${rel}/${name}`;
    if (statSync(join(ROOT, p)).isDirectory()) walk(p);
    else repoFiles.push(p);
  }
}
for (const d of SCAN_DIRS) if (existsSync(join(ROOT, d))) walk(d);
for (const f of readdirSync(ROOT)) if (/\.(md|json|ts|mjs|yml)$/.test(f)) repoFiles.push(f);

/** Файлы, путь которых оканчивается на `/name` (или равен name). */
function findBySuffix(name) {
  return repoFiles.filter((f) => f === name || f.endsWith('/' + name));
}

// ---------- разбор таблиц ----------
/** Ячейки строки таблицы Markdown (без внешних `|`). `\|` внутри ячейки не встречается в наших документах. */
function cells(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function docRequirements() {
  const out = [];
  for (const line of read('docs/01-requirements.md').split('\n')) {
    const c = cells(line);
    if (!c || !/^[A-Z]{3}-\d{2}$/.test(c[0])) continue;
    out.push({ id: c[0], prio: c[c.length - 1], text: c[1] });
  }
  return out;
}

function docTests() {
  const out = [];
  for (const line of read('docs/07-test-plan.md').split('\n')) {
    const c = cells(line);
    if (!c || !/^T-\d+$/.test(c[0])) continue;
    out.push({ id: c[0], text: c[1] });
  }
  return out;
}

function traceRows() {
  const req = [];
  const tests = [];
  const units = [];
  let section = '';
  read('docs/TRACEABILITY.md').split('\n').forEach((line, i) => {
    if (line.startsWith('## ')) section = line.slice(3).trim();
    const c = cells(line);
    if (!c || /^-+$/.test(c[0]) || c[0] === 'ID' || c[0] === 'Файл') return;
    const row = { line: i + 1, cells: c, id: c[0] };
    if (section.startsWith('Требования')) req.push(row);
    else if (section.startsWith('Приёмочные')) tests.push(row);
    else if (section.startsWith('Юнит')) units.push(row);
  });
  return { req, tests, units };
}

// ---------- проверки ----------
const violations = [];
const add = (id, kind, detail, line) => violations.push({ id, kind, detail, line });

const STATUS_RE = /^(todo|partial|done|blocked)\b/;
const statusOf = (s) => (s.match(STATUS_RE) || [])[1] || null;

// Имена файлов артефактов прогона и состояния (не файлы репозитория) — не проверяются как пути.
const RUNTIME_NAMES = new Set([
  'run.json', 'result.json', 'candidates.json', 'triage.json', 'screen.json', 'card.json',
  'verification.json', 'settings.json', 'countries.json', 'outbox.json', 'last_success.json',
  'rate_limit.json', 'country_failures.json', 'schedule_fired.json', 'log.jsonl', 'input.json',
  'report.en.md', 'report.ru.md', 'report.md', 'snapshot.txt', 'snapshot.html', 'SKILL.md',
]);

const ROOT_PATH_RE = /(?<![\w/.~<>-])((?:src|skills|schemas|scripts|docs)\/[\w./*\-]*[\w*])/g;
const BARE_SRC_RE = /(?<![\w/.~-])((?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.(?:tsx?|mjs))(?![\w])/g;

/** Существует ли путь с явным корнем. docs/NN → docs/NN-*.md; `*` → существует папка. */
function rootPathExists(p) {
  if (p.includes('*')) {
    // Шаблон: `*` — любые символы внутри имени, `**` — любые папки.
    const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '(?:.*/)?') + '(?:/.*)?$');
    return repoFiles.some((f) => re.test(f));
  }
  if (existsSync(join(ROOT, p))) return true;
  const m = p.match(/^docs\/(\d{2})$/);
  if (m) return repoFiles.some((f) => f.startsWith(`docs/${m[1]}-`));
  return false;
}

/** Проверка путей в тексте ячейки. */
function checkPaths(id, text, line, where) {
  const seen = new Set();
  for (const m of text.matchAll(ROOT_PATH_RE)) {
    const p = m[1].replace(/[.]+$/, '');
    if (seen.has(p)) continue;
    seen.add(p);
    if (!rootPathExists(p)) add(id, 'битый путь', `${where}: \`${p}\` не существует`, line);
  }
  // Имена исходников без корня: ищем по окончанию пути.
  const stripped = text.replace(ROOT_PATH_RE, ' ');
  for (const m of stripped.matchAll(BARE_SRC_RE)) {
    const name = m[1];
    if (seen.has(name) || RUNTIME_NAMES.has(basename(name))) continue;
    seen.add(name);
    if (findBySuffix(name).length === 0) add(id, 'битый путь', `${where}: \`${name}\` не найден в репозитории`, line);
  }
}

const TEST_FILE_RE = /(?<![\w/.~-])((?:(?:src|scripts)\/)?(?:[\w-]+\/)*[\w.-]+\.test\.(?:ts|mjs)|scripts\/[\w.-]+\.mjs)(?![\w])/g;

/** Файлы тестов и названия тестов в «…» после имени файла (до следующего файла или «;»). */
function checkTestRefs(id, text, line) {
  const refs = [...text.matchAll(TEST_FILE_RE)];
  let found = 0;
  refs.forEach((m, k) => {
    const name = m[1];
    const files = name.startsWith('src/') || name.startsWith('scripts/') ? [name].filter((f) => existsSync(join(ROOT, f))) : findBySuffix(name);
    if (files.length === 0) {
      add(id, 'нет файла теста', `\`${name}\``, line);
      return;
    }
    found++;
    const end = k + 1 < refs.length ? refs[k + 1].index : text.length;
    let seg = text.slice(m.index + name.length, end);
    const semi = seg.indexOf(';');
    if (semi >= 0) seg = seg.slice(0, semi);
    if (!/^\s*\(/.test(seg)) return; // названия тестов пишутся в скобках сразу после файла
    const bodies = files.map((f) => read(f));
    for (const q of seg.matchAll(/«([^»]+)»/g)) {
      // «…» внутри названия — сокращение: ищем самый длинный кусок без многоточия.
      const piece = q[1].split(/…|\.\.\./).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0];
      if (!piece || piece.length < 3) continue;
      if (!bodies.some((b) => b.includes(piece))) add(id, 'нет теста с таким названием', `${name}: «${q[1]}»`, line);
    }
  });
  return found;
}

const MANUAL_RE = /(ручн|вручную|CDP|живой|живьём|живая|живого|живые|npm (run (golden|doctor|build)|test)|scripts\/\w+\.mjs|проверено|чтение|прочитан|статический разбор|T-\d+)/i;

function checkDoneEvidence(id, tested, line) {
  const t = tested.replace(/[\s—-]/g, '');
  if (!t) {
    add(id, 'done без проверки', 'колонка «Чем проверено» пуста', line);
    return;
  }
  const hasTest = [...tested.matchAll(TEST_FILE_RE)].length > 0;
  if (!hasTest && !MANUAL_RE.test(tested)) add(id, 'done без проверки', `ни теста, ни ручной проверки: «${tested.slice(0, 80)}»`, line);
}

// ---------- (а) полнота и дубли ----------
const reqs = docRequirements();
const tests = docTests();
const tr = traceRows();

const reqIds = new Map(reqs.map((r) => [r.id, r]));
const testIds = new Set(tests.map((t) => t.id));

function counts(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.id, (m.get(r.id) || 0) + 1);
  return m;
}
const trReq = counts(tr.req);
const trTest = counts(tr.tests);

for (const r of reqs) if (!trReq.has(r.id)) add(r.id, 'пропущен', `нет строки в TRACEABILITY (П=${r.prio})`);
for (const t of tests) if (!trTest.has(t.id)) add(t.id, 'пропущен', 'нет строки в TRACEABILITY');
for (const [id, n] of trReq) {
  if (n > 1) add(id, 'дубль', `${n} строк`);
  if (!reqIds.has(id)) add(id, 'лишний ID', 'нет в docs/01');
}
for (const [id, n] of trTest) {
  if (n > 1) add(id, 'дубль', `${n} строк`);
  if (!testIds.has(id)) add(id, 'лишний ID', 'нет в docs/07');
}
const dupDoc = counts(reqs);
for (const [id, n] of dupDoc) if (n > 1) add(id, 'дубль в docs/01', `${n} строк`);

// ---------- (б)(в) по строкам требований ----------
const stat = { done: 0, partial: 0, blocked: 0, todo: 0 };
for (const row of tr.req) {
  const c = row.cells;
  if (c.length !== 6) {
    add(row.id, 'сломана строка', `${c.length} колонок вместо 6`, row.line);
    continue;
  }
  const [id, prio, , where, tested, status] = c;
  const doc = reqIds.get(id);
  if (doc && doc.prio !== prio) add(id, 'приоритет', `в TRACEABILITY ${prio}, в docs/01 ${doc.prio}`, row.line);
  const st = statusOf(status);
  if (!st) {
    add(id, 'статус', `неизвестный статус «${status}»`, row.line);
    continue;
  }
  stat[st]++;
  if (st === 'blocked' && !/blocked\s*:\s*\S/.test(status)) add(id, 'статус', 'blocked без причины', row.line);
  if (st === 'done' || st === 'partial') {
    if (!where.replace(/[\s—-]/g, '')) add(id, 'нет реализации', 'колонка «Где реализовано» пуста', row.line);
    checkPaths(id, where, row.line, 'где');
    checkPaths(id, tested, row.line, 'чем');
    checkTestRefs(id, tested, row.line);
  }
  if (st === 'done') checkDoneEvidence(id, tested, row.line);
}

// ---------- приёмочные тесты ----------
for (const row of tr.tests) {
  const c = row.cells;
  if (c.length !== 4) {
    add(row.id, 'сломана строка', `${c.length} колонок вместо 4`, row.line);
    continue;
  }
  const [id, , result, status] = c;
  const st = statusOf(status);
  if (!st) {
    add(id, 'статус', `неизвестный статус «${status}»`, row.line);
    continue;
  }
  if (st === 'blocked' && !/blocked\s*:\s*\S/.test(status + ' ' + result)) add(id, 'статус', 'blocked без причины', row.line);
  if (st === 'done' || st === 'partial') {
    checkPaths(id, result, row.line, 'результат');
    checkTestRefs(id, result, row.line);
  }
  if (st === 'done') checkDoneEvidence(id, result, row.line);
}

// ---------- юнит-наборы docs/07 §1 ----------
for (const row of tr.units) {
  const [file, status] = row.cells;
  const st = statusOf(status || '');
  if (st !== 'done') continue;
  // Первая ячейка — имя набора из docs/07; если набор реализован под другими именами, они перечислены
  // в скобках «(→ a.test.ts, b.test.ts)». Каждое упомянутое имя должно существовать.
  const names = [...file.matchAll(TEST_FILE_RE)].map((m) => m[1]);
  const real = file.includes('→') ? names.slice(1) : names;
  for (const n of real.length ? real : [file]) {
    if (findBySuffix(n).length === 0) add(file, 'нет файла теста', `юнит-набор помечен done, файла \`${n}\` нет`, row.line);
  }
}

// ---------- (г) вывод ----------
console.log(`Требований в docs/01: ${reqs.length} (M: ${reqs.filter((r) => r.prio === 'M').length}), тестов в docs/07: ${tests.length}`);
console.log(`Строк в TRACEABILITY: требований ${tr.req.length}, тестов ${tr.tests.length}`);
console.log(`Статусы требований: done ${stat.done}, partial ${stat.partial}, blocked ${stat.blocked}, todo ${stat.todo}`);
if (violations.length === 0) {
  console.log('\nНарушений нет.');
  process.exit(0);
}
console.log(`\nНарушений: ${violations.length}\n`);
console.log('| ID | Вид | Строка | Подробности |');
console.log('|---|---|---|---|');
for (const v of violations) console.log(`| ${v.id} | ${v.kind} | ${v.line ?? ''} | ${v.detail.replace(/\|/g, '\\|')} |`);
process.exit(1);
