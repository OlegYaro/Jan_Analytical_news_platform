// Контроллер проверки и поиска источников для окна (SRC-01, SRC-07, SRC-09). Без electron: всё — инъекцией.
// Одновременно — одно задание (проверка или поиск); во время прогона оркестратора — отказ.
import type { UiLanguage } from '../../shared/types.ts';
import { langOf, mt } from '../i18n.ts';
import type { CountriesResult } from '../../shared/api.ts';
import type { ActProposalDto, DiscoverResultDto, SourceCheckScope, SourceProposalDto, SourcesStatusDto } from '../../shared/sources-types.ts';
import type { Settings } from '../../shared/types.ts';
import type { Fetcher } from '../collect/fetcher-types.ts';
import { loadCountries } from '../countries/store.ts';
import { checkSources } from './checker.ts';
import type { CheckSourcesResult } from './checker.ts';
import { acceptActProposal, acceptSourceProposal, discoverSources } from './discover.ts';
import type { DiscoverMode, DiscoverResult } from './discover.ts';
import type { ModelDeps } from './model-call.ts';

export const RUN_BUSY_MESSAGE = 'Дождитесь окончания проверки: сейчас идёт проверка изменений.';
export const SOURCES_BUSY_MESSAGE = 'Проверка источников уже идёт. Дождитесь её окончания.';
export const CHECK_STARTED_MESSAGE = 'Проверка источников запущена. Это займёт несколько минут.';
export const BAD_SCOPE_MESSAGE = 'Не указано, что проверять: страна, источник или все страны.';
export const STALE_PROPOSAL_MESSAGE = 'Это предложение устарело — запустите поиск ещё раз.';
export const CONTROLLER_ERROR_MESSAGE = 'Проверка источников остановилась из-за внутренней ошибки. Попробуйте ещё раз.';

const EN: Record<string, string> = {
  [RUN_BUSY_MESSAGE]: 'Wait for the check to finish: a change check is running now.',
  [SOURCES_BUSY_MESSAGE]: 'A source check is already running. Wait for it to finish.',
  [CHECK_STARTED_MESSAGE]: 'The source check has started. It will take a few minutes.',
  [BAD_SCOPE_MESSAGE]: 'It is not specified what to check: a country, a source or all countries.',
  [STALE_PROPOSAL_MESSAGE]: 'This suggestion is out of date — run the search again.',
  [CONTROLLER_ERROR_MESSAGE]: 'The source check stopped because of an internal error. Try again.',
}

export interface SourcesControllerDeps extends ModelDeps {
  fetcher: Fetcher | (() => Fetcher);
  workspaceDir: () => string;
  countriesDir: () => string;
  getSettings: () => Settings;
  /** Идёт прогон оркестратора. */
  isRunBusy: () => boolean;
  /** Проверка перед заданием (найден ли claude): текст отказа или null. */
  preflight?: () => Promise<string | null>;
  now?: () => Date;
  /** Подмена функций (тесты). */
  check?: typeof checkSources;
  discover?: typeof discoverSources;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface SourcesController {
  check(scope: SourceCheckScope): Promise<ActionResult>;
  status(): SourcesStatusDto;
  discover(code: string, mode: DiscoverMode): Promise<DiscoverResultDto>;
  acceptSource(code: string, proposal: SourceProposalDto): CountriesResult;
  acceptAct(code: string, proposal: ActProposalDto): CountriesResult;
  /** Идёт ли задание (для отказа запуска прогона). */
  readonly running: boolean;
  /** Промис текущего задания (тесты, выход из приложения). */
  idle(): Promise<void>;
  onChange(cb: () => void): () => void;
  /** Итоги последней проверки по странам (для журнала и скриптов). */
  lastResults(): CheckSourcesResult[];
}

export function createSourcesController(deps: SourcesControllerDeps): SourcesController {
  const now = deps.now ?? (() => new Date());
  const check = deps.check ?? checkSources;
  const discover = deps.discover ?? discoverSources;
  const fetcher = (): Fetcher => (typeof deps.fetcher === 'function' ? deps.fetcher() : deps.fetcher);
  const L = (): UiLanguage => langOf(deps.getSettings());
  /** Фиксированное сообщение на языке интерфейса; прочие — через mt. */
  const T = (ru: string): string => mt(L(), ru, EN[ru] ?? ru);
  const listeners = new Set<() => void>();
  let st: SourcesStatusDto = { running: false, text: '', done: 0, total: 0 };
  let job: Promise<void> | null = null;
  let last: CheckSourcesResult[] = [];
  /** Подтверждённые предложения последнего поиска по стране: «Добавить» принимает только их. */
  const offered = new Map<string, { sources: SourceProposalDto[]; acts: ActProposalDto[] }>();

  const notify = (): void => {
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch {
        /* подписчик не ломает задание */
      }
    }
  };
  const set = (patch: Partial<SourcesStatusDto>): void => {
    st = { ...st, ...patch };
    notify();
  };

  function busy(): string | null {
    if (st.running) return T(SOURCES_BUSY_MESSAGE);
    if (deps.isRunBusy()) return T(RUN_BUSY_MESSAGE);
    return null;
  }

  function modelDeps(): ModelDeps {
    return {
      schemasDir: deps.schemasDir,
      claudeBin: deps.claudeBin,
      claudeEnv: deps.claudeEnv,
      ...(deps.runStage ? { runStage: deps.runStage } : {}),
      ...(deps.budget ? { budget: deps.budget } : {}),
    };
  }

  async function checkScope(scope: SourceCheckScope): Promise<ActionResult> {
    const why = busy();
    if (why) return { ok: false, message: why };
    const countries = loadCountries(deps.countriesDir());
    let plan: Array<{ code: string; sourceIds?: string[]; items: number }>;
    if (scope?.all) {
      plan = countries
        .map((c) => ({ code: c.code, items: c.sources.filter((s) => s.enabled).length + c.watchedActs.length }))
        .filter((p) => p.items > 0);
    } else if (scope?.code) {
      const c = countries.find((x) => x.code === scope.code);
      if (!c) return { ok: false, message: mt(L(), 'Страна не найдена в списке', 'The country was not found in the list') };
      if (scope.sourceId) {
        if (!c.sources.some((s) => s.id === scope.sourceId)) return { ok: false, message: mt(L(), 'Источник не найден', 'Source not found') };
        plan = [{ code: c.code, sourceIds: [scope.sourceId], items: 1 }];
      } else plan = [{ code: c.code, items: c.sources.filter((s) => s.enabled).length + c.watchedActs.length }];
    } else return { ok: false, message: T(BAD_SCOPE_MESSAGE) };
    if (plan.length === 0 || plan.every((p) => p.items === 0)) return { ok: false, message: mt(L(), 'Нечего проверять: нет включённых источников', 'Nothing to check: there are no enabled sources') };
    const pre = deps.preflight ? await deps.preflight() : null;
    if (pre) return { ok: false, message: pre };

    const total = plan.reduce((n, p) => n + p.items, 0);
    st = { running: true, text: mt(L(), 'Начинаем проверку источников…', 'Starting the source check…'), done: 0, total, startedAt: now().toISOString() };
    notify();
    last = [];
    job = (async () => {
      let base = 0;
      const msgs: string[] = [];
      try {
        for (const p of plan) {
          const r = await check({
            ...modelDeps(),
            country: p.code,
            ...(p.sourceIds ? { sourceIds: p.sourceIds } : {}),
            fetcher: fetcher(),
            workspaceDir: deps.workspaceDir(),
            countriesDir: deps.countriesDir(),
            settings: deps.getSettings(),
            now,
            onProgress: (pr) => set({ text: pr.text, done: base + pr.done }),
          });
          last.push(r);
          msgs.push(r.message);
          base += p.items;
          set({ done: base });
          if (r.interrupted) break; // лимит/нет Claude: остальные страны не трогаем
        }
        const text = msgs.join('\n');
        set({ running: false, text: text || mt(L(), 'Проверка источников закончена', 'The source check is finished'), lastMessage: text, finishedAt: now().toISOString() });
      } catch {
        set({ running: false, text: T(CONTROLLER_ERROR_MESSAGE), lastMessage: T(CONTROLLER_ERROR_MESSAGE), finishedAt: now().toISOString() });
      } finally {
        job = null;
      }
    })();
    return { ok: true, message: T(CHECK_STARTED_MESSAGE) };
  }

  async function discoverFor(code: string, mode: DiscoverMode): Promise<DiscoverResultDto> {
    const fail = (message: string): DiscoverResultDto => ({ ok: false, message, sourceProposals: [], actProposals: [] });
    if (mode !== 'missing' && mode !== 'watched') return fail(mt(L(), 'Неизвестный режим поиска', 'Unknown search mode'));
    const why = busy();
    if (why) return fail(why);
    if (!loadCountries(deps.countriesDir()).some((c) => c.code === code)) return fail(mt(L(), 'Страна не найдена в списке', 'The country was not found in the list'));
    const pre = deps.preflight ? await deps.preflight() : null;
    if (pre) return fail(pre);
    st = { running: true, text: mode === 'watched' ? mt(L(), 'Ищем основные законы страны…', 'Searching for the main laws of the country…') : mt(L(), 'Ищем недостающие источники…', 'Searching for missing sources…'), done: 0, total: 1, startedAt: now().toISOString() };
    notify();
    const p = Promise.resolve().then(() =>
      discover({
        ...modelDeps(),
        mode,
        country: code,
        fetcher: fetcher(),
        workspaceDir: deps.workspaceDir(),
        countriesDir: deps.countriesDir(),
        settings: deps.getSettings(),
        now,
      }),
    );
    job = p.then(
      () => {},
      () => {},
    );
    let res: DiscoverResult | null;
    try {
      res = await p;
    } catch {
      res = null;
    } finally {
      job = null;
    }
    if (!res) {
      set({ running: false, text: T(CONTROLLER_ERROR_MESSAGE), lastMessage: T(CONTROLLER_ERROR_MESSAGE), done: 1, finishedAt: now().toISOString() });
      return fail(T(CONTROLLER_ERROR_MESSAGE));
    }
    const prev = offered.get(code) ?? { sources: [], acts: [] };
    offered.set(code, mode === 'missing' ? { ...prev, sources: res.sourceProposals } : { ...prev, acts: res.actProposals });
    set({ running: false, text: res.message, lastMessage: res.message, done: 1, finishedAt: now().toISOString() });
    return { ok: res.ok, message: res.message, sourceProposals: res.sourceProposals, actProposals: res.actProposals };
  }

  function acceptSource(code: string, proposal: SourceProposalDto): CountriesResult {
    const known = offered.get(code)?.sources.find((x) => x.url === proposal?.url && x.type === proposal?.type);
    if (!known) return { ok: false, errors: { proposal: T(STALE_PROPOSAL_MESSAGE) }, countries: loadCountries(deps.countriesDir()) };
    const r = acceptSourceProposal(deps.countriesDir(), code, known);
    if (r.ok) offered.get(code)!.sources = offered.get(code)!.sources.filter((x) => x !== known);
    return r;
  }

  function acceptAct(code: string, proposal: ActProposalDto): CountriesResult {
    const known = offered.get(code)?.acts.find((x) => x.url === proposal?.url);
    if (!known) return { ok: false, errors: { proposal: T(STALE_PROPOSAL_MESSAGE) }, countries: loadCountries(deps.countriesDir()) };
    const r = acceptActProposal(deps.countriesDir(), code, known);
    if (r.ok) offered.get(code)!.acts = offered.get(code)!.acts.filter((x) => x !== known);
    return r;
  }

  return {
    check: checkScope,
    status: () => ({ ...st }),
    discover: discoverFor,
    acceptSource,
    acceptAct,
    get running() {
      return st.running;
    },
    idle: async () => {
      while (job) await job;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    lastResults: () => [...last],
  };
}
