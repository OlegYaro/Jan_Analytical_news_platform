import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BASE_DENY, ensureWorkspace } from './workspace.ts';

const repo = join(import.meta.dirname, '..', '..');
const skillsSrc = join(repo, 'skills');
const goldenSrc = join(repo, 'docs', 'golden');
const SKILLS = ['analyze-act', 'discover-sources', 'news-sweep', 'screen-act', 'translate-ru', 'triage', 'verify-report', 'verify-sources'];

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'regwatch-ws-'));
  tmps.push(d);
  return d;
}
after(() => {
  for (const d of tmps) {
    try {
      chmodSync(d, 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});
const opts = (dir: string) => ({ dir, skillsSrc, goldenSrc });

test('создаёт структуру', () => {
  const dir = join(tmp(), 'RegWatch');
  const r = ensureWorkspace(opts(dir));
  for (const p of ['runs', 'state/ledger', 'golden/UZ-3254-2.md', 'README.txt', '.claude/settings.json']) {
    assert.ok(existsSync(join(dir, p)), p);
  }
  assert.deepEqual(r.skills, SKILLS);
  for (const s of SKILLS) assert.ok(existsSync(join(dir, '.claude/skills', s, 'SKILL.md')), s);
  assert.match(readFileSync(join(dir, 'README.txt'), 'utf8'), /перезаписываются/i);
  assert.match(r.skillsHash, /^[0-9a-f]{64}$/);
  assert.ok(r.created.includes('runs'));
});

test('идемпотентность: второй вызов ничего не создаёт, хеш тот же', () => {
  const dir = tmp();
  const a = ensureWorkspace(opts(dir));
  const b = ensureWorkspace(opts(dir));
  assert.deepEqual(b.created, []);
  assert.equal(a.skillsHash, b.skillsHash);
});

test('изменённый скилл перезаписывается', () => {
  const dir = tmp();
  ensureWorkspace(opts(dir));
  const f = join(dir, '.claude/skills/triage/SKILL.md');
  const orig = readFileSync(f, 'utf8');
  writeFileSync(f, 'испорчено');
  ensureWorkspace(opts(dir));
  assert.equal(readFileSync(f, 'utf8'), orig);
});

test('устаревший скилл приложения (с маркером) удаляется', () => {
  const dir = tmp();
  ensureWorkspace(opts(dir));
  mkdirSync(join(dir, '.claude/skills/old'), { recursive: true });
  writeFileSync(join(dir, '.claude/skills/old/SKILL.md'), 'x');
  writeFileSync(join(dir, '.claude/skills/old/.regwatch-managed'), '');
  ensureWorkspace(opts(dir));
  assert.deepEqual(readdirSync(join(dir, '.claude/skills')).sort(), SKILLS);
});

test('golden не перезаписывается, чужие файлы остаются', () => {
  const dir = tmp();
  ensureWorkspace(opts(dir));
  writeFileSync(join(dir, 'golden/UZ-3254-2.md'), 'моя версия');
  writeFileSync(join(dir, 'golden/mine.md'), 'добавлено');
  ensureWorkspace(opts(dir));
  assert.equal(readFileSync(join(dir, 'golden/UZ-3254-2.md'), 'utf8'), 'моя версия');
  assert.equal(readFileSync(join(dir, 'golden/mine.md'), 'utf8'), 'добавлено');
});

test('settings.json: deny объединяется, чужие ключи сохраняются', () => {
  const dir = tmp();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    join(dir, '.claude/settings.json'),
    JSON.stringify({ model: 'x', permissions: { allow: ['Read'], deny: ['WebFetch', 'Bash'] } }),
  );
  ensureWorkspace(opts(dir));
  ensureWorkspace(opts(dir));
  const s = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
  assert.equal(s.model, 'x');
  assert.deepEqual(s.permissions.allow, ['Read']);
  assert.deepEqual(s.permissions.deny, ['WebFetch', ...BASE_DENY]);
});

test('settings.json: новый файл содержит базовые запреты', () => {
  const dir = tmp();
  ensureWorkspace(opts(dir));
  const s = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.deny, [...BASE_DENY]);
});

test('хеш меняется при изменении скилла в источнике', () => {
  const src = tmp();
  for (const s of SKILLS) {
    mkdirSync(join(src, s));
    writeFileSync(join(src, s, 'SKILL.md'), s);
  }
  const o = { dir: tmp(), skillsSrc: src, goldenSrc };
  const a = ensureWorkspace(o).skillsHash;
  writeFileSync(join(src, 'triage', 'SKILL.md'), 'другое');
  assert.notEqual(ensureWorkspace(o).skillsHash, a);
});

test('недоступная папка: понятная русская ошибка', () => {
  const base = tmp();
  const file = join(base, 'file');
  writeFileSync(file, 'x');
  assert.throws(() => ensureWorkspace(opts(join(file, 'sub'))), /Не удалось .*рабочей папке/);
  if (process.getuid?.() !== 0) {
    const ro = join(base, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    assert.throws(() => ensureWorkspace(opts(join(ro, 'ws'))), /нет прав на запись/);
  }
});

test('чужие каталоги скиллов не удаляются, свои устаревшие — удаляются', () => {
  const dir = tmp();
  ensureWorkspace(opts(dir));
  const skills = join(dir, '.claude/skills');
  mkdirSync(join(skills, 'my-personal'));
  writeFileSync(join(skills, 'my-personal', 'SKILL.md'), 'личный');
  // устаревший скилл приложения (с маркером)
  mkdirSync(join(skills, 'old-app-skill'));
  writeFileSync(join(skills, 'old-app-skill', '.regwatch-managed'), '');
  ensureWorkspace(opts(dir));
  assert.ok(existsSync(join(skills, 'my-personal', 'SKILL.md')));
  assert.ok(!existsSync(join(skills, 'old-app-skill')));
});

test('домашняя папка и ~/.claude как рабочая папка отклоняются, ничего не удаляется', () => {
  const home = tmp();
  mkdirSync(join(home, '.claude/skills/personal'), { recursive: true });
  writeFileSync(join(home, '.claude/skills/personal/SKILL.md'), 'личный');
  assert.throws(() => ensureWorkspace(opts(home), home), /нельзя использовать/);
  assert.throws(() => ensureWorkspace(opts(join(home, '.claude')), home), /нельзя использовать/);
  assert.ok(existsSync(join(home, '.claude/skills/personal/SKILL.md')));
});
