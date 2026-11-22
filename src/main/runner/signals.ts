// Сигналы прогона: разматывают стек до уровня страны/прогона (orchestrator.ts). Вынесены в отдельный
// модуль, чтобы бюджет лимита (budget.ts) бросал ТЕ ЖЕ сигналы, что и оркестратор, без циклического импорта.

/** Пауза до `until` (ISO): прогон сохраняет состояние, пишет `paused_until` и потом продолжается (NFR-06, RUN-06). */
export class PauseSignal extends Error {
  until: string;
  constructor(until: string, message: string) {
    super(message);
    this.until = until;
  }
}

/** Мягкая остановка пользователем (RUN-08). */
export class StopSignal extends Error {}

/** Провал страны с кодом: статус `failed:<code>`, остальные страны идут дальше (T-13). */
export class CountryFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Код провала исполнителя (Outcome.failure), которым бюджет сообщает «недельный лимит почти исчерпан». */
export const WEEKLY_LIMIT_FAILURE = 'weekly_limit';
