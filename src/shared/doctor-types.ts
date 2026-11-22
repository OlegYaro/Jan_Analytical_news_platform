/** Результат одной проверки окружения (doctor). Тексты — по-русски, без стектрейсов. */
export interface DoctorCheck {
  id: 'node' | 'claude-found' | 'claude-version' | 'claude-login' | 'claude-flags' | 'workspace-write'
  title: string
  ok: boolean
  /** Короткая деталь: версия, путь, причина. */
  detail: string
  /** Что делать, если ❌ (пустая строка, если ok). */
  fix: string
  /** Ссылка с инструкцией (необязательно). */
  link?: string
}
