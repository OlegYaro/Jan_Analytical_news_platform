import { useEffect, useState } from 'react'
import type { RunStatusDto } from '../../shared/run-types.ts'
import { tr } from '../strings-run.ts'
import '../styles-countries.css'
import '../styles-run.css'
import { ConfirmDialog } from './countries/ConfirmDialog.tsx'
import {
  actsSummary,
  canStop,
  countryStatusText,
  countryTone,
  formatUsage,
  formatWhen,
  isUsageEmpty,
  modeLabel,
  pauseText,
  stageErrorTitle,
  stageIcon,
  stageStateLabel,
  STAGE_ORDER,
  screenSummary,
  sumUsage,
} from './run/logic.ts'

/** Одна строка о письме прогона (DLV-06): ушло, ждёт повтора, не ушло. */
function mailLine(m: NonNullable<RunStatusDto['mail']>, mode: string, now: Date): string {
  if (m.state === 'sent') return tr.mail.sent
  if (m.state === 'failed') return tr.mail.failed(m.attempts, m.lastError ?? '')
  if (m.state === 'queued') return m.attempts === 0 || !m.nextAttemptAt ? tr.mail.queuedFirst : tr.mail.queued(m.attempts, formatWhen(m.nextAttemptAt, now), m.lastError ?? '')
  return mode === 'dry_run' || mode === 'backfill' ? tr.mail.trial : tr.mail.notNeeded
}

interface Props {
  status: RunStatusDto | null
  /** Не удалось получить состояние (мягкий баннер). */
  pollError: boolean
  onChanged: () => void
}

export function RunPanel({ status, pollError, onChanged }: Props) {
  const [names, setNames] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')

  useEffect(() => {
    window.rw.countries
      .list()
      .then((list) => setNames(Object.fromEntries(list.map((c) => [c.code, c.name]))))
      .catch(() => {})
  }, [])

  // Остановка завершена, когда прогон перестал идти.
  useEffect(() => {
    if (status && !status.running) setStopping(false)
  }, [status])

  const doStop = async () => {
    setConfirming(false)
    setStopError('')
    setStopping(true)
    try {
      const r = await window.rw.run.stop()
      if (!r.ok) {
        setStopping(false)
        setStopError(r.message)
      }
      onChanged()
    } catch {
      setStopping(false)
      setStopError(tr.stopError)
    }
  }

  const run = status?.run ?? null
  const now = new Date()
  const countries = run ? Object.entries(run.countries) : []
  const total = run ? sumUsage(countries.map(([, c]) => c.usage)) : null

  return (
    <section className="card run-panel">
      <div className="card-head">
        <h2>{tr.title}</h2>
        <button type="button" disabled={!canStop(!!status?.running, stopping)} onClick={() => setConfirming(true)}>
          {stopping ? tr.stopping : tr.stop}
        </button>
      </div>
      {pollError && <div className="banner warn">{tr.pollError}</div>}
      {stopError && <div className="banner warn">{stopError}</div>}
      {!run && status && <p className="muted">{tr.noRuns}</p>}
      {!run && !status && !pollError && <p className="muted">…</p>}
      {run && status && (
        <>
          <p className="run-meta">
            {tr.started(modeLabel(run.mode), formatWhen(run.started_at, now))}
            {run.finished_at ? ` · ${tr.finished(formatWhen(run.finished_at, now))}` : ''}
            {run.stopped ? ` · ${tr.stoppedNote}` : ''}
          </p>
          {status.paused && status.pausedUntil && <p className="run-pause">{pauseText(status.pausedUntil, now)}</p>}
          <p className="run-now">{status.running && status.current ? tr.now(status.current.text) : status.running ? tr.now('…') : tr.idle}</p>
          {status.mail && <p className={status.mail.state === 'failed' ? 'run-pause' : 'muted'}>{mailLine(status.mail, run.mode, now)}</p>}
          <div className="run-scroll">
            <table className="run-table">
              <thead>
                <tr>
                  <th>{tr.country}</th>
                  {STAGE_ORDER.map((s) => (
                    <th key={s}>{tr.stages[s]}</th>
                  ))}
                  <th>{tr.actsHeader}</th>
                  <th>{tr.result}</th>
                </tr>
              </thead>
              <tbody>
                {countries.map(([code, c]) => (
                  <tr key={code}>
                    <td>{names[code] ?? code}</td>
                    {STAGE_ORDER.map((s) => {
                      const st = c.stages[s]?.state ?? 'skipped'
                      const title = stageErrorTitle(c, s)
                      return (
                        <td key={s} className="run-stage" title={title || stageStateLabel(st)}>
                          <span aria-label={stageStateLabel(st)}>{stageIcon(st)}</span>
                        </td>
                      )
                    })}
                    <td>
                      {actsSummary(c.acts) || tr.dash}
                      {screenSummary(c.screen) && <div className="muted">{screenSummary(c.screen)}</div>}
                    </td>
                    <td className={`run-result ${countryTone(c.status)}`}>{countryStatusText(c.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="run-sub">{tr.usageTitle}</h3>
          {total && isUsageEmpty(total) ? (
            <p className="muted">{tr.usageEmpty}</p>
          ) : (
            total && (
              <ul className="run-usage">
                <li>{tr.usageTotal(formatUsage(total))}</li>
                {countries.map(([code, c]) =>
                  isUsageEmpty(c.usage) ? null : (
                    <li key={code}>
                      {names[code] ?? code}: {formatUsage(c.usage)}
                    </li>
                  ),
                )}
              </ul>
            )
          )}
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title={tr.stop}
          text={tr.stopConfirm}
          confirmLabel={tr.stopYes}
          cancelLabel={tr.stopNo}
          onConfirm={doStop}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  )
}
