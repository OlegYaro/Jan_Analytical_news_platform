// Патчи настроек из окна приложения (renderer) не должны менять служебные поля:
// «почта проверена» ставит только отправка тестового письма, «мастер пройден» — только завершение мастера.
import type { SettingsPatch } from '../../shared/types.ts';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Поля одного расписания, которые сохраняются; прочее (служебные поля окна) отбрасывается. */
const SCHEDULE_KEYS = ['id', 'name', 'enabled', 'days', 'time', 'countries'] as const;

/**
 * Копия патча без `mail.verified`, `onboardingDone` и `schemaVersion`; не-объект → пустой патч.
 * У расписаний остаются только известные поля (список приходит целиком и заменяет прежний).
 */
export function sanitizeRendererPatch(patch: unknown): SettingsPatch {
  if (!isObj(patch)) return {};
  const { onboardingDone: _o, schemaVersion: _s, ...rest } = patch;
  if (isObj(rest['mail'])) {
    const { verified: _v, ...mail } = rest['mail'];
    rest['mail'] = mail;
  }
  if (Array.isArray(rest['schedules'])) {
    rest['schedules'] = rest['schedules'].map((item: unknown) => {
      if (!isObj(item)) return item; // неверный элемент отклонит validateSettings
      const out: Record<string, unknown> = {};
      for (const k of SCHEDULE_KEYS) if (k in item) out[k] = item[k];
      return out;
    });
  }
  return rest as SettingsPatch;
}
