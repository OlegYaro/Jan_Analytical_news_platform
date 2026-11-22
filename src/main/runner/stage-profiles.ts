// Профили этапов: скилл, схема, права, модель, таймаут, --max-turns (docs/02 §6, §7).
// Без импорта electron. Собирает аргументы `claude -p` для одного этапа; запускает их claude-runner.ts.
//
// Что проверено реальными вызовами (docs/FINDINGS.md «Фаза 0», «Фаза 3: правила Read»):
// - `--restricted` выключает проектные скиллы → вместо него `--setting-sources project`
//   + `--strict-mcp-config` + явный `--tools` + `--allowedTools` + `--disallowedTools` + dontAsk.
// - `--tools` принимает одно значение через запятую (так и передаём).
// - `--tools` и `--allowedTools` вариадические: промпт обязан стоять сразу после `-p`,
//   иначе CLI примет его за ещё одно правило.
// - Абсолютный путь в правиле Read пишется с двумя косыми: `Read(//Users/x/**)`.
//   `Read(/Users/x/**)` (одна косая) НЕ срабатывает — это путь от корня проекта.
// - Разрешающие правила НЕ ограничивают чтение внутри cwd: всё внутри cwd читается и без них.
//   Поэтому изоляция страны — это cwd = папка страны (`cwd` в результате), а правила Read лишь
//   явно перечисляют то, что нужно (папка страны и input, если он вне её).
//   Проектные скиллы при этом находятся: CLI ищет `.claude/skills` вверх от cwd.

import { isAbsolute, relative, resolve } from 'node:path';
import type { Settings, StageKey } from '../../shared/types.ts';
import { modelForStage, timeoutForStage } from '../settings/presets.ts';

/** Скилл каждого этапа (`skills/<имя>/SKILL.md`). */
export const STAGE_SKILL: Readonly<Record<StageKey, string>> = {
  news: 'news-sweep',
  triage: 'triage',
  screen: 'screen-act',
  confirm: 'screen-act',
  analyze: 'analyze-act',
  verify: 'verify-report',
  translate: 'translate-ru',
  srcCheck: 'verify-sources',
  srcDiscover: 'discover-sources',
};

/** Схема ответа каждого этапа (`schemas/<имя>.json`). */
export const STAGE_SCHEMA: Readonly<Record<StageKey, string>> = {
  news: 'news-sweep',
  triage: 'triage',
  screen: 'screen',
  confirm: 'screen',
  analyze: 'card',
  verify: 'verification',
  translate: 'translation',
  srcCheck: 'verify-sources',
  srcDiscover: 'discover-sources',
};

/** `--max-turns` по таблице docs/02 §6 (без запаса на structured output). */
export const STAGE_MAX_TURNS: Readonly<Record<StageKey, number>> = {
  news: 15,
  triage: 10,
  screen: 10,
  confirm: 10,
  analyze: 30,
  verify: 30,
  translate: 8,
  srcCheck: 30,
  srcDiscover: 30,
};

/** Запас ходов: ответ по `--json-schema` занимает ещё 1–2 хода (служебный StructuredOutput). */
export const STRUCTURED_OUTPUT_TURNS = 2;

/** Запрещено на всех этапах (docs/02 §6, PRM-05/06). */
export const DISALLOWED_TOOLS = ['Bash', 'Agent', 'Task', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/** Встроенные инструменты этапа (`--tools`). */
export const STAGE_TOOLS: Readonly<Record<StageKey, readonly string[]>> = {
  news: ['Read', 'WebSearch', 'WebFetch'],
  triage: ['Read'],
  screen: ['Read'],
  confirm: ['Read'],
  analyze: ['Read', 'WebFetch'],
  verify: ['Read', 'WebFetch'],
  translate: ['Read'],
  srcCheck: ['Read', 'WebFetch', 'WebSearch'],
  // В таблице docs/02 §6 Read нет, но скилл получает вход файлом input.json → Read нужен.
  // Отклонение записано в FINDINGS «Фаза 3»; чтение ограничено cwd (папка этапа) и input.
  srcDiscover: ['Read', 'WebSearch', 'WebFetch'],
};

/** Как этап получает WebFetch: свободно, только по доменам, или никак. */
const WEBFETCH_MODE: Readonly<Record<StageKey, 'free' | 'domains' | 'none'>> = {
  news: 'free',
  triage: 'none',
  screen: 'none',
  confirm: 'none',
  analyze: 'domains',
  verify: 'domains',
  translate: 'none',
  srcCheck: 'domains',
  srcDiscover: 'free',
};

const WEBSEARCH: Readonly<Record<StageKey, boolean>> = {
  news: true,
  triage: false,
  screen: false,
  confirm: false,
  analyze: false,
  verify: false,
  translate: false,
  srcCheck: true,
  srcDiscover: true,
};

/** Готовый вызов одного этапа. */
export interface StageInvocation {
  stage: StageKey;
  skill: string;
  /** Имя схемы ответа (`schemas/<имя>.json`). */
  schema: string;
  /** Промпт `-p` (без хвоста повтора). Всегда лежит в `args[1]`. */
  prompt: string;
  /** Аргументы `claude` (без самого бинаря). `args[0] === '-p'`, `args[1] === prompt`. */
  args: string[];
  /** Алиас модели (`haiku`/`sonnet`/`opus`) или значение из «Дополнительно». */
  model: string;
  timeoutMs: number;
  /** Уже с запасом STRUCTURED_OUTPUT_TURNS. */
  maxTurns: number;
  /** Рабочая папка процесса = папка страны/этапа (изоляция чтения, см. шапку файла). */
  cwd: string;
  /** Правила `--allowedTools` (для лога и тестов). */
  allowedTools: string[];
  /** Домены, реально попавшие в `WebFetch(domain:…)`. */
  domains: string[];
}

export interface BuildStageInput {
  stage: StageKey;
  settings: Pick<Settings, 'preset' | 'advanced'>;
  /** Абсолютный путь к папке страны (или к папке акта/этапа): станет cwd. */
  countryDir: string;
  /** Абсолютный путь к input.json. */
  inputPath: string;
  /** Домены источников страны со статусом ✅ (PRM-04). Нужны для analyze/verify/srcCheck. */
  allowedDomains?: readonly string[];
  /** Текст JSON-схемы ответа. */
  schemaJson: string;
  /** Писать транскрипт сессии; по умолчанию — настройка «Сохранять транскрипты». */
  transcripts?: boolean;
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/**
 * Приводит домен к виду для `WebFetch(domain:…)`: из URL берётся имя хоста, нижний регистр,
 * без точки в конце. Всё, что не похоже на имя хоста (скобки, запятые, пробелы, `*`), отбрасывается:
 * такой текст мог бы сломать правило или расширить права. Возвращает null для негодного.
 */
export function normalizeDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('://')) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/\.$/, '');
  return DOMAIN_RE.test(s) ? s : null;
}

/** Правило Read для абсолютного пути: `Read(//abs/path)` (двойная косая = абсолютный путь). */
export function readRule(absPath: string, recursive: boolean): string {
  const p = resolve(absPath);
  return `Read(/${p}${recursive ? '/**' : ''})`;
}

function isInside(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Собирает аргументы `claude -p` для этапа (docs/02 §6–7, FINDINGS «Фаза 0» и «Фаза 3»). */
export function buildStageInvocation(input: BuildStageInput): StageInvocation {
  const { stage, settings, schemaJson } = input;
  if (!isAbsolute(input.countryDir)) throw new Error(`countryDir должен быть абсолютным: ${input.countryDir}`);
  if (!isAbsolute(input.inputPath)) throw new Error(`inputPath должен быть абсолютным: ${input.inputPath}`);
  const countryDir = resolve(input.countryDir);
  const inputPath = resolve(input.inputPath);

  const skill = STAGE_SKILL[stage];
  const model = modelForStage(settings.preset, stage, settings.advanced?.stageModels);
  const timeoutMs = timeoutForStage(stage, settings.advanced?.timeoutsMin) * 60_000;
  const maxTurns = STAGE_MAX_TURNS[stage] + STRUCTURED_OUTPUT_TURNS;
  const transcripts = input.transcripts ?? settings.advanced?.saveTranscripts ?? false;

  const domains: string[] = [];
  for (const d of input.allowedDomains ?? []) {
    const n = normalizeDomain(d);
    if (n && !domains.includes(n)) domains.push(n);
  }

  const tools: string[] = [];
  const allowed: string[] = [];

  if (STAGE_TOOLS[stage].includes('Read')) {
    tools.push('Read');
    allowed.push(readRule(countryDir, true));
    if (!isInside(countryDir, inputPath)) allowed.push(readRule(inputPath, false));
  }

  const webfetch = WEBFETCH_MODE[stage];
  if (webfetch === 'free') {
    tools.push('WebFetch');
    allowed.push('WebFetch');
  } else if (webfetch === 'domains' && domains.length > 0) {
    // Пустой список доменов → WebFetch не выдаём вовсе (PRM-04): ни инструмента, ни правила.
    tools.push('WebFetch');
    for (const d of domains) allowed.push(`WebFetch(domain:${d})`);
  }

  if (WEBSEARCH[stage]) {
    tools.push('WebSearch');
    allowed.push('WebSearch');
  }

  const prompt = `/${skill} ${inputPath}`;
  const args: string[] = [
    // Промпт — сразу после -p: дальше идут вариадические флаги.
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--max-turns',
    String(maxTurns),
    '--json-schema',
    schemaJson,
  ];
  if (!transcripts) args.push('--no-session-persistence');
  args.push('--disallowedTools', DISALLOWED_TOOLS.join(','));
  // Пустой список → `--tools ""` (никаких встроенных инструментов).
  args.push('--tools', tools.join(','));
  // Каждое правило — отдельный элемент (ловушка №3: через запятую правила со скобками ломаются).
  if (allowed.length > 0) args.push('--allowedTools', ...allowed);

  return {
    stage,
    skill,
    schema: STAGE_SCHEMA[stage],
    prompt,
    args,
    model,
    timeoutMs,
    maxTurns,
    cwd: countryDir,
    allowedTools: allowed,
    domains,
  };
}

/** Копия вызова с хвостом к промпту (повтор после ошибки схемы). */
export function withPromptSuffix(inv: StageInvocation, suffix: string): StageInvocation {
  const args = [...inv.args];
  args[1] = inv.prompt + suffix;
  return { ...inv, args };
}
