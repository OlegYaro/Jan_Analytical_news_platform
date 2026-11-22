import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface SaveStatus {
  /** true в течение 3 с после успешного сохранения. */
  saved: boolean
  markSaved: () => void
  /** Растёт после «Сбросить всё»: страница использует как key секций, чтобы поля перечитали значения. */
  epoch: number
  bumpEpoch: () => void
}

const NOOP: SaveStatus = { saved: false, markSaved: () => {}, epoch: 0, bumpEpoch: () => {} }
const Ctx = createContext<SaveStatus>(NOOP)

/** Общий «Сохранено ✓»: оборачивает страницу настроек или мастер. */
export function SaveStatusProvider({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const bumpEpoch = useCallback(() => setEpoch((e) => e + 1), [])
  const timer = useRef<number | undefined>(undefined)
  const markSaved = useCallback(() => {
    setSaved(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setSaved(false), 3000)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const value = useMemo(() => ({ saved, markSaved, epoch, bumpEpoch }), [saved, markSaved, epoch, bumpEpoch])
  return createElement(Ctx.Provider, { value }, children)
}

/** Без провайдера работает как заглушка. */
export function useSaveStatus(): SaveStatus {
  return useContext(Ctx)
}
