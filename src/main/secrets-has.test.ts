import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSecretStore } from './secrets-store.ts';

test('has не вызывает шифрование (работает и без доступного safeStorage)', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rw-sec-')), 'secrets.json');
  writeFileSync(file, JSON.stringify({ mailPassword: 'AAAA' }));
  const boom = () => { throw new Error('шифрование недоступно'); };
  const st = createSecretStore({ file, encrypt: boom, decrypt: boom });
  assert.equal(st.has('mailPassword'), true);
  assert.equal(st.has('telegramToken'), false);
});
