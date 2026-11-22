import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addGoldenCase } from './golden-cases.ts';
import { getCountryRun, listRuns, LOG_MAX_LINES, readCountryLog, REPORT_MAX_BYTES, resolveOpenTarget } from './history.ts';
import { makeWorkspace, RUN_NEW, RUN_OLD } from './history.fixture.ts';

test('listRuns: новые сверху, битый run.json и посторонние папки пропущены', () => {
  const ws = makeWorkspace();
  const runs = listRuns(ws);
  assert.deepEqual(
    runs.map((r) => r.id),
    [RUN_NEW, RUN_OLD],
  );
  const [fresh, old] = runs;
  assert.equal(fresh!.paused, true);
  assert.equal(fresh!.stopped, false);
  assert.equal(fresh!.finishedAt, undefined);
  assert.deepEqual(fresh!.checked, { ok: 0, total: 1 });
  assert.deepEqual(fresh!.found, { material: 0, forInfo: 0, unverified: 0 });
  assert.equal(fresh!.mail, undefined, 'писем нет — undefined, а не выдуманный статус');

  assert.equal(old!.mode, 'scheduled');
  assert.equal(old!.paused, false);
  assert.deepEqual(old!.checked, { ok: 1, total: 2 }, 'KZ со сбоем не засчитан');
  assert.deepEqual(old!.found, { material: 3, forInfo: 1, unverified: 1 });
  assert.deepEqual(old!.mail, { state: 'sent', attempts: 2 }, 'письмо — из state/outbox.json, а не из run.json');
  assert.deepEqual(
    old!.countries.map((c) => [c.code, c.status, c.material, c.forInfo, c.unverified]),
    [
      ['UZ', 'changes', 3, 1, 1],
      ['KZ', 'failed:source', 0, 0, 0],
    ],
  );
});

test('listRuns: своё правило письма; без очереди — run.json email; нет папки runs — пусто', () => {
  const ws = makeWorkspace();
  const r = listRuns(ws, (id) => (id === RUN_OLD ? { state: 'failed', attempts: 7 } : undefined));
  assert.deepEqual(r.find((x) => x.id === RUN_OLD)!.mail, { state: 'failed', attempts: 7 });
  writeFileSync(join(ws, 'state', 'outbox.json'), '{ битый');
  assert.deepEqual(listRuns(ws).find((x) => x.id === RUN_OLD)!.mail, { state: 'queued', attempts: 0 });
  assert.deepEqual(listRuns(mkdtempSync(join(tmpdir(), 'rw-hist-empty-'))), []);
});

test('getCountryRun: находки, отброшенные, проверка по полям, отчёты, журнал, расход', () => {
  const ws = makeWorkspace();
  const c = getCountryRun(ws, RUN_OLD, 'UZ')!;
  assert.ok(c);
  assert.equal(c.status, 'changes');
  assert.equal(c.error, undefined);
  assert.equal(c.dir, join(ws, 'runs', RUN_OLD, 'UZ'));

  assert.deepEqual(
    c.findings.map((f) => [f.candidateId, f.level, f.confirmed, f.disputedFields, f.title, f.url]),
    [
      ['lexuz-1', 'material', true, [], 'On corporate governance in banks', 'https://lex.uz/docs/1'],
      ['lexuz-2', 'material', false, ['act.effective_date'], 'On bank reserves', 'https://lex.uz/docs/2'],
      ['lexuz-7', 'material', true, [], 'Postal payments', 'https://lex.uz/docs/7'],
      ['lexuz-3', 'for_info', true, [], 'Minor bank form', 'https://lex.uz/docs/3'],
      ['lexuz-4', 'unverified', false, [], 'Bank PDF order', 'https://lex.uz/docs/4'],
    ],
  );
  assert.equal(c.findings[3]!.reason, 'minor wording change');
  assert.ok(c.findings.every((f) => f.markedFalsePositive === undefined));

  // Отброшенные: отбор (кроме возвращённого проверкой lexuz-7), экран кодом и моделью, журнал, дубль. no_text — не отброшен.
  assert.deepEqual(
    c.discarded.map((d) => [d.candidateId, d.by]),
    [
      ['lexuz-8', 'triage'],
      ['lexuz-5', 'code'],
      ['lexuz-6', 'screen'],
      ['lexuz-10', 'code'],
      ['lexuz-9', 'code'],
    ],
  );
  assert.equal(c.discarded[0]!.reason, 'Tourism quotas, not financial');
  assert.equal(c.discarded[0]!.title, 'Tourism quotas');
  assert.equal(c.discarded[0]!.url, 'https://lex.uz/docs/8');
  assert.match(c.discarded[3]!.reason, /журнал отправленного: reg:100-1/);
  assert.ok(!c.discarded.some((d) => d.candidateId === 'lexuz-4'));

  // Проверка: последний проход по каждой карточке; неизвестный статус — unverifiable; порядок — как у находок.
  assert.deepEqual(
    c.verification.map((v) => [v.candidateId, v.verdict, v.fields.map((f) => f.status)]),
    [
      ['lexuz-1', 'confirmed', ['ok']],
      ['lexuz-2', 'unconfirmed', ['unverifiable']],
    ],
  );
  assert.equal(c.verification[1]!.fields[0]!.comment, 'still unclear');

  assert.equal(c.reportEn, '# Uzbekistan\n\nReport text.\n');
  assert.equal(c.reportRu, null);

  // Журнал: только сводные события, текст как есть; решение экрана — кратко.
  assert.deepEqual(
    c.log.map((l) => l.text.slice(0, 20)),
    ['Страна начата', 'Собрано кандидатов 9', 'Отбор: на анализ 4, ', 'lexuz-6: dropped (con', 'Итог: есть изменения'].map((s) => s.slice(0, 20)),
  );
  assert.ok(c.log[3]!.text.length <= 200);
  assert.equal(c.log[0]!.ts, '2026-11-18T14:17:15.654Z');

  assert.deepEqual(c.usage, { costUsd: 1.5, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
});

test('getCountryRun: страна со сбоем — ошибка; английские пояснения кода', () => {
  const ws = makeWorkspace();
  const kz = getCountryRun(ws, RUN_OLD, 'KZ')!;
  assert.equal(kz.status, 'failed:source');
  assert.equal(kz.error, 'Источник не ответил');
  assert.deepEqual([kz.findings, kz.discarded, kz.verification, kz.log], [[], [], [], []]);
  const en = getCountryRun(ws, RUN_OLD, 'UZ', 'en')!;
  assert.match(en.discarded.find((d) => d.candidateId === 'lexuz-10')!.reason, /already sent earlier/);
  // Страна прогона без своей папки (ещё не начата) — пустой разбор, а не ошибка.
  const fresh = getCountryRun(ws, RUN_NEW, 'UZ')!;
  assert.equal(fresh.status, 'running');
  assert.deepEqual(fresh.findings, []);
  assert.equal(fresh.usage.costUsd, 0.25);
});

test('getCountryRun: пометка «ложное срабатывание» видна у находки', () => {
  const ws = makeWorkspace();
  assert.equal(addGoldenCase(ws, { kind: 'false_positive', runId: RUN_OLD, country: 'UZ', candidateId: 'lexuz-3', comment: '' }).ok, true);
  const c = getCountryRun(ws, RUN_OLD, 'UZ')!;
  assert.deepEqual(
    c.findings.filter((f) => f.markedFalsePositive).map((f) => f.candidateId),
    ['lexuz-3'],
  );
});

test('getCountryRun: выход за рабочую папку и неверные id — null, без исключений', () => {
  const ws = makeWorkspace();
  for (const [run, code] of [
    ['../..', 'UZ'],
    [`${RUN_OLD}/..`, 'UZ'],
    [RUN_OLD, '..'],
    [RUN_OLD, 'uz'],
    [RUN_OLD, 'UZ/../KZ'],
    ['/etc', 'UZ'],
    ['', 'UZ'],
    ['2026-11-20_0000', 'UZ'], // нет такого прогона
    [RUN_OLD, 'TJ'], // нет такой страны в прогоне
    ['2026-11-17_0800', 'UZ'], // битый run.json
  ] as const) {
    assert.equal(getCountryRun(ws, run, code), null, `${run} ${code}`);
  }
  assert.equal(getCountryRun(join(ws, 'nope'), RUN_OLD, 'UZ'), null);
});

test('resolveOpenTarget: папка прогона и страны; path traversal и символьная ссылка наружу — отказ', () => {
  const ws = makeWorkspace();
  assert.deepEqual(resolveOpenTarget(ws, RUN_OLD), { ok: true, path: join(ws, 'runs', RUN_OLD) });
  assert.deepEqual(resolveOpenTarget(ws, RUN_OLD, 'UZ'), { ok: true, path: join(ws, 'runs', RUN_OLD, 'UZ') });
  assert.deepEqual(resolveOpenTarget(ws, RUN_OLD, ''), { ok: true, path: join(ws, 'runs', RUN_OLD) });
  for (const [run, code] of [
    ['..', undefined],
    ['../../etc', undefined],
    [`${RUN_OLD}/../..`, undefined],
    [RUN_OLD, '../..'],
    [RUN_OLD, 'U/'],
    [RUN_OLD, 'uz'],
    [123, undefined],
    [null, undefined],
    [`${RUN_OLD}\u0000`, undefined],
  ] as const) {
    assert.deepEqual(resolveOpenTarget(ws, run, code), { ok: false, reason: 'bad_id' }, String(run));
  }
  assert.deepEqual(resolveOpenTarget(ws, '2026-01-01_0000'), { ok: false, reason: 'not_found' });
  assert.deepEqual(resolveOpenTarget(ws, RUN_OLD, 'TJ'), { ok: false, reason: 'not_found' });

  // Символьная ссылка с «правильным» именем, ведущая из рабочей папки наружу.
  const outside = mkdtempSync(join(tmpdir(), 'rw-outside-'));
  mkdirSync(join(outside, 'UZ'));
  writeFileSync(join(outside, 'run.json'), JSON.stringify({ id: '2026-01-02_0000', started_at: '2026-01-02T00:00:00Z', countries: { UZ: {} } }));
  symlinkSync(outside, join(ws, 'runs', '2026-01-02_0000'));
  assert.deepEqual(resolveOpenTarget(ws, '2026-01-02_0000'), { ok: false, reason: 'outside' });
  assert.deepEqual(resolveOpenTarget(ws, '2026-01-02_0000', 'UZ'), { ok: false, reason: 'outside' });
  assert.equal(getCountryRun(ws, '2026-01-02_0000', 'UZ'), null);
  assert.ok(!listRuns(ws).some((r) => r.id === '2026-01-02_0000'), 'прогон-ссылка наружу не в списке');
});

test('отчёт больше 2 МБ обрезается с пометкой; журнал — последние 200 строк', () => {
  const ws = makeWorkspace();
  const uz = join(ws, 'runs', RUN_OLD, 'UZ');
  writeFileSync(join(uz, 'report.ru.md'), 'я'.repeat(REPORT_MAX_BYTES)); // 2 байта на знак — вдвое больше предела
  const lines = Array.from({ length: 450 }, (_, i) => JSON.stringify({ ts: `t${i}`, event: i % 2 ? 'act_done' : 'process', text: `строка ${i}` }));
  writeFileSync(join(uz, 'log.jsonl'), lines.join('\n') + '\n');
  const c = getCountryRun(ws, RUN_OLD, 'UZ')!;
  assert.ok(c.reportRu!.length < REPORT_MAX_BYTES);
  assert.match(c.reportRu!, /Отчёт слишком большой/);
  assert.ok(!c.reportRu!.includes('�'));
  assert.equal(c.log.length, Math.min(LOG_MAX_LINES, 225));
  assert.equal(c.log.at(-1)!.text, 'строка 449');
  assert.deepEqual(readCountryLog(join(uz, 'нет.jsonl')), []);
});
