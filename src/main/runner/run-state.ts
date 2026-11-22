// Состояние прогона (runs/<id>/run.json): создание, атомарная запись, возобновление (RUN-06).
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActRun,
  CountryRun,
  CountryStatus,
  CurrentActivity,
  ISODate,
  RunMode,
  RunState,
  StageName,
  StageState,
  Usage,
} from '../../shared/run-types.ts';
import { writeJsonAtomic } from '../fs-atomic.ts';

export const STAGES: readonly StageName[] = ['collect', 'news', 'triage', 'screen', 'analyze', 'verify'];

export interface CreateRunOptions {
  workspaceDir: string;
  mode: RunMode;
  countries: { code: string; window: { from: ISODate; to: ISODate } }[];
  skillsHash: string;
  windowOverride?: { from: ISODate; to: ISODate };
  now: Date;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD_HHMM` по местному времени. */
export function runIdFor(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 };
}

function newCountry(window: { from: ISODate; to: ISODate }): CountryRun {
  const stages = {} as Record<StageName, StageState>;
  for (const s of STAGES) stages[s] = { state: 'pending', attempts: 0 };
  return { window, status: 'pending', stages, acts: {}, usage: emptyUsage() };
}

export function runFile(dir: string): string {
  return join(dir, 'run.json');
}

/** Создаёт папку прогона и run.json. Возвращает папку и состояние. */
export function createRun(opts: CreateRunOptions): { dir: string; state: RunState } {
  const runs = join(opts.workspaceDir, 'runs');
  mkdirSync(runs, { recursive: true });
  const base = runIdFor(opts.now);
  let id = base;
  let dir = join(runs, id);
  for (let n = 2; ; n++) {
    try {
      mkdirSync(dir); // без recursive: EEXIST означает занятый id
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      id = `${base}-${n}`;
      dir = join(runs, id);
    }
  }
  const countries: Record<string, CountryRun> = {};
  for (const c of opts.countries) countries[c.code] = newCountry(c.window);
  const state: RunState = {
    id,
    mode: opts.mode,
    started_at: opts.now.toISOString(),
    ...(opts.windowOverride ? { window_override: opts.windowOverride } : {}),
    skills_hash: opts.skillsHash,
    countries,
  };
  saveRun(dir, state);
  return { dir, state };
}

export function saveRun(dir: string, state: RunState): void {
  writeJsonAtomic(runFile(dir), state);
}

export function loadRun(dir: string): RunState {
  const raw: unknown = JSON.parse(readFileSync(runFile(dir), 'utf8'));
  const s = raw as Partial<RunState> | null;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.countries || typeof s.countries !== 'object') {
    throw new Error(`Файл состояния прогона повреждён: ${runFile(dir)}`);
  }
  const state = s as RunState;
  // Старые прогоны (до экрана по тексту) не знают этапа «screen»: у них отбор шёл прямо в анализ.
  for (const c of Object.values(state.countries)) {
    if (!c.stages || c.stages.screen) continue;
    const t = c.stages.triage?.state;
    c.stages.screen = { state: t === 'done' || t === 'skipped' ? 'skipped' : 'pending', attempts: 0 };
  }
  return state;
}

function country(state: RunState, code: string): CountryRun {
  const c = state.countries[code];
  if (!c) throw new Error(`В прогоне ${state.id} нет страны ${code}`);
  return c;
}

export function setCountryStatus(state: RunState, code: string, status: CountryStatus): RunState {
  country(state, code).status = status;
  return state;
}

export function markStage(state: RunState, code: string, stage: StageName, patch: Partial<StageState>): RunState {
  const c = country(state, code);
  c.stages[stage] = { ...c.stages[stage], ...patch };
  return state;
}

/** Создаёт запись акта при первом обращении. */
export function markAct(state: RunState, code: string, actId: string, patch: Partial<ActRun>): RunState {
  const c = country(state, code);
  c.acts[actId] = { ...(c.acts[actId] ?? { analyze: 'pending', rounds: 0 }), ...patch };
  return state;
}

export function addUsage(state: RunState, code: string, usage: Partial<Usage>): RunState {
  const u = country(state, code).usage;
  u.input += usage.input ?? 0;
  u.output += usage.output ?? 0;
  u.cache_read += usage.cache_read ?? 0;
  u.cache_write += usage.cache_write ?? 0;
  u.cost_usd += usage.cost_usd ?? 0;
  return state;
}

export function setCurrent(state: RunState, current: CurrentActivity | undefined): RunState {
  if (current) state.current = current;
  else delete state.current;
  return state;
}

export function finishRun(state: RunState, now: Date): RunState {
  state.finished_at = now.toISOString();
  delete state.current;
  delete state.paused_until;
  return state;
}

/**
 * Самый свежий прогон без finished_at (битые run.json пропускаются). Остановленные пользователем
 * (`stopped`) не возвращаются: их продолжают только явно, по папке прогона.
 */
export function findUnfinishedRun(workspaceDir: string): { dir: string; state: RunState } | null {
  const runs = join(workspaceDir, 'runs');
  let names: string[];
  try {
    names = readdirSync(runs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  names.sort().reverse();
  let best: { dir: string; state: RunState } | null = null;
  for (const name of names) {
    const dir = join(runs, name);
    try {
      const state = loadRun(dir);
      if (state.finished_at || state.stopped) continue;
      // сортировка по имени ненадёжна для суффиксов (-2 < -10 лексикографически), сравниваем по started_at
      if (!best || state.started_at > best.state.started_at) best = { dir, state };
    } catch {
      /* битый run.json пропускаем */
    }
  }
  return best;
}

export interface CountryPlan {
  code: string;
  /** Страна уже получила итоговый статус: ничего не делать. */
  skip: boolean;
  /** По каждому этапу: повторять или пропустить. */
  stages: Record<StageName, 'run' | 'skip'>;
  /** Первый этап, который надо выполнить; null, если страна закончена. */
  nextStage: StageName | null;
  /** Акты, которые надо (до)анализировать, по одному, в порядке записи. */
  pendingActs: string[];
  doneActs: string[];
}

/** План возобновления (RUN-06): этапы done/skipped и акты done не повторяются; running = прерван, начать сначала. */
export function resumePlan(state: RunState): CountryPlan[] {
  return Object.entries(state.countries).map(([code, c]) => {
    const final = c.status !== 'pending' && c.status !== 'running';
    const stages = {} as Record<StageName, 'run' | 'skip'>;
    let nextStage: StageName | null = null;
    for (const s of STAGES) {
      const st = c.stages[s].state;
      const skip = final || st === 'done' || st === 'skipped';
      stages[s] = skip ? 'skip' : 'run';
      if (!skip && nextStage === null) nextStage = s;
    }
    const pendingActs: string[] = [];
    const doneActs: string[] = [];
    for (const [id, a] of Object.entries(c.acts)) {
      if (a.analyze === 'done') doneActs.push(id);
      else if (!final && stages.analyze === 'run') pendingActs.push(id);
    }
    return { code, skip: final, stages, nextStage, pendingActs, doneActs };
  });
}
