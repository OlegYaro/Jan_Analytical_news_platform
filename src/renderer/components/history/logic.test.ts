import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  discardedByLabel, foundLabel, formatDateTime, groupFields, isValidUrl, levelLabel, mailLabel, mailTone, reasonLabel, runFlags,
  unconfirmedLabel, validateCaseForm,
} from './logic.ts'

test('foundLabel: все части и нули', () => {
  assert.equal(foundLabel({ material: 6, forInfo: 15, unverified: 2 }, 'ru'), '6 существенных · 15 для сведения · 2 не проверено')
  assert.equal(foundLabel({ material: 6, forInfo: 15, unverified: 2 }, 'en'), '6 material · 15 for information · 2 not verified')
  assert.equal(foundLabel({ material: 0, forInfo: 3, unverified: 0 }, 'ru'), '3 для сведения')
  assert.equal(foundLabel({ material: 0, forInfo: 0, unverified: 0 }, 'ru'), 'ничего нового')
  assert.equal(foundLabel({ material: 0, forInfo: 0, unverified: 0 }, 'en'), 'nothing new')
})

test('mailLabel и mailTone', () => {
  assert.equal(mailLabel({ state: 'sent', attempts: 1 }, 'ru'), 'письмо отправлено')
  assert.equal(mailLabel({ state: 'failed', attempts: 3 }, 'en'), 'email failed')
  assert.equal(mailLabel({ state: 'not_needed', attempts: 0 }, 'ru'), 'письмо не нужно')
  assert.equal(mailLabel({ state: 'queued', attempts: 0 }, 'ru'), 'письмо ждёт отправки')
  assert.equal(mailLabel(undefined, 'ru'), 'письмо: нет данных')
  assert.equal(mailTone({ state: 'failed', attempts: 1 }), 'bad')
  assert.equal(mailTone(undefined), 'idle')
})

test('formatDateTime', () => {
  assert.equal(formatDateTime(new Date(2026, 10, 18, 14, 5).toISOString(), 'ru'), '18.11.2026 14:05')
  assert.equal(formatDateTime('мусор', 'en'), '—')
  assert.equal(formatDateTime(undefined, 'ru'), '—')
})

test('runFlags', () => {
  assert.deepEqual(runFlags({ stopped: true, paused: true }, 'ru'), ['остановлен', 'пауза'])
  assert.deepEqual(runFlags({ stopped: false, paused: true }, 'en'), ['paused'])
  assert.deepEqual(runFlags({ stopped: false, paused: false }, 'ru'), [])
})

test('подписи уровней, причин и «кто отбросил»', () => {
  assert.equal(levelLabel('material', 'ru'), '🔴 существенное')
  assert.equal(levelLabel('unverified', 'en'), '⚠ could not verify')
  assert.equal(reasonLabel('no_text', 'ru'), 'нет текста акта')
  assert.equal(reasonLabel('странный_код', 'en'), 'странный_код')
  assert.equal(discardedByLabel('screen', 'ru'), 'проверка по тексту')
  assert.equal(discardedByLabel('x', 'en'), 'x')
})

test('unconfirmedLabel', () => {
  assert.equal(unconfirmedLabel({ confirmed: true, disputedFields: [] }, 'ru'), '')
  assert.equal(unconfirmedLabel({ confirmed: false, disputedFields: ['date', 'number'] }, 'ru'), '⚠ не подтверждено: поля date, number')
  assert.equal(unconfirmedLabel({ confirmed: false, disputedFields: [] }, 'en'), '⚠ not confirmed')
})

test('isValidUrl', () => {
  assert.equal(isValidUrl('https://lex.uz/docs/1'), true)
  assert.equal(isValidUrl('  http://a.kz  '), true)
  assert.equal(isValidUrl('lex.uz/docs/1'), false)
  assert.equal(isValidUrl('ftp://a.kz'), false)
  assert.equal(isValidUrl('https://'), false)
  assert.equal(isValidUrl(''), false)
})

test('validateCaseForm', () => {
  assert.deepEqual(validateCaseForm('false_positive', '', 'не банковский', 'ru'), {})
  assert.ok(validateCaseForm('false_positive', '', '   ', 'ru').comment)
  assert.equal(validateCaseForm('false_positive', 'мусор', 'ок', 'ru').url, undefined)
  const e = validateCaseForm('missed', 'нет', '', 'en')
  assert.ok(e.url?.includes('http'))
  assert.ok(e.comment?.includes('comment'))
  assert.deepEqual(validateCaseForm('missed', 'https://x.org/a', 'важный', 'ru'), {})
})

test('groupFields: порядок и пустые группы', () => {
  const g = groupFields(
    [
      { field: 'a', status: 'ok', comment: '' },
      { field: 'b', status: 'mismatch', comment: 'дата другая' },
      { field: 'c', status: 'ok', comment: '' },
    ],
    'ru',
  )
  assert.deepEqual(g.map((x) => x.status), ['mismatch', 'ok'])
  assert.equal(g[1]!.fields.length, 2)
  assert.equal(g[0]!.label, 'Расхождения')
  assert.deepEqual(groupFields([], 'en'), [])
})
