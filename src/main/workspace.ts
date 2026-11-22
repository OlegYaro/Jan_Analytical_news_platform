// Рабочая папка (архив прогонов): структура, скиллы, базовые запреты.
// Без electron: все пути приходят параметрами. Функция идемпотентна.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import type { UiLanguage } from '../shared/types.ts';
import { mt } from './i18n.ts';
import { checkWorkspaceDir } from './settings/workspace-dir.ts';

export interface WorkspaceOptions {
  /** Рабочая папка (CFG-11). */
  dir: string;
  /** Откуда копировать скиллы: каталог, внутри которого `<имя>/SKILL.md`. */
  skillsSrc: string;
  /** Откуда копировать эталоны (docs/golden в разработке, resources/golden в сборке). */
  goldenSrc: string;
  /** Язык текстов ошибок; по умолчанию русский. */
  lang?: UiLanguage;
}

export interface WorkspaceResult {
  /** Созданные при этом вызове файлы и папки (относительно dir). */
  created: string[];
  /** Имена скиллов, скопированных в рабочую папку. */
  skills: string[];
  /** sha256 набора скиллов (NFR-15). */
  skillsHash: string;
}

/** Запреты для случая, когда папку откроют в Claude Code вручную (PRM-09). */
export const BASE_DENY: readonly string[] = [
  'Bash',
  'Agent',
  'Task',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

export const README_TEXT = `Это рабочая папка RegWatch.

Здесь приложение хранит всё, что собрало:
  runs/    отчёты и дайджесты, разложенные по датам и странам
  state/   что уже отправлено (чтобы не присылать одно и то же дважды)
  golden/  эталонные примеры для контрольной проверки

Папка .claude/ служебная. Скиллы (инструкции для модели) копируются туда
из приложения и ПЕРЕЗАПИСЫВАЮТСЯ при каждом запуске, поэтому любые правки
там пропадут.

Ничего в этой папке править не нужно. Настройки меняются в окне приложения.
Отчёты можно свободно открывать и копировать.
`;

function fail(action: string, actionEn: string, dir: string, e: unknown, L: UiLanguage): never {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  let why: string;
  if (code === 'EACCES' || code === 'EPERM') why = mt(L, 'нет прав на запись', 'no write permission');
  else if (code === 'ENOENT') why = mt(L, 'нужный файл или папка не найдены', 'the required file or folder was not found');
  else if (code === 'ENOTDIR') why = mt(L, 'на месте папки лежит файл', 'there is a file where the folder should be');
  else if (code === 'ENOSPC') why = mt(L, 'на диске нет места', 'no space left on the disk');
  else if (code === 'EROFS') why = mt(L, 'диск только для чтения', 'the disk is read-only');
  else why = e instanceof Error ? e.message : String(e);
  throw new Error(
    mt(
      L,
      `Не удалось ${action} в рабочей папке «${dir}»: ${why}. ` + `Выберите другую папку в настройках или проверьте доступ к этой.`,
      `Could not ${actionEn} in the working folder "${dir}": ${why}. ` + `Choose another folder in the settings or check access to this one.`,
    ),
  );
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

/** Все файлы каталога рекурсивно: относительные пути (с `/`), отсортированные. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function listSkillNames(src: string, L: UiLanguage = 'ru'): string[] {
  if (!existsSync(src)) {
    throw new Error(
      mt(
        L,
        `Не найдена папка со скиллами «${src}». Приложение установлено не полностью.`,
        `The skills folder "${src}" was not found. The app is not fully installed.`,
      ),
    );
  }
  return readdirSync(src, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(src, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** sha256 по отсортированным путям и содержимому файлов скиллов. */
export function hashSkills(skillsSrc: string): string {
  const h = createHash('sha256');
  for (const name of listSkillNames(skillsSrc)) {
    const base = join(skillsSrc, name);
    for (const f of listFiles(base)) {
      h.update(`${name}/${f}\0`);
      h.update(readFileSync(join(base, f)));
      h.update('\0');
    }
  }
  return h.digest('hex');
}

function mkdirTracked(dir: string, root: string, created: string[]): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  created.push(relative(root, dir).split('\\').join('/'));
}

function mergeSettings(file: string, created: string[], root: string): void {
  let current: Record<string, unknown> = {};
  let existed = false;
  if (existsSync(file)) {
    existed = true;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      } else {
        throw new Error('не объект');
      }
    } catch {
      // Битый файл не теряем, а откладываем рядом.
      renameSync(file, `${file}.bak`);
      current = {};
    }
  }
  const perms =
    current['permissions'] && typeof current['permissions'] === 'object' && !Array.isArray(current['permissions'])
      ? (current['permissions'] as Record<string, unknown>)
      : {};
  const oldDeny = Array.isArray(perms['deny']) ? (perms['deny'] as unknown[]) : [];
  const deny = [...new Set([...oldDeny, ...BASE_DENY])];
  const next = { ...current, permissions: { ...perms, deny } };
  const text = JSON.stringify(next, null, 2) + '\n';
  if (!existed || readFileSync(file, 'utf8') !== text) writeAtomic(file, text);
  if (!existed) created.push(relative(root, file));
}

/** Маркер каталога скилла, созданного приложением (чужие скиллы не удаляются). */
export const MANAGED_MARKER = '.regwatch-managed';

export function ensureWorkspace(opts: WorkspaceOptions, home?: string): WorkspaceResult {
  // Страховка: опасные папки (домашняя, ~/.claude, корень и т.п.) не трогаем даже в обход проверки настроек.
  const unsafe = checkWorkspaceDir(opts.dir, home, false, opts.lang ?? 'ru');
  if (unsafe) throw new Error(unsafe);
  const { dir, skillsSrc, goldenSrc } = opts;
  const created: string[] = [];
  const L: UiLanguage = opts.lang ?? 'ru';
  const skillNames = listSkillNames(skillsSrc, L);
  const skillsHash = hashSkills(skillsSrc);

  try {
    mkdirTracked(dir, dir, created);
    if (!statSync(dir).isDirectory()) {
      throw Object.assign(new Error('not a dir'), { code: 'ENOTDIR' });
    }
    for (const sub of ['runs', join('state', 'ledger'), 'golden']) {
      mkdirTracked(join(dir, sub), dir, created);
    }
  } catch (e) {
    fail('создать структуру', 'create the structure', dir, e, L);
  }

  try {
    // Эталоны: только недостающие, существующие (в т.ч. добавленные пользователем) не трогаем.
    if (existsSync(goldenSrc)) {
      for (const f of listFiles(goldenSrc)) {
        const to = join(dir, 'golden', f);
        if (existsSync(to)) continue;
        mkdirSync(join(to, '..'), { recursive: true });
        copyFileSync(join(goldenSrc, f), to);
        created.push(`golden/${f}`);
      }
    }
  } catch (e) {
    fail('скопировать эталоны', 'copy the reference files', dir, e, L);
  }

  try {
    // Скиллы: перезапись при каждом старте (SKL-05), лишние удаляем.
    const skillsDst = join(dir, '.claude', 'skills');
    mkdirTracked(skillsDst, dir, created);
    // Удаляем только то, что создало приложение (есть маркер); чужие каталоги не трогаем.
    for (const e of readdirSync(skillsDst, { withFileTypes: true })) {
      if (!skillNames.includes(e.name) && existsSync(join(skillsDst, e.name, MANAGED_MARKER))) {
        rmSync(join(skillsDst, e.name), { recursive: true, force: true });
      }
    }
    for (const name of skillNames) {
      const from = join(skillsSrc, name);
      const to = join(skillsDst, name);
      const isNew = !existsSync(to);
      // Каталог скилла заменяем целиком, чтобы убрать устаревшие файлы внутри.
      rmSync(to, { recursive: true, force: true });
      for (const f of listFiles(from)) {
        mkdirSync(join(to, f, '..'), { recursive: true });
        copyFileSync(join(from, f), join(to, f));
      }
      writeFileSync(join(to, MANAGED_MARKER), 'Управляется RegWatch: файлы перезаписываются при запуске.\n');
      if (isNew) created.push(`.claude/skills/${name}`);
    }

    mergeSettings(join(dir, '.claude', 'settings.json'), created, dir);

    const readme = join(dir, 'README.txt');
    const had = existsSync(readme);
    if (!had || readFileSync(readme, 'utf8') !== README_TEXT) writeAtomic(readme, README_TEXT);
    if (!had) created.push('README.txt');
  } catch (e) {
    fail('записать служебные файлы', 'write service files', dir, e, L);
  }

  return { created, skills: skillNames, skillsHash };
}
