import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DoctorCheck } from '../../../shared/doctor-types.ts';
import { canProceed, requiredChecksOk } from './logic.ts';

function chk(id: DoctorCheck['id'], ok: boolean): DoctorCheck {
  return { id, title: id, ok, detail: '', fix: '' };
}
const allOk = [chk('node', true), chk('claude-found', true), chk('claude-version', true), chk('claude-login', true), chk('claude-flags', true), chk('workspace-write', true)];

test('шаг 1: блок без результата и при ❌ в обязательных', () => {
  assert.equal(canProceed(1, { doctor: null, mailVerified: true }), false);
  assert.equal(canProceed(1, { doctor: allOk, mailVerified: false }), true);
  assert.equal(canProceed(1, { doctor: allOk.map((c) => (c.id === 'claude-login' ? { ...c, ok: false } : c)), mailVerified: true }), false);
  assert.equal(canProceed(1, { doctor: allOk.filter((c) => c.id !== 'node'), mailVerified: true }), false);
});

test('шаг 1: ❌ в необязательных не блокирует', () => {
  const soft = allOk.map((c) => (c.id === 'claude-version' || c.id === 'workspace-write' ? { ...c, ok: false } : c));
  assert.equal(requiredChecksOk(soft), true);
});

test('шаг 3: почта блокирует без verified', () => {
  assert.equal(canProceed(3, { doctor: allOk, mailVerified: false }), false);
  assert.equal(canProceed(3, { doctor: null, mailVerified: true }), true);
});

test('остальные шаги не блокируют', () => {
  for (const s of [2, 4, 5, 6, 7, 8]) assert.equal(canProceed(s, { doctor: null, mailVerified: false }), true);
});
