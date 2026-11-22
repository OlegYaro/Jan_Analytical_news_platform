import type { CountriesResult } from '../../../shared/api.ts';

/** Выполняет операцию, обновляет список стран; null — исключение IPC (баннер уже показан). */
export type RunOp = (op: () => Promise<CountriesResult>) => Promise<CountriesResult | null>;
