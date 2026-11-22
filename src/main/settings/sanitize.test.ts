import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRendererPatch } from './sanitize.ts';
import { loadSettings, updateSettings } from './store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('mail.verified, onboardingDone и schemaVersion из окна отбрасываются', () => {
  const p = sanitizeRendererPatch({ topic: 'x', onboardingDone: true, schemaVersion: 99, mail: { verified: true, address: 'a@b.co' } });
  assert.deepEqual(p, { topic: 'x', mail: { address: 'a@b.co' } });
});

test('не-объекты дают пустой патч', () => {
  for (const v of [null, undefined, 5, 'x', [1]]) assert.deepEqual(sanitizeRendererPatch(v), {});
});

test('через очищенный патч гейт почты обойти нельзя', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-san-'));
  updateSettings(dir, sanitizeRendererPatch({ mail: { verified: true } }), { homeDir: '/Users/t' });
  assert.equal(loadSettings(dir, { homeDir: '/Users/t' }).mail.verified, false);
  updateSettings(dir, sanitizeRendererPatch({ onboardingDone: true }), { homeDir: '/Users/t' });
  assert.equal(loadSettings(dir, { homeDir: '/Users/t' }).onboardingDone, false);
});

test('у расписаний остаются только известные поля; список не меняет длину', () => {
  const p = sanitizeRendererPatch({
    schedules: [{ id: 'a', name: 'А', enabled: true, days: [1], time: '08:00', countries: [], nextRun: 'завтра', _key: 3 }, 7],
  });
  assert.deepEqual(p.schedules, [{ id: 'a', name: 'А', enabled: true, days: [1], time: '08:00', countries: [] }, 7]);
});
