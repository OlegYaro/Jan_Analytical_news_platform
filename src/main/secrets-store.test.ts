import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createSecretStore } from './secrets-store.ts';

const dirs: string[] = [];
function setup() {
  const d = mkdtempSync(join(tmpdir(), 'regwatch-sec-'));
  dirs.push(d);
  const file = join(d, 'secrets.json');
  const store = createSecretStore({
    file,
    encrypt: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
    decrypt: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
  });
  return { file, store };
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('set/has/get/delete', () => {
  const { store } = setup();
  assert.equal(store.has('mailPassword'), false);
  assert.equal(store.get('mailPassword'), null);
  store.set('mailPassword', 'p@ss-пароль');
  assert.equal(store.has('mailPassword'), true);
  assert.equal(store.get('mailPassword'), 'p@ss-пароль');
  store.delete('mailPassword');
  assert.equal(store.has('mailPassword'), false);
  store.delete('mailPassword');
});

test('в файле нет открытого значения, права 0600', () => {
  const { file, store } = setup();
  store.set('telegramToken', 'SECRET-TOKEN-123');
  store.set('telegramToken', 'SECRET-TOKEN-456');
  assert.ok(!readFileSync(file, 'utf8').includes('SECRET-TOKEN'));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(store.get('telegramToken'), 'SECRET-TOKEN-456');
});

test('битый файл не роняет', () => {
  const { file, store } = setup();
  writeFileSync(file, '{не json');
  assert.equal(store.has('mailPassword'), false);
  assert.equal(store.get('mailPassword'), null);
  store.set('mailPassword', 'x');
  assert.equal(store.get('mailPassword'), 'x');
});

test('не расшифровывается: get возвращает null', () => {
  const { file, store } = setup();
  writeFileSync(file, JSON.stringify({ mailPassword: 'AAAA' }));
  const bad = createSecretStore({ file, encrypt: () => Buffer.alloc(0), decrypt: () => { throw new Error('x'); } });
  assert.equal(bad.get('mailPassword'), null);
  assert.equal(bad.has('mailPassword'), true);
  assert.ok(store);
});
