// Защита от опасных рабочих папок: приложение пишет в неё и перезаписывает .claude/,
// поэтому домашняя папка, корень диска и служебные папки запрещены.
import { homedir } from 'node:os';
import type { UiLanguage } from '../../shared/types.ts';
import { mt } from '../i18n.ts';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function isInside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Возвращает сообщение об ошибке (по-русски) или null, если папка допустима. */
export function checkWorkspaceDir(dir: string, home: string = homedir(), systemDirs = true, L: UiLanguage = 'ru'): string | null {
  if (typeof dir !== 'string' || dir.trim() === '') return mt(L, 'Выберите папку для отчётов.', 'Choose a folder for reports.');
  if (!isAbsolute(dir)) return mt(L, 'Укажите полный путь к папке, например /Users/имя/RegWatch.', 'Enter the full path to the folder, for example /Users/name/RegWatch.');
  const d = resolve(dir);
  const h = resolve(home);
  const bad = mt(L, 'Эту папку нельзя использовать: приложение будет менять в ней служебные файлы. Выберите отдельную папку, например «RegWatch» в домашней папке.', 'This folder cannot be used: the app will modify service files in it. Choose a separate folder, for example "RegWatch" in your home folder.');
  if (d === sep) return bad;
  if (isInside(d, h)) return bad; // сама домашняя папка и все её родители
  if (isInside(join(h, '.claude'), d)) return bad; // настройки и скиллы Claude Code пользователя
  if (isInside(join(h, 'Library'), d) && d !== join(h, 'Library', 'Mobile Documents')) return bad;
  if (d.split(sep).some((p) => p.endsWith('.app'))) return bad; // внутри приложений
  if (!systemDirs) return null;
  for (const sys of ['/System', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/Applications', '/Library']) {
    if (isInside(sys, d)) return bad;
  }
  return null;
}
