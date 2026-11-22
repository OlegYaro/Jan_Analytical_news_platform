import { en, ru } from '../shared/i18n.ts';
import { pick } from './i18n.ts';

/** Все строки интерфейса в текущем языке (ru/en выбираются при загрузке модуля). */
export const t = pick(ru, en);
