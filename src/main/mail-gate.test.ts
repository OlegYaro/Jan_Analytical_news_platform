import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAIL_GATE_MESSAGE, evaluateGate, guardRun } from './mail-gate.ts'
import type { RunMode } from './mail-gate.ts'
import { defaultSettings } from './settings/defaults.ts'
import type { Settings } from '../shared/types.ts'

const EXACT = 'Без настроенной почты регулярная проверка не запустится. Настройте почту в Настройках → Почта.'
const BLOCKED_MODES: RunMode[] = ['scheduled', 'manual', 'backfill']

function withMail(mail: Partial<Settings['mail']>): Settings {
  const s = defaultSettings('/home/u')
  return { ...s, mail: { ...s.mail, ...mail } }
}

test('сообщение гейта дословно (CFG-14)', () => {
  assert.equal(MAIL_GATE_MESSAGE, EXACT)
})

test('новая установка без почты: запуск и расписание заблокированы (T-21)', () => {
  const gate = evaluateGate(defaultSettings('/home/u'), false)
  assert.equal(gate.canRun, false)
  assert.equal(gate.canDryRun, true)
  assert.equal(gate.message, EXACT)
  for (const mode of BLOCKED_MODES) {
    assert.deepEqual(guardRun(mode, gate), { allowed: false, message: EXACT }, mode)
  }
})

test('адрес и пароль есть, но тестового письма не было — заблокировано', () => {
  const gate = evaluateGate(withMail({ address: 'a@b.co', verified: false }), true)
  assert.equal(gate.canRun, false)
  assert.equal(guardRun('scheduled', gate).allowed, false)
})

test('проверено, но пароля нет — заблокировано', () => {
  const gate = evaluateGate(withMail({ address: 'a@b.co', verified: true }), false)
  assert.equal(gate.canRun, false)
  assert.equal(gate.message, EXACT)
  assert.equal(guardRun('manual', gate).allowed, false)
})

test('проверено, пароль есть, адрес пустой — заблокировано', () => {
  for (const address of ['', '   ']) {
    const gate = evaluateGate(withMail({ address, verified: true }), true)
    assert.equal(gate.canRun, false, JSON.stringify(address))
    assert.equal(guardRun('scheduled', gate).message, EXACT)
  }
})

test('проверено + пароль + адрес — всё разрешено', () => {
  const gate = evaluateGate(withMail({ address: 'a@b.co', verified: true }), true)
  assert.deepEqual(gate, { canRun: true, canDryRun: true, message: '' })
  for (const mode of [...BLOCKED_MODES, 'dry_run'] as RunMode[]) {
    assert.deepEqual(guardRun(mode, gate), { allowed: true, message: '' }, mode)
  }
})

test('пробный прогон без письма разрешён всегда', () => {
  for (const [mail, pw] of [[{}, false], [{ address: 'a@b.co' }, true], [{ verified: true }, false]] as const) {
    const gate = evaluateGate(withMail(mail), pw)
    assert.equal(gate.canDryRun, true)
    assert.deepEqual(guardRun('dry_run', gate), { allowed: true, message: '' })
  }
})

import { canCompleteOnboarding, ONBOARDING_MAIL_MESSAGE } from './mail-gate.ts'

test('мастер нельзя завершить без проверенной почты (CFG-14)', () => {
  assert.deepEqual(canCompleteOnboarding(withMail({}), false), { allowed: false, message: ONBOARDING_MAIL_MESSAGE })
  assert.equal(canCompleteOnboarding(withMail({ verified: true, address: 'a@b.co' }), false).allowed, false)
  assert.equal(canCompleteOnboarding(withMail({ verified: false, address: 'a@b.co' }), true).allowed, false)
  assert.equal(canCompleteOnboarding(withMail({ verified: true, address: 'a@b.co' }), true).allowed, true)
})
