// Проверка: не запущен ли скрипт изнутри самого RegWatch (иначе сборка/установка
// завершит и перезапишет приложение, внутри которого работает).
import { spawnSync } from 'node:child_process';

const MAX_DEPTH = 20;
const APP_BUNDLE = /\/RegWatch\.app\/Contents\//;

/** Родитель процесса через ps: { ppid, comm } или null. */
export function psGetParent(pid) {
  const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const m = r.stdout.trim().match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  return { ppid: Number(m[1]), comm: m[2] };
}

/**
 * true, если процесс запущен изнутри RegWatch: под Electron (ELECTRON_RUN_AS_NODE /
 * versions.electron) или среди предков (до 20 уровней) есть исполняемый файл из RegWatch.app.
 */
export function detectInsideRegWatch({
  env = process.env,
  versions = process.versions,
  getParent = psGetParent,
  pid = process.pid,
} = {}) {
  if (env.ELECTRON_RUN_AS_NODE !== undefined || versions.electron) return true;
  const seen = new Set();
  let cur = pid;
  for (let i = 0; i < MAX_DEPTH && cur > 1 && !seen.has(cur); i++) {
    seen.add(cur);
    let info;
    try {
      info = getParent(cur);
    } catch {
      return false;
    }
    if (!info) return false;
    if (APP_BUNDLE.test(info.comm)) return true;
    cur = info.ppid;
  }
  return false;
}
