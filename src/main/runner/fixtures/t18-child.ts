// T-18 (RUN-06): дочерний процесс с настоящим оркестратором и заглушками этапов.
// Запуск: node src/main/runner/fixtures/t18-child.ts <рабочая папка> <папка маркеров>
// Каждый вызов этапа дописывает строку в файл-счётчик; analyze второго акта «зависает»,
// предварительно создав маркер `hang-<акт>` — по нему родитель убивает процесс SIGKILL.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Country } from '../../../shared/types.ts';
import { Orchestrator } from '../orchestrator.ts';
import type { StageExecutors } from '../orchestrator.ts';
import { OPEN_GATE, cand, confirmAll, country, makeCard, ok, settingsFor, triageAll } from './orchestrator-stubs.ts';

export const T18_COUNTRIES: Country[] = [country('UZ'), country('KZ')];
export const T18_CANDIDATES: Record<string, ReturnType<typeof cand>[]> = {
  UZ: [cand('a1'), cand('a2'), cand('a3')],
  KZ: [cand('k1')],
};

/** Сколько раз вызывался этап (по файлу-счётчику). */
export function callCount(markers: string, name: string): number {
  try {
    return readFileSync(join(markers, `calls-${name}.txt`), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function bump(markers: string, name: string): number {
  appendFileSync(join(markers, `calls-${name}.txt`), `${process.pid}\n`);
  return callCount(markers, name);
}

/** Заглушки со счётчиками в файлах (переживают убийство процесса). hangOn — акт, на котором «зависнуть». */
export function t18Executors(markers: string, hangOn?: string): StageExecutors {
  return {
    async collect(ctx) {
      bump(markers, `collect-${ctx.country.code}`);
      return { ok: true, output: { candidates: T18_CANDIDATES[ctx.country.code] ?? [] } };
    },
    async triage(ctx, cands) {
      bump(markers, `triage-${ctx.country.code}`);
      return ok('triage', triageAll(ctx.country.code, cands));
    },
    async analyze(ctx, c) {
      const n = bump(markers, `analyze-${c.id}`);
      writeFileSync(join(markers, `analyze-${c.id}-${n}`), '');
      if (c.id === hangOn && n === 1) {
        writeFileSync(join(markers, `hang-${c.id}`), String(process.pid));
        // «Зависание»: таймер держит процесс живым, ответ не придёт никогда.
        return new Promise(() => {
          setInterval(() => {}, 1000);
        });
      }
      return ok('analyze', makeCard(c.id, ctx.country.code), c.id);
    },
    async verify(ctx, cards) {
      bump(markers, `verify-${ctx.country.code}`);
      return ok('verify', confirmAll(ctx.country.code, cards));
    },
  };
}

// Точка входа дочернего процесса.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [ws, markers] = process.argv.slice(2);
  if (!ws || !markers) {
    process.stderr.write('нужны аргументы: <рабочая папка> <папка маркеров>\n');
    process.exit(2);
  }
  const orch = new Orchestrator({ executors: t18Executors(markers, 'a2') });
  await orch.start({ mode: 'manual', countries: T18_COUNTRIES, settings: settingsFor(ws), gate: OPEN_GATE });
  // Сюда процесс доходить не должен: родитель убивает его на зависшем акте.
  writeFileSync(join(markers, 'child-finished'), '');
}
