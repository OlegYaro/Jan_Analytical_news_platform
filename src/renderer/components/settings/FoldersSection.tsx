import { useCallback, useEffect, useState } from 'react'
import { ts } from '../../strings-settings.ts'
import { Field, SectionShell } from './Field.tsx'
import type { SectionProps } from './SectionProps.ts'
import { useSaveStatus } from './useSaveStatus.ts'
import { useSectionSave } from './useSectionSave.ts'

const s = ts.folders

/** Папки, доступ к которым macOS защищает (системный запрос разрешения). */
const PROTECTED = /^\/Users\/[^/]+\/(Documents|Desktop|Downloads|Library\/Mobile Documents)(\/|$)/

export function FoldersSection({ settings, onSettings, compact }: SectionProps) {
  const { errors, failed, reset } = useSectionSave(onSettings)
  const { markSaved } = useSaveStatus()
  const [info, setInfo] = useState<{ dir: string; exists: boolean } | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    window.rw.workspace.info().then(setInfo).catch(() => setError(true))
  }, [])
  // settings.workspaceDir в зависимостях: после сброса путь перечитывается.
  useEffect(load, [load, settings.workspaceDir])

  const choose = async () => {
    try {
      const dir = await window.rw.workspace.choose()
      if (!dir) return
      setInfo(await window.rw.workspace.info())
      onSettings(await window.rw.settings.get())
    } catch {
      setError(true)
      return
    }
    setError(false)
    markSaved()
  }

  return (
    <SectionShell
      id="settings-folders"
      title={s.title}
      compact={compact}
      failed={failed || error}
      onReset={() => void reset('folders', [ts.resetConfirm])}
    >
      {!info ? (
        <p className="muted">{ts.loading}</p>
      ) : (
        <>
          <Field
            label={s.workspace}
            hint={s.workspaceHint}
            example={s.workspaceExample}
            defaultValue={s.workspaceDefault}
            error={errors.workspaceDir}
            compact={compact}
          >
            <div className="path">{info.dir}</div>
            {!info.exists && <div className="muted">{s.missing}</div>}
            <div className="row">
              <button type="button" onClick={() => void choose()}>
                {s.choose}
              </button>
              <button type="button" onClick={() => window.rw.workspace.openInFinder().catch(() => setError(true))}>
                {s.openInFinder}
              </button>
            </div>
          </Field>
          {PROTECTED.test(info.dir) && <div className="banner warn">{s.protectedFolder}</div>}
          <div className="banner warn">{s.skillsWarning}</div>
        </>
      )}
    </SectionShell>
  )
}
