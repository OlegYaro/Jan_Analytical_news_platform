// Один процесс модели для проверки/поиска источников (srcCheck/srcDiscover): input.json → claude -p → ответ по схеме.
// Права и аргументы — общие (stage-profiles.ts, docs/02 §6–7). Без electron.
import { writeJsonAtomic } from '../fs-atomic.ts';
import { createValidator, schemaForCli } from '../schemas.ts';
import type { SchemaName } from '../schemas.ts';
import { runStage as realRunStage } from '../runner/claude-runner.ts';
import type { RateLimitInfo, RunStageOptions, StageResult, ValidateFn } from '../runner/claude-runner.ts';
import { buildStageInvocation } from '../runner/stage-profiles.ts';
import { NO_CLAUDE_MESSAGE } from '../runner/executors.ts';
import type { Settings } from '../../shared/types.ts';

type MaybePromise<T> = T | Promise<T>;

export interface ModelDeps {
  schemasDir: string;
  /** Путь к claude или null — не найден. */
  claudeBin: () => MaybePromise<string | null>;
  claudeEnv: () => MaybePromise<Record<string, string | undefined> | NodeJS.ProcessEnv>;
  /** Подмена запуска процесса (тесты); по умолчанию runStage из claude-runner. */
  runStage?: (opts: RunStageOptions) => Promise<StageResult>;
  /** Перед каждым процессом модели (фаза 8: пауза по доле 5-часового лимита). */
  budget?: { beforeProcess(): Promise<void> };
}

export interface ModelCallInput {
  stage: 'srcCheck' | 'srcDiscover';
  schema: SchemaName;
  settings: Pick<Settings, 'preset' | 'advanced'>;
  /** cwd процесса (реальный путь): папка проверки страны. */
  cwd: string;
  inputPath: string;
  input: unknown;
  /** Домены WebFetch (только srcCheck: домены проверяемых источников). */
  domains?: string[];
  transcriptPath?: string;
}

export type ModelCallResult<T> =
  | { ok: true; output: T; costUsd: number; numTurns: number | null; durationMs: number; model: string; rateLimit?: RateLimitInfo; denied: string[] }
  | { ok: false; failure: string; message: string; resetsAt?: string; costUsd: number; durationMs: number; model: string; rateLimit?: RateLimitInfo; denied: string[] };

const validators = new Map<string, ValidateFn>();
const cliSchemas = new Map<string, string>();

function validator(name: SchemaName, dir: string): ValidateFn {
  const k = `${dir}::${name}`;
  let v = validators.get(k);
  if (!v) {
    v = createValidator(name, dir);
    validators.set(k, v);
  }
  return v;
}

function cliSchema(name: SchemaName, dir: string): string {
  const k = `${dir}::${name}`;
  let s = cliSchemas.get(k);
  if (s === undefined) {
    s = schemaForCli(name, dir);
    cliSchemas.set(k, s);
  }
  return s;
}

export async function callModel<T>(deps: ModelDeps, c: ModelCallInput): Promise<ModelCallResult<T>> {
  const bin = await deps.claudeBin();
  const inv = buildStageInvocation({
    stage: c.stage,
    settings: c.settings,
    countryDir: c.cwd,
    inputPath: c.inputPath,
    ...(c.domains ? { allowedDomains: c.domains } : {}),
    schemaJson: cliSchema(c.schema, deps.schemasDir),
  });
  if (!bin) return { ok: false, failure: 'spawn', message: NO_CLAUDE_MESSAGE, costUsd: 0, durationMs: 0, model: inv.model, denied: [] };
  writeJsonAtomic(c.inputPath, c.input);
  if (deps.budget) await deps.budget.beforeProcess();
  const env = (await deps.claudeEnv()) as Record<string, string | undefined>;
  const run = deps.runStage ?? realRunStage;
  const res = await run({
    invocation: inv,
    bin,
    env,
    validate: validator(c.schema, deps.schemasDir),
    ...(c.transcriptPath ? { transcriptPath: c.transcriptPath } : {}),
  });
  const denied = res.denied.map((d) => d.tool);
  const extra = res.rateLimit ? { rateLimit: res.rateLimit } : {};
  if (res.ok) {
    return { ok: true, output: res.output as T, costUsd: res.costUsd ?? 0, numTurns: res.numTurns ?? null, durationMs: res.durationMs, model: inv.model, denied, ...extra };
  }
  return {
    ok: false,
    failure: res.failure,
    message: res.message,
    ...(res.resetsAt ? { resetsAt: res.resetsAt } : {}),
    costUsd: res.costUsd ?? 0,
    durationMs: res.durationMs,
    model: inv.model,
    denied,
    ...extra,
  };
}
