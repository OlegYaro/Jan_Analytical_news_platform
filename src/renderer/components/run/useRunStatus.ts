import { useCallback, useEffect, useState } from 'react'
import type { RunStatusDto } from '../../../shared/run-types.ts'

const POLL_MS = 2000

/** Состояние прогона: опрос раз в 2 с плюс подписка на события из главного процесса. */
export function useRunStatus(): { status: RunStatusDto | null; error: boolean; refresh: () => void } {
  const [status, setStatus] = useState<RunStatusDto | null>(null)
  const [error, setError] = useState(false)

  const refresh = useCallback(() => {
    window.rw.run
      .status()
      .then((s) => {
        setStatus(s)
        setError(false)
      })
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    let off: (() => void) | undefined
    try {
      off = window.rw.run.onProgress((s) => {
        setStatus(s)
        setError(false)
      })
    } catch {
      setError(true)
    }
    return () => {
      clearInterval(timer)
      off?.()
    }
  }, [refresh])

  return { status, error, refresh }
}
