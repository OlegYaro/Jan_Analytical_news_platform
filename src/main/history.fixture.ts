// Синтетический архив прогонов для тестов «Истории» и эталонов из приложения.
// Форма файлов — как у настоящего прогона (run.json, candidates/triage/screen/result/verification, log.jsonl),
// данные — свои, выдуманные для тестов логики (это не эталон и не приёмка).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RUN_OLD = '2026-11-18_1517';
export const RUN_NEW = '2026-11-19_0800';
export const RUN_BROKEN = '2026-11-17_0800';

/** Текст без банковских терминов, длиннее MIN_TEXT_CHARS. */
export const NOISE_TEXT = 'Road maintenance rules for municipal roads and bridges in the region. '.repeat(12);
/** Текст с банковскими терминами. */
export const BANK_TEXT = 'Commercial bank capital requirements for bank deposits and credit operations. '.repeat(12);

const w = (file: string, data: unknown): void => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

const usage = (cost: number) => ({ input: 10, output: 20, cache_read: 30, cache_write: 40, cost_usd: cost });
const stages = (state: string) => ({
  collect: { state, attempts: 1 },
  news: { state, attempts: 1 },
  triage: { state, attempts: 1 },
  screen: { state, attempts: 1 },
  analyze: { state, attempts: 1 },
  verify: { state, attempts: 1 },
});

const cand = (id: string, title: string, url: string, issuerClass: 1 | 2 | 3, channel = 'B') => ({
  id,
  key: `reg:${id}`,
  title_original: title,
  issuer: issuerClass === 1 ? 'Central Bank' : 'Ministry of Roads',
  date: '2026-11-10',
  doc_type: 'order',
  url,
  snippet: '',
  channel,
  issuerClass,
});

/** Рабочая папка с тремя прогонами: старый (UZ — находки, KZ — сбой), новый (на паузе), битый; и очередь писем. */
export function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'rw-hist-'));
  // ── Старый прогон: UZ с находками, KZ со сбоем ──
  const r1 = join(ws, 'runs', RUN_OLD);
  w(join(r1, 'run.json'), {
    id: RUN_OLD,
    mode: 'scheduled',
    started_at: '2026-11-18T14:17:15.631Z',
    finished_at: '2026-11-18T15:29:31.504Z',
    skills_hash: 'h',
    countries: {
      UZ: {
        window: { from: '2026-10-19', to: '2026-11-18' },
        status: 'changes',
        stages: stages('done'),
        acts: { 'lexuz-1': { analyze: 'done', rounds: 1, verdict: 'confirmed' }, 'lexuz-2': { analyze: 'done', rounds: 2, verdict: 'unconfirmed' }, 'lexuz-7': { analyze: 'done', rounds: 1, verdict: 'confirmed' } },
        screen: {
          'lexuz-3': { state: 'done', final: 'minor', by: 'screen', reason: 'minor wording change' },
          'lexuz-4': { state: 'done', final: 'no_text', by: 'code', reason: 'страница акта не открылась' },
          'lexuz-5': { state: 'done', final: 'dropped', by: 'code', reason: 'орган не из финансовых, банковских терминов 0' },
          'lexuz-6': { state: 'done', final: 'dropped', by: 'confirm', reason: 'not about banks' },
          'lexuz-7': { state: 'done', final: 'material', by: 'screen', reason: 'returned and material' },
        },
        usage: usage(1.5),
      },
      KZ: {
        window: { from: '2026-10-19', to: '2026-11-18' },
        status: 'failed:source',
        stages: { ...stages('done'), collect: { state: 'failed', attempts: 1, error: 'Источник не ответил' } },
        acts: {},
        usage: usage(0),
      },
    },
    email: { state: 'queued', attempts: 0 },
  });
  const uz = join(r1, 'UZ');
  w(join(uz, 'candidates.json'), {
    country: 'UZ',
    window: { from: '2026-10-19', to: '2026-11-18' },
    candidates: [
      cand('lexuz-1', 'Bank governance amendments', 'https://lex.uz/docs/1', 1, 'A'),
      cand('lexuz-2', 'Bank reserve rules', 'https://lex.uz/docs/2', 1),
      cand('lexuz-3', 'Minor bank form', 'https://lex.uz/docs/3', 1),
      cand('lexuz-4', 'Bank PDF order', 'https://lex.uz/docs/4', 2),
      cand('lexuz-5', 'Road rules', 'https://lex.uz/docs/5', 3),
      cand('lexuz-6', 'Bridge rules', 'https://lex.uz/docs/6', 2),
      cand('lexuz-7', 'Postal payments', 'https://lex.uz/docs/7', 2),
      cand('lexuz-8', 'Tourism quotas', 'https://lex.uz/docs/8', 3),
      cand('lexuz-9', 'Duplicate bank act', 'https://lex.uz/docs/9', 1),
    ],
    filtered_by_ledger: [{ id: 'lexuz-10', key: 'reg:100-1' }],
    source_failures: [],
    anomalies: [],
    source_counts: [],
  });
  w(join(uz, 'triage.json'), {
    country: 'UZ',
    items: [
      { id: 'lexuz-1', decision: 'relevant', reason_code: null, reason_text: 'Channel A', confidence: 'high' },
      { id: 'lexuz-2', decision: 'relevant', reason_code: null, reason_text: 'bank reserves', confidence: 'high' },
      { id: 'lexuz-3', decision: 'borderline', reason_code: null, reason_text: 'maybe', confidence: 'low' },
      { id: 'lexuz-4', decision: 'relevant', reason_code: null, reason_text: 'bank', confidence: 'high' },
      { id: 'lexuz-5', decision: 'borderline', reason_code: null, reason_text: 'unclear', confidence: 'low' },
      { id: 'lexuz-6', decision: 'borderline', reason_code: null, reason_text: 'unclear', confidence: 'low' },
      // Отброшен отбором, но возвращён проверкой (VER-02) и стал находкой — в «отброшенных» его быть не должно.
      { id: 'lexuz-7', decision: 'irrelevant', reason_code: 'other_sector', reason_text: 'postal service', confidence: 'medium' },
      { id: 'lexuz-8', decision: 'irrelevant', reason_code: 'other_sector', reason_text: 'Tourism quotas, not financial', confidence: 'high' },
      { id: 'lexuz-9', decision: 'relevant', reason_code: null, reason_text: 'bank', confidence: 'high' },
    ],
  });
  w(join(uz, 'screen.json'), {
    country: 'UZ',
    items: [
      { id: 'lexuz-3', state: 'done', final: 'minor', by: 'screen', reason: 'minor wording change' },
      { id: 'lexuz-4', state: 'done', final: 'no_text', by: 'code', reason: 'страница акта не открылась' },
      { id: 'lexuz-5', state: 'done', final: 'dropped', by: 'code', reason: 'орган не из финансовых, банковских терминов 0' },
      { id: 'lexuz-6', state: 'done', final: 'dropped', by: 'confirm', reason: 'not about banks' },
      { id: 'lexuz-7', state: 'done', final: 'material', by: 'screen', reason: 'returned and material' },
    ],
  });
  w(join(uz, 'result.json'), {
    country: 'UZ',
    status: 'changes',
    items: [
      { candidate_id: 'lexuz-1', key: 'reg:lexuz-1', channel: 'A', kind: 'new', confirmed: true, disputed_fields: [], rounds: 1, title_en: 'On corporate governance in banks', card_file: 'acts/lexuz-1/card.json' },
      { candidate_id: 'lexuz-2', key: 'reg:lexuz-2', channel: 'B', kind: 'new', confirmed: false, disputed_fields: ['act.effective_date'], rounds: 2, title_en: 'On bank reserves', card_file: 'acts/lexuz-2/card.json' },
      { candidate_id: 'lexuz-7', key: 'reg:lexuz-7', channel: 'B', kind: 'new', confirmed: true, disputed_fields: [], rounds: 1, title_en: '', card_file: 'acts/lexuz-7/card.json' },
    ],
    for_information: [{ candidate_id: 'lexuz-3', key: 'reg:lexuz-3', title_original: 'Minor bank form', issuer: 'Central Bank', date: '2026-11-10', url: 'https://lex.uz/docs/3', reason: 'minor wording change', points: ['p. 2'] }],
    unverified: [{ candidate_id: 'lexuz-4', title_original: 'Bank PDF order', issuer: 'Ministry of Roads', date: '2026-11-10', url: 'https://lex.uz/docs/4', reason: 'страница акта не открылась' }],
    duplicates: [{ candidate_id: 'lexuz-9', key: 'reg:lexuz-9' }],
    warnings: [],
    to_commit: [],
  });
  w(join(uz, 'verification.pass-1.json'), {
    country: 'UZ',
    cards: [
      { candidate_id: 'lexuz-2', verdict: 'needs_correction', fields: [{ field: 'act.effective_date', status: 'mismatch', comment: 'wrong date', quote: 'q', url: 'https://lex.uz/docs/2' }] },
      { candidate_id: 'lexuz-1', verdict: 'confirmed', fields: [{ field: 'act.number', status: 'ok', comment: 'matches', quote: 'q', url: 'https://lex.uz/docs/1' }] },
    ],
    returned: [],
    watched_acts_check: [],
  });
  w(join(uz, 'verification.pass-2.json'), {
    country: 'UZ',
    cards: [{ candidate_id: 'lexuz-2', verdict: 'unconfirmed', fields: [{ field: 'act.effective_date', status: 'weird', comment: 'still unclear', quote: 'q', url: 'https://lex.uz/docs/2' }] }],
    returned: [],
    watched_acts_check: [],
  });
  // verification.json = последний проход (копия pass-2), как пишет оркестратор.
  w(join(uz, 'verification.json'), {
    country: 'UZ',
    cards: [{ candidate_id: 'lexuz-2', verdict: 'unconfirmed', fields: [{ field: 'act.effective_date', status: 'weird', comment: 'still unclear', quote: 'q', url: 'https://lex.uz/docs/2' }] }],
    returned: [],
    watched_acts_check: [],
  });
  w(join(uz, 'report.en.md'), '# Uzbekistan\n\nReport text.\n');
  const log = [
    { ts: '2026-11-18T14:17:15.654Z', country: 'UZ', event: 'country_start', text: 'Страна начата' },
    { ts: '2026-11-18T14:17:56.563Z', country: 'UZ', event: 'collect_summary', text: 'Собрано кандидатов 9' },
    { ts: '2026-11-18T14:17:56.564Z', country: 'UZ', event: 'candidate', text: 'Кандидат lexuz-1' },
    { ts: '2026-11-18T14:18:24.683Z', country: 'UZ', event: 'process', text: 'Процесс модели: этап news' },
    { ts: '2026-11-18T14:19:56.870Z', country: 'UZ', event: 'triage_decision', text: 'lexuz-1: relevant' },
    { ts: '2026-11-18T14:19:56.883Z', country: 'UZ', event: 'triage_done', text: 'Отбор: на анализ 4, отброшено 2' },
    { ts: '2026-11-18T14:20:00.000Z', country: 'UZ', event: 'screen_decision', text: `lexuz-6: dropped (confirm) — ${'x'.repeat(400)}` },
    { ts: '2026-11-18T15:29:31.502Z', country: 'UZ', event: 'status', text: 'Итог: есть изменения (3)' },
  ];
  w(join(uz, 'log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n') + '\nне json\n');
  w(join(uz, 'acts', 'lexuz-1', 'snapshot.txt'), BANK_TEXT);
  w(join(uz, 'acts', 'lexuz-5', 'snapshot.txt'), NOISE_TEXT);
  w(join(r1, 'KZ', 'result.json'), { country: 'KZ', status: 'failed:source', error: 'Источник не ответил', items: [], duplicates: [], warnings: [], to_commit: [] });

  // ── Новый прогон: на паузе, без результатов ──
  w(join(ws, 'runs', RUN_NEW, 'run.json'), {
    id: RUN_NEW,
    mode: 'dry_run',
    started_at: '2026-11-19T07:00:00.000Z',
    skills_hash: 'h',
    paused_until: '2026-11-19T12:00:00.000Z',
    countries: { UZ: { window: { from: '2026-11-18', to: '2026-11-19' }, status: 'running', stages: stages('pending'), acts: {}, usage: usage(0.25) } },
  });
  // ── Битый прогон и посторонняя папка ──
  w(join(ws, 'runs', RUN_BROKEN, 'run.json'), '{ not json');
  mkdirSync(join(ws, 'runs', 'notes'), { recursive: true });
  // ── Очередь писем: у старого прогона одно письмо отправлено ──
  w(join(ws, 'state', 'outbox.json'), {
    version: 1,
    entries: [{ id: `${RUN_OLD}:digest:ru`, runId: RUN_OLD, kind: 'digest', status: 'sent', attempts: 2, nextAttemptAt: '2026-11-18T15:30:00.000Z', createdAt: '2026-11-18T15:30:00.000Z' }],
  });
  // ── Эталон из репозитория (копия): не должен меняться ──
  w(join(ws, 'golden', 'UZ-3254-2.expected.json'), { id: 'UZ-3254-2' });
  return ws;
}
