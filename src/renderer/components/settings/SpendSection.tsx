import { useState } from 'react'
import type { Preset } from '../../../shared/types.ts'
import { ts } from '../../strings-settings.ts'
import { useKnownCountries } from './useCountryNames.ts'
import { Field, SectionShell } from './Field.tsx'
import { limitLabel } from './logic.ts'
import { spendSummary } from '../home/logic.ts'
import { formatAmount, formatCost } from '../run/logic.ts'
import { useRunStatus } from '../run/useRunStatus.ts'
import { th } from '../../strings-home.ts'
import { tr } from '../../strings-run.ts'
import type { SectionProps } from './SectionProps.ts'
import { useSectionSave } from './useSectionSave.ts'

const s = ts.spend
const PRESETS: readonly Preset[] = ['economy', 'balanced', 'max']

function LimitSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [limit, setLimit] = useState(value)
  return (
    <div className="st-slider">
      <input
        id="st-limit"
        className="st-range"
        type="range"
        min={10}
        max={100}
        step={5}
        value={limit}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLimit(v)
          onChange(v)
        }}
      />
      <strong>{limitLabel(limit)}</strong>
    </div>
  )
}

function LastRunSpend() {
  const { status } = useRunStatus()
  const known = useKnownCountries()
  const sum = status?.run ? spendSummary(status.run, status.running, known, new Date()) : null
  if (!sum) return <span className="muted">{s.lastRunEmpty}</span>
  const line = (u: typeof sum.total) =>
    `${tr.usage.read} ${formatAmount(u.input)}, ${tr.usage.cached} ${formatAmount(u.cache_read)}, ${tr.usage.cacheWritten} ${formatAmount(u.cache_write)}, ${tr.usage.written} ${formatAmount(u.output)}`
  return (
    <div>
      <p>
        <strong>{th.spend.head(sum.mode, sum.when, sum.running)}</strong>
      </p>
      <p>
        {th.spend.total}: {formatCost(sum.total.cost_usd)} ({line(sum.total)})
      </p>
      <table className="run-table">
        <thead>
          <tr>
            <th>{th.spend.country}</th>
            <th>{tr.usage.cost}</th>
            <th>{tr.usageTitle}</th>
          </tr>
        </thead>
        <tbody>
          {sum.rows.map((r) => (
            <tr key={r.code}>
              <td>{r.name}</td>
              <td>{formatCost(r.usage.cost_usd)}</td>
              <td>{line(r.usage)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SpendSection({ settings, onSettings, compact }: SectionProps) {
  const { errors, failed, version, saveNow, saveLater, reset } = useSectionSave(onSettings)
  return (
    <SectionShell
      id="settings-spend"
      title={s.title}
      compact={compact}
      failed={failed}
      onReset={() => void reset('spend', [ts.resetConfirm])}
    >
      <div key={version}>
        <Field label={s.preset} hint={s.presetHint} example={s.presetExample} defaultValue={s.presetDefault} error={errors.preset} compact={compact}>
          <div className="st-radios" role="radiogroup">
            {PRESETS.map((p) => (
              <label key={p} className={`st-radio${settings.preset === p ? ' on' : ''}`}>
                <input type="radio" name="st-preset" checked={settings.preset === p} onChange={() => saveNow({ preset: p })} />
                <span>
                  <strong>{s.presets[p].name}</strong>
                  <span className="st-hint"> — {s.presets[p].text}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>

        <Field
          label={s.limit}
          hint={s.limitHint}
          example={s.limitExample}
          defaultValue={s.limitDefault}
          error={errors.limitPercent}
          htmlFor="st-limit"
          compact={compact}
        >
          <LimitSlider value={settings.limitPercent} onChange={(v) => saveLater('limit', { limitPercent: v })} />
        </Field>

        <Field label={s.lastRun} hint={s.lastRunHint} compact={compact}>
          <LastRunSpend />
        </Field>
      </div>
    </SectionShell>
  )
}
