import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actsSummary,
  canStop,
  countryStatusText,
  failureReason,
  formatAmount,
  formatCost,
  formatUsage,
  isUsageEmpty,
  formatWhen,
  pauseText,
  stageIcon,
  validatePeriod,
  sumUsage,
} from './logic.ts'

test('значки этапов', () => {
  assert.equal(stageIcon('pending'), '⏳')
  assert.equal(stageIcon('running'), '🔄')
  assert.equal(stageIcon('done'), '✅')
  assert.equal(stageIcon('skipped'), '—')
  assert.equal(stageIcon('failed'), '❌')
})

test('причины сбоя простыми словами, неизвестное как есть', () => {
  assert.equal(failureReason('timeout'), 'не уложились во время')
  assert.equal(failureReason('schema'), 'ответ не прошёл проверку формата')
  assert.equal(failureReason('completeness'), 'не все найденные документы получили решение')
  assert.equal(failureReason('source'), 'сайт недоступен')
  assert.equal(failureReason('parser'), 'сайт стал отдавать пустой список')
  assert.equal(failureReason('limit'), 'достигнут лимит Claude')
  assert.equal(failureReason('internal'), 'внутренняя ошибка')
  assert.equal(failureReason('no_result'), 'no_result')
})

test('итог страны', () => {
  assert.equal(countryStatusText('changes'), 'есть изменения')
  assert.equal(countryStatusText('no_changes'), 'нет изменений')
  assert.equal(countryStatusText('failed:timeout'), 'сбой: не уложились во время')
  assert.equal(countryStatusText('pending'), 'ожидает')
})

test('акты: число и состояние', () => {
  assert.equal(actsSummary({}), '')
  assert.equal(
    actsSummary({ a: { analyze: 'done', rounds: 1 }, b: { analyze: 'done', rounds: 1 }, c: { analyze: 'running', rounds: 0 } }),
    '3 акта: готово 2, в работе 1',
  )
  assert.equal(actsSummary({ a: { analyze: 'failed', rounds: 0 } }), '1 акт: сбой 1')
})

test('расход', () => {
  assert.equal(formatAmount(950), '950')
  assert.equal(formatAmount(12_340), '12,3 тыс.')
  assert.equal(formatAmount(2_500_000), '2,5 млн')
  assert.equal(formatCost(0.123), '≈ $0.12')
  const u = sumUsage([
    { input: 1000, output: 500, cache_read: 0, cache_write: 0, cost_usd: 0.1 },
    { input: 2000, output: 700, cache_read: 5, cache_write: 0, cost_usd: 0.05 },
  ])
  assert.equal(u.input, 3000)
  assert.equal(formatUsage(u), 'объём обработки 4,2 тыс. (прочитано 3,0 тыс., из кэша 5, написано 1,2 тыс.), примерная стоимость ≈ $0.15')
  assert.doesNotMatch(formatUsage(u), /токен/i)
  const c = sumUsage([{ input: 462, output: 312_000, cache_read: 4_300_000, cache_write: 1_900_000, cost_usd: 1 }])
  assert.equal(formatUsage(c), 'объём обработки 312,5 тыс. (прочитано 462, из кэша 4,3 млн, записано в кэш 1,9 млн, написано 312,0 тыс.), примерная стоимость ≈ $1.00')
  assert.equal(isUsageEmpty({ input: 0, output: 0, cache_read: 5, cache_write: 0, cost_usd: 0 }), false)
})

test('пауза и время', () => {
  const now = new Date(2026, 10, 17, 10, 0)
  const until = new Date(2026, 10, 17, 14, 20).toISOString()
  assert.equal(pauseText(until, now), 'Пауза до 14:20 — ждём восстановления лимита Claude')
  assert.equal(formatWhen(new Date(2026, 10, 18, 9, 5).toISOString(), now), '18.11 09:05')
  assert.equal(formatWhen('мусор', now), '—')
})

test('кнопка «Остановить» активна только при идущем прогоне', () => {
  assert.equal(canStop(true, false), true)
  assert.equal(canStop(false, false), false)
  assert.equal(canStop(true, true), false)
})

test('период: ISO-даты, «с» не позже «по»', () => {
  assert.deepEqual(validatePeriod('2026-11-01', ' 2026-11-15 '), { from: '2026-11-01', to: '2026-11-15' })
  assert.equal(validatePeriod('2026-11-15', '2026-11-01'), null)
  assert.equal(validatePeriod('2026-02-30', '2026-03-01'), null)
  assert.equal(validatePeriod('01.11.2026', '2026-11-15'), null)
  assert.equal(validatePeriod('', ''), null)
})

// Оценка до прогона: числа синтетические, проверяется только форматирование.
import { estimateText, formatPercentRange, formatRange, formatUsdRange } from './logic.ts'

test('formatUsdRange: целые от $2, десятые ниже, одинаковые края — одно число', () => {
  assert.equal(formatUsdRange([2.2, 3.4]), '$2–4')
  assert.equal(formatUsdRange([0.31, 0.74]), '$0,3–0,8')
  assert.equal(formatUsdRange([3.01, 3.2]), '$3–4')
  assert.equal(formatUsdRange([0, 0]), '$0,1')
  assert.equal(formatUsdRange([NaN, 5]), '$0–5')
})

test('formatPercentRange: шаг 5, потолок 100, одинаковые края', () => {
  assert.equal(formatPercentRange([22, 38]), '20–40 %')
  assert.equal(formatPercentRange([4, 9]), '0–10 %')
  assert.equal(formatPercentRange([120, 480]), '100 %')
  assert.equal(formatRange(20, 20, { step: 5 }), '20')
})

test('estimateText (ru): строка, пометка про грубую оценку, подсказка про лимит', () => {
  const e = { usd: [2.2, 3.4] as [number, number], limitPercent: [22, 38] as [number, number], countries: 9, days: 7, from: '2026-11-15', to: '2026-11-22', basis: 'history' as const, exceedsLimit: false }
  assert.deepEqual(estimateText(e), { line: 'Оценка следующей проверки (с 15.11.2026 по 22.11.2026, 7 дней): ≈ $2–4, около 20–40 % 5-часового лимита, 9 стран', rough: '', over: '' })
  const r = estimateText({ ...e, countries: 2, basis: 'default', exceedsLimit: true })
  assert.match(r.line, /2 страны$/)
  assert.match(r.rough, /грубая оценка/)
  assert.match(r.over, /встанет на паузу/)
  assert.match(estimateText({ ...e, countries: 1 }).line, /1 страна$/)
})

test('строки оценки (en)', async () => {
  const g = globalThis as unknown as { localStorage?: unknown }
  const old = g.localStorage
  g.localStorage = { getItem: () => 'en' }
  try {
    const m = (await import('../../strings-run.ts?en-estimate')) as typeof import('../../strings-run.ts')
    assert.equal(m.tr.estimate.line('$2–4', '20–40 %', 9, 7, '2026-11-15', '2026-11-22'), 'Estimate for the next check (2026-11-15 to 2026-11-22, 7 days): ≈ $2–4, about 20–40 % of the 5-hour limit, 9 countries')
    assert.match(m.tr.estimate.line('$1', '10 %', 1, 1, '2026-11-22', '2026-11-22'), /1 country$/)
  } finally {
    g.localStorage = old
  }
})
