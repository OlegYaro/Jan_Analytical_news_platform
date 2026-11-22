#!/usr/bin/env node
// Сборка, ad-hoc подпись и установка RegWatch.app.
// Флаги: --no-launch (без запуска), --build-only (только сборка и подпись в dist/).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectInsideRegWatch } from './inside-check.mjs';

// Изнутри RegWatch нельзя: скрипт завершил бы и перезаписал приложение, в котором работает.
if (detectInsideRegWatch()) {
  console.error(
    '\nОшибка: Эта команда запущена изнутри RegWatch.\n' +
      'Что делать: Закройте RegWatch (значок в строке меню → Выйти) и запустите npm run app из обычного Терминала.',
  );
  process.exit(1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const buildOnly = args.has('--build-only');
const noLaunch = args.has('--no-launch');
const APP_NAME = 'RegWatch';

class StepError extends Error {
  constructor(what, todo) {
    super(what);
    this.todo = todo;
  }
}

function log(msg) {
  console.log(`[RegWatch] ${msg}`);
}

function run(cmd, cmdArgs, { env = {}, quiet = false, step = cmd, todo = 'Посмотрите вывод выше и повторите.' } = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: quiet ? 'pipe' : 'inherit',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (r.error) {
    throw new StepError(`Не удалось запустить «${step}»: ${r.error.message}.`, todo);
  }
  if (r.status !== 0) {
    const tail = quiet ? `\n${(r.stderr || r.stdout || '').trim()}` : '';
    throw new StepError(`Шаг «${step}» завершился с кодом ${r.status}.${tail}`, todo);
  }
  return r;
}

function localBin(name) {
  const p = join(ROOT, 'node_modules', '.bin', name);
  if (!existsSync(p)) {
    throw new StepError(
      `Не найден ${name} в node_modules.`,
      'Выполните «npm install» в папке проекта и повторите.',
    );
  }
  return p;
}

function isRunning() {
  const r = spawnSync('pgrep', ['-x', APP_NAME], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function quitRunning() {
  if (!isRunning()) return;
  log('RegWatch сейчас запущен — завершаю перед заменой…');
  spawnSync('osascript', ['-e', `quit app "${APP_NAME}"`], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (!isRunning()) return;
  }
  throw new StepError(
    'RegWatch не завершился за 10 секунд.',
    'Закройте RegWatch вручную (Cmd+Q) и запустите «npm run app» снова.',
  );
}

function build() {
  if (process.platform !== 'darwin') {
    throw new StepError('Сборка поддерживается только на macOS.', 'Запустите скрипт на Mac.');
  }
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!arch) {
    throw new StepError(`Неподдерживаемая архитектура: ${process.arch}.`, 'Нужен Mac на arm64 или x64.');
  }
  log('Сборка исходников (electron-vite build)…');
  run(localBin('electron-vite'), ['build'], {
    step: 'electron-vite build',
    todo: 'Исправьте ошибки сборки выше (проверьте «npm run typecheck») и повторите.',
  });

  log(`Упаковка приложения (electron-builder, ${arch})…`);
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
  run(localBin('electron-builder'), ['--dir', '--mac', `--${arch}`], {
    env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    step: 'electron-builder',
    todo: 'Проверьте вывод выше; при проблемах с сетью (загрузка Electron) повторите позже.',
  });

  const dist = join(ROOT, 'dist');
  const dirs = existsSync(dist)
    ? readdirSync(dist).filter((d) => d.startsWith('mac') && existsSync(join(dist, d, `${APP_NAME}.app`)))
    : [];
  if (dirs.length === 0) {
    throw new StepError(
      `После сборки не найден dist/mac*/${APP_NAME}.app.`,
      'Посмотрите вывод electron-builder выше и проверьте electron-builder.yml.',
    );
  }
  // Предпочесть каталог текущей архитектуры (mac-arm64), иначе первый найденный.
  const pick = dirs.find((d) => d.includes(arch)) ?? dirs.sort()[0];
  const app = join(dist, pick, `${APP_NAME}.app`);

  log('Ad-hoc подпись (codesign)…');
  run('codesign', ['--force', '--deep', '-s', '-', app], {
    step: 'codesign',
    todo: 'Установите Command Line Tools: «xcode-select --install», и повторите.',
  });
  run('xattr', ['-cr', app], { step: 'xattr', todo: 'Повторите запуск; проверьте права на папку dist/.' });
  return app;
}

function copyTo(dir, app) {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${APP_NAME}.app`);
  rmSync(target, { recursive: true, force: true });
  const r = spawnSync('ditto', [app, target], { encoding: 'utf8' });
  if (r.status !== 0) {
    const e = new Error((r.stderr || 'ditto failed').trim());
    e.code = /permission denied|not permitted/i.test(r.stderr || '') ? 'EACCES' : 'EFAIL';
    throw e;
  }
  return target;
}

function install(app) {
  let target;
  let note = '';
  try {
    target = copyTo('/Applications', app);
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') {
      throw new StepError(
        `Не удалось скопировать приложение в /Applications: ${e.message}`,
        'Проверьте свободное место и права, затем повторите.',
      );
    }
    log('Нет прав на /Applications — установлено в ~/Applications');
    try {
      target = copyTo(join(homedir(), 'Applications'), app);
    } catch (e2) {
      throw new StepError(
        `Не удалось установить и в ~/Applications: ${e2.message}`,
        'Скопируйте dist/mac*/RegWatch.app вручную в любую папку.',
      );
    }
    note = ' (нет прав на /Applications)';
  }
  return { target, note };
}

async function main() {
  const app = build();
  if (buildOnly) {
    log(`Готово (только сборка): ${app}`);
    return;
  }
  await quitRunning();
  const { target, note } = install(app);
  log(`Установлено: ${target}${note}. Настройки и архив не затронуты.`);
  if (!noLaunch) {
    run('open', [target], { step: 'open', todo: `Откройте ${target} вручную из Finder.` });
    log('Запущено.');
  }
  console.log(
    '\nЕсли macOS пишет «не удаётся проверить разработчика»: Системные настройки → ' +
      'Конфиденциальность и безопасность → «Всё равно открыть».',
  );
}

main().catch((e) => {
  if (e instanceof StepError) {
    console.error(`\nОшибка: ${e.message}\nЧто делать: ${e.todo}`);
  } else {
    console.error(`\nОшибка: непредвиденный сбой — ${e?.message ?? e}\nЧто делать: повторите запуск; если повторяется — сообщите разработчику.`);
  }
  process.exit(1);
});
