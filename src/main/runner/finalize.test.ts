// Шаги 7–10 (DIGEST/TRANSLATE/SEND/COMMIT) на настоящем оркестраторе с заглушками этапов и подставной почтой.
// T-3 (нет повторов), T-4 (тишина), пробный прогон, недоступная почта (DLV-06), both_one/both_two, COV-06,
// идемпотентность finalize. Реальная почта и claude не используются.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunReport, StartResult } from '../../shared/pipeline-types.ts';
import type { Settings } from '../../shared/types.ts';
import type { TranslateFn } from '../digest/contracts.ts';
import { loadLedger } from '../ledger.ts';
import { loadOutbox, outboxFile } from '../mail/outbox.ts';
import type { OutboxEntry } from '../mail/outbox.ts';
import {
  FAILURE_ALERT_AFTER,
  INCOMPLETE_TRANSLATION_RU,
  createFinalize,
  lastSuccessFile,
  loadCountryFailures,
  mailStatusFor,
  noticeText,
  processMailQueue,
} from './finalize.ts';
import type { FinalizeDeps, FinalizeNotice } from './finalize.ts';
import { Orchestrator, computeWindow, loadRunReport } from './orchestrator.ts';
import { loadRun } from './run-state.ts';
import { OPEN_GATE, cand, country, makeHarness, settingsFor } from './fixtures/orchestrator-stubs.ts';
import type { HarnessOptions } from './fixtures/orchestrator-stubs.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'rw-final-'));
const MAIL = { service: 'gmail' as const, address: 'me@example.com', recipients: [], server: '', port: 465, security: 'ssl' as const, verified: true };

interface World {
  ws: string;
  settings: Settings;
  clock: { t: Date };
  sent: OutboxEntry[];
  notices: FinalizeNotice[];
  /** Ошибка транспорта для следующих отправок (null — отправка проходит). */
  mailError: { err: unknown | null };
  deps: FinalizeDeps;
}

function world(patch: Partial<Settings> = {}, extra: Partial<FinalizeDeps> = {}): World {
  const ws = tmp();
  const settings = settingsFor(ws, { mail: MAIL, reportLanguage: 'en', ...patch });
  const clock = { t: new Date(2026, 10, 16, 8, 0) };
  const sent: OutboxEntry[] = [];
  const notices: FinalizeNotice[] = [];
  const mailError: { err: unknown | null } = { err: null };
  const deps: FinalizeDeps = {
    getSettings: () => settings,
    getCountries: () => [country('UZ'), country('KZ')].map((c) => ({ ...c, name: c.code === 'UZ' ? 'Узбекистан' : 'Казахстан' })),
    now: () => clock.t,
    send: async (e) => {
      if (mailError.err) throw mailError.err;
      sent.push(e);
    },
    notify: (n) => void notices.push(n),
    ...extra,
  };
  return { ws, settings, clock, sent, notices, mailError, deps };
}

type Ok = Extract<StartResult, { ok: true }>;

/** Один прогон оркестратора с finalize; время прогона сдвигается на сутки каждый раз (разные папки прогонов). */
async function runOnce(w: World, o: HarnessOptions, mode: 'manual' | 'dry_run' | 'scheduled' | 'backfill' = 'manual', codes = ['UZ'], windowOverride?: { from: string; to: string }): Promise<Ok> {
  w.clock.t = new Date(w.clock.t.getTime() + 24 * 3600_000);
  const h = makeHarness(o);
  const orch = new Orchestrator({ executors: h.executors, now: () => w.clock.t, finalize: createFinalize(w.deps) });
  const r = await orch.start({ mode, countries: codes.map((c) => country(c)), settings: w.settings, gate: OPEN_GATE, ...(windowOverride ? { windowOverride } : {}) });
  assert.ok(r && r.ok, JSON.stringify(r));
  return r as Ok;
}

const runLog = (r: Ok): Array<{ event: string }> =>
  readFileSync(join(r.runDir, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

test('T-3: прогон с изменениями → письмо ушло и журнал записан; повтор тех же актов → дублей нет, письма нет', async () => {
  const w = world();
  const acts = { candidates: { UZ: [cand('3254-2')] } };
  const r1 = await runOnce(w, acts);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0]!.subject, /^RegWatch: UZ/);
  assert.deepEqual(w.sent[0]!.to, ['me@example.com']);
  assert.deepEqual(loadLedger(w.ws, 'UZ').map((e) => e.key), ['reg:3254-2']);
  assert.equal(loadRun(r1.runDir).email?.state, 'sent');
  assert.equal(loadRun(r1.runDir).email?.attempts, 1);
  assert.ok(existsSync(join(r1.runDir, 'UZ', 'report.en.md')));
  assert.ok(existsSync(join(r1.runDir, 'digest.html')));
  const ev = runLog(r1).map((e) => e.event);
  for (const k of ['finalize_start', 'finalize_digest', 'finalize_queued', 'finalize_sent', 'finalize_commit', 'finalize_done']) assert.ok(ev.includes(k), k);
  // last_success страны из письма — после отправки.
  assert.equal(JSON.parse(readFileSync(lastSuccessFile(w.ws), 'utf8')).UZ, loadRun(r1.runDir).started_at);

  const r2 = await runOnce(w, acts);
  assert.equal(w.sent.length, 1, 'повторный прогон не шлёт письмо');
  assert.equal(loadLedger(w.ws, 'UZ').length, 1, 'дублей в журнале нет');
  assert.equal(loadRun(r2.runDir).email?.state, 'not_needed');
  assert.equal(w.notices.at(-1)?.changes.length, 0);
});

test('T-4: нет изменений → письма нет, last_success обновлён в формате computeWindow', async () => {
  const w = world();
  const r = await runOnce(w, { candidates: { UZ: [] } });
  assert.equal(w.sent.length, 0);
  assert.equal(existsSync(outboxFile(w.ws)), false);
  const st = loadRun(r.runDir);
  assert.equal(st.email?.state, 'not_needed');
  const ls = JSON.parse(readFileSync(lastSuccessFile(w.ws), 'utf8'));
  assert.equal(ls.UZ, st.started_at);
  // Следующее окно начинается с даты этого прогона (RUN-09).
  const next = computeWindow(w.ws, 'UZ', w.settings, new Date(2026, 10, 25, 8, 0));
  assert.equal(next.from, '2026-11-17');
  assert.equal(noticeText(w.notices[0]!, 'ru').body, 'Проверка завершена, изменений нет.');
});

test('пробный прогон: дайджест и отчёты в папке прогона, письма нет, журнала и last_success нет', async () => {
  const w = world();
  const r = await runOnce(w, { candidates: { UZ: [cand('u1')] } }, 'dry_run');
  assert.equal(w.sent.length, 0);
  assert.equal(existsSync(outboxFile(w.ws)), false);
  assert.deepEqual(loadLedger(w.ws, 'UZ'), []);
  assert.equal(existsSync(lastSuccessFile(w.ws)), false);
  assert.ok(existsSync(join(r.runDir, 'digest.html')));
  assert.ok(existsSync(join(r.runDir, 'digest.txt')));
  assert.ok(existsSync(join(r.runDir, 'UZ', 'report.en.md')));
  assert.equal(loadRun(r.runDir).email?.state, 'not_needed');
  const n = noticeText(w.notices[0]!, 'ru');
  assert.match(n.body, /^Пробная проверка\. Есть изменения: UZ — 1 существенный/);
});

test('«за период»: письма и журнала нет, но страна засчитана проверенной до конца окна', async () => {
  const w = world();
  const r = await runOnce(w, { candidates: { UZ: [cand('u1')] } }, 'backfill', ['UZ'], { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(w.sent.length, 0);
  assert.equal(existsSync(outboxFile(w.ws)), false);
  assert.deepEqual(loadLedger(w.ws, 'UZ'), []);
  assert.equal(loadRun(r.runDir).email?.state, 'not_needed');
  const next = computeWindow(w.ws, 'UZ', w.settings, new Date(2026, 10, 25, 8, 0));
  assert.equal(next.from, '2026-10-31');
});

test('«за период» с разрывом после последней проверки: окно не сдвигается', async () => {
  const w = world();
  mkdirSync(join(w.ws, 'state'), { recursive: true });
  writeFileSync(lastSuccessFile(w.ws), JSON.stringify({ UZ: new Date(2026, 8, 1, 12).toISOString() }));
  const r = await runOnce(w, { candidates: { UZ: [cand('u1')] } }, 'backfill', ['UZ'], { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(computeWindow(w.ws, 'UZ', w.settings, new Date(2026, 10, 25, 8, 0)).from, '2026-09-01');
  assert.ok(runLog(r).some((l) => l.event === 'finalize_done'));
});

test('«за период» сплошной, граница: следующее окно начинается с самого дня «по» (день перепроверяется)', async () => {
  const w = world();
  mkdirSync(join(w.ws, 'state'), { recursive: true });
  writeFileSync(lastSuccessFile(w.ws), JSON.stringify({ UZ: new Date(2026, 9, 5, 12).toISOString() }));
  await runOnce(w, { candidates: { UZ: [cand('u1')] } }, 'backfill', ['UZ'], { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(computeWindow(w.ws, 'UZ', w.settings, new Date(2026, 10, 25, 8, 0)).from, '2026-10-31');
});

test('почта недоступна: письмо в очереди, 6 повторов через 15 мин (в т.ч. после «перезапуска»), затем failed; журнал НЕ записан', async () => {
  const w = world();
  w.mailError.err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const r = await runOnce(w, { candidates: { UZ: [cand('u1')] } });
  let st = loadRun(r.runDir);
  assert.equal(st.email?.state, 'queued');
  assert.equal(st.email?.attempts, 1);
  assert.equal(w.notices[0]?.mail, 'queued');
  const ui = mailStatusFor(w.ws, st, 'ru');
  assert.equal(ui?.state, 'queued');
  assert.match(ui?.lastError ?? '', /не отвечает/);
  assert.ok(ui?.nextAttemptAt);
  const changes: OutboxEntry[] = [];
  for (let i = 0; i < 6; i++) {
    w.clock.t = new Date(w.clock.t.getTime() + 15 * 60_000);
    // Каждый вызов — как таймер после перезапуска приложения: всё состояние в state/outbox.json.
    await processMailQueue(w.ws, { ...w.deps, onOutboxChange: (e) => void changes.push(e) });
  }
  const e = loadOutbox(outboxFile(w.ws)).entries[0]!;
  assert.equal(e.status, 'failed');
  assert.equal(e.attempts, 7);
  assert.equal(changes.at(-1)?.status, 'failed');
  assert.deepEqual(loadLedger(w.ws, 'UZ'), [], 'журнал не записан');
  assert.equal(existsSync(lastSuccessFile(w.ws)), false, 'страна с находками не засчитана — окно не сдвинется');
  st = loadRun(r.runDir);
  assert.deepEqual(st.email, { state: 'failed', attempts: 7 });
  assert.equal(mailStatusFor(w.ws, st, 'en')?.state, 'failed');
});

test('почта: неверный пароль → failed сразу, уведомление «Письмо не отправлено — откройте RegWatch»', async () => {
  const w = world({ uiLanguage: 'ru' });
  w.mailError.err = Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
  const r = await runOnce(w, { candidates: { UZ: [cand('u1')] } });
  assert.deepEqual(loadRun(r.runDir).email, { state: 'failed', attempts: 1 });
  assert.match(noticeText(w.notices[0]!, 'ru').body, /Письмо не отправлено — откройте RegWatch/);
  assert.deepEqual(loadLedger(w.ws, 'UZ'), []);
});

test('both_two: два письма (ru и en), журнал записан один раз', async () => {
  const translate: TranslateFn = async (_ctx, texts) => ({ ok: true, output: { translations: Object.fromEntries(texts.map((t) => [t, `RU:${t}`])), rejected: [] } });
  const w = world({ reportLanguage: 'both_two' }, { translate });
  await runOnce(w, { candidates: { UZ: [cand('u1')] } });
  assert.deepEqual(w.sent.map((e) => e.lang), ['ru', 'en']);
  assert.match(w.sent[0]!.subject, /существенный/);
  assert.match(w.sent[1]!.subject, /material/);
  assert.doesNotMatch(w.sent[0]!.text, new RegExp(INCOMPLETE_TRANSLATION_RU.slice(0, 20)));
  assert.equal(loadLedger(w.ws, 'UZ').length, 1);
  const entries = loadOutbox(outboxFile(w.ws)).entries;
  assert.ok(entries.every((e) => e.committed && e.status === 'sent'));
});

test('both_one: одно письмо — сверху русская версия, ниже английская', async () => {
  const w = world({ reportLanguage: 'both_one' });
  await runOnce(w, { candidates: { UZ: [cand('u1')] } });
  assert.equal(w.sent.length, 1);
  const t = w.sent[0]!.text;
  const iRu = t.indexOf('Проверено');
  const iEn = t.indexOf('English version');
  assert.ok(iRu >= 0 && iEn > iRu);
  assert.ok(t.indexOf('Checked') > iEn);
  assert.equal((w.sent[0]!.html.match(/<\/body>/g) ?? []).length, 1);
});

test('ru: перевод не получен → русское письмо с английскими фрагментами и строкой о неполном переводе', async () => {
  const translate: TranslateFn = async () => ({ ok: false, failure: 'timeout', message: 'не уложились во время' });
  const w = world({ reportLanguage: 'ru' }, { translate });
  const r = await runOnce(w, { candidates: { UZ: [cand('u1')] } });
  assert.equal(w.sent.length, 1);
  assert.ok(w.sent[0]!.text.includes(INCOMPLETE_TRANSLATION_RU));
  assert.ok(w.sent[0]!.html.includes('Перевод неполный'));
  assert.equal(loadRun(r.runDir).digest?.ru, 'blocked');
});

test('COV-06: одна неудача — без письма о сбое; вторая подряд — письмо о сбое; успех сбрасывает счётчик', async () => {
  const w = world({ reportLanguage: 'ru', failureAlerts: true });
  const kzDown: HarnessOptions = {
    collect: (ctx) =>
      ctx.country.code === 'KZ'
        ? { ok: true, output: { candidates: [], sourceFailures: [{ sourceId: 'adilet', message: 'сайт не отвечает', critical: true }] } }
        : { ok: true, output: { candidates: [] } },
  };
  await runOnce(w, kzDown, 'scheduled', ['UZ', 'KZ']);
  assert.equal(w.sent.length, 0, 'первая неудача — письма нет');
  assert.equal(loadCountryFailures(w.ws).countries.KZ?.consecutive, 1);
  assert.match(noticeText(w.notices[0]!, 'ru').body, /Не удалось проверить: KZ/);

  const r2 = await runOnce(w, kzDown, 'scheduled', ['UZ', 'KZ']);
  assert.equal(w.sent.length, 1, 'вторая подряд — письмо о сбое');
  assert.equal(w.sent[0]!.kind, 'failure_alert');
  assert.match(w.sent[0]!.subject, /не удалось проверить KZ/);
  assert.match(w.sent[0]!.text, /Казахстан — .*прогонов подряд без проверки: 2/);
  assert.match(w.sent[0]!.text, /Проверено 1 из 2 стран/);
  assert.equal(loadCountryFailures(w.ws).countries.KZ?.consecutive, FAILURE_ALERT_AFTER);
  assert.equal(loadRun(r2.runDir).email?.state, 'sent');
  // UZ проверен без находок — засчитан сразу; KZ — нет.
  const ls = JSON.parse(readFileSync(lastSuccessFile(w.ws), 'utf8'));
  assert.ok(ls.UZ);
  assert.equal(ls.KZ, undefined);

  await runOnce(w, { candidates: { UZ: [], KZ: [] } }, 'scheduled', ['UZ', 'KZ']);
  assert.equal(loadCountryFailures(w.ws).countries.KZ?.consecutive, 0);
  assert.equal(w.sent.length, 1);
});

test('COV-06: письма о сбое выключены (failureAlerts=false) — не шлём; письмо с изменениями содержит строку о сбоях', async () => {
  const w = world({ reportLanguage: 'en', failureAlerts: false });
  const o: HarnessOptions = {
    collect: (ctx) =>
      ctx.country.code === 'KZ'
        ? { ok: true, output: { candidates: [], sourceFailures: [{ sourceId: 'adilet', message: 'down', critical: true }] } }
        : { ok: true, output: { candidates: [] } },
  };
  await runOnce(w, o, 'scheduled', ['UZ', 'KZ']);
  await runOnce(w, o, 'scheduled', ['UZ', 'KZ']);
  assert.equal(w.sent.length, 0);
  const withChanges: HarnessOptions = {
    collect: (ctx) =>
      ctx.country.code === 'KZ'
        ? { ok: true, output: { candidates: [], sourceFailures: [{ sourceId: 'adilet', message: 'down', critical: true }] } }
        : { ok: true, output: { candidates: [cand('u9')] } },
  };
  await runOnce(w, withChanges, 'scheduled', ['UZ', 'KZ']);
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0]!.text, /Checked 1 of 2/);
  assert.match(w.sent[0]!.text, /KZ|Kazakhstan/);
});

test('идемпотентность: повторный finalize того же прогона не шлёт дубль и не меняет счётчики', async () => {
  const w = world({ failureAlerts: true });
  const r = await runOnce(w, { candidates: { UZ: [cand('u1')] } });
  assert.equal(w.sent.length, 1);
  const fin = createFinalize(w.deps);
  const report: RunReport = loadRunReport(r.runDir, loadRun(r.runDir));
  await fin(report);
  await fin(loadRunReport(r.runDir, loadRun(r.runDir)));
  assert.equal(w.sent.length, 1);
  assert.equal(report.state.email?.state, 'sent');
  assert.equal(loadLedger(w.ws, 'UZ').length, 1);
  assert.equal(loadCountryFailures(w.ws).countries.UZ?.consecutive, 0);
});

test('идемпотентность: сбой после постановки в очередь (до отправки) — повторный finalize дошлёт то же письмо один раз', async () => {
  const w = world();
  w.mailError.err = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  const r = await runOnce(w, { candidates: { UZ: [cand('u1')] } });
  assert.equal(w.sent.length, 0);
  w.mailError.err = null;
  w.clock.t = new Date(w.clock.t.getTime() + 16 * 60_000);
  await createFinalize(w.deps)(loadRunReport(r.runDir, loadRun(r.runDir)));
  await createFinalize(w.deps)(loadRunReport(r.runDir, loadRun(r.runDir)));
  assert.equal(w.sent.length, 1);
  assert.equal(loadOutbox(outboxFile(w.ws)).entries.length, 1);
  assert.equal(loadLedger(w.ws, 'UZ').length, 1);
});

test('уведомления: тексты на двух языках', () => {
  const n: FinalizeNotice = { runId: 'r', mode: 'scheduled', changes: [{ code: 'UZ', material: 2, info: 1, unverified: 0 }], failed: [{ code: 'KZ', consecutive: 2 }], mail: 'sent' };
  assert.equal(noticeText(n, 'ru').body, 'Есть изменения: UZ — 2 существенных, 1 для сведения. Не удалось проверить: KZ (2-й раз подряд).');
  assert.equal(noticeText(n, 'en').body, 'Changes: UZ — 2 material, 1 for information. Could not check: KZ (2 runs in a row).');
  assert.equal(noticeText({ ...n, changes: [], failed: [], mail: 'not_needed', mode: 'dry_run' }, 'ru').body, 'Пробная проверка. Проверка завершена, изменений нет.');
  assert.equal(noticeText({ ...n, mail: 'failed' }, 'ru').title, 'RegWatch: есть изменения');
  assert.match(noticeText({ ...n, mail: 'failed' }, 'en').body, /The e-mail was not sent — open RegWatch\./);
});
