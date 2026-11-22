// Точка входа `npm run doctor` (node src/main/doctor-cli.ts).
// Параметры: --workspace <папка> (по умолчанию ~/RegWatch), --claude <путь к claude>.
// settings.json не читается: так проверка работает и до первого запуска приложения.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDoctor } from './doctor.ts';

function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const ws = argValue(argv, '--workspace');
  const claude = argValue(argv, '--claude');
  const workspaceDir = ws ? resolve(expandHome(ws)) : join(homedir(), 'RegWatch');

  console.log('Проверка окружения RegWatch… (проверка входа отправляет Claude короткий запрос)\n');
  const checks = await runDoctor({
    workspaceDir,
    configuredClaudePath: claude ? expandHome(claude) : null,
  });

  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.title} — ${c.detail}`);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    console.log('\nВсё в порядке.');
    return 0;
  }
  console.log('\nЧто делать:');
  for (const c of failed) {
    console.log(`• ${c.title}: ${c.fix}${c.link ? ` (${c.link})` : ''}`);
  }
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error('Проверка не завершилась из-за непредвиденной ошибки. Запустите её ещё раз.');
    process.exitCode = 1;
  },
);
