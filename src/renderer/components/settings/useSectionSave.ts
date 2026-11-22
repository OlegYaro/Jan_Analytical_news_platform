import { useCallback, useEffect, useRef, useState } from 'react'
import type { ResetSection } from '../../../shared/api.ts'
import type { Settings, SettingsPatch } from '../../../shared/types.ts'
import { mergeErrors } from './logic.ts'
import { useSaveStatus } from './useSaveStatus.ts'

const DEBOUNCE_MS = 400

/** Автосохранение секции: debounce для текста, сразу для переключателей, ошибки по путям полей. */
export function useSectionSave(onSettings: (s: Settings) => void) {
  const { markSaved, bumpEpoch } = useSaveStatus()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [failed, setFailed] = useState(false)
  /** Растёт после сброса секции: используется как key, чтобы поля перечитали значения. */
  const [version, setVersion] = useState(0)
  const cb = useRef(onSettings)
  cb.current = onSettings
  const queue = useRef(new Map<string, { patch: SettingsPatch; timer: number }>())

  const send = useCallback(
    async (patch: SettingsPatch) => {
      try {
        const r = await window.rw.settings.update(patch)
        setErrors((prev) => mergeErrors(prev, patch, r.errors))
        setFailed(false)
        if (r.ok) {
          cb.current(r.settings)
          markSaved()
        }
      } catch {
        setFailed(true)
      }
    },
    [markSaved],
  )

  /** Сразу (переключатели, выпадающие списки). */
  const saveNow = useCallback((patch: SettingsPatch) => void send(patch), [send])

  /** С задержкой; последнее значение под тем же ключом заменяет предыдущее. */
  const saveLater = useCallback(
    (key: string, patch: SettingsPatch) => {
      const old = queue.current.get(key)
      if (old) window.clearTimeout(old.timer)
      const timer = window.setTimeout(() => {
        queue.current.delete(key)
        void send(patch)
      }, DEBOUNCE_MS)
      queue.current.set(key, { patch, timer })
    },
    [send],
  )

  // При уходе со страницы не теряем набранное.
  useEffect(() => {
    const q = queue.current
    return () => {
      for (const { patch, timer } of q.values()) {
        window.clearTimeout(timer)
        void send(patch)
      }
      q.clear()
    }
  }, [send])

  const reset = useCallback(
    async (section: ResetSection, confirms: readonly string[]) => {
      for (const text of confirms) if (!window.confirm(text)) return
      for (const { timer } of queue.current.values()) window.clearTimeout(timer)
      queue.current.clear()
      try {
        const r = await window.rw.settings.resetSection(section)
        setErrors({})
        setFailed(false)
        cb.current(r.settings)
        setVersion((v) => v + 1)
        if (section === 'all') bumpEpoch()
        markSaved()
      } catch {
        setFailed(true)
      }
    },
    [markSaved, bumpEpoch],
  )

  return { errors, failed, version, saveNow, saveLater, reset }
}
