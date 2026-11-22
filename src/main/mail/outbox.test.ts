// Очередь исходящих (DLV-06): повторы, постоянные ошибки, перезапуск, идемпотентность, журнал один раз на группу.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  OUTBOX_MAX_RETRIES,
  OUTBOX_RETRY_MS,
  enqueueOutbox,
  loadOutbox,
  outboxFile,
  processOutbox,
  summarizeEntries,
} from './outbox.ts';
import type { NewOutboxEntry, OutboxEntry, ProcessOutboxDeps } from './outbox.ts';
import { isRetryableMailError, translateMailError } from './smtp.ts';

const T0 = new Date('2026-11-20T08:00:00Z');

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'rw-outbox-'));
}

function letter(id: string, extra: Partial<NewOutboxEntry> = {}): NewOutboxEntry {
  return {
    id,
    runId: 'r1',
    kind: 'digest',
    group: 'r1:digest',
    lang: 'ru',
    subject: 'RegWatch: UZ — 1 существенный',
    html: '<p>x</p>',
    text: 'x',
    to: ['me@example.com'],
    commit: { UZ: [{ key: 'reg:1', stage: 'published', effective_date: '2027-01-13', title_en: 'T' }] },
    ...extra,
  };
}

interface Harness {
  deps: ProcessOutboxDeps;
  sent: string[];
  committed: string[];
  clock: { t: Date };
}

function harness(file: string, send: (e: OutboxEntry) => Promise<void> = async () => {}, onSent?: (e: OutboxEntry) => void): Harness {
  const sent: string[] = [];
  const committed: string[] = [];
  const clock = { t: T0 };
  return {
    sent,
    committed,
    clock,
    deps: {
      file,
      now: () => clock.t,
      send: async (e) => {
        await send(e);
        sent.push(e.id);
      },
      onSent: (e) => {
        onSent?.(e);
        committed.push(e.id);
      },
      isRetryable: isRetryableMailError,
      describeError: (err) => ({ ru: translateMailError(err, { service: 'gmail' }, 'ru'), en: translateMailError(err, { service: 'gmail' }, 'en') }),
    },
  };
}

const later = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

test('успех: письмо уходит один раз, журнал пишется один раз, повторная обработка ничего не шлёт', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('r1:digest:ru')], T0);
  const h = harness(file);
  const r = await processOutbox(h.deps);
  assert.deepEqual(r.sent, ['r1:digest:ru']);
  assert.deepEqual(h.committed, ['r1:digest:ru']);
  const e = loadOutbox(file).entries[0]!;
  assert.equal(e.status, 'sent');
  assert.equal(e.attempts, 1);
  assert.equal(e.committed, true);
  assert.equal(e.inFlightSince, undefined);
  await processOutbox(h.deps);
  assert.equal(h.sent.length, 1);
  assert.equal(h.committed.length, 1);
});

test('идемпотентность постановки: тот же id второй раз не добавляется (и отправленное не возвращается в очередь)', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('a')], T0);
  await processOutbox(harness(file).deps);
  const again = await enqueueOutbox(file, [letter('a'), letter('a')], T0);
  assert.equal(loadOutbox(file).entries.length, 1);
  assert.equal(again[0]!.status, 'sent');
});

test('DLV-06: нет сети — 6 повторов через 15 минут, очередь переживает «перезапуск», затем failed; журнал не пишется', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('r1:digest:ru')], T0);
  const netErr = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  let calls = 0;
  const attemptsAt: number[] = [];
  const failing = async () => {
    calls++;
    throw netErr;
  };
  let t = T0;
  for (let i = 0; i < 1 + OUTBOX_MAX_RETRIES; i++) {
    // Каждая итерация — как новый процесс: всё состояние только в outbox.json.
    const h = harness(file, failing);
    h.clock.t = t;
    // Раньше срока — не отправляет.
    if (i > 0) {
      h.clock.t = later(t, -60_000);
      await processOutbox(h.deps);
      assert.equal(calls, i, 'до срока повтора письмо не отправляется');
      h.clock.t = t;
    }
    attemptsAt.push(h.clock.t.getTime());
    await processOutbox(h.deps);
    const e = loadOutbox(file).entries[0]!;
    assert.equal(e.attempts, i + 1);
    assert.match(e.lastError ?? '', /не отвечает|интернет/);
    if (i < OUTBOX_MAX_RETRIES) {
      assert.equal(e.status, 'queued');
      assert.equal(Date.parse(e.nextAttemptAt) - t.getTime(), OUTBOX_RETRY_MS);
      t = new Date(e.nextAttemptAt);
    } else {
      assert.equal(e.status, 'failed', 'после 6 повторов — окончательно не отправлено');
      assert.ok(e.failedAt);
    }
    assert.equal(h.committed.length, 0, 'журнал не пишется без отправки');
  }
  assert.equal(calls, 7);
  for (let i = 1; i < attemptsAt.length; i++) assert.equal(attemptsAt[i]! - attemptsAt[i - 1]!, OUTBOX_RETRY_MS);
  // Окончательно неотправленное больше не трогается.
  const h = harness(file, failing);
  h.clock.t = later(t, 10 * OUTBOX_RETRY_MS);
  await processOutbox(h.deps);
  assert.equal(calls, 7);
  assert.equal(summarizeEntries(loadOutbox(file).entries)?.state, 'failed');
});

test('неверный пароль — failed сразу, без повторов, понятный текст по-русски', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('x')], T0);
  const auth = Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
  const h = harness(file, async () => {
    throw auth;
  });
  const r = await processOutbox(h.deps);
  assert.deepEqual(r.failed, ['x']);
  const e = loadOutbox(file).entries[0]!;
  assert.equal(e.status, 'failed');
  assert.equal(e.attempts, 1);
  assert.match(e.lastError!, /не принял пароль/);
  assert.match(e.lastErrorEn!, /did not accept the password/);
  assert.doesNotMatch(e.lastError!, /535|Username/);
});

test('прерванная попытка (процесс упал во время отправки) засчитывается и повторяется сразу', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('x')], T0);
  const data = loadOutbox(file);
  data.entries[0]!.attempts = 1;
  data.entries[0]!.inFlightSince = T0.toISOString();
  writeFileSync(file, JSON.stringify(data));
  const h = harness(file);
  h.clock.t = later(T0, 60_000);
  await processOutbox(h.deps);
  const e = loadOutbox(file).entries[0]!;
  assert.equal(e.status, 'sent');
  assert.equal(e.attempts, 2);
  assert.deepEqual(h.sent, ['x']);
});

test('группа из двух писем (both_two): журнал пишется один раз — после первого успешного', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('r1:digest:ru'), letter('r1:digest:en', { lang: 'en' })], T0);
  const h = harness(file);
  await processOutbox(h.deps);
  assert.deepEqual(h.sent, ['r1:digest:ru', 'r1:digest:en']);
  assert.deepEqual(h.committed, ['r1:digest:ru']);
  assert.ok(loadOutbox(file).entries.every((e) => e.committed));
});

test('группа: первое письмо отвергнуто, второе ушло — журнал всё равно записан один раз', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('r1:digest:ru'), letter('r1:digest:en', { lang: 'en' })], T0);
  const h = harness(file, async (e) => {
    if (e.lang === 'ru') throw Object.assign(new Error('message rejected'), { code: 'EMESSAGE', responseCode: 552 });
  });
  await processOutbox(h.deps);
  assert.deepEqual(h.committed, ['r1:digest:en']);
  const st = loadOutbox(file).entries.map((e) => e.status);
  assert.deepEqual(st, ['failed', 'sent']);
  assert.equal(summarizeEntries(loadOutbox(file).entries)?.state, 'failed');
});

test('сбой записи журнала не теряется: письмо не уходит второй раз, журнал дописывается при следующей обработке', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('x')], T0);
  let boom = true;
  const h = harness(file, async () => {}, () => {
    if (boom) throw new Error('диск занят');
  });
  await processOutbox(h.deps);
  let e = loadOutbox(file).entries[0]!;
  assert.equal(e.status, 'sent');
  assert.equal(e.committed, false);
  assert.match(e.commitError!, /диск занят/);
  boom = false;
  await processOutbox(h.deps);
  e = loadOutbox(file).entries[0]!;
  assert.equal(e.committed, true);
  assert.deepEqual(h.sent, ['x'], 'письмо ушло один раз');
});

test('параллельные вызовы обработки не отправляют одно письмо дважды', async () => {
  const file = outboxFile(ws());
  await enqueueOutbox(file, [letter('x')], T0);
  const h = harness(file, () => new Promise((r) => setTimeout(r, 20)));
  await Promise.all([processOutbox(h.deps), processOutbox(h.deps), processOutbox(h.deps)]);
  assert.deepEqual(h.sent, ['x']);
});

test('битый outbox.json не роняет очередь: сохраняется в .bak', async () => {
  const dir = ws();
  const file = outboxFile(dir);
  await enqueueOutbox(file, [], T0);
  writeFileSync(file, '{ битый');
  assert.deepEqual(loadOutbox(file).entries, []);
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{ битый');
});
