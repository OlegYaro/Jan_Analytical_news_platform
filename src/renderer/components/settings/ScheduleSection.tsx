import { useEffect, useMemo, useState } from 'react'
import { MAX_SCHEDULES } from '../../../shared/types.ts'
import type { ScheduleEntry } from '../../../shared/types.ts'
import { ts } from '../../strings-settings.ts'
import { DraftInput } from './DraftInput.tsx'
import { Field, SectionShell } from './Field.tsx'
import {
  canAddSchedule, canRemoveSchedule, countriesLabel, DAY_LONG, findOverlaps, formatNextRun, newSchedule,
  nextRun, parseScheduleErrors, toggleCountry, toggleDay, uncoveredCountries, WEEK_ORDER,
} from './logic.ts'
import { useKnownCountries } from './useCountryNames.ts'
import type { SectionProps } from './SectionProps.ts'
import { useSectionSave } from './useSectionSave.ts'

const s = ts.schedule

export function ScheduleSection({ settings, onSettings, compact }: SectionProps) {
  const { errors, failed, version, saveNow, saveLater, reset } = useSectionSave(onSettings)
  // Локальный список — источник правды для правок: сохраняем его целиком (один debounce на все поля).
  const [items, setItems] = useState<ScheduleEntry[]>(() => settings.schedules)
  const known = useKnownCountries()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  // После «Вернуть стандартные» читаем список заново.
  useEffect(() => {
    if (version > 0) setItems(settings.schedules)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const active = useMemo(() => known.filter((k) => k.active), [known])
  const activeCodes = useMemo(() => active.map((k) => k.code), [active])
  const errs = parseScheduleErrors(errors)
  const overlaps = useMemo(() => findOverlaps(items, activeCodes), [items, activeCodes])
  const uncovered = useMemo(() => new Set(uncoveredCountries(items, activeCodes)), [items, activeCodes])

  const commit = (next: ScheduleEntry[]) => {
    setItems(next)
    saveLater('schedules', { schedules: next })
  }
  const patchItem = (i: number, patch: Partial<ScheduleEntry>) => commit(items.map((e, k) => (k === i ? { ...e, ...patch } : e)))
  const addDisabled = !canAddSchedule(items)

  return (
    <SectionShell
      id="settings-schedule"
      title={s.title}
      compact={compact}
      failed={failed}
      onReset={() => void reset('schedule', [ts.resetConfirm])}
    >
      <div key={version}>
        <p className="st-hint st-caption">{s.intro}</p>
        {errs.general.map((m) => (
          <div key={m} className="st-error" role="alert">{m}</div>
        ))}

        <div className="st-sched-list" role="list" aria-label={s.listLabel}>
          {items.map((e, i) => {
            const own = errs.byIndex[i] ?? {}
            const date = e.enabled ? nextRun(e.days, e.time, now) : null
            const nextText = !e.enabled
              ? s.nextOfOff
              : date
                ? s.nextOf(formatNextRun(date, now), countriesLabel(e, known, s.countriesAll))
                : s.nextOfNone
            const myOverlaps = overlaps.filter((o) => o.a === i || o.b === i)
            return (
              <div key={e.id} className={`st-sched${e.enabled ? '' : ' off'}`} role="listitem">
                <div className="st-sched-head">
                  <label className="st-check">
                    <input type="checkbox" checked={e.enabled} onChange={(ev) => patchItem(i, { enabled: ev.target.checked })} />
                    {s.enabled}
                  </label>
                  <button
                    type="button"
                    disabled={!canRemoveSchedule(items)}
                    title={canRemoveSchedule(items) ? undefined : s.removeLast}
                    onClick={() => window.confirm(s.removeConfirm(e.name)) && commit(items.filter((_, k) => k !== i))}
                  >
                    {s.remove}
                  </button>
                </div>
                {/* Подсказка к переключателю «Включено» (CFG-02, docs/05 §6.2). */}
                <div className="st-hint">{s.enabledHint}</div>
                {own.entry && <div className="st-error" role="alert">{own.entry}</div>}
                {own.enabled && <div className="st-error" role="alert">{own.enabled}</div>}
                {own.id && <div className="st-error" role="alert">{own.id}</div>}

                <Field label={s.name} hint={s.nameHint} example={s.nameExample} defaultValue={s.nameDefault} error={own.name} htmlFor={`st-name-${e.id}`} compact={compact}>
                  <DraftInput id={`st-name-${e.id}`} value={e.name} invalid={!!own.name} onCommit={(v) => patchItem(i, { name: v })} />
                </Field>

                <Field label={s.days} hint={s.daysHint} example={s.daysExample} defaultValue={s.daysDefault} error={own.days} compact={compact}>
                  <div className="st-days">
                    {WEEK_ORDER.map((d, k) => (
                      <label key={d} className="st-check" title={DAY_LONG[d]}>
                        <input type="checkbox" checked={e.days.includes(d)} onChange={() => patchItem(i, { days: toggleDay(e.days, d) })} />
                        {s.days7[k]}
                      </label>
                    ))}
                  </div>
                </Field>

                <Field label={s.time} hint={s.timeHint} example={s.timeExample} defaultValue={s.timeDefault} error={own.time} htmlFor={`st-time-${e.id}`} compact={compact}>
                  <DraftInput id={`st-time-${e.id}`} type="time" className="st-short" value={e.time} invalid={!!own.time} onCommit={(v) => patchItem(i, { time: v })} />
                </Field>

                <Field label={s.countries} hint={s.countriesHint} example={s.countriesExample} defaultValue={s.countriesDefault} error={own.countries} compact={compact}>
                  {active.length === 0 ? (
                    <span className="muted">{s.countriesNone}</span>
                  ) : (
                    <>
                      <div className="st-days">
                        {active.map((c) => (
                          <label key={c.code} className="st-check">
                            <input type="checkbox" checked={e.countries.includes(c.code)} onChange={() => patchItem(i, { countries: toggleCountry(e.countries, c.code) })} />
                            {c.name}
                          </label>
                        ))}
                      </div>
                      {e.countries.length === 0 && <div className="st-all-note">{s.countriesAll}</div>}
                    </>
                  )}
                </Field>

                {myOverlaps.map((o) => {
                  const names = (c: string[]) => c.map((x) => known.find((k) => k.code === x)?.name ?? x).join(', ')
                  return (
                    <div key={`${o.a}-${o.b}`} className="banner warn">
                      {s.overlap(items[o.a].name, items[o.b].name, o.days.map((d) => DAY_LONG[d]).join(', '), names(o.codes))}
                    </div>
                  )
                })}

                <div className="st-next">{nextText}</div>
              </div>
            )
          })}
        </div>

        {uncovered.size > 0 && (
          <div className="st-uncovered">
            {active
              .filter((c) => uncovered.has(c.code))
              .map((c) => (
                <div key={c.code} className="st-hint">
                  <strong>{c.name}</strong>: {s.uncovered}
                </div>
              ))}
          </div>
        )}

        <div className="st-sched-add">
          <button
            type="button"
            disabled={addDisabled}
            title={addDisabled ? s.addMax(MAX_SCHEDULES) : undefined}
            onClick={() => commit([...items, newSchedule(items)])}
          >
            + {s.add}
          </button>
          {addDisabled && <span className="st-hint">{s.addMax(MAX_SCHEDULES)}</span>}
        </div>

        <Field
          label={s.launchAtLogin}
          hint={s.launchAtLoginHint}
          example={s.launchAtLoginExample}
          defaultValue={s.launchAtLoginDefault}
          error={errors.launchAtLogin}
          compact={compact}
        >
          <label className="st-check">
            <input type="checkbox" checked={settings.launchAtLogin} onChange={(e) => saveNow({ launchAtLogin: e.target.checked })} />
            {s.launchAtLogin}
          </label>
        </Field>

        <Field
          label={s.catchUp}
          hint={s.catchUpHint}
          example={s.catchUpExample}
          defaultValue={s.catchUpDefault}
          error={errors.catchUpMissed}
          compact={compact}
        >
          <label className="st-check">
            <input type="checkbox" checked={settings.catchUpMissed} onChange={(e) => saveNow({ catchUpMissed: e.target.checked })} />
            {s.catchUp}
          </label>
        </Field>
      </div>
    </SectionShell>
  )
}
