import { useState } from 'react'
import type { UiLanguage } from '../../../shared/types.ts'
import { currentLang, setLangLocal } from '../../i18n.ts'
import { ts } from '../../strings-settings.ts'
import { Field, SectionShell } from './Field.tsx'
import type { SectionProps } from './SectionProps.ts'

const s = ts.general
const LANGS: readonly UiLanguage[] = ['ru', 'en']

/** Общие настройки: язык интерфейса. После смены окно перезагружается, чтобы все тексты обновились. */
export function GeneralSection({ settings, compact }: SectionProps) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const change = async (lang: UiLanguage) => {
    if (lang === settings.uiLanguage && lang === currentLang()) return
    setBusy(true)
    setFailed(false)
    try {
      const r = await window.rw.settings.update({ uiLanguage: lang })
      if (!r.ok) throw new Error('rejected')
      setLangLocal(lang)
      window.location.reload()
    } catch {
      setBusy(false)
      setFailed(true)
    }
  }

  return (
    <SectionShell id="settings-general" title={s.title} compact={compact}>
      <Field label={s.language} hint={s.languageHint} example={s.languageExample} defaultValue={s.languageDefault} htmlFor="st-ui-lang" compact={compact}>
        <select
          id="st-ui-lang"
          className="st-input st-short"
          value={settings.uiLanguage}
          disabled={busy}
          onChange={(e) => void change(e.target.value as UiLanguage)}
        >
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {s[l]}
            </option>
          ))}
        </select>
        {busy && <div className="muted" role="status">{s.applying}</div>}
        {failed && <div className="st-error" role="alert">{s.applyError}</div>}
      </Field>
    </SectionShell>
  )
}
