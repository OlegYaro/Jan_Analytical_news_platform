import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addGoldenCase,
  casesDir,
  COMMENT_MAX,
  falsePositiveIds,
  listGoldenCases,
  readCaseFiles,
  screenCheckOnSavedText,
  urlKey,
  validActUrl,
  validateCaseFile,
} from './golden-cases.ts';
import type { GoldenCaseFile } from './golden-cases.ts';
import { checkAppCases, formatAppCasesReport } from './golden.ts';
import { BANK_TEXT, makeWorkspace, NOISE_TEXT, RUN_OLD } from './history.fixture.ts';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const read = (file: string): GoldenCaseFile => JSON.parse(readFileSync(file, 'utf8')) as GoldenCaseFile;

test('false_positive: файл, реквизиты кандидата, решения того прогона, текст акта рядом', () => {
  const ws = makeWorkspace();
  const r = addGoldenCase(ws, { kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'lexuz-1', comment: '  не про банки  ' }, NOW);
  assert.ok(r.ok);
  assert.equal(r.file, join(casesDir(ws), 'false_positive-UZ-lexuz-1.json'));
  const c = read(r.file);
  assert.equal(c.format, 1);
  assert.equal(c.kind, 'false_positive');
  assert.equal(c.id, 'lexuz-1');
  assert.equal(c.created_at, NOW.toISOString());
  assert.equal(c.run_id, RUN_OLD);
  assert.equal(c.comment, 'не про банки');
  assert.deepEqual(c.candidate, {
    id: 'lexuz-1',
    key: 'reg:lexuz-1',
    title_original: 'Bank governance amendments',
    issuer: 'Central Bank',
    date: '2026-11-10',
    url: 'https://lex.uz/docs/1',
    doc_type: 'order',
    issuer_class: 1,
  });
  assert.deepEqual(c.decision_at_that_time, { collected: true, triage: 'relevant', screen: null, by: 'triage', reason: 'Channel A', result_level: 'material' });
  assert.deepEqual(c.expected, { level: 'none' });
  assert.equal(c.snapshot_text, 'false_positive-UZ-lexuz-1.snapshot.txt');
  assert.equal(readFileSync(join(casesDir(ws), c.snapshot_text!), 'utf8'), BANK_TEXT);
  assert.deepEqual(validateCaseFile(c, 'false_positive-UZ-lexuz-1.json', casesDir(ws)), []);

  // Решение экрана того прогона: «для сведения» от экрана.
  const r3 = addGoldenCase(ws, { kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'lexuz-3', comment: '' }, NOW);
  assert.ok(r3.ok);
  assert.deepEqual(read(r3.file).decision_at_that_time, { collected: true, triage: 'borderline', screen: 'minor', by: 'screen', reason: 'minor wording change', result_level: 'for_info' });
  assert.equal(read(r3.file).snapshot_text, undefined, 'снимка в архиве нет — текст не придумывается');

  assert.deepEqual([...falsePositiveIds(ws, 'UZ')].sort(), ['lexuz-1', 'lexuz-3']);
  assert.deepEqual([...falsePositiveIds(ws, 'KZ')], []);
});

test('дубль: тот же вид и кандидат (или та же ссылка) — прежний файл, второй не создаётся', () => {
  const ws = makeWorkspace();
  const a = addGoldenCase(ws, { kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'lexuz-2', comment: 'первый' }, NOW);
  const b = addGoldenCase(ws, { kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'lexuz-2', comment: 'второй' }, new Date('2026-11-22T00:00:00Z'));
  assert.ok(a.ok && b.ok);
  assert.equal(a.file, b.file);
  assert.equal(read(a.file).comment, 'первый');
  const m1 = addGoldenCase(ws, { kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'https://lex.uz/docs/777', comment: '' }, NOW);
  const m2 = addGoldenCase(ws, { kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'http://www.LEX.uz/docs/777/#top', comment: '' }, NOW);
  assert.ok(m1.ok && m2.ok);
  assert.equal(m1.file, m2.file);
  assert.equal(readdirSync(casesDir(ws)).filter((f) => f.endsWith('.json')).length, 2);
  assert.equal(listGoldenCases(ws).length, 2);
});

test('missed: ссылка найдена среди кандидатов — реквизиты и решения; не найдена — только ссылка', () => {
  const ws = makeWorkspace();
  const r = addGoldenCase(ws, { kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'https://www.lex.uz/docs/5/', comment: 'отброшен экраном' }, NOW);
  assert.ok(r.ok);
  const c = read(r.file);
  assert.match(r.file, /missed-UZ-url-[0-9a-f]{16}\.json$/);
  assert.equal(c.candidate.id, 'lexuz-5');
  assert.equal(c.candidate.url, 'https://www.lex.uz/docs/5/', 'в случае — ссылка из формы');
  assert.equal(c.candidate.issuer_class, 3);
  assert.deepEqual(c.decision_at_that_time, { collected: true, triage: 'borderline', screen: 'dropped', by: 'code', reason: 'орган не из финансовых, банковских терминов 0', result_level: 'none' });
  assert.deepEqual(c.expected, { level: 'material_or_for_info' });
  assert.equal(c.snapshot_text?.endsWith('.snapshot.txt'), true);

  const u = addGoldenCase(ws, { kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'https://cbu.uz/ru/documents/123', comment: '' }, NOW);
  assert.ok(u.ok);
  const cu = read(u.file);
  assert.deepEqual(cu.candidate, { url: 'https://cbu.uz/ru/documents/123' });
  assert.deepEqual(cu.decision_at_that_time, { collected: false, triage: null, screen: null, by: null, reason: null, result_level: 'none' });
  assert.equal(cu.snapshot_text, undefined);

  const list = listGoldenCases(ws);
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((x) => [x.kind, x.country, x.runId, x.title]).sort(),
    [
      ['missed', 'UZ', RUN_OLD, 'Road rules'],
      ['missed', 'UZ', RUN_OLD, 'https://cbu.uz/ru/documents/123'],
    ],
  );
});

test('невалидные входы: понятная ошибка, файлов нет, docs/golden-копия не тронута', () => {
  const ws = makeWorkspace();
  const bad: Array<[unknown, RegExp]> = [
    [{ kind: 'other', runId: RUN_OLD, country: 'UZ', comment: '' }, /вид случая/],
    [null, /вид случая/],
    [{ kind: 'missed', runId: '../..', country: 'UZ', url: 'https://lex.uz/docs/1', comment: '' }, /прогона нет/],
    [{ kind: 'missed', runId: '2026-01-01_0000', country: 'UZ', url: 'https://lex.uz/docs/1', comment: '' }, /прогона нет/],
    [{ kind: 'missed', runId: RUN_OLD, country: '..', url: 'https://lex.uz/docs/1', comment: '' }, /страны нет/],
    [{ kind: 'missed', runId: RUN_OLD, country: 'TJ', url: 'https://lex.uz/docs/1', comment: '' }, /страны нет/],
    [{ kind: 'false_positive', runId: RUN_OLD, country: 'UZ', comment: '' }, /находки нет/],
    [{ kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'lexuz-404', comment: '' }, /находки нет/],
    [{ kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'x'.repeat(201), comment: '' }, /находки нет/],
    [{ kind: 'missed', runId: RUN_OLD, country: 'UZ', comment: '' }, /https:\/\//],
    [{ kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'javascript:alert(1)', comment: '' }, /https:\/\//],
    [{ kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'ftp://lex.uz/1', comment: '' }, /https:\/\//],
    [{ kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'https://localhost/1', comment: '' }, /https:\/\//],
    [{ kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'https://user:pw@lex.uz/1', comment: '' }, /https:\/\//],
    [{ kind: 'missed', runId: RUN_OLD, country: 'UZ', url: `https://lex.uz/${'a'.repeat(2001)}`, comment: '' }, /https:\/\//],
    [{ kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'https://lex.uz/docs/1', comment: 'я'.repeat(COMMENT_MAX + 1) }, /длиннее 1000/],
  ];
  for (const [input, re] of bad) {
    const r = addGoldenCase(ws, input as never, NOW);
    assert.equal(r.ok, false, JSON.stringify(input)?.slice(0, 80));
    if (!r.ok) assert.match(r.error, re);
  }
  assert.deepEqual(readCaseFiles(ws), []);
  assert.deepEqual(readdirSync(join(ws, 'golden')), ['UZ-3254-2.expected.json']);
  // Ровно 1000 знаков — можно.
  assert.ok(addGoldenCase(ws, { kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'https://lex.uz/docs/1', comment: 'я'.repeat(COMMENT_MAX) }, NOW).ok);
  assert.deepEqual(readdirSync(join(ws, 'golden')).sort(), ['UZ-3254-2.expected.json', 'cases']);
  assert.equal(readFileSync(join(ws, 'golden', 'UZ-3254-2.expected.json'), 'utf8').includes('UZ-3254-2'), true);
  // Английский интерфейс — английская ошибка.
  const en = addGoldenCase(ws, { kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'nope', comment: '' }, NOW, 'en');
  assert.ok(!en.ok && /link to the act/.test(en.error));
});

test('ссылки: проверка и ключ для дублей', () => {
  assert.equal(validActUrl(' https://lex.uz/docs/1 '), 'https://lex.uz/docs/1');
  assert.equal(validActUrl('http://gov.uz/a'), 'http://gov.uz/a');
  assert.equal(validActUrl('lex.uz/docs/1'), null);
  assert.equal(validActUrl(42), null);
  assert.equal(urlKey('https://www.Lex.uz/docs/1/#x'), urlKey('http://lex.uz/docs/1'));
  assert.notEqual(urlKey('https://lex.uz/docs/1?a=1'), urlKey('https://lex.uz/docs/1?a=2'));
});

test('формат: битый файл виден в проверке и не попадает в список', () => {
  const ws = makeWorkspace();
  const ok = addGoldenCase(ws, { kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'lexuz-1', comment: '' }, NOW);
  assert.ok(ok.ok);
  writeFileSync(join(casesDir(ws), 'missed-UZ-broken.json'), '{ не json');
  const wrong = { ...read(ok.file), expected: { level: 'material_or_for_info' } };
  writeFileSync(join(casesDir(ws), 'false_positive-UZ-other.json'), JSON.stringify(wrong));
  // Подменённый текст рядом со случаем: sha256 не совпадает.
  writeFileSync(join(casesDir(ws), 'false_positive-UZ-lexuz-1.snapshot.txt'), 'подмена');
  const files = readCaseFiles(ws);
  const errs = Object.fromEntries(files.map((f) => [f.name, f.errors.join('; ')]));
  assert.match(errs['missed-UZ-broken.json']!, /не читается/);
  assert.match(errs['false_positive-UZ-other.json']!, /expected\.level: none/);
  assert.match(errs['false_positive-UZ-other.json']!, /имя файла должно быть false_positive-UZ-lexuz-1\.json/);
  assert.match(errs['false_positive-UZ-lexuz-1.json']!, /sha256 не совпадает/);
  assert.deepEqual(listGoldenCases(ws), []);
  assert.deepEqual(validateCaseFile([]), ['не JSON-объект']);
});

test('экран на сохранённом тексте (код, без модели): pass / fail / needs_model / no_text_saved', () => {
  const ws = makeWorkspace();
  const dir = casesDir(ws);
  mkdirSync(dir, { recursive: true });
  const base = (kind: 'false_positive' | 'missed', issuerClass: 1 | 2 | 3, text?: string): GoldenCaseFile => {
    const name = `${kind}-UZ-t${issuerClass}.snapshot.txt`;
    if (text !== undefined) writeFileSync(join(dir, name), text);
    return {
      format: 1,
      kind,
      id: `t${issuerClass}`,
      country: 'UZ',
      created_at: NOW.toISOString(),
      run_id: RUN_OLD,
      comment: '',
      candidate: { url: 'https://lex.uz/docs/x', issuer_class: issuerClass },
      decision_at_that_time: { collected: true, triage: null, screen: null, by: null, reason: null, result_level: 'none' },
      expected: kind === 'false_positive' ? { level: 'none' } : { level: 'material_or_for_info' },
      ...(text !== undefined ? { snapshot_text: name } : {}),
    };
  };
  assert.equal(screenCheckOnSavedText(base('false_positive', 3, NOISE_TEXT), dir).status, 'pass', 'класс 3 без терминов — код отсекает');
  const miss = screenCheckOnSavedText(base('missed', 3, NOISE_TEXT), dir);
  assert.equal(miss.status, 'fail', 'пропущенный снова отброшен кодом');
  assert.equal(miss.route, 'drop');
  assert.equal(screenCheckOnSavedText(base('missed', 1, 'short'), dir).status, 'pass', 'нет текста — «не удалось проверить», виден');
  assert.equal(screenCheckOnSavedText(base('false_positive', 1, 'short'), dir).status, 'fail');
  const ask = screenCheckOnSavedText(base('missed', 2, BANK_TEXT), dir);
  assert.equal(ask.status, 'needs_model');
  assert.ok(ask.termCount! > 0);
  assert.equal(screenCheckOnSavedText(base('missed', 1), dir).status, 'no_text_saved');
});

test('npm run golden --app-cases: перечисление, формат, экран; битый случай — не ок', () => {
  const ws = makeWorkspace();
  const empty = checkAppCases(ws);
  assert.equal(empty.ok, true);
  assert.match(formatAppCasesReport(empty), /Случаи из приложения.*: 0/);
  assert.ok(addGoldenCase(ws, { kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'lexuz-1', comment: 'шум' }, NOW).ok);
  assert.ok(addGoldenCase(ws, { kind: 'missed', runId: RUN_OLD, country: 'UZ', url: 'https://lex.uz/docs/5', comment: '' }, NOW).ok);
  const r = checkAppCases(ws);
  assert.equal(r.cases.length, 2);
  const byName = Object.fromEntries(r.cases.map((c) => [c.name.split('-')[0], c]));
  assert.equal(byName['false_positive']!.screen!.status, 'needs_model', 'класс 1 с терминами решает модель');
  assert.equal(byName['missed']!.screen!.status, 'fail', 'класс 3 без терминов: код снова отбросит пропущенный');
  assert.equal(r.ok, false);
  const text = formatAppCasesReport(r);
  assert.match(text, /ложное срабатывание, UZ/);
  assert.match(text, /комментарий: шум/);
  assert.match(text, /Прогон модели по случаям — не делается/);
  writeFileSync(join(casesDir(ws), 'x.json'), '[]');
  assert.match(formatAppCasesReport(checkAppCases(ws)), /❌ x\.json: формат неверен/);
});
