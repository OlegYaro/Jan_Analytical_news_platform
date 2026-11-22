import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkspaceDir } from './workspace-dir.ts';
import { validateSettings } from './validate.ts';

const home = '/Users/test';

test('допустимые папки', () => {
  assert.equal(checkWorkspaceDir('/Users/test/Documents/RegWatch', home), null);
  assert.equal(checkWorkspaceDir('/Volumes/Disk/RegWatch', home), null);
});

test('опасные папки отклоняются', () => {
  for (const d of [
    '/', '/Users', home, home + '/', '/Users/test/.claude', '/Users/test/.claude/skills',
    '/Users/test/Library/Application Support/RegWatch', '/Applications/RegWatch.app/Contents', '/System/x', '/usr/local/x', 'relative/path', '', '   ',
  ]) assert.notEqual(checkWorkspaceDir(d, home), null, d);
});

test('системные папки можно отключить (для временных папок тестов)', () => {
  assert.equal(checkWorkspaceDir('/var/folders/x/rw', home, false), null);
  assert.notEqual(checkWorkspaceDir(home, home, false), null);
});

test('validateSettings отклоняет домашнюю папку', () => {
  const r = validateSettings({ workspaceDir: process.env['HOME'] ?? '/Users/x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors['workspaceDir']);
});
